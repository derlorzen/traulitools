import { getSetting } from './settings.js';
import { gscConfig, pageKey } from './gsc.js';
import { analyse } from './analysis.js';

/**
 * Sichtbarkeit: Daten der Google Search Console zusammen mit der Preislage.
 * Kernidee: Preis und Auffindbarkeit gehören zusammen. Ein günstiger Preis nützt wenig, wenn niemand die Seite findet,
 * und viele Impressionen bringen wenig Umsatz, wenn der Preis nicht stimmt.
 */
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export function seoStatus(db) {
  const g = gscConfig(db);
  return { gsc: { configured: g.configured, site: g.site, email: g.email, synced_at: getSetting(db, 'gsc_synced_at'), range: getSetting(db, 'gsc_range') } };
}

export function seoOverview(db) {
  const status = seoStatus(db);
  const daily = db.prepare('SELECT date, clicks, impressions, ctr, position FROM seo_daily ORDER BY date').all();
  const last28 = daily.slice(-28), prev28 = daily.slice(-56, -28);
  const sum = (a, k) => a.reduce((s, x) => s + (x[k] ?? 0), 0);
  const avgPos = (a) => { const imp = sum(a, 'impressions'); return imp ? a.reduce((s, x) => s + x.position * x.impressions, 0) / imp : null; };
  const kpi = {
    clicks: sum(last28, 'clicks'), impressions: sum(last28, 'impressions'),
    clicks_prev: prev28.length ? sum(prev28, 'clicks') : null, impressions_prev: prev28.length ? sum(prev28, 'impressions') : null,
    ctr: sum(last28, 'impressions') ? r1((sum(last28, 'clicks') / sum(last28, 'impressions')) * 100) : null,
    position: r1(avgPos(last28)), position_prev: r1(avgPos(prev28)),
    pages: db.prepare('SELECT COUNT(*) AS n FROM seo_pages').get().n,
  };
  // Produktseiten mit den meisten Klicks bzw. Impressionen, mit Preislage
  const products = productsByPage(db);
  const pages = db.prepare('SELECT page, url, clicks, impressions, ctr, position FROM seo_pages ORDER BY clicks DESC, impressions DESC LIMIT 300').all()
    .map((p) => { const pr = products.get(p.page); return { ...p, product: pr ? { id: pr.id, name: pr.name, price: pr.price, offline: Boolean(pr.offline_since) } : null }; });
  // Suchanfragen gesamt (über alle Seiten der Stichprobe)
  const queries = db.prepare('SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) / NULLIF(SUM(impressions),0) AS position FROM seo_queries GROUP BY query ORDER BY clicks DESC, impressions DESC LIMIT 100').all();
  const productPages = pages.filter((p) => p.product);
  const coverage = { product_pages: db.prepare('SELECT COUNT(*) AS n FROM products WHERE active=1 AND url IS NOT NULL').get().n, with_data: 0 };
  for (const p of db.prepare('SELECT page FROM seo_pages').all()) if (products.has(p.page)) coverage.with_data++;
  return { status, kpi, daily, pages: productPages.slice(0, 100), other_pages: pages.filter((p) => !p.product).slice(0, 30), queries, coverage, opportunities: opportunities(db) };
}

function productsByPage(db) {
  const m = new Map();
  for (const p of db.prepare('SELECT id, name, number, url, price, tracked, offline_since FROM products WHERE active=1 AND url IS NOT NULL').all()) m.set(pageKey(p.url), p);
  return m;
}

/**
 * Chancen aus Preis und Suche. Nur Artikel mit Search-Console-Daten; Grenzwerte bewusst einfach und nachvollziehbar.
 */
export function opportunities(db) {
  const a = analyse(db);
  const tol = a.rules.tolerance;
  const rows = a.rows.filter((r) => r.impressions != null && !r.warning);
  const pick = (list, f, sort, n = 15) => list.filter(f).sort(sort).slice(0, n);
  const item = (r, why) => ({ id: r.id, number: r.number, name: r.name, own_price: r.own_price, cheapest: r.cheapest, cheapest_competitor: r.cheapest_competitor, gap_percent: r.gap_percent, impressions: r.impressions, clicks: r.clicks, search_position: r.search_position, why });
  const ctrOf = (r) => (r.impressions ? (r.clicks / r.impressions) * 100 : 0);
  const pos = (v) => String(v).replace('.', ',');
  return {
    available: rows.length > 0,
    groups: [
      {
        key: 'demand_price', title: 'Viel gesucht, aber teurer', hint: `Artikel mit vielen Impressionen, bei denen du mehr als ${tol} % über dem günstigsten Angebot liegst. Hier kostet der Preis am meisten Umsatz.`, tone: 'warm',
        items: pick(rows, (r) => r.gap_percent > tol && r.impressions >= 30, (x, y) => y.impressions * y.gap_percent - x.impressions * x.gap_percent).map((r) => item(r, `${Math.round(r.impressions)} Impressionen, ${pos(r.gap_percent)} % teurer als ${r.cheapest_competitor}`)),
      },
      {
        key: 'cheap_hidden', title: 'Günstigster, aber kaum gefunden', hint: 'Du hast den besten Preis, aber die Seite steht im Schnitt hinter Platz 10 oder wird kaum gesehen. Hier lohnt Arbeit an Titel, Beschreibung und internen Links.', tone: 'cool',
        items: pick(rows, (r) => r.gap_percent <= 0 && (r.search_position > 10 || r.impressions < 30), (x, y) => (y.search_position ?? 0) - (x.search_position ?? 0)).map((r) => item(r, `Platz ${pos(r.search_position)} bei Google, ${Math.round(r.impressions)} Impressionen`)),
      },
      {
        key: 'almost_page1', title: 'Knapp vor Seite 1', hint: 'Durchschnittlich Platz 8 bis 15 mit spürbarer Nachfrage. Wenige Plätze mehr bringen hier deutlich mehr Klicks.', tone: 'near',
        items: pick(rows, (r) => r.search_position >= 8 && r.search_position <= 15 && r.impressions >= 50, (x, y) => y.impressions - x.impressions).map((r) => item(r, `Platz ${pos(r.search_position)}, ${Math.round(r.impressions)} Impressionen`)),
      },
      {
        key: 'low_ctr', title: 'Gut platziert, wenig Klicks', hint: 'Top-5-Platz, aber unter 2 % Klickrate. Oft hilft ein besserer Seitentitel oder ein sichtbarer Preis- bzw. Versandvorteil im Suchergebnis.', tone: 'near',
        items: pick(rows, (r) => r.search_position <= 5 && r.impressions >= 100 && ctrOf(r) < 2, (x, y) => y.impressions - x.impressions).map((r) => item(r, `Platz ${pos(r.search_position)}, Klickrate ${ctrOf(r).toFixed(1).replace('.', ',')} %`)),
      },
    ],
  };
}

/** Suchdaten eines Artikels für die Detailansicht. */
export function productSeo(db, productId) {
  const p = db.prepare('SELECT url FROM products WHERE id=?').get(productId);
  if (!p?.url) return { page: null, queries: [] };
  const k = pageKey(p.url);
  return {
    page: db.prepare('SELECT clicks, impressions, ctr, position FROM seo_pages WHERE page=?').get(k) ?? null,
    queries: db.prepare('SELECT query, clicks, impressions, ctr, position FROM seo_queries WHERE page=? ORDER BY clicks DESC, impressions DESC LIMIT 10').all(k),
  };
}
