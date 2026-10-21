import { getSetting } from './settings.js';

export const DEFAULT_MODEL = 'gpt-4.1-mini';

export function aiConfig(db) {
  return {
    key: getSetting(db, 'openai_api_key') || process.env.OPENAI_API_KEY || '',
    model: getSetting(db, 'openai_model') || process.env.OPENAI_MODEL || DEFAULT_MODEL,
    base: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  };
}

/** Chat-Completion mit JSON-Antwort (OpenAI-kompatibel). */
export async function chatJson(cfg, system, user, { timeout = 150000 } = {}) {
  if (!cfg.key) throw new Error('OpenAI-API-Schlüssel fehlt (Einstellungen → KI)');
  let res;
  try {
    res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: `${system}\nAntworte ausschließlich mit einem gültigen JSON-Objekt.` },
          { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
        ],
        response_format: { type: 'json_object' },
      }),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'OpenAI antwortet nicht (Zeitüberschreitung)' : `OpenAI nicht erreichbar: ${e.cause?.code || e.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI antwortet mit HTTP ${res.status} (kein JSON)`);
  }
  if (!res.ok) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    throw new Error(res.status === 401 ? 'OpenAI: API-Schlüssel ungültig' : `OpenAI: ${msg}`);
  }
  const content = json.choices?.[0]?.message?.content;
  try {
    return { data: JSON.parse(content), usage: json.usage ?? null };
  } catch {
    throw new Error('Die KI-Antwort war kein gültiges JSON');
  }
}

export async function testAi(cfg) {
  await chatJson(cfg, 'Du bist ein Verbindungstest. Antworte mit {"ok": true}.', 'Test', { timeout: 30000 });
  return { ok: true, model: cfg.model };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Kompakte Datengrundlage: nur bestätigte Mitbewerberpreise, größte Rückstände zuerst. */
export function buildDataset(db, limit = 120) {
  const products = db.prepare('SELECT id, number, name, manufacturer, price FROM products WHERE active=1 AND price IS NOT NULL').all();
  const ms = db.prepare("SELECT m.product_id, c.name AS competitor, m.price, m.availability FROM matches m JOIN competitors c ON c.id=m.competitor_id WHERE m.status='ok' AND m.price IS NOT NULL AND c.enabled=1").all();
  const by = new Map();
  for (const m of ms) {
    if (!by.has(m.product_id)) by.set(m.product_id, []);
    by.get(m.product_id).push({ competitor: m.competitor, price: m.price, availability: m.availability });
  }
  const rows = products
    .filter((p) => by.has(p.id))
    .map((p) => {
      const comps = by.get(p.id);
      const min = Math.min(...comps.map((c) => c.price));
      return { number: p.number, name: p.name, brand: p.manufacturer, own_price: p.price, competitors: comps, cheapest_competitor: min, gap_percent: Math.round(((p.price - min) / min) * 1000) / 10 };
    });
  // Auffälligste zuerst: teuer gegenüber Mitbewerbern, dann sehr günstig (mögliches Anhebe-Potenzial)
  rows.sort((a, b) => Math.abs(b.gap_percent) - Math.abs(a.gap_percent));
  return { total: rows.length, rows: rows.slice(0, limit) };
}

const ANALYSIS_SYSTEM = `Du bist Preisanalyst für einen deutschen Onlineshop für Bad und Sanitär.
Du bekommst Produkte mit eigenem Bruttopreis (own_price) und den Bruttopreisen bestätigter Mitbewerber.
gap_percent ist die Abweichung des eigenen Preises zum günstigsten Mitbewerber (positiv = wir sind teurer).
Es liegen KEINE Einkaufspreise oder Margen vor. Nimm keine an, erfinde keine Zahlen und weise bei Preissenkungen darauf hin, dass die Marge geprüft werden muss.
Liefere JSON in dieser Form:
{"summary": "3-5 Sätze: Gesamtbild, größte Auffälligkeiten, Handlungsbedarf",
 "recommendations": [{"number": "Artikelnummer exakt wie in den Daten", "action": "senken|halten|erhöhen|prüfen", "suggested_price": Zahl oder null, "reason": "max. 160 Zeichen, konkret"}],
 "warnings": [{"number": "Artikelnummer", "issue": "z. B. Preis weicht über 40 % ab, vermutlich andere Variante oder falsche Zuordnung"}]}
Regeln: höchstens 25 Empfehlungen, die wichtigsten zuerst; suggested_price als Bruttopreis mit üblicher Preisendung (z. B. .90 oder .00); "erhöhen" nur, wenn wir deutlich unter allen Mitbewerbern liegen; Auffälligkeiten mit extremen Abständen als warnings statt als Empfehlung behandeln.`;

export async function analyze(db, cfg) {
  const ds = buildDataset(db);
  if (!ds.rows.length) throw new Error('Noch keine bestätigten Mitbewerberpreise vorhanden. Lege Mitbewerber an und starte einen Abruf.');
  const { data, usage } = await chatJson(cfg, ANALYSIS_SYSTEM, { products: ds.rows });
  const known = new Set(ds.rows.map((r) => r.number));
  const clean = {
    summary: String(data.summary ?? '').slice(0, 1500),
    recommendations: (Array.isArray(data.recommendations) ? data.recommendations : [])
      .filter((r) => known.has(String(r.number)))
      .slice(0, 25)
      .map((r) => ({
        number: String(r.number),
        action: ['senken', 'halten', 'erhöhen', 'prüfen'].includes(r.action) ? r.action : 'prüfen',
        suggested_price: num(r.suggested_price),
        reason: String(r.reason ?? '').slice(0, 240),
      })),
    warnings: (Array.isArray(data.warnings) ? data.warnings : [])
      .filter((w) => known.has(String(w.number)))
      .slice(0, 25)
      .map((w) => ({ number: String(w.number), issue: String(w.issue ?? '').slice(0, 240) })),
  };
  const created = new Date().toISOString();
  const id = db.prepare('INSERT INTO ai_reports(created_at, model, product_count, analysed, result, usage) VALUES (?,?,?,?,?,?)').run(created, cfg.model, ds.total, ds.rows.length, JSON.stringify(clean), JSON.stringify(usage)).lastInsertRowid;
  return { id: Number(id), created_at: created, model: cfg.model, product_count: ds.total, analysed: ds.rows.length, result: clean, usage };
}

export function latestReport(db) {
  const r = db.prepare('SELECT * FROM ai_reports ORDER BY id DESC LIMIT 1').get();
  return r ? { id: r.id, created_at: r.created_at, model: r.model, product_count: r.product_count, analysed: r.analysed, result: JSON.parse(r.result), usage: r.usage ? JSON.parse(r.usage) : null } : null;
}

const VERIFY_SYSTEM = `Du prüfst für einen Preisvergleich, ob ein gefundenes Mitbewerber-Produkt DASSELBE Produkt ist wie unser eigenes.
Maßgeblich sind Marke, Serie/Modell, Maße, Farbe/Oberfläche, Ausführung und Set-Umfang. Abweichende Größe, Farbe, Serie oder Set statt Einzelteil bedeutet: nicht dasselbe.
Wenn die Angaben nicht reichen, setze same=false und confidence niedrig.
Liefere JSON: {"results": [{"id": Zahl, "same": true|false, "confidence": 0..1, "reason": "max. 140 Zeichen"}]}`;

const CONFIDENT = 0.85;

/** Unsichere Zuordnungen ("zu prüfen") von der KI beurteilen lassen und eindeutige Fälle übernehmen. */
export async function verifyReviews(db, cfg, max = 25) {
  const rows = db.prepare(`
    SELECT m.id, m.url, m.title, m.price, p.name, p.manufacturer, p.number, p.ean, p.mpn, c.name AS competitor
    FROM matches m JOIN products p ON p.id=m.product_id JOIN competitors c ON c.id=m.competitor_id
    WHERE m.status='review' AND m.url IS NOT NULL ORDER BY m.id LIMIT ?`).all(max);
  if (!rows.length) return { checked: 0, confirmed: 0, rejected: 0, unclear: 0 };
  const payload = rows.map((r) => ({ id: r.id, own: { name: r.name, brand: r.manufacturer, number: r.number, ean: r.ean, mpn: r.mpn }, competitor_page: { shop: r.competitor, title: r.title, url: r.url } }));
  const { data } = await chatJson(cfg, VERIFY_SYSTEM, { pairs: payload });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const now = new Date().toISOString();
  let confirmed = 0, rejected = 0, unclear = 0;
  for (const v of Array.isArray(data.results) ? data.results : []) {
    const row = byId.get(Number(v.id));
    if (!row) continue;
    const conf = Math.max(0, Math.min(1, Number(v.confidence) || 0));
    const note = `KI (${Math.round(conf * 100)} %): ${v.same ? 'passt' : 'passt nicht'} – ${String(v.reason ?? '').slice(0, 140)}`;
    if (v.same === true && conf >= CONFIDENT) {
      db.prepare("UPDATE matches SET status='ok', ai_note=? WHERE id=?").run(note, row.id);
      confirmed++;
    } else if (v.same === false && conf >= CONFIDENT) {
      db.prepare("UPDATE matches SET url=NULL, price=NULL, title=NULL, status='not_found', source='auto', last_error='Von der KI als anderes Produkt erkannt', ai_note=?, last_checked=? WHERE id=?").run(note, now, row.id);
      rejected++;
    } else {
      db.prepare('UPDATE matches SET ai_note=? WHERE id=?').run(note, row.id);
      unclear++;
    }
  }
  return { checked: rows.length, confirmed, rejected, unclear };
}
