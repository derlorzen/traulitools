/**
 * Preisliste für die Oberfläche: Auswertung je Artikel, Filter, Sortierung und seitenweise Ausgabe.
 * Die Auswertung aller Artikel wird kurz zwischengespeichert, damit das Nachladen beim Scrollen schnell bleibt.
 */
import { auditFlags } from './seoaudit.js';

/*
 * Zwischenspeicher je Ausschnitt (beobachtet / alle), gültig solange sich der Datenstand nicht ändert.
 * Ein Hintergrund-Wärmer rechnet nach Änderungen (z. B. während ein Abruf läuft) alle paar Sekunden vor,
 * damit das Öffnen der Preisliste meist ohne Neuberechnung auskommt.
 */
const caches = new Map(); // scope -> { key, at, rows }
const TTL = 10 * 60000;
export const invalidatePriceList = () => { caches.clear(); };
const lastUsed = new Map(); // scope -> Zeitpunkt der letzten Abfrage durch die Oberfläche
function rowsFor(db, scope, key, { warm = false } = {}) {
  if (!warm) lastUsed.set(scope, Date.now());
  const c = caches.get(scope);
  if (c && c.key === key && Date.now() - c.at <= TTL) return c.rows;
  const rows = build(db, scope);
  caches.set(scope, { key, at: Date.now(), rows });
  return rows;
}
/**
 * Preisliste im Hintergrund aktuell halten: beim Start beide Ausschnitte, danach alle 20 Sekunden nur die, die in den
 * letzten 10 Minuten benutzt wurden (spart Rechenzeit, wenn niemand hinschaut).
 */
export function warmPriceList(db) {
  const tick = (first = false) => {
    try {
      const key = dataVersion(db);
      for (const scope of ['tracked', 'all']) if (first || Date.now() - (lastUsed.get(scope) ?? 0) < 10 * 60000) rowsFor(db, scope, key, { warm: true });
    } catch (e) { console.error('Preisliste vorbereiten:', e.message); }
  };
  tick(true);
  return setInterval(tick, 20000);
}

function build(db, scope) {
  const comps = db.prepare('SELECT id FROM competitors ORDER BY position, id').all();
  const products = db.prepare(`SELECT * FROM products WHERE active=1 ${scope === 'tracked' ? 'AND tracked=1' : ''}`).all();
  const byProduct = new Map();
  for (const m of db.prepare('SELECT id, product_id, competitor_id, status, price, url, title, availability, last_checked, last_error, source, ai_note, prev_price FROM matches').all()) {
    if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, {});
    byProduct.get(m.product_id)[m.competitor_id] = matchView(m, m.prev_price);
  }
  const seo = seoMap(db);
  const sales = salesMap(db);
  const mc = mcMap(db);
  const qs = queriesMap(db);
  const audit = auditFlags(db);
  return products.map((p) => {
    const matches = byProduct.get(p.id) ?? {};
    const page = p.url ? keyOf(p.url) : null;
    const queries = page ? qs.get(page) ?? [] : [];
    const r = { ...p, matches, seo: seoOf(seo, p.url), sales: sales.get(p.id) ?? null, google: mc.get(mcKey(p.number)) ?? null, a: evaluate(p, comps, matches), audit: audit.get(p.id) ?? null };
    if (r.seo && queries.length) r.seo.top = { query: queries[0].query, position: Math.round(queries[0].position * 10) / 10 };
    r.g = googleSignals(r);
    Object.defineProperty(r, 'qtext', { value: queries.map((q) => q.query.toLowerCase()), enumerable: false });
    return r;
  });
}

// Übliche Klickrate je Google-Position (Erfahrungswerte für organische Treffer im Onlinehandel, grob gerundet)
const CTR_CURVE = [0.2, 0.12, 0.08, 0.06, 0.045, 0.035, 0.028, 0.022, 0.018, 0.015]; // vorsichtig, weil Shopping-Anzeigen Klicks abziehen
export const expectedCtr = (pos) => (pos == null ? null : pos <= 10 ? CTR_CURVE[Math.max(0, Math.round(pos) - 1)] : pos <= 20 ? 0.01 : 0.003);
export const G = { demand: 100, lowCtrImp: 200 };

/**
 * Google-Signale eines Artikels: Klickpotenzial und was zu tun ist.
 * Klickpotenzial = zusätzliche Klicks in 28 Tagen, wenn die Seite unter die ersten drei käme (bzw. auf Platz 1–3
 * so oft geklickt würde wie dort üblich).
 */
export function googleSignals(r) {
  const s = r.seo, g = r.google, a = r.a;
  const out = { potential: 0, expected: null, flags: [], advice: [] };
  const bench = g?.benchmark && r.price ? Math.round(((r.price - g.benchmark) / g.benchmark) * 1000) / 10 : null;
  out.bench = bench;
  if (s) {
    const exp = expectedCtr(s.position);
    out.expected = exp;
    const ctr = s.impressions ? s.clicks / s.impressions : 0;
    const target = s.position > 3 ? expectedCtr(3) : exp;
    out.potential = Math.max(0, Math.round(s.impressions * target - s.clicks));
    if (s.impressions >= G.demand) out.flags.push('demand');
    if (s.position > 3 && s.position <= 20 && s.impressions >= 50) out.flags.push('striking');
    if (s.impressions >= G.lowCtrImp && ctr < exp * 0.5) out.flags.push('lowCtr');
  } else if (r.url) out.flags.push('invisible');
  if (bench != null && bench > 2) out.flags.push('aboveBench');
  if (g?.suggested && r.price && Math.abs(g.suggested - r.price) >= 0.01) out.flags.push('suggest');
  if (out.flags.includes('demand') && a.kind === 'undercut') out.flags.push('demandDear');
  if (r.sales?.units_90 > 0 && (!s || s.impressions < 20)) out.flags.push('soldHidden');
  // Hinweise in der Reihenfolge, in der sie am meisten bringen
  const dearer = a.kind === 'undercut';
  if (out.flags.includes('demand') && (dearer || (bench != null && bench > 2))) out.advice.push({ kind: 'price', text: dearer ? `Preis prüfen: gefragt, aber ${a.gapPct != null ? `${String(a.gapPct).replace('.', ',')} %` : ''} teurer als der günstigste Mitbewerber` : `Preis prüfen: gefragt, aber ${String(bench).replace('.', ',')} % über dem Google-Vergleichspreis` });
  else if (bench != null && bench > 2) out.advice.push({ kind: 'price', text: `${String(bench).replace('.', ',')} % über dem Google-Vergleichspreis` });
  if (out.flags.includes('lowCtr')) out.advice.push({ kind: 'snippet', text: `Wenig geklickt für Platz ${String(Math.round(s.position * 10) / 10).replace('.', ',')}: Titel, Beschreibung und Preisanzeige bei Google prüfen` });
  if (out.flags.includes('striking')) out.advice.push({ kind: 'content', text: s.position <= 10 ? `Platz ${String(Math.round(s.position * 10) / 10).replace('.', ',')}: mit besserer Produktseite in die Top 3` : `Platz ${String(Math.round(s.position * 10) / 10).replace('.', ',')}: knapp hinter Seite 1, Seite stärken` });
  if (out.flags.includes('soldHidden')) out.advice.push({ kind: 'content', text: 'Verkauft sich, wird bei Google aber kaum gefunden' });
  if (r.audit?.errors) { out.flags.push('seoErrors'); out.advice.push({ kind: 'snippet', text: `${r.audit.errors} SEO-Fehler auf der Seite (Seiten-Check)` }); }
  if (out.flags.includes('suggest')) out.advice.push({ kind: 'price', text: `Google schlägt ${g.suggested.toFixed(2).replace('.', ',')} € vor` });
  return out;
}
const queriesMap = (db) => {
  const m = new Map();
  for (const q of db.prepare('SELECT page, query, clicks, impressions, position FROM seo_queries ORDER BY clicks DESC, impressions DESC').all()) {
    if (!m.has(q.page)) m.set(q.page, []);
    m.get(q.page).push(q);
  }
  return m;
};

// Suchdaten (Search Console, letzte 28 Tage) je Produktseite
const keyOf = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase(); } catch { return null; } };
const mcKey = (s) => String(s ?? '').trim().toLowerCase();
const mcMap = (db) => new Map(db.prepare('SELECT offer_id, benchmark, suggested, clicks_change, conversions_change FROM mc_products').all().map((r) => [mcKey(r.offer_id).replace(/^online:[a-z]{2}:[a-z]{2}:/, ''), r]));
const salesMap = (db) => new Map(db.prepare('SELECT product_id, units_30, revenue_30, units_90, revenue_90 FROM product_sales').all().map((r) => [r.product_id, r]));
const seoMap = (db) => new Map(db.prepare('SELECT page, clicks, impressions, position FROM seo_pages').all().map((r) => [r.page, r]));
const seoOf = (m, url) => { const r = url ? m.get(keyOf(url)) : null; return r ? { clicks: r.clicks, impressions: r.impressions, ctr: r.impressions ? r.clicks / r.impressions : 0, position: Math.round(r.position * 10) / 10 } : null; };

export function matchView(m, previous = null) {
  return {
    id: m.id, status: m.status, price: m.price, url: m.url, title: m.title, availability: m.availability,
    checked: m.last_checked, error: m.last_error, source: m.source, previous: previous ?? null, ai_note: m.ai_note,
  };
}

/** Gleiche Logik wie bisher in der Oberfläche: Position zum günstigsten bestätigten Preis. */
export function evaluate(p, comps, matches) {
  const ms = comps.map((c) => matches[c.id]).filter(Boolean);
  const ok = ms.filter((m) => m.status === 'ok' && m.price != null);
  const min = ok.length ? Math.min(...ok.map((m) => m.price)) : null;
  let kind = 'none';
  if (min != null && p.price != null) kind = p.price <= min ? 'cheapest' : 'undercut';
  const gap = min != null && p.price != null ? Math.round((p.price - min) * 100) / 100 : null;
  return {
    kind, min, gap, gapPct: gap != null && min ? Math.round((gap / min) * 1000) / 10 : null,
    review: ms.some((m) => m.status === 'review'),
    equal: kind === 'cheapest' && Math.abs(p.price - min) < 0.005,
    moved: ok.some((m) => m.previous != null && m.previous !== m.price),
    problem: ms.some((m) => ['error', 'blocked'].includes(m.status)),
    notFound: ms.some((m) => m.status === 'not_found'),
    oos: ok.some((m) => m.availability === 'out_of_stock'),
    offline: Boolean(p.offline_since),
  };
}

const CHIPS = {
  all: () => true,
  undercut: (r) => r.a.kind === 'undercut',
  cheapest: (r) => r.a.kind === 'cheapest',
  none: (r) => r.a.kind === 'none',
  review: (r) => r.a.review,
  equal: (r) => r.a.equal,
  moved: (r) => r.a.moved,
  problem: (r) => r.a.problem,
  notFound: (r) => r.a.notFound,
  oos: (r) => r.a.oos,
  offline: (r) => r.a.offline,
  tierA: (r) => r.tier === 'A',
  // Google (Search Console und Merchant Center)
  gDemand: (r) => r.g.flags.includes('demand'),
  gDemandDear: (r) => r.g.flags.includes('demandDear'),
  gStriking: (r) => r.g.flags.includes('striking'),
  gLowCtr: (r) => r.g.flags.includes('lowCtr'),
  gAboveBench: (r) => r.g.flags.includes('aboveBench'),
  gSuggest: (r) => r.g.flags.includes('suggest'),
  gSoldHidden: (r) => r.g.flags.includes('soldHidden'),
  gInvisible: (r) => r.g.flags.includes('invisible'),
  gAdvice: (r) => r.g.advice.length > 0,
  gSeo: (r) => r.g.flags.includes('seoErrors'),
};

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Alle Filter außer dem Status-Chip (damit die Chips ihre Anzahl im aktuellen Ausschnitt zeigen). */
function baseFilter(q) {
  const text = String(q.q ?? '').trim().toLowerCase();
  const comp = q.comp ? String(q.comp) : '';
  const minP = num(q.minP), maxP = num(q.maxP), gapMin = num(q.gapMin), impMin = num(q.impMin), posMax = num(q.posMax);
  const words = text.split(/\s+/).filter(Boolean);
  return (r) => {
    if (q.brand && r.manufacturer !== q.brand) return false;
    if (text && ![r.name, r.number, r.ean, r.mpn, r.manufacturer].some((v) => String(v ?? '').toLowerCase().includes(text))) {
      // auch über Google-Suchanfragen finden, mit denen die Produktseite gefunden wird (alle Wörter müssen vorkommen)
      const hit = words.length && r.qtext.find((x) => words.every((w) => x.includes(w)));
      if (!hit) return false;
    }
    if (impMin != null && !((r.seo?.impressions ?? 0) >= impMin)) return false;
    if (posMax != null && !(r.seo && r.seo.position <= posMax)) return false;
    if (comp) { const m = r.matches[comp]; if (!(m && m.status === 'ok' && m.price != null && r.price != null && m.price < r.price)) return false; }
    if (q.status && !Object.values(r.matches).some((m) => m.status === q.status)) return false;
    if (minP != null && !(r.price >= minP)) return false;
    if (maxP != null && !(r.price <= maxP)) return false;
    if (gapMin != null && !(r.a.gapPct != null && r.a.gapPct >= gapMin)) return false;
    return true;
  };
}

function sorter(key, dir) {
  const d = dir === 'desc' ? -1 : 1;
  const nullsLast = (get) => (x, y) => {
    const a = get(x), b = get(y);
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (a < b ? -1 : a > b ? 1 : 0) * d;
  };
  const byName = (x, y) => (x.manufacturer ?? '').localeCompare(y.manufacturer ?? '', 'de') || x.name.localeCompare(y.name, 'de');
  if (key === 'name') return (x, y) => byName(x, y) * d;
  if (key === 'number') return (x, y) => String(x.number).localeCompare(String(y.number), 'de', { numeric: true }) * d;
  if (key === 'price') return nullsLast((r) => r.price);
  if (key === 'gap') return nullsLast((r) => r.a.gap);
  if (key === 'gappct') return nullsLast((r) => r.a.gapPct);
  if (key === 'cheapest') return nullsLast((r) => r.a.min);
  if (key === 'updated') return nullsLast((r) => r.updated_at);
  if (key === 'units') return nullsLast((r) => r.sales?.units_30 ?? null);
  if (key === 'revenue') return nullsLast((r) => r.sales?.revenue_90 ?? null);
  if (key === 'margin') return nullsLast((r) => (r.purchase_price > 0 && r.price ? (r.price / (1 + (r.tax_rate ?? 19) / 100) - r.purchase_price) / (r.price / (1 + (r.tax_rate ?? 19) / 100)) : null));
  if (key === 'benchmark') return nullsLast((r) => (r.google?.benchmark && r.price ? (r.price - r.google.benchmark) / r.google.benchmark : null));
  if (key === 'impressions') return nullsLast((r) => r.seo?.impressions ?? null);
  if (key === 'clicks') return nullsLast((r) => r.seo?.clicks ?? null);
  if (key === 'potential') return nullsLast((r) => (r.seo ? r.g.potential : null));
  if (key === 'position') return nullsLast((r) => r.seo?.position ?? null);
  if (key === 'ctr') return nullsLast((r) => r.seo?.ctr ?? null);
  if (key === 'query') return nullsLast((r) => r.seo?.top?.query ?? null);
  const m = /^comp:(\d+)$/.exec(key ?? '');
  if (m) return nullsLast((r) => { const x = r.matches[m[1]]; return x && (x.status === 'ok' || x.status === 'review') ? x.price : null; });
  return byName;
}

// Datenstand: ändert sich bei jedem Abruf, Import oder jeder Zuordnung
const dataVersion = (db) => db.prepare(`SELECT (SELECT COUNT(*) || ':' || COALESCE(MAX(last_checked),'') || ':' || COALESCE(SUM(LENGTH(COALESCE(url,'')) + LENGTH(status)),0) FROM matches) || '|' ||
    (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at),'') || ':' || COALESCE(SUM(tracked),0) || ':' || COUNT(offline_since) || ':' || COALESCE(SUM(tier='A'),0) || ':' || COALESCE(SUM(tier_pin),0) FROM products) || '|' || (SELECT COUNT(*) FROM competitors) || '|' || (SELECT COUNT(*) || ':' || COALESCE(SUM(impressions),0) FROM seo_pages) || '|' || (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at),'') FROM product_sales) || '|' || (SELECT COUNT(*) || ':' || COALESCE(SUM(benchmark),0) FROM mc_products) || '|' || (SELECT COUNT(*) || ':' || COALESCE(MAX(checked_at),'') FROM seo_audit) AS v`).get().v;

export function listProducts(db, q = {}) {
  const counts = db.prepare('SELECT COUNT(*) AS "all", COALESCE(SUM(tracked),0) AS tracked FROM products WHERE active=1').get();
  const scope = q.scope === 'all' || (q.scope !== 'tracked' && !counts.tracked) ? 'all' : 'tracked';
  const all = rowsFor(db, scope, dataVersion(db));
  const base = all.filter(baseFilter(q));
  const chips = Object.fromEntries(Object.entries(CHIPS).map(([k, f]) => [k, base.filter(f).length]));
  const chip = CHIPS[q.filter] ?? CHIPS.all;
  const rows = base.filter(chip).sort(sorter(q.sort, q.dir));
  const offset = Math.max(0, Math.floor(num(q.offset) ?? 0));
  const limit = Math.min(500, Math.max(1, Math.floor(num(q.limit) ?? 100)));
  const brands = [...new Set(all.map((r) => r.manufacturer).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const text = String(q.q ?? '').trim().toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const out = rows.slice(offset, offset + limit).map((r) => {
    if (!text || [r.name, r.number, r.ean, r.mpn, r.manufacturer].some((v) => String(v ?? '').toLowerCase().includes(text))) return r;
    return { ...r, hit: r.qtext.find((x) => words.every((w) => x.includes(w))) ?? null };
  });
  return { scope, counts, total: rows.length, inScope: all.length, chips, brands, offset, rows: out, ids: q.ids ? rows.map((r) => r.id) : undefined };
}

export function getProduct(db, id) {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!p) return null;
  const comps = db.prepare('SELECT id FROM competitors ORDER BY position, id').all();
  const matches = {};
  for (const m of db.prepare('SELECT * FROM matches WHERE product_id=?').all(id)) {
    const prev = db.prepare('SELECT price FROM price_history WHERE match_id=? ORDER BY at DESC LIMIT 1 OFFSET 1').get(m.id);
    matches[m.competitor_id] = matchView(m, prev?.price);
  }
  const r = { ...p, matches, seo: seoOf(seoMap(db), p.url), sales: salesMap(db).get(p.id) ?? null, google: mcMap(db).get(mcKey(p.number)) ?? null, a: evaluate(p, comps, matches), audit: auditFlags(db).get(p.id) ?? null };
  const q = r.seo ? db.prepare('SELECT query, position FROM seo_queries WHERE page=? ORDER BY clicks DESC, impressions DESC LIMIT 1').get(keyOf(p.url)) : null;
  if (q) r.seo.top = { query: q.query, position: Math.round(q.position * 10) / 10 };
  r.g = googleSignals(r);
  return r;
}
