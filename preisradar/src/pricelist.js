/**
 * Preisliste für die Oberfläche: Auswertung je Artikel, Filter, Sortierung und seitenweise Ausgabe.
 * Die Auswertung aller Artikel wird kurz zwischengespeichert, damit das Nachladen beim Scrollen schnell bleibt.
 */
let cache = null; // { key, at, rows }
const TTL = 60000;
export const invalidatePriceList = () => { cache = null; };

function build(db, scope) {
  const comps = db.prepare('SELECT id FROM competitors ORDER BY position, id').all();
  const products = db.prepare(`SELECT * FROM products WHERE active=1 ${scope === 'tracked' ? 'AND tracked=1' : ''}`).all();
  const prev = new Map(db.prepare(`
    SELECT match_id, price FROM (
      SELECT match_id, price, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY at DESC) AS rn FROM price_history
    ) WHERE rn = 2`).all().map((r) => [r.match_id, r.price]));
  const byProduct = new Map();
  for (const m of db.prepare('SELECT * FROM matches').all()) {
    if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, {});
    byProduct.get(m.product_id)[m.competitor_id] = matchView(m, prev.get(m.id));
  }
  const seo = seoMap(db);
  const sales = salesMap(db);
  const mc = mcMap(db);
  return products.map((p) => {
    const matches = byProduct.get(p.id) ?? {};
    return { ...p, matches, seo: seoOf(seo, p.url), sales: sales.get(p.id) ?? null, google: mc.get(mcKey(p.number)) ?? null, a: evaluate(p, comps, matches) };
  });
}

// Suchdaten (Search Console, letzte 28 Tage) je Produktseite
const keyOf = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase(); } catch { return null; } };
const mcKey = (s) => String(s ?? '').trim().toLowerCase();
const mcMap = (db) => new Map(db.prepare('SELECT offer_id, benchmark, suggested, clicks_change, conversions_change FROM mc_products').all().map((r) => [mcKey(r.offer_id).replace(/^online:[a-z]{2}:[a-z]{2}:/, ''), r]));
const salesMap = (db) => new Map(db.prepare('SELECT product_id, units_30, revenue_30, units_90, revenue_90 FROM product_sales').all().map((r) => [r.product_id, r]));
const seoMap = (db) => new Map(db.prepare('SELECT page, clicks, impressions, position FROM seo_pages').all().map((r) => [r.page, r]));
const seoOf = (m, url) => { const r = url ? m.get(keyOf(url)) : null; return r ? { clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 } : null; };

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
};

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Alle Filter außer dem Status-Chip (damit die Chips ihre Anzahl im aktuellen Ausschnitt zeigen). */
function baseFilter(q) {
  const text = String(q.q ?? '').trim().toLowerCase();
  const comp = q.comp ? String(q.comp) : '';
  const minP = num(q.minP), maxP = num(q.maxP), gapMin = num(q.gapMin);
  return (r) => {
    if (q.brand && r.manufacturer !== q.brand) return false;
    if (text && ![r.name, r.number, r.ean, r.mpn, r.manufacturer].some((v) => String(v ?? '').toLowerCase().includes(text))) return false;
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
  const m = /^comp:(\d+)$/.exec(key ?? '');
  if (m) return nullsLast((r) => { const x = r.matches[m[1]]; return x && (x.status === 'ok' || x.status === 'review') ? x.price : null; });
  return byName;
}

export function listProducts(db, q = {}) {
  const counts = db.prepare('SELECT COUNT(*) AS "all", COALESCE(SUM(tracked),0) AS tracked FROM products WHERE active=1').get();
  const scope = q.scope === 'all' || (q.scope !== 'tracked' && !counts.tracked) ? 'all' : 'tracked';
  // Datenstand: ändert sich bei jedem Abruf, Import oder jeder Zuordnung
  const v = db.prepare(`SELECT (SELECT COUNT(*) || ':' || COALESCE(MAX(last_checked),'') || ':' || COALESCE(SUM(LENGTH(COALESCE(url,'')) + LENGTH(status)),0) FROM matches) || '|' ||
    (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at),'') || ':' || COALESCE(SUM(tracked),0) || ':' || COUNT(offline_since) || ':' || COALESCE(SUM(tier='A'),0) || ':' || COALESCE(SUM(tier_pin),0) FROM products) || '|' || (SELECT COUNT(*) FROM competitors) || '|' || (SELECT COUNT(*) || ':' || COALESCE(SUM(impressions),0) FROM seo_pages) || '|' || (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at),'') FROM product_sales) || '|' || (SELECT COUNT(*) || ':' || COALESCE(SUM(benchmark),0) FROM mc_products) AS v`).get().v;
  const key = `${scope}#${v}`;
  if (!cache || cache.key !== key || Date.now() - cache.at > TTL) cache = { key, at: Date.now(), rows: build(db, scope) };
  const all = cache.rows;
  const base = all.filter(baseFilter(q));
  const chips = Object.fromEntries(Object.entries(CHIPS).map(([k, f]) => [k, base.filter(f).length]));
  const chip = CHIPS[q.filter] ?? CHIPS.all;
  const rows = base.filter(chip).sort(sorter(q.sort, q.dir));
  const offset = Math.max(0, Math.floor(num(q.offset) ?? 0));
  const limit = Math.min(500, Math.max(1, Math.floor(num(q.limit) ?? 100)));
  const brands = [...new Set(all.map((r) => r.manufacturer).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  return { scope, counts, total: rows.length, inScope: all.length, chips, brands, offset, rows: rows.slice(offset, offset + limit), ids: q.ids ? rows.map((r) => r.id) : undefined };
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
  return { ...p, matches, seo: seoOf(seoMap(db), p.url), sales: salesMap(db).get(p.id) ?? null, google: mcMap(db).get(mcKey(p.number)) ?? null, a: evaluate(p, comps, matches) };
}
