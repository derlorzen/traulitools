import { getSetting } from './settings.js';
import { shopwareConfig } from './shopware.js';
import { adsConfig, adsSummary } from './ads.js';
import { ebayConfig } from './ebay.js';
import { ebayCheck } from './opportunities.js';
import { marketOverview } from './market.js';
import { merchantConfig } from './merchant.js';

/**
 * Übersicht (Startseite): was gestern passiert ist, wie die Kanäle stehen, die wichtigsten Chancen, Umsatz und
 * Werbung im Zeitraum mit Vergleich und Verlauf, Rückblick auf die letzte Woche. Alles aus vorhandenen Daten.
 */
const r2 = (v) => Math.round(v * 100) / 100;
const day = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return day(d); };
const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/** Kalendertag in Berlin (Bestellungen und Werbung zählen nach deutschem Datum). */
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());

function series(db, from, to) {
  const shop = new Map(db.prepare('SELECT * FROM shop_daily WHERE day BETWEEN ? AND ?').all(from, to).map((r) => [r.day, r]));
  const ads = new Map(db.prepare('SELECT * FROM ads_daily WHERE day BETWEEN ? AND ?').all(from, to).map((r) => [r.day, r]));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const s = shop.get(d), a = ads.get(d);
    out.push({ day: d, revenue: s?.revenue ?? 0, orders: s?.orders ?? 0, units: s?.units ?? 0, profit: s?.profit ?? 0, profit_base: s?.profit_base ?? 0, ads_cost: a?.cost ?? 0, ads_value: a?.value ?? 0, ads_clicks: a?.clicks ?? 0 });
  }
  return out;
}
const sum = (rows, k) => r2(rows.reduce((a, r) => a + (r[k] ?? 0), 0));
function totals(rows) {
  const revenue = sum(rows, 'revenue'), profit = sum(rows, 'profit'), base = sum(rows, 'profit_base'), cost = sum(rows, 'ads_cost'), value = sum(rows, 'ads_value');
  // Gewinn für Umsatz ohne Einkaufspreis hochrechnen (gleiche Marge wie beim bekannten Teil), sonst wäre er zu niedrig
  const grossProfit = base > 0 ? r2(profit * (revenue / base)) : null;
  return {
    revenue, orders: sum(rows, 'orders'), units: sum(rows, 'units'), ads_cost: cost, ads_value: value,
    gross_profit: grossProfit, profit_after_ads: grossProfit != null ? r2(grossProfit - cost) : null,
    profit_coverage: revenue > 0 ? Math.round((base / revenue) * 100) : null,
  };
}

export function dashboard(db, { user = null, opportunities = null } = {}) {
  const t = today();
  const yesterday = addDays(t, -1);
  const sw = shopwareConfig(db).configured, ads = adsConfig(db).configured;

  // Zeiträume: 7 und 30 Tage bis gestern, jeweils mit dem Zeitraum davor; Verlauf 12 Wochen (Wochensummen)
  const period = (n) => {
    const to = yesterday, from = addDays(to, -(n - 1));
    const cur = totals(series(db, from, to)), prev = totals(series(db, addDays(from, -n), addDays(from, -1)));
    const weeks = [];
    for (let w = 11; w >= 0; w--) { const end = addDays(to, -7 * w); weeks.push(totals(series(db, addDays(end, -6), end))); }
    const delta = {};
    for (const k of ['revenue', 'ads_value', 'ads_cost', 'profit_after_ads', 'orders']) delta[k] = cur[k] != null && prev[k] != null ? pct(cur[k], prev[k]) : null;
    return { from, to, cur, prev, delta, weeks: weeks.map((w) => ({ revenue: w.revenue, ads_value: w.ads_value, ads_cost: w.ads_cost, profit_after_ads: w.profit_after_ads })) };
  };
  const p7 = period(7), p30 = period(30);

  // Gestern im Vergleich zum gleichen Wochentag der Vorwoche
  const y = series(db, yesterday, yesterday)[0], lw = series(db, addDays(yesterday, -7), addDays(yesterday, -7))[0];

  // Werbekosten-Anteil: von 100 € Umsatz über Werbung so viel für Werbung; Grenze = Rohertrags-Anteil (darüber Verlust)
  const c30 = p30.cur;
  const adShare = c30.ads_value > 0 ? r2((c30.ads_cost / c30.ads_value) * 100) : null;
  const breakEven = c30.revenue > 0 && c30.gross_profit != null ? r2((c30.gross_profit / c30.revenue) * 100) : null;

  // Kanäle
  const prod = db.prepare(`SELECT COUNT(*) AS all_n, COALESCE(SUM(offline_since IS NULL),0) AS online, COALESCE(SUM(offline_since IS NOT NULL),0) AS offline,
    COALESCE(SUM(offline_since IS NULL AND stock = 0),0) AS no_stock, COALESCE(SUM(tracked),0) AS tracked FROM products WHERE active=1`).get();
  const channels = [{ key: 'shop', name: 'Shop', connected: sw, main: prod.online, main_label: 'online', sub: [prod.offline ? `${prod.offline} offline` : null, prod.no_stock ? `${prod.no_stock} ohne Bestand` : null].filter(Boolean).join(' · ') || 'alle online', warn: Boolean(prod.offline), share: prod.all_n ? prod.online / prod.all_n : null, tab: 'preise' }];
  const eb = ebayConfig(db);
  const ec = ebayCheck(db, { limit: 1 });
  channels.push(eb.connected
    ? { key: 'ebay', name: 'eBay', connected: true, main: ec.active, main_label: 'Angebote', sub: ec.missing.count ? `${ec.missing.count} fehlen${ec.dearer.count ? ` · ${ec.dearer.count} teurer als der Günstigste` : ''}` : 'nichts fehlt', warn: Boolean(ec.missing.count || ec.dearer.count), share: ec.active + ec.missing.count ? ec.active / (ec.active + ec.missing.count) : null, tab: 'ebay' }
    : { key: 'ebay', name: 'eBay', connected: false, main: ec.missing.count, main_label: 'fehlen vermutlich', sub: 'nicht verbunden', warn: false, share: null, tab: 'ebay' });
  if (ads) {
    const s = adsSummary(db);
    channels.push({ key: 'ads', name: 'Google Ads', connected: true, main: s.products.matched, main_label: 'beworben', sub: s.products.loss ? `${s.products.loss} mit Verlust` : s.synced_at ? 'keiner mit Verlust' : 'Abgleich steht aus', warn: Boolean(s.products.loss), share: null, tab: 'sichtbarkeit' });
  } else channels.push({ key: 'ads', name: 'Google Ads', connected: false, main: null, main_label: '', sub: 'nicht verbunden', warn: false, share: null, tab: 'einstellungen' });
  const mk = marketOverview(db);
  for (const s of mk.sources.filter((x) => mk.configured && (x.enabled || x.selected))) {
    channels.push({ key: s.key, name: s.name, connected: mk.configured, main: s.listed, main_label: 'gelistet', sub: [`${s.selected} vorgemerkt`, s.dearer ? `${s.dearer} teurer` : null].filter(Boolean).join(' · '), warn: Boolean(s.dearer), share: s.found ? s.listed / s.found : null, tab: 'preise' });
  }
  if (merchantConfig(db).configured) {
    const mc = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(benchmark IS NOT NULL),0) AS b FROM mc_products').get();
    channels.push({ key: 'shopping', name: 'Google Shopping', connected: true, main: mc.n, main_label: 'Produkte', sub: `${mc.b} mit Vergleichspreis`, warn: false, share: null, tab: 'sichtbarkeit' });
  }

  // Chancen
  const o = opportunities;
  const opp = o ? { total: o.items.length, top: o.items[0] ? { type: o.items[0].type, label: o.items[0].label, name: o.items[0].name, detail: o.items[0].detail, product_id: o.items[0].product_id } : null,
    groups: Object.entries(o.counts).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => ({ type: k, label: o.types[k]?.label ?? k, count: n })),
    no_ad_cost: o.items.filter((i) => !i.type.startsWith('ads_')).length } : null;

  // Rückblick: letzte volle Kalenderwoche (Montag bis Sonntag)
  const dow = (new Date(`${t}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = Montag
  const wEnd = addDays(t, -dow - 1), wStart = addDays(wEnd, -6);
  const iso = (() => { const d = new Date(`${wStart}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 3); const y1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - y1) / 86400000 - 3 + ((y1.getUTCDay() + 6) % 7)) / 7); })();
  const range = [`${wStart}T00:00:00`, `${addDays(wEnd, 1)}T00:00:00`];
  const compChanges = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT m.product_id) AS p FROM price_history h JOIN matches m ON m.id=h.match_id
    WHERE h.at >= ? AND h.at < ? AND EXISTS (SELECT 1 FROM price_history h2 WHERE h2.match_id=h.match_id AND h2.at < h.at)`).get(...range);
  const ownChanges = db.prepare(`SELECT COUNT(DISTINCT product_id) AS n FROM product_price_history h WHERE at >= ? AND at < ?
    AND EXISTS (SELECT 1 FROM product_price_history h2 WHERE h2.product_id=h.product_id AND h2.at < h.at)`).get(...range).n;
  const wentOffline = db.prepare('SELECT COUNT(*) AS n FROM products WHERE offline_since >= ? AND offline_since < ?').get(...range).n;
  const week = totals(series(db, wStart, wEnd)), weekBefore = totals(series(db, addDays(wStart, -7), addDays(wStart, -1)));

  return {
    user, today: t, yesterday,
    fresh: { shop: getSetting(db, 'sw_daily_at'), ads: getSetting(db, 'ads_synced_at'), prices: db.prepare('SELECT MAX(last_checked) AS t FROM matches').get().t },
    has: { shop: sw, ads, sales: Boolean(db.prepare('SELECT 1 FROM shop_daily LIMIT 1').get()), ads_daily: Boolean(db.prepare('SELECT 1 FROM ads_daily LIMIT 1').get()) },
    yesterday_stats: { revenue: y.revenue, orders: y.orders, last_week: lw.revenue, delta: pct(y.revenue, lw.revenue) },
    channels, opportunities: opp,
    numbers: { d7: p7, d30: p30 },
    ad_cost: adShare != null ? { per_100: adShare, limit: breakEven, ok: breakEven != null ? adShare < breakEven : null } : null,
    review: {
      week: iso, from: wStart, to: wEnd, comp_changes: compChanges.n, comp_products: compChanges.p, own_changes: ownChanges, went_offline: wentOffline,
      revenue: week.revenue, revenue_delta: pct(week.revenue, weekBefore.revenue), orders: week.orders,
    },
    daily: series(db, addDays(yesterday, -89), yesterday),
    products: prod.all_n,
  };
}
