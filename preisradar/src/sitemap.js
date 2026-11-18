import zlib from 'node:zlib';
import { timed } from './perf.js';
import { fetchText, robotsAllows } from './fetcher.js';
import { tokens, jaccard, normId } from './util.js';

/**
 * Produkt-URLs eines Mitbewerbers aus seinen Sitemaps. Für Shops, deren Suche gesperrt oder nur per
 * JavaScript gerendert ist: Die URLs enthalten meist Marke und Produktname und werden darüber zugeordnet.
 */

const WEEK = 7 * 24 * 3600 * 1000;
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
      bumpIndex(db, comp.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    ensureIndex(db, comp.id).catch((e) => console.error('Sitemap-Index:', e.message)); // im Hintergrund neu aufbauen
  }
  return { count: found.size, report };
}

/** Eigene Sitemap laden und den eigenen Produkten ohne Shop-URL die Seiten zuordnen. */
export async function refreshOwnSitemap(db, urls) {
  const { found, report } = await collectSitemapUrls(urls);
  let assigned = 0;
  let offline = 0;
  let online = 0;
  const before = db.prepare('SELECT COUNT(*) AS n FROM own_sitemap_urls').get().n;
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
    // Artikel, deren Seite nicht mehr in der Sitemap steht, gelten als offline (bleiben aber erhalten).
    // Schutz vor Fehlalarm: nur wenn die Sitemap nicht plötzlich deutlich kleiner ist.
    if (found.size >= before * 0.8) {
      const now = new Date().toISOString();
      const norm = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, ''); } catch { return u; } };
      const present = new Set([...found].map(norm));
      const off = db.prepare('UPDATE products SET offline_since=? WHERE id=? AND offline_since IS NULL');
      const on = db.prepare('UPDATE products SET offline_since=NULL WHERE id=? AND offline_since IS NOT NULL');
      const ownHosts = new Set([...found].map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }));
      db.exec('BEGIN');
      for (const p of db.prepare('SELECT id, url FROM products WHERE url IS NOT NULL').all()) {
        let host = '';
        try { host = new URL(p.url).hostname.replace(/^www\./, ''); } catch { continue; }
        if (!ownHosts.has(host)) continue;
        if (present.has(norm(p.url))) online += on.run(p.id).changes;
        else offline += off.run(now, p.id).changes;
      }
      db.exec('COMMIT');
    }
  }
  db.prepare("INSERT INTO settings(key, value) VALUES ('own_sitemap_fetched_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
  return { count: found.size, assigned, offline, online, report };
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

/** Kategoriepfad einer URL: alle Pfadsegmente außer dem letzten ('' = direkt unter der Domain). */
export function categoryOf(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return segs.slice(0, -1).join('/').toLowerCase();
  } catch {
    return '';
  }
}
const inCategories = (cat, sel) => sel.some((c) => (c === '' ? cat === '' : cat === c || cat.startsWith(c + '/')));
export function selectedCategories(db, compId) {
  try { return JSON.parse(db.prepare('SELECT sitemap_categories FROM competitors WHERE id=?').get(compId)?.sitemap_categories || '[]'); } catch { return []; }
}
/** Früher: Speicher-Index verwerfen. Die Kategorie-Auswahl wirkt jetzt direkt bei der Suche, daher nichts zu tun. */
export const clearSitemapCache = () => {};

/**
 * Kategorien aus den Sitemap-URLs eines Mitbewerbers (zwei Ebenen) mit Anzahl der Produkt-URLs.
 * flat = Produkte liegen überwiegend ohne Kategorie in der URL (dann bringt eine Auswahl wenig).
 */
export function sitemapCategories(db, compId) {
  const counts = new Map();
  let total = 0;
  let root = 0;
  for (const { url } of db.prepare('SELECT url FROM sitemap_urls WHERE competitor_id=?').all(compId)) {
    total++;
    const segs = categoryOf(url).split('/').filter(Boolean);
    if (!segs.length) { root++; continue; }
    for (let i = 1; i <= Math.min(2, segs.length); i++) {
      const k = segs.slice(0, i).join('/');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const top = [...counts.keys()].filter((k) => !k.includes('/'));
  const flat = top.length > 150 || root > total * 0.5;
  const list = [...counts.entries()].filter(([k, n]) => n >= 3 && (!k.includes('/') || counts.get(k.split('/')[0]) > n))
    .map(([path, count]) => ({ path, count, level: path.split('/').length }))
    .sort((a, b) => a.path.localeCompare(b.path, 'de'));
  return { total, root, flat, categories: flat ? list.filter((c) => c.level === 1).sort((a, b) => b.count - a.count).slice(0, 60) : list, selected: selectedCategories(db, compId) };
}

// ---------- Suchindex der Sitemap-Adressen (SQLite-Volltext, FTS5) ----------
// Je Adresse: Wörter der URL-Bezeichnung (wie tokens()) und alle Folgen von URL-Bestandteilen mit Ziffer, sodass
// eine Kennung (EAN, Herstellernummer, Artikelnummer) exakt als ein Begriff gefunden wird.
// Jeder Mitbewerber hat einen Index-Stand (gen); nach einem Sitemap-Update wird ein neuer Stand in kleinen Paketen
// aufgebaut und der alte danach gelöscht, ohne den Server zu blockieren.
const STEP = 2000;
const building = new Map(); // competitor_id -> Promise
const yieldNow = () => new Promise((r) => setImmediate(r));
const cidOf = (compId, gen) => `c${compId}g${gen}`;
const pathParts = (url) => {
  let path = url;
  try { path = decodeURIComponent(new URL(url).pathname); } catch { try { path = new URL(url).pathname; } catch { /* Rohwert */ } }
  return path.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
};
/** Alle zusammenhängenden Folgen von URL-Bestandteilen mit Ziffer (4–24 Zeichen): „75-275-182“ ergibt u. a. 75275182. */
const idTerms = (parts) => {
  const out = new Set();
  for (let i = 0; i < parts.length; i++) {
    let s = '';
    for (let j = i; j < parts.length; j++) {
      s += parts[j];
      if (s.length > 24) break;
      if (s.length >= 4 && /\d/.test(s)) out.add(s);
    }
  }
  return [...out];
};
const q = (t) => `"${t}"`; // Begriffe enthalten nur a-z, 0-9, äöüß

function indexState(db, compId) {
  let st = db.prepare('SELECT gen, built FROM sitemap_index WHERE competitor_id=?').get(compId);
  if (!st) { db.prepare('INSERT OR IGNORE INTO sitemap_index(competitor_id, gen, built) VALUES (?,1,0)').run(compId); st = { gen: 1, built: 0 }; }
  return st;
}
function bumpIndex(db, compId) {
  indexState(db, compId);
  db.prepare('UPDATE sitemap_index SET gen=gen+1, built=0 WHERE competitor_id=?').run(compId);
}
async function deleteGen(db, cid) {
  const del = db.prepare('DELETE FROM sitemap_fts WHERE rowid IN (SELECT rowid FROM sitemap_fts WHERE sitemap_fts MATCH ? LIMIT 5000)');
  while (timed(`Sitemap-Index aufräumen (${cid})`, () => del.run(`cid:${q(cid)}`).changes) > 0) await yieldNow();
}
async function buildIndex(db, compId, gen) {
  const cid = cidOf(compId, gen);
  await deleteGen(db, cid); // Reste eines abgebrochenen Aufbaus
  const { lo, hi } = db.prepare('SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM sitemap_urls WHERE competitor_id=?').get(compId);
  const sel = db.prepare('SELECT rowid AS id, url, slug FROM sitemap_urls WHERE rowid BETWEEN ? AND ? AND competitor_id=?');
  const ins = db.prepare('INSERT INTO sitemap_fts(cid, words, ids, uid) VALUES (?,?,?,?)');
  let n = 0;
  const t0 = Date.now();
  for (let a = lo ?? 1; lo != null && a <= hi; a += STEP) {
    timed(`Sitemap-Index Paket (Mitbewerber ${compId})`, () => {
      db.exec('BEGIN');
      try {
        for (const r of sel.all(a, a + STEP - 1, compId)) { ins.run(cid, [...tokens(r.slug)].join(' '), idTerms(pathParts(r.url)).join(' '), r.id); n++; }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    });
    await yieldNow();
    if (indexState(db, compId).gen !== gen) return null; // Sitemap wurde inzwischen neu geladen: dieser Stand ist veraltet
  }
  db.prepare('UPDATE sitemap_index SET built=1, rows=?, built_at=? WHERE competitor_id=? AND gen=?').run(n, new Date().toISOString(), compId, gen);
  if (n > 20000) console.log(`Sitemap-Index für Mitbewerber ${compId} aufgebaut: ${n} Adressen in ${Math.round((Date.now() - t0) / 1000)} s`);
  // ältere Stände im Hintergrund löschen
  (async () => { for (let g = gen - 1; g >= Math.max(1, gen - 5); g--) await deleteGen(db, cidOf(compId, g)); })().catch((e) => console.error('Sitemap-Index aufräumen:', e.message));
  return gen;
}
/** Index-Stand eines Mitbewerbers sicherstellen (baut bei Bedarf im Hintergrund auf); gibt den Stand zurück. */
export function ensureIndex(db, compId) {
  const st = indexState(db, compId);
  if (st.built) return Promise.resolve(st.gen);
  if (!building.has(compId)) {
    building.set(compId, (async () => {
      let gen = st.gen;
      // neu starten, falls sich der Stand während des Aufbaus ändert
      for (let i = 0; i < 3; i++) { const r = await buildIndex(db, compId, gen); if (r != null) return r; gen = indexState(db, compId).gen; }
      throw new Error('Sitemap ändert sich laufend, Index nicht fertig');
    })().finally(() => building.delete(compId)));
  }
  return building.get(compId);
}
/** Alle Indizes im Hintergrund vorbereiten (nach dem Start, damit der erste Abruf nicht warten muss). */
export async function prepareSitemapIndexes(db) {
  for (const { id } of db.prepare('SELECT DISTINCT competitor_id AS id FROM sitemap_urls').all()) {
    try { await ensureIndex(db, id); } catch (e) { console.error('Sitemap-Index:', e.message); }
  }
}

export const hasSitemap = (db, compId) => Boolean(db.prepare('SELECT 1 FROM sitemap_urls WHERE competitor_id=? LIMIT 1').get(compId));

/** Kennungen des eigenen Artikels, die in einer fremden URL vorkommen können (EAN, Herstellernummer, Artikelnummer). */
export function productIds(product) {
  const out = [];
  const add = (v, kind, minLen) => {
    const n = normId(v);
    if (n.length >= minLen && /\d/.test(n) && !out.some((x) => x.id === n)) out.push({ id: n, kind });
  };
  add(product.ean, 'EAN', 8);
  add(product.mpn, 'Herstellernummer', 6);
  add(product.number, 'Artikelnummer', 6);
  return out;
}

/** Kommt die Kennung als zusammenhängende Folge ganzer URL-Bestandteile vor? („hs-48206090-01-50-52-l“ enthält 48206090015052l) */
function idInUrl(e, id) {
  if (!e.norm.includes(id)) return false;
  for (let i = 0; i < e.parts.length; i++) {
    let s = '';
    for (let j = i; j < e.parts.length && s.length < id.length; j++) {
      s += e.parts[j];
      if (s === id) return true;
    }
  }
  return false;
}

/**
 * Passende Produkt-URLs zu einem eigenen Artikel. Zuerst Treffer über EAN, Herstellernummer oder Artikelnummer
 * in der URL (eindeutig, unabhängig von der Schreibweise des Namens), danach die ähnlichsten Namen (Marke + Name gegen URL-Bezeichnung).
 */
export async function sitemapCandidates(db, compId, product, { limit = 5, min = 0.25 } = {}) {
  const gen = await ensureIndex(db, compId);
  return timed(`Sitemap-Suche (Mitbewerber ${compId})`, () => searchIndex(db, compId, gen, product, { limit, min }));
}
function searchIndex(db, compId, gen, product, { limit, min }) {
  const cid = `cid:${q(cidOf(compId, gen))}`;
  const want = tokens(`${product.manufacturer ?? ''} ${product.name}`);
  const brand = [...tokens(product.manufacturer)].slice(0, 1); // erstes Markenwort („HSK - Die Badexperten“ → hsk)
  const ids = productIds(product);
  const sel = selectedCategories(db, compId);
  const inSel = (url) => !sel.length || inCategories(categoryOf(url), sel);
  const rowsOf = (match, cap) => {
    const uids = db.prepare('SELECT uid FROM sitemap_fts WHERE sitemap_fts MATCH ? ORDER BY rank LIMIT ?').all(match, cap).map((r) => r.uid);
    if (!uids.length) return [];
    const out = [];
    for (let i = 0; i < uids.length; i += 900) out.push(...db.prepare(`SELECT rowid AS rid, url, slug FROM sitemap_urls WHERE rowid IN (${uids.slice(i, i + 900).map(() => '?').join(',')})`).all(...uids.slice(i, i + 900)));
    return out.filter((r) => inSel(r.url));
  };
  // 1) Kennung als zusammenhängende Folge von URL-Bestandteilen (exakt über den Index)
  const byId = [];
  const idSeen = new Set();
  for (const x of ids) {
    if (x.id.length < 4 || x.id.length > 24) continue;
    for (const r of rowsOf(`${cid} AND ids:${q(x.id)}`, 500)) {
      if (idSeen.has(r.url)) continue;
      const parts = pathParts(r.url);
      if (idInUrl({ parts, norm: parts.join('') }, x.id)) { idSeen.add(r.url); byId.push({ url: r.url, slug: r.slug, score: 2, via: x.kind, rid: r.rid }); }
    }
  }
  // 2) ähnlichste Bezeichnungen: Marke (Wortanfang) und mindestens ein weiteres Wort, Ähnlichkeit wie bisher (Jaccard)
  const scored = [];
  if (want.size) {
    const rest = [...want].filter((t) => !brand.includes(t));
    const words = brand.length ? `${q(brand[0])}*${rest.length ? ` AND (${rest.map(q).join(' OR ')})` : ''}` : rest.map(q).join(' OR ');
    for (const r of rowsOf(`${cid} AND words:(${words})`, 4000)) {
      if (idSeen.has(r.url)) continue;
      if (brand.length && !brand.every((b) => r.slug.toLowerCase().includes(b))) continue;
      const s = jaccard(want, tokens(r.slug));
      if (s >= min) scored.push({ url: r.url, slug: r.slug, score: s, rid: r.rid });
    }
  }
  // Gleichstand wie früher in der Reihenfolge der Adressen
  byId.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  // Viele ID-Treffer heißen: Kennung zu unspezifisch (z. B. Teil vieler Varianten) – dann nur als normale Kandidaten
  const ids1 = byId.length <= 6 ? byId : [];
  // gleiche Seite unter www/ohne www nur einmal
  const seen = new Set();
  const out = [];
  for (const c of [...ids1, ...scored.sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))]) {
    let key = c.url;
    try { const u = new URL(c.url); key = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, ''); } catch { /* Rohwert */ }
    if (seen.has(key)) continue;
    seen.add(key);
    const { rid, ...rest } = c;
    out.push(c.rid != null ? rest : c);
  }
  return out.slice(0, Math.max(limit, ids1.length ? Math.min(ids1.length, 6) : 0));
}
