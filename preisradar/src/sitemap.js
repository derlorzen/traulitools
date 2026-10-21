import { fetchText, robotsAllows } from './fetcher.js';
import { tokens, jaccard } from './util.js';

/**
 * Produkt-URLs eines Mitbewerbers aus seinen Sitemaps. Für Shops, deren Suche gesperrt oder nur per
 * JavaScript gerendert ist: Die URLs enthalten meist Marke und Produktname und werden darüber zugeordnet.
 */

const WEEK = 7 * 24 * 3600 * 1000;
const cache = new Map(); // competitor_id -> [{ url, tokens }]

export const sitemapList = (comp) => String(comp.sitemap_url ?? '').split(/\s+/).filter(Boolean);

const slugOf = (url) => {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(seg).replace(/_\d+(_\d+)*$/, '').replace(/\.(html?|php)$/i, '');
  } catch {
    return '';
  }
};

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

/** Sitemaps (auch Index-Sitemaps, eine Ebene tief) laden und die URLs speichern. */
export async function refreshSitemaps(db, comp) {
  const report = [];
  const found = new Set();
  const load = async (url, depth) => {
    try {
      if (!(await robotsAllows(url))) return report.push({ url, error: 'robots.txt untersagt den Abruf' });
      const r = await fetchText(url, { timeout: 120000 });
      if (r.finalUrl !== url && !(await robotsAllows(r.finalUrl))) return report.push({ url, error: 'Weiterleitung auf eine laut robots.txt gesperrte Seite' });
      if (r.status >= 400) return report.push({ url, error: `HTTP ${r.status}` });
      const list = locs(r.text);
      if (/<sitemapindex/i.test(r.text) && depth < 1) {
        for (const sub of list) await load(sub, depth + 1);
        return;
      }
      for (const u of list) found.add(u);
      report.push({ url, urls: list.length });
    } catch (e) {
      report.push({ url, error: e.message });
    }
  };
  for (const u of sitemapList(comp)) await load(u, 0);

  if (found.size) {
    const ins = db.prepare('INSERT OR IGNORE INTO sitemap_urls(competitor_id, url, slug) VALUES (?,?,?)');
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM sitemap_urls WHERE competitor_id=?').run(comp.id);
      for (const u of found) ins.run(comp.id, u, slugOf(u));
      db.prepare('UPDATE competitors SET sitemap_fetched_at=? WHERE id=?').run(new Date().toISOString(), comp.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    cache.delete(comp.id);
  }
  return { count: found.size, report };
}

export function sitemapDue(db, comp) {
  if (!sitemapList(comp).length) return false;
  if (!comp.sitemap_fetched_at) return true;
  return Date.now() - Date.parse(comp.sitemap_fetched_at) > WEEK;
}

function entries(db, compId) {
  if (!cache.has(compId)) {
    cache.set(compId, db.prepare('SELECT url, slug FROM sitemap_urls WHERE competitor_id=?').all(compId).map((r) => ({ url: r.url, slug: r.slug, tokens: tokens(r.slug) })));
  }
  return cache.get(compId);
}

export const hasSitemap = (db, compId) => entries(db, compId).length > 0;

/** Die ähnlichsten Produkt-URLs zu einem eigenen Produkt (Marke + Name gegen URL-Bezeichnung). */
export function sitemapCandidates(db, compId, product, { limit = 5, min = 0.25 } = {}) {
  const want = tokens(`${product.manufacturer ?? ''} ${product.name}`);
  const brand = [...tokens(product.manufacturer)];
  if (!want.size) return [];
  const scored = [];
  for (const e of entries(db, compId)) {
    if (brand.length && !brand.every((b) => e.slug.toLowerCase().includes(b))) continue;
    const s = jaccard(want, e.tokens);
    if (s >= min) scored.push({ url: e.url, slug: e.slug, score: s });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
