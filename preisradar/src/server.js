import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, upsertProducts, tx } from './db.js';
import { parseCsv, pick, parsePrice, csvEscape } from './util.js';
import { extractProduct, findCandidates } from './extract.js';
import { fetchText, robotsAllows } from './fetcher.js';
import { fetchShopwareProducts, shopwareConfig, testShopware } from './shopware.js';
import { aiConfig, testAi, DEFAULT_MODEL } from './ai.js';
import { analyse } from './analysis.js';
import { autoSetup } from './autosetup.js';
import { startOwnImport, ownImportState } from './ownimport.js';
import { refreshSitemaps, refreshOwnSitemap, discoverSitemaps, sitemapList } from './sitemap.js';
import { pageDigest, aiExtract } from './aiscrape.js';
import { initSecrets, getSetting, setSetting, hasSetting } from './settings.js';
import { hashPassword, verifyPassword, createSession, destroySession, currentUser, hasUsers, tooManyAttempts, clearAttempts } from './auth.js';
import { startScrape, scrapeState } from './scraper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRAPE_HOURS = String(process.env.SCRAPE_HOURS ?? '6,18').split(',').map((x) => Number(x.trim())).filter((x) => x >= 0 && x < 24);

export function createApp(db, { dataDir = null } = {}) {
  initSecrets(dataDir);
  const ownName = () => getSetting(db, 'own_name') || process.env.OWN_SHOP_NAME || 'BelKai';
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '25mb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    // Schreibende Anfragen nur als JSON (schützt zusätzlich vor Formular-Angriffen von fremden Seiten)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Nur JSON erlaubt' });
    }
    next();
  });

  // --- Anmeldung: Benutzer wird beim ersten Aufruf angelegt ---
  const bad0 = (msg, status = 400) => Object.assign(new Error(msg), { status });
  const setupToken = process.env.SETUP_TOKEN || '';
  const checkCredentials = (username, password) => {
    if (!/^[\w.@-]{3,64}$/.test(username ?? '')) throw bad0('Benutzername: 3–64 Zeichen (Buchstaben, Zahlen, . _ - @)');
    if (String(password ?? '').length < 10) throw bad0('Das Passwort braucht mindestens 10 Zeichen');
  };
  app.get('/api/auth/state', (req, res) => {
    const user = currentUser(db, req);
    res.json({ setup: !hasUsers(db), setupTokenRequired: Boolean(setupToken) && !hasUsers(db), authenticated: Boolean(user), username: user?.username ?? null });
  });
  app.post('/api/auth/setup', (req, res) => {
    try {
      if (hasUsers(db)) throw bad0('Die Einrichtung ist bereits abgeschlossen', 409);
      if (tooManyAttempts(req)) throw bad0('Zu viele Versuche, bitte später erneut probieren', 429);
      const { username, password, setup_token } = req.body ?? {};
      if (setupToken && setup_token !== setupToken) throw bad0('Einrichtungscode falsch', 403);
      checkCredentials(username, password);
      const id = db.prepare('INSERT INTO users(username, password_hash, created_at) VALUES (?,?,?)').run(username, hashPassword(password), new Date().toISOString()).lastInsertRowid;
      createSession(db, Number(id), req, res);
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.post('/api/auth/login', (req, res) => {
    try {
      if (tooManyAttempts(req)) throw bad0('Zu viele Versuche, bitte später erneut probieren', 429);
      const { username, password } = req.body ?? {};
      const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username ?? ''));
      if (!u || !verifyPassword(String(password ?? ''), u.password_hash)) throw bad0('Benutzername oder Passwort falsch', 401);
      clearAttempts(req);
      createSession(db, u.id, req, res);
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.post('/api/auth/logout', (req, res) => { destroySession(db, req, res); res.json({ ok: true }); });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(express.static(path.join(here, '..', 'public')));

  // Ab hier nur mit Anmeldung
  app.use('/api', (req, res, next) => (currentUser(db, req) ? next() : res.status(401).json({ error: 'Nicht angemeldet' })));

  const wrap = (fn) => (req, res) => (async () => fn(req, res))().catch((e) => res.status(e.status || 500).json({ error: e.message })); // auch synchrone Fehler als JSON
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

  // --- Übersicht ---
  app.get('/api/overview', wrap((req, res) => {
    const competitors = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM sitemap_urls s WHERE s.competitor_id=c.id) AS sitemap_count FROM competitors c ORDER BY position, id').all();
    const counts = db.prepare('SELECT COUNT(*) AS "all", COALESCE(SUM(tracked),0) AS tracked FROM products WHERE active=1').get();
    // scope: tracked = beobachtete Artikel, all = komplette Artikelbasis; ohne Angabe beobachtete, sofern vorhanden
    const scope = req.query.scope === 'all' || (req.query.scope !== 'tracked' && !counts.tracked) ? 'all' : 'tracked';
    const products = db.prepare(`SELECT * FROM products WHERE active=1 ${scope === 'tracked' ? 'AND tracked=1' : ''} ORDER BY manufacturer, name`).all();
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
        checked: m.last_checked, error: m.last_error, source: m.source, previous: prevBy.get(m.id) ?? null, ai_note: m.ai_note,
      };
    }
    res.json({
      own: { name: ownName() },
      competitors,
      scope,
      counts,
      schedule: scheduleConfig(db),
      products: products.map((p) => ({ ...p, matches: byProduct.get(p.id) ?? {} })),
      scrape: { ...scrapeState },
      lastRun: db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() ?? null,
      config: { shopware: shopwareConfig(db).configured, scrapeHours: SCRAPE_HOURS, ai: Boolean(aiConfig(db).key) },
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
  const sitemapField = (v) => {
    const list = String(v ?? '').split(/\s+/).filter(Boolean);
    for (const u of list) {
      try { if (!/^https?:$/.test(new URL(u).protocol)) throw 0; } catch { throw bad(`Sitemap-URL ungültig: ${u}`); }
    }
    return list.join('\n') || null;
  };
  const compFields = (b) => {
    if (!b.name?.trim()) throw bad('Name fehlt');
    let base;
    try { base = new URL(b.base_url).origin; } catch { throw bad('Basis-URL ungültig (mit https:// angeben)'); }
    return [
      b.name.trim(), base, b.search_url?.trim() || null, b.result_selector?.trim() || null, b.price_selector?.trim() || null,
      Math.max(Number(process.env.MIN_DELAY_MS ?? 1000), Number(b.delay_ms) || 3000), b.enabled === false || b.enabled === 0 ? 0 : 1,
      ['off', 'fallback', 'always'].includes(b.ai_mode) ? b.ai_mode : 'fallback',
      sitemapField(b.sitemap_url),
    ];
  };
  app.post('/api/competitors', wrap((req, res) => {
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM competitors').get().p;
    const r = db.prepare('INSERT INTO competitors(name, base_url, search_url, result_selector, price_selector, delay_ms, enabled, ai_mode, sitemap_url, position) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...compFields(req.body), pos);
    res.json({ id: Number(r.lastInsertRowid) });
  }));
  app.put('/api/competitors/:id', wrap((req, res) => {
    db.prepare('UPDATE competitors SET name=?, base_url=?, search_url=?, result_selector=?, price_selector=?, delay_ms=?, enabled=?, ai_mode=?, sitemap_url=? WHERE id=?').run(...compFields(req.body), Number(req.params.id));
    res.json({ ok: true });
  }));
  // Mitbewerber per Produktlink einrichten: analysieren (create=false) oder direkt anlegen (create=true)
  app.post('/api/competitors/autosetup', wrap(async (req, res) => {
    const cfg = aiConfig(db);
    const r = await autoSetup(String(req.body?.product_url ?? '').trim(), { ai: cfg.key ? { cfg } : null });
    if (req.body?.create) {
      if (!r.product && !r.search_url && !r.sitemaps.length) throw bad('Der Shop lässt sich nicht automatisch einrichten: ' + r.notes.join(' '));
      const name = String(req.body?.name || r.name).trim();
      const body = {
        name, base_url: r.base_url, search_url: r.search_url, delay_ms: 3000, ai_mode: r.ai_mode, enabled: true,
        sitemap_url: r.search_url ? '' : r.sitemaps.map((s) => s.url).join('\n'),
      };
      const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM competitors').get().p;
      const ins = db.prepare('INSERT INTO competitors(name, base_url, search_url, result_selector, price_selector, delay_ms, enabled, ai_mode, sitemap_url, position) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...compFields(body), pos);
      // Produktlink als bekannte URL ist nicht möglich (Zuordnung zu eigenem Artikel fehlt), daher nur der Mitbewerber
      return res.json({ ...r, created: true, id: Number(ins.lastInsertRowid) });
    }
    res.json(r);
  }));
  app.post('/api/sitemaps/discover', wrap(async (req, res) => {
    let base;
    try { base = new URL(req.body?.base_url).origin; } catch { throw bad('Shop-URL ungültig (mit https:// angeben)'); }
    res.json({ sitemaps: await discoverSitemaps(base) });
  }));
  // Artikelbasis aus der eigenen Sitemap importieren (Hintergrundjob)
  app.post('/api/import/sitemap', wrap((req, res) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM own_sitemap_urls').get().n;
    if (!n) throw bad('Eigene Sitemap erst einlesen (Einstellungen → Dein Shop)');
    const limit = Math.max(0, Math.floor(Number(req.body?.limit) || 0)) || null;
    if (!startOwnImport(db, { limit, all: req.body?.all === true, tracked: req.body?.tracked === true })) throw bad('Es läuft bereits ein Import', 409);
    res.json({ ok: true, ...ownImportState });
  }));
  app.post('/api/import/sitemap/stop', wrap((_req, res) => { ownImportState.stop = true; res.json({ ok: true }); }));
  app.get('/api/import/sitemap/status', wrap((_req, res) => res.json(ownImportState)));
  app.post('/api/settings/own-sitemap/refresh', wrap(async (req, res) => {
    const urls = sitemapList({ sitemap_url: getSetting(db, 'own_sitemap_url') });
    if (!urls.length) throw bad('Keine eigene Sitemap hinterlegt (erst speichern)');
    res.json(await refreshOwnSitemap(db, urls));
  }));
  app.post('/api/competitors/:id/sitemap/refresh', wrap(async (req, res) => {
    const comp = db.prepare('SELECT * FROM competitors WHERE id=?').get(Number(req.params.id));
    if (!comp) throw bad('Mitbewerber nicht gefunden', 404);
    if (!comp.sitemap_url) throw bad('Keine Sitemap-URL hinterlegt');
    res.json(await refreshSitemaps(db, comp));
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
      if (r.finalUrl !== product_url && !(await robotsAllows(r.finalUrl))) return res.json({ blocked: true, message: 'robots.txt untersagt das Weiterleitungsziel dieser URL.' });
      const e = extractProduct(r.text, { priceSelector: price_selector });
      out.product = { http: r.status, found: e.found, price: e.price, title: e.title, source: e.source, availability: e.availability, ids: [...e.ids].slice(0, 8) };
      if (req.body.use_ai) {
        const cfg = aiConfig(db);
        const sample = { name: String(req.body.sample_name ?? ''), manufacturer: null, number: null, ean: req.body.sample_ean || null, mpn: null };
        const a = await aiExtract(cfg, sample, pageDigest(r.text), r.finalUrl);
        out.ai = a && { isProductPage: a.isProductPage, title: a.title, price: a.price, priceUngrounded: a.priceUngrounded, availability: a.availability, same: a.same, confidence: a.confidence, reason: a.reason };
      }
    }
    if (search_url && query) {
      const tpl = search_url.includes('{q}') ? search_url : `${search_url}${search_url.includes('?') ? '&' : '?'}q={q}`;
      const url = tpl.replace('{q}', encodeURIComponent(query));
      if (!(await robotsAllows(url))) return res.json({ ...out, blocked: true, message: 'robots.txt untersagt die Suche unter dieser URL.' });
      const r = await fetchText(url);
      if (r.finalUrl !== url && !(await robotsAllows(r.finalUrl))) return res.json({ ...out, blocked: true, message: `Die Suche leitet auf ${new URL(r.finalUrl).pathname} weiter, und die robots.txt untersagt dieses Ziel.` });
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
    const rows = await fetchShopwareProducts(shopwareConfig(db));
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

  // --- Beobachtete Artikel (nur diese werden bei Mitbewerbern abgeglichen) ---
  app.post('/api/products/track', wrap((req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) throw bad('Keine Artikel ausgewählt');
    if (ids.length > 100000) throw bad('Zu viele Artikel auf einmal');
    const v = req.body?.tracked === false ? 0 : 1;
    const upd = db.prepare('UPDATE products SET tracked=? WHERE id=?');
    tx(db, () => { for (const id of ids) upd.run(v, id); });
    res.json({ ok: true, changed: ids.length, counts: db.prepare('SELECT COUNT(*) AS "all", COALESCE(SUM(tracked),0) AS tracked FROM products WHERE active=1').get() });
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

  // --- Einstellungen ---
  app.get('/api/settings', wrap((_req, res) => {
    const cfg = shopwareConfig(db);
    res.json({
      own_name: ownName(),
      own_url: getSetting(db, 'own_url') || process.env.OWN_SHOP_URL || '',
      own_sitemap_url: getSetting(db, 'own_sitemap_url') || '',
      schedule: scheduleConfig(db),
      shopware_url: cfg.url,
      shopware_client_id: cfg.clientId,
      shopware_secret_set: Boolean(cfg.clientSecret),
      shopware_from_env: !hasSetting(db, 'shopware_url') && Boolean(process.env.SHOPWARE_URL),
      openai_key_set: Boolean(aiConfig(db).key),
      openai_from_env: !hasSetting(db, 'openai_api_key') && Boolean(process.env.OPENAI_API_KEY),
      openai_model: aiConfig(db).model,
      openai_default_model: DEFAULT_MODEL,
    });
  }));
  const cleanUrl = (u) => {
    if (!u?.trim()) return '';
    try { return new URL(u.trim()).origin; } catch { throw bad('URL ungültig (mit https:// angeben)'); }
  };
  app.put('/api/settings', wrap((req, res) => {
    const b = req.body ?? {};
    if (b.own_name !== undefined) setSetting(db, 'own_name', String(b.own_name).trim());
    if (b.own_url !== undefined) setSetting(db, 'own_url', cleanUrl(b.own_url));
    if (b.schedule && typeof b.schedule === 'object') {
      const sc = b.schedule;
      if (['rolling', 'slots'].includes(sc.mode)) setSetting(db, 'scrape_mode', sc.mode);
      for (const [k, key] of [['batch', 'scrape_batch'], ['interval', 'scrape_interval'], ['jitter', 'scrape_jitter'], ['refresh', 'scrape_refresh_hours']]) {
        if (sc[k] !== undefined && sc[k] !== '' && Number.isFinite(Number(sc[k]))) setSetting(db, key, String(Number(sc[k])));
      }
    }
    if (b.own_sitemap_url !== undefined) setSetting(db, 'own_sitemap_url', sitemapField(b.own_sitemap_url));
    if (b.shopware_url !== undefined) setSetting(db, 'shopware_url', cleanUrl(b.shopware_url));
    if (b.shopware_client_id !== undefined) setSetting(db, 'shopware_client_id', String(b.shopware_client_id).trim());
    if (b.shopware_client_secret) setSetting(db, 'shopware_client_secret', String(b.shopware_client_secret).trim(), { secret: true });
    if (b.openai_api_key) setSetting(db, 'openai_api_key', String(b.openai_api_key).trim(), { secret: true });
    if (typeof b.openai_model === 'string') setSetting(db, 'openai_model', b.openai_model.trim());
    if (b.openai_remove_key) setSetting(db, 'openai_api_key', '');
    res.json({ ok: true });
  }));
  app.post('/api/settings/shopware/test', wrap(async (req, res) => {
    const b = req.body ?? {};
    const stored = shopwareConfig(db);
    const cfg = {
      url: cleanUrl(b.shopware_url) || stored.url,
      clientId: String(b.shopware_client_id || stored.clientId).trim(),
      clientSecret: String(b.shopware_client_secret || stored.clientSecret).trim(),
    };
    Object.defineProperty(cfg, 'configured', { get: () => Boolean(cfg.url && cfg.clientId && cfg.clientSecret) });
    res.json({ ok: true, ...(await testShopware(cfg)) });
  }));
  app.post('/api/auth/password', wrap((req, res) => {
    const { current, password } = req.body ?? {};
    const user = currentUser(db, req);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!verifyPassword(String(current ?? ''), u.password_hash)) throw bad('Aktuelles Passwort falsch', 401);
    if (String(password ?? '').length < 10) throw bad('Das neue Passwort braucht mindestens 10 Zeichen');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    createSession(db, u.id, req, res);
    res.json({ ok: true });
  }));

  // --- Benutzerverwaltung (alle angemeldeten Benutzer sind gleichberechtigt) ---
  app.get('/api/users', wrap((req, res) => {
    const me = currentUser(db, req);
    res.json(db.prepare('SELECT id, username, created_at FROM users ORDER BY username').all().map((u) => ({ ...u, me: u.id === me.id })));
  }));
  app.post('/api/users', wrap((req, res) => {
    const { username, password } = req.body ?? {};
    checkCredentials(username, password);
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw bad('Diesen Benutzernamen gibt es schon', 409);
    const id = db.prepare('INSERT INTO users(username, password_hash, created_at) VALUES (?,?,?)').run(username, hashPassword(password), new Date().toISOString()).lastInsertRowid;
    res.json({ id: Number(id) });
  }));
  app.put('/api/users/:id/password', wrap((req, res) => {
    const id = Number(req.params.id);
    const { password } = req.body ?? {};
    if (String(password ?? '').length < 10) throw bad('Das Passwort braucht mindestens 10 Zeichen');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) throw bad('Benutzer nicht gefunden', 404);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), id);
    const me = currentUser(db, req);
    if (id !== me.id) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); // andere Benutzer werden abgemeldet
    res.json({ ok: true });
  }));
  app.delete('/api/users/:id', wrap((req, res) => {
    const id = Number(req.params.id);
    if (id === currentUser(db, req).id) throw bad('Das eigene Konto kann nicht gelöscht werden', 409);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    res.json({ ok: true });
  }));

  // --- KI ---
  app.post('/api/settings/openai/test', wrap(async (req, res) => {
    const b = req.body ?? {};
    const cfg = aiConfig(db);
    if (b.openai_api_key) cfg.key = String(b.openai_api_key).trim();
    if (b.openai_model) cfg.model = String(b.openai_model).trim();
    res.json(await testAi(cfg));
  }));
  app.get('/api/analysis', wrap((_req, res) => res.json(analyse(db))));

  // --- Export ---
  app.get('/api/export.csv', wrap((_req, res) => {
    const comps = db.prepare('SELECT * FROM competitors ORDER BY position, id').all();
    const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY manufacturer, name').all();
    const ms = db.prepare('SELECT * FROM matches').all();
    const key = new Map(ms.map((m) => [`${m.product_id}:${m.competitor_id}`, m]));
    const fmt = (n) => (n == null ? '' : Number(n).toFixed(2).replace('.', ','));
    const lines = [['Artikelnummer', 'EAN', 'Hersteller', 'Name', `${ownName()} Preis`, ...comps.flatMap((c) => [`${c.name} Preis`, `${c.name} URL`])].map(csvEscape).join(';')];
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

const clamp = (v, lo, hi, dflt) => { const n = v == null || v === '' ? NaN : Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

/** Abrufplan. rolling: laufend kleine Pakete über den Tag verteilt; slots: feste Uhrzeiten (SCRAPE_HOURS). */
export function scheduleConfig(db) {
  return {
    mode: getSetting(db, 'scrape_mode') === 'slots' ? 'slots' : 'rolling',
    batch: clamp(getSetting(db, 'scrape_batch'), 1, 1000, 100), // Artikel je Mitbewerber und Paket
    interval: clamp(getSetting(db, 'scrape_interval'), 10, 86400, 200), // Sekunden zwischen den Paketen
    jitter: clamp(getSetting(db, 'scrape_jitter'), 0, 3600, 100), // zufälliger Aufschlag in Sekunden
    refresh: clamp(getSetting(db, 'scrape_refresh_hours'), 1, 168, 12), // Mindestabstand je Artikel in Stunden
    hours: SCRAPE_HOURS,
  };
}

export function startScheduler(db) {
  const done = new Set(); // "YYYY-MM-DD-HH" – pro Zeitfenster nur ein Lauf (Modus slots)
  const tick = () => {
    let next = 60;
    try {
      const cfg = scheduleConfig(db);
      if (cfg.mode === 'rolling') {
        if (!scrapeState.running) startScrape(db, { trigger: 'rolling', limitPerCompetitor: cfg.batch, minIntervalH: cfg.refresh });
        next = cfg.interval + Math.random() * cfg.jitter;
      } else {
        const d = new Date();
        const slot = `${d.toISOString().slice(0, 10)}-${d.getHours()}`;
        if (SCRAPE_HOURS.includes(d.getHours()) && !done.has(slot) && startScrape(db, { trigger: 'schedule' })) {
          done.add(slot);
          if (done.size > 10) done.delete(done.values().next().value);
        }
      }
    } catch (e) {
      console.error('Zeitplan:', e.message);
    }
    setTimeout(tick, next * 1000).unref();
  };
  setTimeout(tick, 30 * 1000).unref();
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
    const vals = [base, c.search_url ?? null, c.result_selector ?? null, c.price_selector ?? null, Number(c.delay_ms) || 3000, c.enabled === false ? 0 : 1, ['off', 'fallback', 'always'].includes(c.ai_mode) ? c.ai_mode : 'fallback', c.sitemap_url ? [].concat(c.sitemap_url).join('\n') : null];
    if (row) db.prepare('UPDATE competitors SET base_url=?, search_url=?, result_selector=?, price_selector=?, delay_ms=?, enabled=?, ai_mode=?, sitemap_url=? WHERE id=?').run(...vals, row.id);
    else db.prepare('INSERT INTO competitors(name, base_url, search_url, result_selector, price_selector, delay_ms, enabled, ai_mode, sitemap_url, position) VALUES (?,?,?,?,?,?,?,?,?,?)').run(c.name, ...vals, 100 + n);
    n++;
  }
  return n;
}

/**
 * Einmalige Grundeinrichtung aus data/bootstrap.json (im Repo): eigene Sitemap, Import der ersten Artikel,
 * Mitbewerber anlegen (nur wenn es sie noch nicht gibt). Wird pro "id" nur einmal vollständig ausgeführt;
 * wird der Server mitten im Import neu gestartet, läuft er beim nächsten Start weiter (importierte Seiten werden übersprungen).
 */
export async function applyBootstrap(db, file = process.env.BOOTSTRAP_FILE || './data/bootstrap.json') {
  if (!fs.existsSync(file)) return null;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cfg.id || getSetting(db, 'bootstrap_done') === cfg.id) return null;
  for (const c of cfg.competitors ?? []) {
    if (!c?.name || !c?.base_url || db.prepare('SELECT 1 FROM competitors WHERE name=?').get(c.name)) continue;
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM competitors').get().p;
    db.prepare('INSERT INTO competitors(name, base_url, search_url, delay_ms, enabled, ai_mode, sitemap_url, position) VALUES (?,?,?,?,1,?,?,?)')
      .run(c.name, new URL(c.base_url).origin, c.search_url ?? null, Number(c.delay_ms) || 3000, ['off', 'fallback', 'always'].includes(c.ai_mode) ? c.ai_mode : 'fallback', c.sitemap_url ? [].concat(c.sitemap_url).join('\n') : null, pos);
    console.log(`Bootstrap: Mitbewerber ${c.name} angelegt`);
  }
  const own = [].concat(cfg.own_sitemap_url ?? []).filter(Boolean);
  if (own.length) {
    if (!getSetting(db, 'own_sitemap_url')) setSetting(db, 'own_sitemap_url', own.join('\n'));
    const urls = String(getSetting(db, 'own_sitemap_url')).split(/\s+/).filter(Boolean);
    const r = await refreshOwnSitemap(db, urls);
    console.log(`Bootstrap: eigene Sitemap, ${r.count} URLs, ${r.assigned} zugeordnet`);
  }
  if (cfg.import?.limit) {
    const have = db.prepare("SELECT COUNT(*) AS n FROM products WHERE source='sitemap'").get().n;
    const want = Math.max(0, Number(cfg.import.limit) - have);
    if (want && startOwnImport(db, { limit: want, tracked: cfg.import.tracked !== false })) {
      console.log(`Bootstrap: importiere ${want} Artikel aus der Sitemap`);
      while (ownImportState.running) await new Promise((r) => setTimeout(r, 2000));
      if (ownImportState.errors > ownImportState.done / 2) return console.error('Bootstrap: zu viele Fehler, wird beim nächsten Start wiederholt');
    }
  }
  setSetting(db, 'bootstrap_done', cfg.id);
  console.log('Bootstrap abgeschlossen');
  return cfg.id;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const seeded = seedCompetitors(db);
  if (seeded) console.log(`${seeded} Mitbewerber aus Datei übernommen`);
  const port = Number(process.env.PORT || 3000);
  createApp(db, { dataDir: path.dirname(process.env.DB_PATH || './data/preisradar.db') }).listen(port, () => console.log(`Preisradar läuft auf Port ${port}`));
  startScheduler(db);
  applyBootstrap(db).catch((e) => console.error('Bootstrap fehlgeschlagen:', e.message));
}
