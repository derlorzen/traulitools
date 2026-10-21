import zlib from 'node:zlib';
import { fetchText, robotsAllows } from './fetcher.js';
import { tokens, jaccard } from './util.js';

/**
 * Produkt-URLs eines Mitbewerbers aus seinen Sitemaps. Für Shops, deren Suche gesperrt oder nur per
 * JavaScript gerendert ist: Die URLs enthalten meist Marke und Produktname und werden darüber zugeordnet.
 */

const WEEK = 7 * 24 * 3600 * 1000;
const cache = new Map(); // competitor_id -> [{ url, tokens }]
const MAX_FILES = 40;

export const sitemapList = (comp) => String(comp.sitemap_url ?? '').split(/\s+/).filter(Boolean);

/** Produktbezeichnung aus der URL: das längste Pfadsegment (ohne angehängte IDs wie _123_456). */
export function slugOf(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean).map((x) => {
      try { return decodeURIComponent(x); } catch { return x; }
    });
    let best = '';
    for (const x of segs) {
      const t = x.replace(/_\d+(_\d+)*$/, '').replace(/\.(html?|php)$/i, '');
      if (t.replace(/[^a-zäöüß-]/gi, '').length >= best.replace(/[^a-zäöüß-]/gi, '').length) best = t;
    }
    return best;
  } catch {
    return '';
  }
}

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

/** Sitemap laden; .xml.gz wird entpackt. */
async function fetchSitemap(url) {
  const r = await fetchText(url, { timeout: 120000, raw: true });
  let buf = r.buf;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: 300 * 1024 * 1024 });
  return { ...r, text: buf.toString('utf8') };
}

/**
 * Sitemaps laden, auch verschachtelte Index-Sitemaps (zwei Ebenen) und .gz-Dateien.
 * Gibt es in einem Index Teil-Sitemaps für Artikel/Produkte, werden nur diese gelesen.
 */
export async function collectSitemapUrls(list) {
  const found = new Set();
  const report = [];
  let files = 0;
  const load = async (url, depth) => {
    if (files++ >= MAX_FILES) return report.push({ url, error: 'zu viele Sitemap-Dateien, abgebrochen' });
    try {
      if (!(await robotsAllows(url))) return report.push({ url, error: 'robots.txt untersagt den Abruf' });
      const r = await fetchSitemap(url);
      if (r.finalUrl !== url && !(await robotsAllows(r.finalUrl))) return report.push({ url, error: 'Weiterleitung auf eine laut robots.txt gesperrte Seite' });
      if (r.status >= 400) return report.push({ url, error: `HTTP ${r.status}` });
      const list = locs(r.text);
      if (/<sitemapindex/i.test(r.text)) {
        if (depth >= 2) return report.push({ url, error: 'zu tief verschachtelt' });
        const pref = list.filter((u) => /artikel|item|product|produkt|detail/i.test(u.split('/').pop()));
        for (const sub of pref.length ? pref : list) await load(sub, depth + 1);
        return;
      }
      if (!/<urlset/i.test(r.text)) return report.push({ url, error: 'keine gültige Sitemap' });
      for (const u of list) found.add(u);
      report.push({ url, urls: list.length });
    } catch (e) {
      report.push({ url, error: e.message });
    }
  };
  for (const u of list) await load(u, 0);
  return { found, report };
}

/** Sitemaps eines Shops automatisch finden: robots.txt (Sitemap:-Zeilen) und übliche Pfade. */
export async function discoverSitemaps(baseUrl) {
  const origin = new URL(baseUrl).origin;
  const cands = new Set();
  try {
    if (await robotsAllows(`${origin}/robots.txt`)) {
      const r = await fetchText(`${origin}/robots.txt`, { timeout: 10000 });
      for (const m of r.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) cands.add(m[1]);
    }
  } catch { /* weiter mit den üblichen Pfaden */ }
  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap/sitemap.xml', '/sitemapuebersicht.xml', '/sitemap.xml.gz']) cands.add(origin + p);
  const out = [];
  for (const url of cands) {
    try {
      if (!(await robotsAllows(url))) continue;
      const r = await fetchSitemap(url);
      if (r.status !== 200) continue;
      const kind = /<sitemapindex/i.test(r.text) ? 'index' : /<urlset/i.test(r.text) ? 'urlset' : null;
      if (kind) out.push({ url, kind, entries: locs(r.text).length });
    } catch { /* nicht vorhanden */ }
  }
  return out;
}

/** Sitemaps eines Mitbewerbers laden und die URLs speichern. */
export async function refreshSitemaps(db, comp) {
  const { found, report } = await collectSitemapUrls(sitemapList(comp));
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

/** Eigene Sitemap laden und den eigenen Produkten ohne Shop-URL die Seiten zuordnen. */
export async function refreshOwnSitemap(db, urls) {
  const { found, report } = await collectSitemapUrls(urls);
  let assigned = 0;
  if (found.size) {
    const ins = db.prepare('INSERT OR IGNORE INTO own_sitemap_urls(url, slug) VALUES (?,?)');
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM own_sitemap_urls');
      for (const u of found) ins.run(u, slugOf(u));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    assigned = assignOwnUrls(db, [...found]);
  }
  return { count: found.size, assigned, report };
}

/** Eigene Produkte ↔ URL: Artikelnummer als Pfadsegment (Shopware) oder sehr ähnliche Bezeichnung. */
export function assignOwnUrls(db, urls) {
  const byNumber = new Map();
  const entries = urls.map((u) => ({ url: u, tokens: tokens(slugOf(u)), segs: new URL(u).pathname.split('/').filter(Boolean) }));
  for (const e of entries) for (const sg of e.segs) if (!byNumber.has(sg.toLowerCase())) byNumber.set(sg.toLowerCase(), e.url);
  const upd = db.prepare('UPDATE products SET url=? WHERE id=?');
  let n = 0;
  for (const p of db.prepare("SELECT id, number, name, manufacturer, url FROM products WHERE url IS NULL OR url LIKE '%/detail/%'").all()) {
    let hit = byNumber.get(String(p.number).toLowerCase());
    if (!hit) {
      const want = tokens(`${p.manufacturer ?? ''} ${p.name}`);
      let best = null;
      for (const e of entries) {
        const s = jaccard(want, e.tokens);
        if (s >= 0.7 && (!best || s > best.s)) best = { s, url: e.url };
      }
      hit = best?.url;
    }
    if (hit && hit !== p.url) { upd.run(hit, p.id); n++; }
  }
  return n;
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
  const brand = [...tokens(product.manufacturer)].slice(0, 1); // erstes Markenwort („HSK - Die Badexperten“ → hsk)
  if (!want.size) return [];
  const scored = [];
  for (const e of entries(db, compId)) {
    if (brand.length && !brand.every((b) => e.slug.toLowerCase().includes(b))) continue;
    const s = jaccard(want, e.tokens);
    if (s >= min) scored.push({ url: e.url, slug: e.slug, score: s });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
