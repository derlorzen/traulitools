import { getSetting, setSetting } from './settings.js';
import { gscConfig, googleToken } from './gsc.js';

/**
 * Google Merchant Center über die Merchant API (Berichte, nur lesen). Nutzt dasselbe Dienstkonto wie die Search
 * Console; die Adresse des Dienstkontos muss im Merchant Center als Nutzer eingetragen sein.
 *  - Vergleichspreis: der Preis, zu dem andere Händler dasselbe Produkt bei Google anbieten (Preiswettbewerbsfähigkeit)
 *  - Preisvorschläge: Googles empfohlener Preis mit erwarteter Wirkung auf Klicks und Conversions (Preisstatistiken)
 *  - Wettbewerber: Domains, die in deinen Kategorien bei Google sichtbar sind (Wettbewerbsübersicht)
 */
const SCOPE = 'https://www.googleapis.com/auth/content';
const API = () => (process.env.MERCHANT_API_BASE || 'https://merchantapi.googleapis.com').replace(/\/+$/, '');
const micros = (p) => (p && p.amountMicros != null ? Math.round(Number(p.amountMicros) / 10000) / 100 : null);
const hostOf = (u) => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

export function merchantConfig(db) {
  const g = gscConfig(db);
  return {
    key: g.key,
    email: g.email,
    account: (getSetting(db, 'mc_account') || '').replace(/\D/g, ''),
    country: (getSetting(db, 'mc_country') || 'DE').toUpperCase(),
    categories: String(getSetting(db, 'mc_categories') || '').split(/[\s,;]+/).map((x) => x.replace(/\D/g, '')).filter(Boolean).slice(0, 10),
    get configured() { return Boolean(this.key && this.account); },
  };
}

async function search(cfg, query, { max = 20000 } = {}) {
  const tok = await googleToken(cfg.key, SCOPE);
  const out = [];
  let pageToken;
  do {
    const res = await fetch(`${API()}/reports/v1/accounts/${cfg.account}/reports:search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, pageSize: 1000, ...(pageToken ? { pageToken } : {}) }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = j.error?.message || `HTTP ${res.status}`;
      if (res.status === 403) throw new Error(`Kein Zugriff auf Merchant-Center-Konto ${cfg.account}. Ist ${cfg.email} dort als Nutzer eingetragen? (${msg})`);
      throw new Error(`Merchant Center: ${msg}`);
    }
    for (const r of j.results ?? []) out.push(Object.values(r)[0] ?? {});
    pageToken = j.nextPageToken;
  } while (pageToken && out.length < max);
  return out;
}

/** Zugang testen (kleine Abfrage auf die Produktliste). */
export async function merchantTest(db) {
  const cfg = merchantConfig(db);
  if (!cfg.key) throw new Error('Zuerst unter „Google Search Console“ den Dienstkonto-Schlüssel hinterlegen');
  if (!cfg.account) throw new Error('Merchant-Center-Konto-ID fehlt');
  const rows = await search(cfg, 'SELECT offer_id FROM product_view', { max: 1 });
  return { ok: true, sample: rows[0]?.offerId ?? null, email: cfg.email };
}

const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

export async function syncMerchant(db) {
  const cfg = merchantConfig(db);
  if (!cfg.configured) throw new Error('Merchant Center ist nicht eingerichtet');
  const report = { prices: 0, insights: 0, competitors: 0, warnings: [] };
  const step = async (name, fn) => { try { await fn(); } catch (e) { report.warnings.push(`${name}: ${e.message}`); } };
  const rows = new Map(); // offer_id -> Zeile

  await step('Vergleichspreise', async () => {
    const list = await search(cfg, `SELECT offer_id, id, title, brand, price, benchmark_price FROM price_competitiveness_product_view WHERE report_country_code = '${cfg.country}'`);
    for (const r of list) {
      if (!r.offerId) continue;
      rows.set(r.offerId, { ...(rows.get(r.offerId) ?? {}), offer_id: r.offerId, title: r.title ?? null, brand: r.brand ?? null, price: micros(r.price), benchmark: micros(r.benchmarkPrice) });
    }
    report.prices = list.length;
  });
  await step('Preisvorschläge', async () => {
    const list = await search(cfg, 'SELECT offer_id, id, title, price, suggested_price, predicted_impressions_change_fraction, predicted_clicks_change_fraction, predicted_conversions_change_fraction, effectiveness FROM price_insights_product_view');
    for (const r of list) {
      if (!r.offerId) continue;
      rows.set(r.offerId, {
        ...(rows.get(r.offerId) ?? { offer_id: r.offerId, title: r.title ?? null, price: micros(r.price) }),
        suggested: micros(r.suggestedPrice),
        clicks_change: r.predictedClicksChangeFraction != null ? Number(r.predictedClicksChangeFraction) : null,
        conversions_change: r.predictedConversionsChangeFraction != null ? Number(r.predictedConversionsChangeFraction) : null,
        effectiveness: r.effectiveness ?? null,
      });
    }
    report.insights = list.length;
  });
  const comps = [];
  for (const cat of cfg.categories) {
    await step(`Wettbewerber Kategorie ${cat}`, async () => {
      const list = await search(cfg, `SELECT domain, is_your_domain, rank, relative_visibility, page_overlap_rate, higher_position_rate, ads_organic_ratio FROM competitive_visibility_competitor_view WHERE date BETWEEN '${day(31)}' AND '${day(3)}' AND report_country_code = '${cfg.country}' AND report_category_id = ${cat} AND traffic_source = 'ALL' ORDER BY rank`, { max: 100 });
      for (const r of list) comps.push({ category: cat, domain: hostOf(r.domain), own: r.isYourDomain === true, rank: Number(r.rank ?? 0), visibility: num(r.relativeVisibility), overlap: num(r.pageOverlapRate), higher: num(r.higherPositionRate), ads_ratio: num(r.adsOrganicRatio) });
    });
  }
  // Speichern (bei Fehlern einzelner Teile bleiben deren alte Daten erhalten)
  db.exec('BEGIN');
  try {
    if (report.prices || report.insights) {
      db.exec('DELETE FROM mc_products');
      const ins = db.prepare('INSERT INTO mc_products(offer_id, title, brand, price, benchmark, suggested, clicks_change, conversions_change, effectiveness) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const r of rows.values()) ins.run(r.offer_id, r.title ?? null, r.brand ?? null, r.price ?? null, r.benchmark ?? null, r.suggested ?? null, r.clicks_change ?? null, r.conversions_change ?? null, r.effectiveness ?? null);
    }
    if (comps.length) {
      db.exec('DELETE FROM mc_competitors');
      const ic = db.prepare('INSERT OR REPLACE INTO mc_competitors(category, domain, own, rank, visibility, overlap, higher, ads_ratio) VALUES (?,?,?,?,?,?,?,?)');
      for (const c of comps) if (c.domain) ic.run(c.category, c.domain, c.own ? 1 : 0, c.rank, c.visibility, c.overlap, c.higher, c.ads_ratio);
      report.competitors = comps.length;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (!report.prices && !report.insights && !report.competitors && report.warnings.length) throw new Error(report.warnings.join(' | '));
  setSetting(db, 'mc_synced_at', new Date().toISOString());
  return report;
}
const num = (v) => (v == null || v === '' ? null : Number(v));

/** Google-Daten zu einem Artikel (Zuordnung über die Artikelnummer als Angebots-ID). */
export const offerKey = (s) => String(s ?? '').trim().toLowerCase().replace(/^online:[a-z]{2}:[a-z]{2}:/, '');
export function merchantByNumber(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT * FROM mc_products').all()) m.set(offerKey(r.offer_id), r);
  return m;
}

/** Mitbewerber laut Google: Domains über alle gewählten Kategorien, mit Hinweis, ob bereits angelegt. */
export function merchantCompetitors(db) {
  const known = new Set(db.prepare('SELECT base_url FROM competitors').all().map((c) => hostOf(c.base_url)));
  const by = new Map();
  for (const r of db.prepare('SELECT * FROM mc_competitors WHERE own=0 ORDER BY rank').all()) {
    const cur = by.get(r.domain) ?? { domain: r.domain, categories: [], best_rank: r.rank, visibility: 0, overlap: 0, higher: 0, n: 0 };
    cur.categories.push(r.category);
    cur.best_rank = Math.min(cur.best_rank, r.rank);
    cur.visibility = Math.max(cur.visibility, r.visibility ?? 0);
    cur.overlap = Math.max(cur.overlap, r.overlap ?? 0);
    cur.higher = Math.max(cur.higher, r.higher ?? 0);
    by.set(r.domain, cur);
  }
  return [...by.values()].sort((a, b) => b.overlap - a.overlap || a.best_rank - b.best_rank).map((c) => ({ ...c, known: known.has(c.domain) }));
}

export function merchantSummary(db) {
  const cfg = merchantConfig(db);
  const byNum = merchantByNumber(db);
  const own = db.prepare('SELECT id, number, name, price FROM products WHERE active=1').all();
  const matched = [];
  for (const p of own) { const r = byNum.get(offerKey(p.number)); if (r) matched.push({ ...r, id: p.id, number: p.number, name: p.name, own_price: p.price }); }
  const withBench = matched.filter((r) => r.benchmark && r.own_price);
  const above = withBench.filter((r) => r.own_price > r.benchmark * 1.02);
  const gapOf = (r) => ((r.own_price - r.benchmark) / r.benchmark) * 100;
  return {
    configured: cfg.configured, account: cfg.account, country: cfg.country, categories: cfg.categories, synced_at: getSetting(db, 'mc_synced_at'),
    offers: db.prepare('SELECT COUNT(*) AS n FROM mc_products').get().n, matched: matched.length,
    benchmark: { total: withBench.length, above: above.length, below: withBench.filter((r) => r.own_price < r.benchmark * 0.98).length },
    above_benchmark: above.map((r) => ({ id: r.id, name: r.name, number: r.number, own_price: r.own_price, benchmark: r.benchmark, gap_percent: Math.round(gapOf(r) * 10) / 10 })).sort((a, b) => b.gap_percent - a.gap_percent),
    suggestions: matched.filter((r) => r.suggested && r.own_price && Math.abs(r.suggested - r.own_price) >= 0.01).map((r) => ({ id: r.id, name: r.name, number: r.number, own_price: r.own_price, suggested: r.suggested, clicks_change: r.clicks_change, conversions_change: r.conversions_change, effectiveness: r.effectiveness }))
      .sort((a, b) => (b.conversions_change ?? 0) - (a.conversions_change ?? 0)),
    competitors: merchantCompetitors(db),
  };
}
