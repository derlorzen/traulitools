import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { openDb, upsertProducts, tx } from './db.js';
import { parseCsv, pick, parsePrice, csvEscape } from './util.js';
import { extractProduct, findCandidates } from './extract.js';
import { fetchText, robotsAllows } from './fetcher.js';
import { fetchShopwareProducts, shopwareConfig } from './shopware.js';
import { startScrape, scrapeState } from './scraper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OWN_NAME = process.env.OWN_SHOP_NAME || 'BelKai';
const SCRAPE_HOURS = String(process.env.SCRAPE_HOURS ?? '6,18').split(',').map((x) => Number(x.trim())).filter((x) => x >= 0 && x < 24);

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' }));

  // --- Zugangsschutz (HTTP Basic) ---
  const user = process.env.APP_USER;
  const pass = process.env.APP_PASSWORD;
  if (user && pass) {
    const safeEq = (a, b) => {
      const A = crypto.createHash('sha256').update(a).digest();
      const B = crypto.createHash('sha256').update(b).digest();
      return crypto.timingSafeEqual(A, B);
    };
    app.use((req, res, next) => {
      if (req.path === '/healthz') return next();
      const h = req.headers.authorization || '';
      if (h.startsWith('Basic ')) {
        const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
        if (safeEq(u, user) && safeEq(rest.join(':'), pass)) return next();
      }
      res.set('WWW-Authenticate', 'Basic realm="Preisradar"').status(401).send('Anmeldung erforderlich');
    });
  } else {
    console.warn('WARNUNG: APP_USER/APP_PASSWORD nicht gesetzt – die App ist ohne Passwort erreichbar.');
  }

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 500).json({ error: e.message }));
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(express.static(path.join(here, '..', 'public')));

  // --- Übersicht ---
  app.get('/api/overview', wrap((_req, res) => {
    const competitors = db.prepare('SELECT * FROM competitors ORDER BY position, id').all();
    const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY manufacturer, name').all();
    const matches = db.prepare('SELECT * FROM matches').all();
    const prev = db.prepare(`
      SELECT h.match_id, h.price FROM price_history h
      JOIN (SELECT match_id, MAX(at) AS at FROM price_history WHERE at < (SELECT MAX(at) FROM price_history h2 WHERE h2.match_id = price_history.match_id) GROUP BY match_id) l
      ON l.match_id = h.match_id AND l.at = h.at`).all();
    const prevBy = new Map(prev.map((r) => [r.match_id, r.price]));
    const byProduct = new Map();
    for (const m of matches) {
      if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, {});
      byProduct.get(m.product_id)[m.competitor_id] = {
        id: m.id, status: m.status, price: m.price, url: m.url, title: m.title, availability: m.availability,
        checked: m.last_checked, error: m.last_error, source: m.source, previous: prevBy.get(m.id) ?? null,
      };
    }
    res.json({
      own: { name: OWN_NAME },
      competitors,
      products: products.map((p) => ({ ...p, matches: byProduct.get(p.id) ?? {} })),
      scrape: { ...scrapeState },
      lastRun: db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() ?? null,
      config: { shopware: shopwareConfig().configured, scrapeHours: SCRAPE_HOURS },
    });
  }));

  app.get('/api/products/:id/history', wrap((req, res) => {
    const id = Number(req.params.id);
    const own = db.prepare('SELECT price, at FROM product_price_history WHERE product_id=? ORDER BY at').all(id);
    const series = db.prepare(`
      SELECT m.competitor_id, c.name FROM matches m JOIN competitors c ON c.id=m.competitor_id WHERE m.product_id=?`).all(id)
      .map((s) => ({
        ...s,
        points: db.prepare('SELECT h.price, h.at FROM price_history h JOIN matches m ON m.id=h.match_id WHERE m.product_id=? AND m.competitor_id=? ORDER BY h.at').all(id, s.competitor_id),
      }));
    res.json({ own, series });
  }));

  // --- Mitbewerber ---
  const compFields = (b) => {
    if (!b.name?.trim()) throw bad('Name fehlt');
    let base;
    try { base = new URL(b.base_url).origin; } catch { throw bad('Basis-URL ungültig (mit https:// angeben)'); }
    return [
      b.name.trim(), base, b.search_url?.trim() || null, b.result_selector?.trim() || null, b.price_selector?.trim() || null,
      Math.max(Number(process.env.MIN_DELAY_MS ?? 1000), Number(b.delay_ms) || 3000), b.enabled === false || b.enabled === 0 ? 0 : 1,
    ];
  };
  app.post('/api/competitors', wrap((req, res) => {
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM competitors').get().p;
    const r = db.prepare('INSERT INTO competitors(name, base_url, search_url, result_selector, price_selector, delay_ms, enabled, position) VALUES (?,?,?,?,?,?,?,?)').run(...compFields(req.body), pos);
    res.json({ id: Number(r.lastInsertRowid) });
  }));
  app.put('/api/competitors/:id', wrap((req, res) => {
    db.prepare('UPDATE competitors SET name=?, base_url=?, search_url=?, result_selector=?, price_selector=?, delay_ms=?, enabled=? WHERE id=?').run(...compFields(req.body), Number(req.params.id));
    res.json({ ok: true });
  }));
  app.delete('/api/competitors/:id', wrap((req, res) => {
    db.prepare('DELETE FROM competitors WHERE id=?').run(Number(req.params.id));
    res.json({ ok: true });
  }));

  // Einrichtungshilfe: Produktseite oder Suche eines Mitbewerbers ausprobieren
  app.post('/api/competitors/test', wrap(async (req, res) => {
    const { product_url, search_url, query, result_selector, price_selector } = req.body ?? {};
    const out = {};
    if (product_url) {
      if (!(await robotsAllows(product_url))) return res.json({ blocked: true, message: 'robots.txt untersagt den Abruf dieser URL.' });
      const r = await fetchText(product_url);
      const e = extractProduct(r.text, { priceSelector: price_selector });
      out.product = { http: r.status, found: e.found, price: e.price, title: e.title, source: e.source, availability: e.availability, ids: [...e.ids].slice(0, 8) };
    }
    if (search_url && query) {
      const tpl = search_url.includes('{q}') ? search_url : `${search_url}${search_url.includes('?') ? '&' : '?'}q={q}`;
      const url = tpl.replace('{q}', encodeURIComponent(query));
      if (!(await robotsAllows(url))) return res.json({ ...out, blocked: true, message: 'robots.txt untersagt die Suche unter dieser URL.' });
      const r = await fetchText(url);
      out.search = { url, http: r.status, candidates: findCandidates(r.text, r.finalUrl, { resultSelector: result_selector }) };
    }
    res.json(out);
  }));

  // --- Zuordnungen ---
  app.put('/api/matches', wrap(async (req, res) => {
    const { product_id, competitor_id, url } = req.body ?? {};
    let u = null;
    if (url?.trim()) {
      try { u = new URL(url.trim()).toString(); } catch { throw bad('URL ungültig'); }
    }
    db.prepare("INSERT OR IGNORE INTO matches(product_id, competitor_id, status) VALUES (?,?,'pending')").run(product_id, competitor_id);
    if (u) db.prepare("UPDATE matches SET url=?, source='manual', status='pending', last_checked=NULL, last_error=NULL WHERE product_id=? AND competitor_id=?").run(u, product_id, competitor_id);
    else db.prepare("UPDATE matches SET url=NULL, source='auto', status='pending', price=NULL, last_checked=NULL, last_error=NULL WHERE product_id=? AND competitor_id=?").run(product_id, competitor_id);
    startScrape(db, { trigger: 'manual', productId: product_id, competitorId: competitor_id, force: true });
    res.json({ ok: true });
  }));
  app.post('/api/matches/:id/confirm', wrap((req, res) => {
    db.prepare("UPDATE matches SET status='ok', source='manual' WHERE id=? AND url IS NOT NULL").run(Number(req.params.id));
    res.json({ ok: true });
  }));
  app.post('/api/matches/:id/reject', wrap((req, res) => {
    db.prepare("UPDATE matches SET url=NULL, price=NULL, title=NULL, status='not_found', source='auto', last_error='Vorschlag verworfen', last_checked=? WHERE id=?").run(new Date().toISOString(), Number(req.params.id));
    res.json({ ok: true });
  }));

  // --- Import ---
  app.post('/api/import/shopware', wrap(async (_req, res) => {
    const rows = await fetchShopwareProducts();
    res.json({ total: rows.length, ...upsertProducts(db, rows, 'shopware') });
  }));
  app.post('/api/import/csv', wrap((req, res) => {
    const rows = parseCsv(req.body?.text).map((r) => ({
      number: pick(r, ['Artikelnummer', 'productNumber', 'sku', 'Nummer', 'number']),
      ean: pick(r, ['EAN', 'GTIN', 'ean']),
      mpn: pick(r, ['Herstellernummer', 'manufacturerNumber', 'mpn', 'HAN']),
      name: pick(r, ['Name', 'Titel', 'Produktname', 'name', 'title']),
      manufacturer: pick(r, ['Hersteller', 'Marke', 'manufacturer', 'brand']),
      url: pick(r, ['URL', 'Link', 'url']),
      price: parsePrice(pick(r, ['Preis', 'Bruttopreis', 'price', 'gross'])),
    })).filter((r) => r.number && r.name);
    if (!rows.length) throw bad('Keine gültigen Zeilen gefunden. Benötigt: Artikelnummer und Name (optional EAN, Herstellernummer, Hersteller, Preis, URL).');
    res.json({ total: rows.length, ...upsertProducts(db, rows, 'csv') });
  }));
  // CSV mit bekannten Mitbewerber-URLs: Artikelnummer; Mitbewerber; URL
  app.post('/api/import/urls', wrap((req, res) => {
    const comps = new Map(db.prepare('SELECT id, name FROM competitors').all().map((c) => [c.name.toLowerCase(), c.id]));
    const prods = new Map(db.prepare('SELECT id, number FROM products').all().map((p) => [p.number, p.id]));
    let set = 0;
    const skipped = [];
    tx(db, () => {
      for (const r of parseCsv(req.body?.text)) {
        const num = pick(r, ['Artikelnummer', 'productNumber', 'number']);
        const cn = pick(r, ['Mitbewerber', 'competitor', 'Shop']);
        const url = pick(r, ['URL', 'Link', 'url']);
        const pid = prods.get(num);
        const cid = comps.get(String(cn).toLowerCase());
        if (!pid || !cid || !url) { skipped.push(num || '?'); continue; }
        db.prepare("INSERT OR IGNORE INTO matches(product_id, competitor_id, status) VALUES (?,?,'pending')").run(pid, cid);
        db.prepare("UPDATE matches SET url=?, source='manual', status='pending', last_checked=NULL WHERE product_id=? AND competitor_id=?").run(url, pid, cid);
        set++;
      }
    });
    res.json({ set, skipped: skipped.length });
  }));

  // --- Abruf starten/stoppen ---
  app.post('/api/scrape', wrap((req, res) => {
    const { competitor_id = null, product_id = null, force = false } = req.body ?? {};
    const started = startScrape(db, { trigger: 'manual', competitorId: competitor_id, productId: product_id, force });
    if (!started) throw bad('Es läuft bereits ein Abruf', 409);
    res.json({ ok: true, total: scrapeState.total });
  }));
  app.post('/api/scrape/stop', (_req, res) => { scrapeState.stop = true; res.json({ ok: true }); });
  app.get('/api/scrape/status', (_req, res) => res.json({ ...scrapeState }));
  app.get('/api/runs', wrap((_req, res) => res.json(db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 30').all())));

  // --- Export ---
  app.get('/api/export.csv', wrap((_req, res) => {
    const comps = db.prepare('SELECT * FROM competitors ORDER BY position, id').all();
    const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY manufacturer, name').all();
    const ms = db.prepare('SELECT * FROM matches').all();
    const key = new Map(ms.map((m) => [`${m.product_id}:${m.competitor_id}`, m]));
    const fmt = (n) => (n == null ? '' : Number(n).toFixed(2).replace('.', ','));
    const lines = [['Artikelnummer', 'EAN', 'Hersteller', 'Name', `${OWN_NAME} Preis`, ...comps.flatMap((c) => [`${c.name} Preis`, `${c.name} URL`])].map(csvEscape).join(';')];
    for (const p of products) {
      lines.push([p.number, p.ean, p.manufacturer, p.name, fmt(p.price), ...comps.flatMap((c) => {
        const m = key.get(`${p.id}:${c.id}`);
        return [m && (m.status === 'ok' || m.status === 'review') ? fmt(m.price) : '', m?.url ?? ''];
      })].map(csvEscape).join(';'));
    }
    res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="preisvergleich.csv"' });
    res.send('﻿' + lines.join('\r\n'));
  }));

  return app;
}

export function startScheduler(db) {
  const done = new Set(); // "YYYY-MM-DD-HH" – pro Zeitfenster nur ein Lauf
  setInterval(() => {
    const d = new Date();
    const slot = `${d.toISOString().slice(0, 10)}-${d.getHours()}`;
    if (SCRAPE_HOURS.includes(d.getHours()) && !done.has(slot) && startScrape(db, { trigger: 'schedule' })) {
      done.add(slot);
      if (done.size > 10) done.delete(done.values().next().value);
    }
  }, 60 * 1000).unref();
}

/** Mitbewerber aus einer JSON-Datei übernehmen (Schlüssel: Name), z. B. data/competitors.json. */
export function seedCompetitors(db, file = process.env.COMPETITORS_FILE || './data/competitors.json') {
  if (!fs.existsSync(file)) return 0;
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  for (const c of Array.isArray(list) ? list : []) {
    if (!c?.name || !c?.base_url) continue;
    const base = new URL(c.base_url).origin;
    const row = db.prepare('SELECT id FROM competitors WHERE name=?').get(c.name);
    const vals = [base, c.search_url ?? null, c.result_selector ?? null, c.price_selector ?? null, Number(c.delay_ms) || 3000, c.enabled === false ? 0 : 1];
    if (row) db.prepare('UPDATE competitors SET base_url=?, search_url=?, result_selector=?, price_selector=?, delay_ms=?, enabled=? WHERE id=?').run(...vals, row.id);
    else db.prepare('INSERT INTO competitors(name, base_url, search_url, result_selector, price_selector, delay_ms, enabled, position) VALUES (?,?,?,?,?,?,?,?)').run(c.name, ...vals, 100 + n);
    n++;
  }
  return n;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const seeded = seedCompetitors(db);
  if (seeded) console.log(`${seeded} Mitbewerber aus Datei übernommen`);
  const port = Number(process.env.PORT || 3000);
  createApp(db).listen(port, () => console.log(`Preisradar läuft auf Port ${port}`));
  startScheduler(db);
}
