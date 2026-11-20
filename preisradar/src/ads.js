import { getSetting, setSetting } from './settings.js';
import { gscConfig, googleToken } from './gsc.js';
import { offerKey } from './merchant.js';
import { channel, profit } from './channels.js';

/**
 * Google Ads über die Google Ads API (nur lesen, letzte 30 Tage). Nutzt dasselbe Dienstkonto wie Search Console und
 * Merchant Center: Die Adresse des Dienstkontos wird in Google Ads unter „Verwaltung → Zugriff und Sicherheit“ als
 * Nutzer eingetragen. Das Cloud-Projekt des Dienstkontos braucht die Google Ads API mit mindestens Explorer-Zugang.
 *  - Artikel: Shopping und Performance Max (shopping_performance_view, Zuordnung über die Produkt-ID = Artikelnummer)
 *  - Suchbegriffe: Suchanzeigen (search_term_view), verglichen mit dem kostenlosen Google-Platz aus der Search Console
 *  - Kampagnenarten: Kosten und Umsatz je Art (Shopping, Performance Max, Suche …)
 */
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const API = () => (process.env.GOOGLE_ADS_API_BASE || 'https://googleads.googleapis.com').replace(/\/+$/, '');
const VERSIONS = (process.env.GOOGLE_ADS_API_VERSIONS || 'v25,v24,v23,v22').split(',').map((v) => v.trim()).filter(Boolean);
let workingVersion = null;
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const eur = (micros) => (micros == null ? 0 : Number(micros) / 1e6);
const r2 = (v) => Math.round(v * 100) / 100;

export function adsConfig(db) {
  const g = gscConfig(db);
  return {
    key: g.key, email: g.email,
    customer: digits(getSetting(db, 'ads_customer_id')),
    login: digits(getSetting(db, 'ads_login_customer_id')),
    devToken: getSetting(db, 'ads_developer_token') || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
    get configured() { return Boolean(this.key && this.customer); },
  };
}

class AdsError extends Error {}
function explain(cfg, status, j) {
  const err = j?.error ?? (Array.isArray(j) ? j[0]?.error : null) ?? {};
  const codes = JSON.stringify(err.details ?? '');
  const msg = err.message || `HTTP ${status}`;
  if (/USER_PERMISSION_DENIED|NOT_ADS_USER|CUSTOMER_NOT_ENABLED|PERMISSION_DENIED/.test(codes) || status === 403) {
    if (/NOT_APPROVED|ACTION_NOT_PERMITTED|DEVELOPER_TOKEN/.test(codes + msg)) return `Das Google-Cloud-Projekt des Dienstkontos hat noch keinen Zugang zur Google Ads API für echte Konten (Explorer-Zugang beantragen). (${msg})`;
    return `Kein Zugriff auf Google-Ads-Konto ${cfg.customer}. Ist ${cfg.email} in Google Ads unter „Verwaltung → Zugriff und Sicherheit“ eingetragen? Bei Zugriff über ein Verwaltungskonto dessen Kundennummer angeben. (${msg})`;
  }
  if (/SERVICE_DISABLED|has not been used|is disabled/.test(codes + msg)) return `Die Google Ads API ist im Cloud-Projekt des Dienstkontos nicht aktiviert. (${msg})`;
  return `Google Ads: ${msg}`;
}

async function search(cfg, query, { max = 200000 } = {}) {
  const tok = await googleToken(cfg.key, SCOPE);
  const headers = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
  if (cfg.devToken) headers['developer-token'] = cfg.devToken;
  if (cfg.login && cfg.login !== cfg.customer) headers['login-customer-id'] = cfg.login;
  const versions = workingVersion ? [workingVersion] : VERSIONS;
  let lastErr;
  for (const ver of versions) {
    const out = [];
    let pageToken;
    try {
      do {
        const res = await fetch(`${API()}/${ver}/customers/${cfg.customer}/googleAds:search`, {
          method: 'POST', headers, body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }), signal: AbortSignal.timeout(90000),
        });
        const j = await res.json().catch(() => ({}));
        // Versionen werden nach gut einem Jahr abgeschaltet: dann die nächstältere bzw. -neuere probieren
        if (res.status === 404 || (res.status === 400 && /UNSUPPORTED_VERSION|deprecated|sunset/i.test(JSON.stringify(j)))) throw Object.assign(new Error(`API-Version ${ver} nicht verfügbar`), { retry: true });
        if (!res.ok) throw new AdsError(explain(cfg, res.status, j));
        out.push(...(j.results ?? []));
        pageToken = j.nextPageToken;
      } while (pageToken && out.length < max);
      workingVersion = ver;
      return out;
    } catch (e) {
      if (!e.retry) throw e;
      lastErr = e;
    }
  }
  throw new AdsError(`Google Ads: keine der API-Versionen ${versions.join(', ')} erreichbar (${lastErr?.message})`);
}

/** Zugang testen: Kontoname und Währung. */
export async function adsTest(db) {
  const cfg = adsConfig(db);
  if (!cfg.key) throw new Error('Zuerst unter „Google Search Console“ den Dienstkonto-Schlüssel hinterlegen');
  if (!cfg.customer) throw new Error('Google-Ads-Kundennummer fehlt');
  const rows = await search(cfg, 'SELECT customer.descriptive_name, customer.currency_code, customer.id FROM customer LIMIT 1');
  const c = rows[0]?.customer ?? {};
  return { ok: true, email: cfg.email, name: c.descriptiveName ?? null, currency: c.currencyCode ?? null, version: workingVersion };
}

const TYPE_NAMES = {
  SHOPPING: 'Shopping', PERFORMANCE_MAX: 'Performance Max', SEARCH: 'Suche', DISPLAY: 'Display', VIDEO: 'Video',
  DEMAND_GEN: 'Demand Gen', DISCOVERY: 'Demand Gen', SMART: 'Smart', LOCAL: 'Lokal', MULTI_CHANNEL: 'App', HOTEL: 'Hotel',
};
export const typeName = (t) => TYPE_NAMES[t] ?? (t ? t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' ') : 'Sonstige');
const metric = (m) => ({ impressions: Number(m?.impressions ?? 0), clicks: Number(m?.clicks ?? 0), cost: eur(m?.costMicros), conversions: Number(m?.conversions ?? 0), value: Number(m?.conversionsValue ?? 0) });
const add = (a, b) => { for (const k of ['impressions', 'clicks', 'cost', 'conversions', 'value']) a[k] = (a[k] ?? 0) + b[k]; return a; };

/** Täglicher Abgleich der letzten 30 Tage. Jeder Teil läuft für sich; Fehler eines Teils landen als Hinweis. */
export async function syncAds(db) {
  const cfg = adsConfig(db);
  if (!cfg.configured) throw new Error('Google Ads ist nicht eingerichtet');
  const report = { campaign_types: 0, products: 0, terms: 0, warnings: [] };
  const now = new Date().toISOString();
  let firstError = null;
  const step = async (name, fn) => { try { await fn(); } catch (e) { firstError ??= e; report.warnings.push(`${name}: ${e.message}`); } };

  await step('Kampagnenarten', async () => {
    const rows = await search(cfg, 'SELECT campaign.advertising_channel_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date DURING LAST_30_DAYS AND metrics.impressions > 0');
    const by = new Map();
    for (const r of rows) { const t = r.campaign?.advertisingChannelType ?? 'UNKNOWN'; by.set(t, add(by.get(t) ?? { campaigns: 0 }, metric(r.metrics))); by.get(t).campaigns++; }
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM ads_types');
      const ins = db.prepare('INSERT INTO ads_types(type, campaigns, impressions, clicks, cost, conversions, value, updated_at) VALUES (?,?,?,?,?,?,?,?)');
      for (const [t, v] of by) ins.run(t, v.campaigns, v.impressions, v.clicks, r2(v.cost), v.conversions, r2(v.value), now);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    report.campaign_types = by.size;
  });

  await step('Artikel (Shopping, Performance Max)', async () => {
    const rows = await search(cfg, 'SELECT segments.product_item_id, segments.product_title, campaign.advertising_channel_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM shopping_performance_view WHERE segments.date DURING LAST_30_DAYS AND metrics.impressions > 0');
    const by = new Map();
    for (const r of rows) {
      const id = offerKey(r.segments?.productItemId);
      if (!id) continue;
      const cur = by.get(id) ?? { title: r.segments?.productTitle ?? null, types: new Set() };
      cur.types.add(r.campaign?.advertisingChannelType ?? '');
      by.set(id, add(cur, metric(r.metrics)));
    }
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM ads_products');
      const ins = db.prepare('INSERT INTO ads_products(item_id, title, types, impressions, clicks, cost, conversions, value, updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const [id, v] of by) ins.run(id, v.title, [...v.types].filter(Boolean).join(','), v.impressions, v.clicks, r2(v.cost), v.conversions, r2(v.value), now);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    report.products = by.size;
  });

  await step('Suchbegriffe', async () => {
    const rows = await search(cfg, 'SELECT search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE segments.date DURING LAST_30_DAYS AND metrics.clicks > 0');
    const by = new Map();
    for (const r of rows) { const t = String(r.searchTermView?.searchTerm ?? '').trim().toLowerCase(); if (t) by.set(t, add(by.get(t) ?? {}, metric(r.metrics))); }
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM ads_terms');
      const ins = db.prepare('INSERT INTO ads_terms(term, impressions, clicks, cost, conversions, value, updated_at) VALUES (?,?,?,?,?,?,?)');
      for (const [t, v] of by) ins.run(t, v.impressions, v.clicks, r2(v.cost), v.conversions, r2(v.value), now);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    report.terms = by.size;
  });

  await step('Verlauf je Tag', async () => {
    const from = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
    const rows = await search(cfg, `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM customer WHERE segments.date BETWEEN '${from}' AND '${to}'`);
    db.exec('BEGIN');
    try {
      const up = db.prepare('INSERT INTO ads_daily(day, impressions, clicks, cost, conversions, value, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET impressions=excluded.impressions, clicks=excluded.clicks, cost=excluded.cost, conversions=excluded.conversions, value=excluded.value, updated_at=excluded.updated_at');
      for (const r of rows) { const d = r.segments?.date; if (!d) continue; const m = metric(r.metrics); up.run(d, m.impressions, m.clicks, r2(m.cost), m.conversions, r2(m.value), now); }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    report.days = rows.length;
  });

  // Wenn gar nichts ging, ist es ein Zugangsproblem: als Fehler melden statt als Hinweis
  if (report.warnings.length === 4 && firstError) throw firstError;
  setSetting(db, 'ads_synced_at', now);
  return report;
}

/** Werbedaten je Artikel (Zuordnung Produkt-ID = Artikelnummer), mit Gewinn nach Werbung, sofern ein Einkaufspreis da ist. */
export function adsByProduct(db) {
  const rows = db.prepare('SELECT * FROM ads_products').all();
  if (!rows.length) return new Map();
  const byKey = new Map(rows.map((r) => [r.item_id, r]));
  const shop = channel(db, 'shop');
  const out = new Map();
  for (const p of db.prepare('SELECT id, number, price, purchase_price, tax_rate FROM products WHERE active=1').all()) {
    const a = byKey.get(offerKey(p.number));
    if (!a) continue;
    out.set(p.id, adsView(a, p, shop));
  }
  return out;
}
export function adsView(a, p, shop) {
  const cost = p.purchase_price > 0 ? p.purchase_price : null;
  const perSale = cost && p.price && shop ? profit(p.price, cost, shop, p.tax_rate ?? 19) : null;
  const units = p.price ? a.value / p.price : a.conversions; // verkaufte Stück laut Conversion-Wert
  const profitAfter = perSale != null ? r2(units * perSale - a.cost) : null;
  return {
    item_id: a.item_id, types: a.types ? a.types.split(',') : [], impressions: a.impressions, clicks: a.clicks, cost: a.cost, conversions: r2(a.conversions), value: a.value,
    roas: a.cost > 0 ? r2(a.value / a.cost) : null, cpc: a.clicks ? r2(a.cost / a.clicks) : null,
    profit_per_sale: perSale, profit_after_ads: profitAfter,
    // Werbekosten, bis zu denen sich ein Verkauf noch lohnt (Gewinn je Verkauf)
    max_cpa: perSale,
  };
}

/** Übersicht für die Seite Sichtbarkeit und das Lagebild. */
export function adsSummary(db) {
  const cfg = adsConfig(db);
  const types = db.prepare('SELECT * FROM ads_types ORDER BY cost DESC').all().map((t) => ({ ...t, name: typeName(t.type), roas: t.cost > 0 ? r2(t.value / t.cost) : null }));
  const total = types.reduce((a, t) => add(a, t), { impressions: 0, clicks: 0, cost: 0, conversions: 0, value: 0 });
  const map = adsByProduct(db);
  const prods = new Map(db.prepare('SELECT id, number, name, price, stock, offline_since FROM products WHERE active=1').all().map((p) => [p.id, p]));
  const items = [...map.entries()].map(([id, v]) => ({ id, number: prods.get(id)?.number, name: prods.get(id)?.name, price: prods.get(id)?.price, stock: prods.get(id)?.stock ?? null, ...v }));
  const productCost = db.prepare('SELECT COALESCE(SUM(cost),0) AS c, COUNT(*) AS n FROM ads_products').get();
  const matchedCost = items.reduce((a, i) => a + i.cost, 0);
  const withProfit = items.filter((i) => i.profit_after_ads != null);
  // Suchbegriffe mit Kosten, bei denen die Seite kostenlos schon weit oben steht (Search Console, letzte 28 Tage)
  const organic = new Map();
  for (const q of db.prepare('SELECT query, MIN(position) AS position, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM seo_queries GROUP BY query').all()) organic.set(String(q.query).toLowerCase(), q);
  const terms = db.prepare('SELECT * FROM ads_terms ORDER BY cost DESC LIMIT 500').all().map((t) => {
    const o = organic.get(t.term);
    return { ...t, roas: t.cost > 0 ? r2(t.value / t.cost) : null, organic_position: o ? r2(o.position) : null, organic_clicks: o?.clicks ?? null };
  });
  return {
    configured: cfg.configured, customer: cfg.customer, email: cfg.email, synced_at: getSetting(db, 'ads_synced_at'),
    total: { ...total, cost: r2(total.cost), value: r2(total.value), roas: total.cost > 0 ? r2(total.value / total.cost) : null },
    types,
    products: {
      count: productCost.n, cost: r2(productCost.c), matched: items.length, matched_cost: r2(matchedCost),
      with_profit: withProfit.length,
      profit_after_ads: r2(withProfit.reduce((a, i) => a + i.profit_after_ads, 0)),
      loss: withProfit.filter((i) => i.profit_after_ads < 0).length,
      items: items.sort((a, b) => b.cost - a.cost),
    },
    terms: { count: db.prepare('SELECT COUNT(*) AS n FROM ads_terms').get().n, paid_top3: terms.filter((t) => t.organic_position != null && t.organic_position <= 3).length, items: terms },
  };
}

