import { pageKey } from './gsc.js';
import { ISSUES } from './seoaudit.js';

/**
 * Gemeinsamer Blick auf einen Artikel über alle Bereiche hinweg: Preislage, Verkäufe, Google (Search Console,
 * Merchant Center), Seiten-Check, Keywords, eBay und Prüf-Stufe. Jede Liste im Tool zeigt damit dieselben
 * Signale, und ein Klick führt immer in dieselbe Detailansicht.
 */
export function productSignals(db, ids = null) {
  const where = ids ? `WHERE p.id IN (${ids.map(() => '?').join(',') || 'NULL'})` : 'WHERE p.active=1';
  const prods = db.prepare(`SELECT p.id, p.url, p.price, p.number, p.tier, p.tier_pin, p.stock, p.offline_since, s.units_90, s.units_30 FROM products p LEFT JOIN product_sales s ON s.product_id=p.id ${where}`).all(...(ids ?? []));
  if (!prods.length) return new Map();
  const want = new Set(prods.map((p) => p.id));
  const minBy = new Map();
  const idList = ids ? `AND m.product_id IN (${ids.map(() => '?').join(',') || 'NULL'})` : '';
  for (const m of db.prepare(`SELECT m.product_id, m.price, m.availability, c.name FROM matches m JOIN competitors c ON c.id=m.competitor_id
    WHERE c.enabled=1 AND m.status='ok' AND m.price IS NOT NULL ${idList}`).all(...(ids ?? []))) {
    if (!want.has(m.product_id)) continue;
    const cur = minBy.get(m.product_id) ?? { min: null, name: null, n: 0, oos: 0 };
    cur.n++;
    if (m.availability === 'out_of_stock') cur.oos++;
    else if (cur.min == null || m.price < cur.min) { cur.min = m.price; cur.name = m.name; }
    minBy.set(m.product_id, cur);
  }
  const gsc = new Map(db.prepare('SELECT page, clicks, impressions, position FROM seo_pages').all().map((r) => [r.page, r]));
  const audit = new Map();
  for (const a of db.prepare(`SELECT product_id, issues, checked_at FROM seo_audit ${ids ? `WHERE product_id IN (${ids.map(() => '?').join(',') || 'NULL'})` : ''}`).all(...(ids ?? []))) {
    if (!want.has(a.product_id)) continue;
    const list = JSON.parse(a.issues || '[]');
    const errs = list.filter((i) => ISSUES[i.code]?.sev === 'error');
    audit.set(a.product_id, { errors: errs.length, warns: list.filter((i) => ISSUES[i.code]?.sev === 'warn').length, top: (errs[0] ?? list[0]) ? ISSUES[(errs[0] ?? list[0]).code]?.label : null, checked_at: a.checked_at });
  }
  // Keywords, mit denen die Produktseite rankt (Keyword-Monitoring)
  const kwByPage = new Map();
  for (const k of db.prepare('SELECT keyword, position, url FROM keywords WHERE url IS NOT NULL AND position IS NOT NULL').all()) {
    const key = pageKey(k.url);
    const cur = kwByPage.get(key) ?? { count: 0, best: null, best_keyword: null };
    cur.count++;
    if (cur.best == null || k.position < cur.best) { cur.best = k.position; cur.best_keyword = k.keyword; }
    kwByPage.set(key, cur);
  }
  const ebay = new Map();
  for (const l of db.prepare("SELECT product_id, price, created_by_us, jtl_state FROM ebay_listings WHERE status='active' AND product_id IS NOT NULL").all()) if (want.has(l.product_id)) ebay.set(l.product_id, l);
  const ebayMkt = new Map();
  for (const m of db.prepare('SELECT product_id, min_total, offers FROM ebay_market').all()) if (want.has(m.product_id)) ebayMkt.set(m.product_id, m);

  const out = new Map();
  for (const p of prods) {
    const c = minBy.get(p.id);
    const g = p.url ? gsc.get(pageKey(p.url)) : null;
    const l = ebay.get(p.id), em = ebayMkt.get(p.id);
    const gap = c?.min != null && p.price != null ? Math.round(((p.price - c.min) / c.min) * 1000) / 10 : null;
    out.set(p.id, {
      price: c ? { min: c.min, competitor: c.name, gap_pct: gap, offers: c.n, oos: c.oos, kind: gap == null ? 'none' : gap <= 0 ? 'cheapest' : 'undercut' } : null,
      sales: p.units_90 ? { units_90: p.units_90, units_30: p.units_30 ?? 0 } : null,
      stock: p.stock ?? null,
      tier: p.tier ?? null, pinned: Boolean(p.tier_pin),
      gsc: g ? { impressions: g.impressions, clicks: g.clicks, position: Math.round(g.position * 10) / 10 } : null,
      audit: audit.get(p.id) ?? null,
      keywords: p.url ? kwByPage.get(pageKey(p.url)) ?? null : null,
      ebay: l || em ? { listed: Boolean(l), price: l?.price ?? null, pending_jtl: Boolean(l?.created_by_us && l.jtl_state === 'pending'), market_min: em?.min_total ?? null, offers: em?.offers ?? null } : null,
      offline: Boolean(p.offline_since),
    });
  }
  return out;
}

/** Signale an Zeilen hängen (Feld `sig`), über ein Feld mit der Artikel-ID. */
export function withSignals(db, rows, idField = 'id') {
  const ids = [...new Set(rows.map((r) => r[idField]).filter((v) => Number.isInteger(v)))];
  if (!ids.length) return rows;
  const s = productSignals(db, ids);
  return rows.map((r) => (s.has(r[idField]) ? { ...r, sig: s.get(r[idField]) } : r));
}
