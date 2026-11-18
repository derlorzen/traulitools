import { getSetting, setSetting } from './settings.js';
import { SOURCES, sourceList, source } from './sources/index.js';
import { digits, r2 } from './sources/util.js';

/**
 * Marktquellen über Apify (idealo, später weitere): zu jeder EAN die Angebote anderer Händler.
 *
 * Preisradar ruft diese Seiten nicht selbst ab. Ein Apify-Actor (ein fremder, bezahlter Scraper) liefert die
 * Daten; ein Apify-Token gilt für alle Quellen und liegt verschlüsselt in den Einstellungen. Jede Quelle hat
 * eigenen Actor, eigenes Tageskontingent und eigenes Monatsbudget (Kosten nach dem Tarif des Actors geschätzt).
 * Abgefragt werden nur Artikel, die je Quelle vorgemerkt sind.
 *
 * Einstellungen je Quelle: <key>_actor, <key>_enabled, <key>_country, <key>_per_day, <key>_days, <key>_days_a, <key>_budget.
 */
const API = () => process.env.APIFY_API_BASE || 'https://api.apify.com';
const today = () => new Date().toISOString().slice(0, 10);

export const apifyToken = (db) => getSetting(db, 'apify_token') || process.env.APIFY_TOKEN || '';

export function ownNames(db) {
  const v = getSetting(db, 'market_own_names') || getSetting(db, 'idealo_own_names');
  if (v) return v.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const name = getSetting(db, 'own_name') || process.env.OWN_SHOP_NAME || 'BelKai';
  let host = '';
  try { host = new URL(getSetting(db, 'own_url') || process.env.OWN_SHOP_URL || '').hostname.replace(/^www\./, ''); } catch { /* nur der Name */ }
  return [name, host].filter(Boolean);
}

export function sourceConfig(db, key) {
  const s = source(key);
  if (!s) throw Object.assign(new Error(`Unbekannte Marktquelle: ${key}`), { status: 404 });
  const n = (k, d, lo, hi) => { const raw = getSetting(db, `${key}_${k}`); const v = Number(raw); return raw != null && raw !== '' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const actorId = (getSetting(db, `${key}_actor`) || s.defaultActor).trim().replace('/', '~');
  const country = getSetting(db, `${key}_country`);
  const token = apifyToken(db);
  return {
    key, source: s, token, actorId, actor: s.actors[actorId] ?? s.custom, configured: Boolean(token),
    enabled: getSetting(db, `${key}_enabled`) !== '0',
    country: s.countries?.some(([c]) => c === country) ? country : s.countries?.[0]?.[0] ?? 'de',
    perDay: n('per_day', s.defaults.perDay, 0, 5000), days: n('days', s.defaults.days, 1, 90), daysA: n('days_a', s.defaults.daysA, 1, 60), budget: n('budget', s.defaults.budget, 0, 10000),
    ownNames: ownNames(db),
  };
}
/** Quellen, für die ein Token da ist (für Schalter und Anzeigen in der Oberfläche). */
export const activeSources = (db) => (apifyToken(db) ? sourceList().map((s) => ({ key: s.key, name: s.name, kind: s.kind, canList: Boolean(s.canList), enabled: getSetting(db, `${s.key}_enabled`) !== '0' })) : []);

// ---------- Kosten ----------
export function spendMonth(db, key) {
  return db.prepare("SELECT COALESCE(SUM(usd),0) AS usd, COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(units),0) AS units FROM ext_spend WHERE service=? AND day LIKE ? || '%'").get(key, today().slice(0, 7));
}
export const spendToday = (db, key) => db.prepare('SELECT COALESCE(SUM(units),0) AS units FROM ext_spend WHERE service=? AND day=?').get(key, today()).units;
function addSpend(db, key, { calls = 0, units = 0, usd = 0 }) {
  db.prepare(`INSERT INTO ext_spend(day, service, calls, units, usd) VALUES (?,?,?,?,?)
    ON CONFLICT(day, service) DO UPDATE SET calls=calls+excluded.calls, units=units+excluded.units, usd=usd+excluded.usd`).run(today(), key, calls, units, usd);
}
export const budgetLeft = (db, key) => sourceConfig(db, key).budget - spendMonth(db, key).usd;

// ---------- Apify ----------
async function apify(token, method, path, body, timeoutMs = 60000) {
  const res = await fetch(`${API()}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* unten */ }
  if (!res.ok) {
    const msg = j?.error?.message || j?.message || `HTTP ${res.status}`;
    const hint = res.status === 401 ? ' (Token ungültig)' : res.status === 402 ? ' (Guthaben oder Tarif reicht nicht)' : res.status === 404 ? ' (Actor nicht gefunden: ID prüfen)' : '';
    throw Object.assign(new Error(`Apify: ${msg}${hint}`), { status: res.status });
  }
  return j;
}

/** Token und die Actors aller Quellen prüfen. */
export async function apifyTest(db) {
  const token = apifyToken(db);
  if (!token) throw new Error('Kein Apify-Token eingetragen');
  const me = await apify(token, 'GET', '/v2/users/me');
  const actors = [];
  for (const s of sourceList()) {
    const cfg = sourceConfig(db, s.key);
    const act = await apify(token, 'GET', `/v2/acts/${encodeURIComponent(cfg.actorId)}`).catch((e) => ({ error: e.message }));
    actors.push({ source: s.key, name: s.name, id: cfg.actorId, title: act?.data ? act.data.title ?? act.data.name : null, error: act?.data ? null : act.error });
  }
  return { ok: true, username: me?.data?.username ?? null, plan: me?.data?.plan?.id ?? null, actors };
}

async function runActor(cfg, input) {
  const items = await apify(cfg.token, 'POST', `/v2/acts/${encodeURIComponent(cfg.actorId)}/run-sync-get-dataset-items?timeout=280&clean=true`, input, 300000);
  return Array.isArray(items) ? items : [];
}

// ---------- Zuordnung ----------
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^https?:\/\//, '').replace(/^www\./, '')
  .replace(/\.(de|com|at|eu|net|shop|online)\b.*$/, '').replace(/\b(gmbh|ug|kg|ohg|ag|e\.?k\.?|shop|onlineshop|store|de)\b/g, '').replace(/[^a-z0-9]/g, '');
const hostKey = (u) => { try { return norm(new URL(u).hostname); } catch { return ''; } };
/** Händlernamen einem angelegten Mitbewerber zuordnen (über Name oder Domain). */
export function competitorMatcher(db) {
  const comps = db.prepare('SELECT id, name, base_url FROM competitors').all().map((c) => ({ id: c.id, keys: [norm(c.name), hostKey(c.base_url)].filter((k) => k.length >= 3) }));
  return (shop) => { const k = norm(shop); if (k.length < 3) return null; return comps.find((c) => c.keys.some((x) => x === k || (x.length >= 5 && (k.includes(x) || x.includes(k)))))?.id ?? null; };
}
const ownMatcher = (names) => { const keys = names.map(norm).filter((k) => k.length >= 3); return (shop) => { const k = norm(shop); return keys.some((x) => x === k || (x.length >= 5 && k.includes(x))); }; };

// ---------- Speichern ----------
function save(db, key, productId, ean, res, now, { cfg, compOf }) {
  const delOffers = db.prepare('DELETE FROM market_offers WHERE source=? AND product_id=?');
  if (!res) {
    db.prepare(`INSERT OR REPLACE INTO market_products(source, product_id, ean, checked_at, found, offers) VALUES (?,?,?,?,0,0)`).run(key, productId, ean, now);
    delOffers.run(key, productId);
    return;
  }
  const isOwn = ownMatcher(cfg.ownNames);
  const offers = res.offers.map((o) => ({ ...o, own: isOwn(o.shop) ? 1 : 0, competitor_id: compOf(o.shop) }));
  const others = offers.filter((o) => !o.own);
  const ownIdx = offers.findIndex((o) => o.own);
  const own = ownIdx >= 0 ? offers[ownIdx] : null;
  // nächstes fremdes Angebot über dem eigenen (für „Luft nach oben“)
  const next = own ? others.find((o) => o.total >= own.total) ?? null : null;
  db.prepare(`INSERT OR REPLACE INTO market_products(source, product_id, ean, checked_at, found, ext_id, url, title, offers, min_total, min_shop, own_rank, own_total, next_total) VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?)`)
    .run(key, productId, ean, now, res.ext_id ?? null, res.url ?? null, res.title ?? null, Math.max(res.count ?? 0, offers.length), others[0]?.total ?? null, others[0]?.shop ?? null, ownIdx >= 0 ? ownIdx + 1 : null, own?.total ?? null, next?.total ?? null);
  delOffers.run(key, productId);
  const ins = db.prepare('INSERT INTO market_offers(source, product_id, position, shop, shop_id, price, shipping, total, delivery, marketplace, own, competitor_id, url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  offers.forEach((o, i) => ins.run(key, productId, i + 1, o.shop, o.shop_id, o.price, o.shipping, o.total, o.delivery, o.marketplace, o.own, o.competitor_id, o.url ?? null));
  db.prepare('INSERT OR REPLACE INTO market_history(source, product_id, day, min_total, own_total, offers) VALUES (?,?,?,?,?,?)').run(key, productId, now.slice(0, 10), others[0]?.total ?? null, own?.total ?? null, others.length);
}

/** Eine Gruppe von Artikeln (höchstens Stapelgröße des Actors) bei einer Quelle abgleichen. */
export async function lookupBatch(db, key, products) {
  const cfg = sourceConfig(db, key);
  if (!cfg.configured) throw new Error('Kein Apify-Token eingetragen');
  const list = products.map((p) => ({ ...p, ean: digits(p.ean) })).filter((p) => p.ean.length >= 8 && p.ean.length <= 14);
  if (!list.length) return { found: 0, missing: 0 };
  const items = await runActor(cfg, cfg.actor.input([...new Set(list.map((p) => p.ean))], cfg.country));
  const byEan = new Map();
  for (const it of items) {
    const r = cfg.source.normProduct(it);
    if (!r) continue;
    // ohne EAN im Ergebnis: bei nur einer angefragten EAN eindeutig
    const ean = r.ean || (list.length === 1 ? list[0].ean : '');
    if (!ean) continue;
    const a = byEan.get(ean);
    if (!a || r.offers.length > a.offers.length) byEan.set(ean, r);
  }
  const now = new Date().toISOString();
  const compOf = competitorMatcher(db);
  const strip = (e) => e.replace(/^0+/, '');
  let found = 0;
  for (const p of list) {
    const r = byEan.get(p.ean) ?? [...byEan.entries()].find(([k]) => strip(k) === strip(p.ean))?.[1] ?? null;
    if (r) found++;
    save(db, key, p.id, p.ean, r, now, { cfg, compOf });
  }
  addSpend(db, key, { calls: 1, units: list.length, usd: cfg.actor.cost(1, found) });
  return { found, missing: list.length - found };
}

// ---------- Vormerken je Artikel und Quelle ----------
export function setSelected(db, key, ids, on) {
  source(key) ?? (() => { throw Object.assign(new Error(`Unbekannte Marktquelle: ${key}`), { status: 404 }); })();
  const st = on ? db.prepare('INSERT OR IGNORE INTO market_select(source, product_id) VALUES (?,?)') : db.prepare('DELETE FROM market_select WHERE source=? AND product_id=?');
  db.exec('BEGIN');
  try { for (const id of ids) st.run(key, id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (on) resetTick(key);
  return db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(p.ean IS NULL OR length(p.ean) < 8),0) AS no_ean FROM market_select m JOIN products p ON p.id=m.product_id WHERE m.source=? AND p.active=1`).get(key);
}
export const selectedSources = (db, productId) => db.prepare('SELECT source FROM market_select WHERE product_id=?').all(productId).map((r) => r.source);
export function selectionMap(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT product_id, source FROM market_select').all()) { const a = m.get(r.product_id) ?? []; a.push(r.source); m.set(r.product_id, a); }
  return m;
}

// ---------- Planung ----------
export const jobs = Object.fromEntries(sourceList().map((s) => [s.key, { running: false, stop: false, total: 0, done: 0, found: 0, errors: 0, error: null, startedAt: null, finishedAt: null }]));
/** Fällige Artikel einer Quelle: vorgemerkt, mit EAN, online; Prüf-Stufe A öfter, nicht gefundene nach 30 Tagen erneut. */
export function dueFor(db, key, limit) {
  const cfg = sourceConfig(db, key);
  const now = Date.now();
  return db.prepare(`SELECT p.id, p.ean, p.tier, s.revenue_90, i.checked_at, i.found FROM market_select m JOIN products p ON p.id=m.product_id
      LEFT JOIN product_sales s ON s.product_id=p.id LEFT JOIN market_products i ON i.source=m.source AND i.product_id=p.id
    WHERE m.source=? AND p.active=1 AND p.offline_since IS NULL AND p.ean IS NOT NULL AND length(p.ean) >= 8`).all(key)
    .filter((r) => { if (!r.checked_at) return true; const days = r.found === 0 ? 30 : r.tier === 'A' ? cfg.daysA : cfg.days; return now - Date.parse(r.checked_at) > days * 86400e3 - 3600e3; })
    // nie geprüfte zuerst, dann wichtige Artikel, dann die ältesten
    .sort((a, b) => (a.checked_at ? 1 : 0) - (b.checked_at ? 1 : 0) || (b.tier === 'A') - (a.tier === 'A') || (b.revenue_90 ?? 0) - (a.revenue_90 ?? 0) || String(a.checked_at).localeCompare(String(b.checked_at)))
    .slice(0, limit);
}

/** Abgleich einer Quelle starten. ids: bestimmte Artikel (sofort, ohne Tageskontingent, aber mit Budget). */
export function startJob(db, key, { ids = null, max = null } = {}) {
  const cfg = sourceConfig(db, key);
  const job = jobs[key];
  if (job.running || !cfg.configured) return false;
  if (budgetLeft(db, key) <= 0) { job.error = `Monatsbudget von ${cfg.budget} $ erreicht`; return false; }
  const list = ids?.length
    ? db.prepare(`SELECT id, ean FROM products WHERE id IN (${ids.map(() => '?').join(',')}) AND ean IS NOT NULL AND length(ean) >= 8`).all(...ids)
    : dueFor(db, key, max ?? Math.max(0, cfg.perDay - spendToday(db, key)));
  if (!list.length) return false;
  Object.assign(job, { running: true, stop: false, total: list.length, done: 0, found: 0, errors: 0, error: null, startedAt: new Date().toISOString() });
  const size = cfg.actor.batch;
  (async () => {
    for (let i = 0; i < list.length; i += size) {
      if (job.stop) break;
      if (budgetLeft(db, key) <= 0) { job.error = `Monatsbudget von ${cfg.budget} $ erreicht`; break; }
      const batch = list.slice(i, i + size);
      try {
        const r = await lookupBatch(db, key, batch);
        job.found += r.found;
        setSetting(db, `${key}_error`, '');
      } catch (e) {
        job.errors++;
        job.error = e.message;
        setSetting(db, `${key}_error`, `${new Date().toISOString()}|${e.message}`);
        // Zugang, Guthaben oder Actor falsch: sofort aufhören, nicht weiter Geld oder Zeit verbrennen
        if ([401, 402, 403, 404].includes(e.status) || job.errors >= 3) break;
      }
      job.done += batch.length;
    }
  })().finally(() => { job.running = false; job.finishedAt = new Date().toISOString(); setSetting(db, `${key}_last_run`, job.finishedAt); });
  return true;
}
/** Einen Artikel sofort bei einer Quelle abgleichen und das Ergebnis zurückgeben. */
export async function lookupNow(db, key, productId) {
  const job = jobs[key];
  if (!sourceConfig(db, key).configured) throw Object.assign(new Error('Marktquellen sind nicht eingerichtet (Einstellungen → Preisabfrage → Marktquellen)'), { status: 400 });
  if (job.running) throw Object.assign(new Error(`Ein Abgleich bei ${source(key).name} läuft gerade, bitte kurz warten`), { status: 400 });
  if (!startJob(db, key, { ids: [productId] })) throw Object.assign(new Error(job.error || 'Artikel hat keine gültige EAN'), { status: 400 });
  while (job.running) await new Promise((r) => setTimeout(r, 300));
  if (job.errors) throw Object.assign(new Error(job.error), { status: 400 });
  return productMarket(db, productId);
}

const nextAt = {};
const resetTick = (key) => { nextAt[key] = 0; };
export const resetTicks = () => { for (const k of Object.keys(SOURCES)) nextAt[k] = 0; };
/** Planer: verteilt das Tageskontingent jeder Quelle in kleinen Paketen über den Tag (alle 15 Minuten ein Paket). */
export function marketTick(db) {
  if (!apifyToken(db)) return;
  for (const s of sourceList()) {
    const cfg = sourceConfig(db, s.key);
    if (!cfg.enabled || !cfg.perDay || jobs[s.key].running || Date.now() < (nextAt[s.key] ?? 0)) continue;
    const err = getSetting(db, `${s.key}_error`);
    if (err && Date.now() - Date.parse(err.split('|')[0]) < 3600e3) continue; // nach einem Fehler eine Stunde Pause
    nextAt[s.key] = Date.now() + 15 * 60e3;
    const left = cfg.perDay - spendToday(db, s.key);
    if (left <= 0) continue;
    startJob(db, s.key, { max: Math.min(left, Math.max(cfg.actor.batch, Math.ceil(cfg.perDay / 96))) });
  }
}

// ---------- Auswertung ----------
/** Kennzahlen einer Quelle für einen Artikel. Vergleich mit dem eigenen Angebot dort (inkl. Versand), sonst mit dem Shop-Preis. */
export function sourceView(r) {
  if (!r) return null;
  if (!r.found) return { source: r.source, found: false, checked_at: r.checked_at };
  const own = r.own_total ?? r.own_price ?? null;
  const gap = own != null && r.min_total ? Math.round(((own - r.min_total) / r.min_total) * 1000) / 10 : null;
  const headroom = r.own_rank === 1 && r.next_total && r.own_total ? Math.round(((r.next_total - r.own_total) / r.own_total) * 1000) / 10 : null;
  return {
    source: r.source, found: true, checked_at: r.checked_at, offers: r.offers, min_total: r.min_total, min_shop: r.min_shop, url: r.url,
    own_rank: r.own_rank, own_total: r.own_total, listed: r.own_rank != null, compare: r.own_total != null ? 'source' : 'shop',
    gap_pct: gap, next_total: r.next_total, headroom_pct: headroom,
    kind: gap == null ? 'none' : gap > 0.5 ? 'dearer' : 'cheapest',
  };
}
/** Je Artikel: Kennzahlen aller Quellen und der günstigste Marktpreis über alle Angebots-Quellen. */
function combine(views, sel) {
  const per = Object.fromEntries(views.map((v) => [v.source, v]));
  const found = views.filter((v) => v.found && v.min_total != null && SOURCES[v.source]?.kind === 'offers');
  const best = found.sort((a, b) => a.min_total - b.min_total)[0] ?? null;
  return { per, best, sel: sel ?? [], headroom: views.some((v) => v.headroom_pct >= 5), unlisted: views.some((v) => v.found && SOURCES[v.source]?.canList && !v.listed) };
}
export function marketMap(db, ids = null) {
  const where = ids ? `WHERE i.product_id IN (${ids.map(() => '?').join(',') || 'NULL'})` : '';
  const by = new Map();
  for (const r of db.prepare(`SELECT i.*, p.price AS own_price FROM market_products i JOIN products p ON p.id=i.product_id ${where}`).all(...(ids ?? []))) {
    const a = by.get(r.product_id) ?? [];
    a.push(sourceView(r));
    by.set(r.product_id, a);
  }
  const sel = selectionMap(db);
  const m = new Map();
  for (const [pid, views] of by) m.set(pid, combine(views, sel.get(pid)));
  for (const [pid, s] of sel) if (!m.has(pid)) m.set(pid, combine([], s));
  return m;
}

/** Alles zu einem Artikel: je Quelle Kennzahlen, alle Angebote und Verlauf. */
export function productMarket(db, productId) {
  const sel = selectedSources(db, productId);
  const out = {};
  for (const s of sourceList()) {
    const r = db.prepare('SELECT i.*, p.price AS own_price FROM market_products i JOIN products p ON p.id=i.product_id WHERE i.source=? AND i.product_id=?').get(s.key, productId);
    const base = { key: s.key, name: s.name, kind: s.kind, canList: Boolean(s.canList), selected: sel.includes(s.key) };
    if (!r) { out[s.key] = { ...base, data: null }; continue; }
    const offers = db.prepare(`SELECT o.position, o.shop, o.price, o.shipping, o.total, o.delivery, o.marketplace, o.own, o.competitor_id, o.url, c.name AS competitor
      FROM market_offers o LEFT JOIN competitors c ON c.id=o.competitor_id WHERE o.source=? AND o.product_id=? ORDER BY o.total`).all(s.key, productId);
    const history = db.prepare('SELECT day, min_total, own_total, offers FROM market_history WHERE source=? AND product_id=? ORDER BY day DESC LIMIT 60').all(s.key, productId).reverse();
    out[s.key] = { ...base, data: { ...sourceView(r), ean: r.ean, title: r.title, offers_list: offers, history } };
  }
  return { sources: out, best: combine(Object.values(out).filter((x) => x.data).map((x) => x.data), sel).best };
}

let remapKey = null;
/** Zuordnung Händler → Mitbewerber neu rechnen, wenn sich die Mitbewerber geändert haben (z. B. gerade angelegt). */
export function remapCompetitors(db) {
  const key = db.prepare("SELECT COUNT(*) || ':' || COALESCE(GROUP_CONCAT(name || base_url, '|'), '') AS k FROM competitors").get().k;
  if (key === remapKey) return;
  remapKey = key;
  const of = competitorMatcher(db);
  const up = db.prepare('UPDATE market_offers SET competitor_id=? WHERE shop=?');
  for (const { shop } of db.prepare('SELECT DISTINCT shop FROM market_offers').all()) up.run(of(shop), shop);
}
/** Händler aus den Marktquellen, die noch nicht als Mitbewerber angelegt sind: wie oft dabei, wie oft günstiger als du. */
export function discoveredShops(db, { limit = 50 } = {}) {
  remapCompetitors(db);
  const rows = db.prepare(`SELECT o.shop, MAX(o.marketplace) AS marketplace, GROUP_CONCAT(DISTINCT o.source) AS sources, COUNT(DISTINCT o.product_id) AS products,
      COUNT(DISTINCT CASE WHEN o.total < COALESCE(i.own_total, p.price) - 0.005 THEN o.product_id END) AS cheaper,
      ROUND(AVG((o.total - COALESCE(i.own_total, p.price)) / COALESCE(i.own_total, p.price) * 100), 1) AS avg_gap
    FROM market_offers o JOIN market_products i ON i.source=o.source AND i.product_id=o.product_id JOIN products p ON p.id=o.product_id
    WHERE o.own=0 AND o.competitor_id IS NULL AND p.price > 0 GROUP BY lower(o.shop) ORDER BY cheaper DESC, products DESC LIMIT ?`).all(limit);
  const dismissed = new Set(String(getSetting(db, 'market_dismissed') || '').split('\n').filter(Boolean).map((s) => s.toLowerCase()));
  return rows.filter((r) => !dismissed.has(r.shop.toLowerCase())).map((r) => ({ ...r, sources: String(r.sources ?? '').split(',').filter(Boolean) }));
}
export function dismissShop(db, shop) {
  const set = new Set(String(getSetting(db, 'market_dismissed') || '').split('\n').filter(Boolean));
  set.add(String(shop).trim());
  setSetting(db, 'market_dismissed', [...set].join('\n'));
}

export function sourceOverview(db, key) {
  const cfg = sourceConfig(db, key);
  const st = db.prepare(`SELECT COUNT(*) AS checked, COALESCE(SUM(found),0) AS found, COALESCE(SUM(own_rank IS NOT NULL),0) AS listed, COALESCE(SUM(own_rank=1),0) AS best, MAX(checked_at) AS last FROM market_products WHERE source=?`).get(key);
  const sel = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(p.ean IS NOT NULL AND length(p.ean) >= 8),0) AS with_ean FROM market_select m JOIN products p ON p.id=m.product_id WHERE m.source=? AND p.active=1 AND p.offline_since IS NULL`).get(key);
  let dearer = 0;
  for (const r of db.prepare('SELECT i.*, p.price AS own_price FROM market_products i JOIN products p ON p.id=i.product_id WHERE i.source=? AND i.found=1').all(key)) if (sourceView(r).kind === 'dearer') dearer++;
  const spend = spendMonth(db, key);
  const err = getSetting(db, `${key}_error`);
  return {
    key, name: cfg.source.name, kind: cfg.source.kind, canList: Boolean(cfg.source.canList), configured: cfg.configured, enabled: cfg.enabled,
    actor: { id: cfg.actorId, label: cfg.actor.label, note: cfg.actor.note }, country: cfg.country,
    per_day: cfg.perDay, days: cfg.days, days_a: cfg.daysA, budget: cfg.budget,
    spend: { usd: r2(spend.usd), lookups: spend.units, today: spendToday(db, key) },
    selected: sel.n, with_ean: sel.with_ean, checked: st.checked, found: st.found, listed: st.listed, best: st.best, dearer, last: st.last,
    due: cfg.configured ? dueFor(db, key, 100000).length : null,
    error: err ? { at: err.split('|')[0], message: err.split('|').slice(1).join('|') } : null,
    job: { ...jobs[key] },
  };
}
export const marketOverview = (db) => ({ configured: Boolean(apifyToken(db)), sources: sourceList().map((s) => sourceOverview(db, s.key)) });

/** Einstellungen für die Oberfläche (ohne Token). */
export function marketSettings(db, { hasToken, fromEnv }) {
  return {
    token_set: hasToken, from_env: fromEnv, own_names: ownNames(db).join(', '),
    sources: sourceList().map((s) => {
      const c = sourceConfig(db, s.key);
      return { key: s.key, name: s.name, about: s.about, enabled: c.enabled, actor: c.actorId, default_actor: s.defaultActor,
        actors: Object.entries(s.actors).map(([id, a]) => ({ id, label: a.label, note: a.note, per1000: a.per1000 })),
        countries: s.countries ?? [], country: c.country, per_day: c.perDay, days: c.days, days_a: c.daysA, budget: c.budget };
    }),
  };
}
/** Einstellungen speichern (Werte aus dem Formular, Schlüssel <quelle>_<feld>). */
export function saveMarketSettings(db, b, bad) {
  if (typeof b.market_own_names === 'string') setSetting(db, 'market_own_names', b.market_own_names.trim());
  for (const s of sourceList()) {
    const k = s.key;
    if (typeof b[`${k}_actor`] === 'string') {
      const a = b[`${k}_actor`].trim().replace('/', '~');
      if (a && !/^[\w.-]+~[\w.-]+$/.test(a)) throw bad(`${s.name}: Actor-ID im Format „anbieter~name“ bzw. „anbieter/name“`);
      setSetting(db, `${k}_actor`, a);
      setSetting(db, `${k}_error`, '');
    }
    if (b[`${k}_enabled`] !== undefined) setSetting(db, `${k}_enabled`, [true, 'on', '1', 1].includes(b[`${k}_enabled`]) ? '1' : '0');
    if (b[`${k}_country`] !== undefined && s.countries?.some(([c]) => c === b[`${k}_country`])) setSetting(db, `${k}_country`, b[`${k}_country`]);
    for (const [f, lo, hi, label] of [['per_day', 0, 5000, 'Artikel pro Tag: 0 bis 5000'], ['days', 1, 90, 'Abstand: 1 bis 90 Tage'], ['days_a', 1, 60, 'Abstand Prüf-Stufe A: 1 bis 60 Tage']]) {
      const v = b[`${k}_${f}`];
      if (v === undefined || v === '') continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${s.name}: ${label}`);
      setSetting(db, `${k}_${f}`, String(n));
    }
    const bu = b[`${k}_budget`];
    if (bu !== undefined && bu !== '') {
      const n = Number(String(bu).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 10000) throw bad(`${s.name}: Monatsbudget 0 bis 10000 $`);
      setSetting(db, `${k}_budget`, String(n));
    }
  }
  resetTicks();
}

/**
 * Übernahme aus der ersten idealo-Version (eigene Tabellen und Spalte products.idealo_on) in die gemeinsamen
 * Tabellen der Marktquellen. Einmalig; die alten Tabellen bleiben unverändert liegen.
 */
export function migrateIdealo(db) {
  if (getSetting(db, 'migr_market_idealo') === '1') return;
  const has = (t) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
  db.exec('BEGIN');
  try {
    if (has('idealo_products')) {
      db.exec(`INSERT OR IGNORE INTO market_products(source, product_id, ean, checked_at, found, ext_id, url, title, offers, min_total, min_shop, own_rank, own_total, next_total)
        SELECT 'idealo', product_id, ean, checked_at, found, idealo_id, url, title, offers, min_total, min_shop, own_rank, own_total, next_total FROM idealo_products`);
      db.exec(`INSERT INTO market_offers(source, product_id, position, shop, shop_id, price, shipping, total, delivery, marketplace, own, competitor_id)
        SELECT 'idealo', product_id, position, shop, shop_id, price, shipping, total, delivery, marketplace, own, competitor_id FROM idealo_offers
        WHERE NOT EXISTS (SELECT 1 FROM market_offers m WHERE m.source='idealo' AND m.product_id=idealo_offers.product_id)`);
      db.exec(`INSERT OR IGNORE INTO market_history(source, product_id, day, min_total, own_total, offers) SELECT 'idealo', product_id, day, min_total, own_total, offers FROM idealo_history`);
    }
    const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
    if (cols.includes('idealo_on')) db.exec("INSERT OR IGNORE INTO market_select(source, product_id) SELECT 'idealo', id FROM products WHERE idealo_on=1");
    const d = getSetting(db, 'idealo_dismissed');
    if (d && !getSetting(db, 'market_dismissed')) setSetting(db, 'market_dismissed', d);
    setSetting(db, 'migr_market_idealo', '1');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
