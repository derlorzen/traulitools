import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, upsertProducts, tx } from './db.js';
import { parseCsv, pick, parsePrice, csvEscape } from './util.js';
import { extractProduct, findCandidates } from './extract.js';
import { fetchText, robotsAllows, paceInfo } from './fetcher.js';
import { fetchShopwareProducts, shopwareConfig, testShopware, syncShopware, productDetails } from './shopware.js';
import { aiConfig, testAi, chatJson, DEFAULT_MODEL } from './ai.js';
import { analyse, RULES } from './analysis.js';
import { autoSetup, detectSearchLink } from './autosetup.js';
import { startOwnImport, ownImportState } from './ownimport.js';
import { refreshSitemaps, refreshOwnSitemap, discoverSitemaps, sitemapList, sitemapCategories, clearSitemapCache } from './sitemap.js';
import { pageDigest, aiExtract, initAiBudget, aiUsage, DEFAULT_AI_DAILY_LIMIT } from './aiscrape.js';
import { initSecrets, getSetting, setSetting, hasSetting } from './settings.js';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, createSession, destroySession, currentUser, hasUsers, tooManyAttempts, clearAttempts } from './auth.js';
import { startScrape, scrapeState, closeStaleRuns, checkProductNow } from './scraper.js';
import { listProducts, getProduct, invalidatePriceList, warmPriceList } from './pricelist.js';
import { loadTemplates, removeTemplate } from './templates.js';
import { gscSites, syncGsc, saveServiceAccount, gscConfig, pageKey as pageKeyOf } from './gsc.js';
import { seoOverview, seoStatus, productSeo } from './seo.js';
import { mailConfig, digestData, digestHtml, sendDigest, maybeSendDigest } from './digest.js';
import { merchantConfig, merchantTest, syncMerchant, merchantSummary } from './merchant.js';
import { computeTiers, tierConfig, tierStatus } from './tiers.js';
import { listChannels, updateChannel, channelView } from './channels.js';
import { ebayConfig, authorizeUrl, exchangeCode, disconnect as ebayDisconnect, ebayTest, syncListings, startMarketJob, marketJob, marketCheck, ebayTick, suggestCategories, aspects as ebayAspects, policies as ebayPolicies, draft as ebayDraft, createListing, ebayOverview, resetAppToken, cleanDescription } from './ebay.js';
import { findOpportunities, jtlExport, productOpportunities } from './opportunities.js';
import { productSignals, withSignals } from './signals.js';
import { auditOverview, auditOf, auditProduct, startAudit, auditJob, auditTick, auditConfig, suggestMeta } from './seoaudit.js';
import { kwConfig, kwTest, addKeywords, postChecks, collectChecks, refreshVolumes, kwOverview, kwDetail, suggestions, startSuggestionJob, kwTick, kwJob, MAX_KEYWORDS, normKeyword } from './keywords.js';
import { mountMcp, mcpEnabled, createMcpToken, revokeMcpToken } from './mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRAPE_HOURS = String(process.env.SCRAPE_HOURS ?? '6,18').split(',').map((x) => Number(x.trim())).filter((x) => x >= 0 && x < 24);

export function createApp(db, { dataDir = null } = {}) {
  initSecrets(dataDir);
  initAiBudget(db);
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
  const internalKey = crypto.randomBytes(24).toString('hex'); // nur für Aufrufe des MCP-Endpunkts an die eigenen Routen
  mountMcp(app, db, { ownName, schedule: () => scheduleConfig(db), internalKey }); // eigene Token-Prüfung, vor der Sitzungsprüfung
  app.use(express.static(path.join(here, '..', 'public')));

  // Ab hier nur mit Anmeldung
  app.use('/api', (req, _res, next) => { if (req.method !== 'GET') invalidatePriceList(); next(); });
  // eBay-Rücksprung nach der Zustimmung (Browser-Weiterleitung von eBay, daher Umleitung statt JSON)
  app.get('/api/ebay/callback', (req, res) => {
    if (!currentUser(db, req)) return res.redirect('/?ebay=login');
    if (req.query.error) return res.redirect(`/?ebay=error&msg=${encodeURIComponent(String(req.query.error_description || req.query.error))}`);
    exchangeCode(db, String(req.query.code || ''), String(req.query.state || ''))
      .then(() => res.redirect('/?ebay=connected'))
      .catch((e) => res.redirect(`/?ebay=error&msg=${encodeURIComponent(e.message)}`));
  });
  app.use('/api', (req, res, next) => (req.headers['x-internal-mcp'] === internalKey || currentUser(db, req) ? next() : res.status(401).json({ error: 'Nicht angemeldet' })));
  // Adresse der App für Links in der E-Mail (vom ersten angemeldeten Aufruf übernommen)
  app.use('/api/overview', (req, _res, next) => { if (!getSetting(db, 'app_url') && !/^(localhost|127\.)/.test(req.hostname)) setSetting(db, 'app_url', `${req.protocol}://${req.get('host')}`); next(); });

  const wrap = (fn) => (req, res) => (async () => fn(req, res))().catch((e) => res.status(e.status || 500).json({ error: e.message })); // auch synchrone Fehler als JSON
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

  // --- Übersicht ---
  app.get('/api/overview', wrap((req, res) => {
    const since24 = new Date(Date.now() - 86400e3).toISOString();
    const competitors = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM sitemap_urls s WHERE s.competitor_id=c.id) AS sitemap_count,
      (SELECT COUNT(*) FROM matches m WHERE m.competitor_id=c.id AND m.last_checked >= ?) AS checked_24h FROM competitors c ORDER BY position, id`).all(since24)
      .map((c) => ({ ...c, pace: { ...paceInfo(c.base_url, c.delay_ms), live: scrapeState.comps?.[c.id] ?? null } }));
    const counts = db.prepare('SELECT COUNT(*) AS "all", COALESCE(SUM(tracked),0) AS tracked FROM products WHERE active=1').get();
    // scope: tracked = beobachtete Artikel, all = komplette Artikelbasis; ohne Angabe beobachtete, sofern vorhanden
    const scope = req.query.scope === 'all' || (req.query.scope !== 'tracked' && !counts.tracked) ? 'all' : 'tracked';
    res.json({
      own: { name: ownName() },
      competitors,
      scope,
      counts,
      schedule: scheduleConfig(db),
      offline: db.prepare('SELECT COUNT(*) AS n FROM products WHERE active=1 AND offline_since IS NOT NULL').get().n,
      tiers: tierStatus(db),
      scrape: { ...scrapeState },
      lastRun: db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() ?? null,
      config: { shopware: shopwareConfig(db).configured, scrapeHours: SCRAPE_HOURS, ai: Boolean(aiConfig(db).key), gsc: gscConfig(db).configured, merchant: merchantConfig(db).configured, keywords: kwConfig(db).configured, ebay: ebayConfig(db).app, ebayConnected: ebayConfig(db).connected, seoAudit: Boolean(db.prepare('SELECT 1 FROM seo_audit LIMIT 1').get()), swSynced: getSetting(db, 'sw_synced_at'), aiModel: aiConfig(db).model, aiUsage: aiUsage(), rules: RULES },
    });
  }));

  // --- Preisliste: seitenweise, gefiltert und sortiert ---
  app.get('/api/products', wrap((req, res) => { const r = listProducts(db, req.query); res.json({ ...r, rows: withSignals(db, r.rows) }); }));
  app.get('/api/products/:id', wrap((req, res) => {
    const p = getProduct(db, Number(req.params.id));
    if (!p) throw bad('Artikel nicht gefunden', 404);
    res.json(p);
  }));

  // Sofortprüfung eines Artikels bei allen Mitbewerbern (wartet auf das Ergebnis)
  app.post('/api/products/:id/check', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const results = await checkProductNow(db, id);
    invalidatePriceList();
    res.json({ results, product: getProduct(db, id) });
  }));

  // --- Google Merchant Center ---
  // --- Verkaufskanäle (Gebühren, Marge) ---
  app.get('/api/channels', wrap((_req, res) => res.json(listChannels(db))));
  app.put('/api/channels/:key', wrap((req, res) => res.json(updateChannel(db, req.params.key, req.body ?? {}))));
  app.get('/api/products/:id/channels', wrap((req, res) => {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(Number(req.params.id));
    if (!p) throw bad('Artikel nicht gefunden', 404);
    const l = db.prepare("SELECT item_id, price, url, quantity, sold, created_by_us, jtl_state FROM ebay_listings WHERE status='active' AND product_id=? LIMIT 1").get(p.id) ?? null;
    const m = db.prepare('SELECT * FROM ebay_market WHERE product_id=?').get(p.id) ?? null;
    const shopMin = db.prepare("SELECT MIN(m.price) AS v FROM matches m JOIN competitors c ON c.id=m.competitor_id WHERE c.enabled=1 AND m.product_id=? AND m.status='ok' AND m.price IS NOT NULL AND COALESCE(m.availability,'') <> 'out_of_stock'").get(p.id).v;
    res.json({ channels: channelView(db, p, { prices: { shop: p.price, ebay: l?.price ?? null }, market: { shop: shopMin ?? null, ebay: m?.min_total ?? null } }), ebay: { listing: l, market: m }, purchase_price: p.purchase_price ?? null });
  }));

  // --- eBay ---
  app.get('/api/ebay', wrap((_req, res) => { const o = ebayOverview(db); res.json({ ...o, listings: withSignals(db, o.listings, 'product_id') }); }));
  app.get('/api/ebay/connect', wrap((_req, res) => res.redirect(authorizeUrl(db))));
  app.post('/api/ebay/disconnect', wrap((_req, res) => { ebayDisconnect(db); res.json({ ok: true }); }));
  app.post('/api/ebay/test', wrap(async (_req, res) => res.json(await ebayTest(db))));
  app.post('/api/ebay/sync', wrap(async (_req, res) => res.json(await syncListings(db))));
  app.post('/api/ebay/market', wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
    if (ids?.length === 1) { const p = db.prepare('SELECT id, ean FROM products WHERE id=?').get(ids[0]); return res.json({ result: p ? await marketCheck(db, p) : null }); }
    if (!startMarketJob(db, { ids: ids?.length ? ids : null, manual: true })) throw bad(marketJob.running ? 'Es läuft bereits eine eBay-Prüfung' : 'Keine Artikel fällig (oder eBay-App-Schlüssel fehlen)', 409);
    res.json({ ok: true, job: { ...marketJob } });
  }));
  app.get('/api/ebay/policies', wrap(async (_req, res) => res.json(await ebayPolicies(db))));
  app.get('/api/ebay/categories', wrap(async (req, res) => res.json(await suggestCategories(db, String(req.query.q || '')))));
  app.get('/api/ebay/aspects', wrap(async (req, res) => res.json(await ebayAspects(db, String(req.query.category || '')))));
  app.get('/api/ebay/draft/:id', wrap(async (req, res) => res.json(await ebayDraft(db, Number(req.params.id)))));
  app.post('/api/ebay/verify/:id', wrap(async (req, res) => res.json(await createListing(db, Number(req.params.id), req.body ?? {}, { verify: true }))));
  app.post('/api/ebay/list/:id', wrap(async (req, res) => res.json(await createListing(db, Number(req.params.id), req.body ?? {}))));
  app.post('/api/ebay/texts/:id', wrap(async (req, res) => {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(Number(req.params.id));
    if (!p) throw bad('Artikel nicht gefunden', 404);
    const cfg = aiConfig(db);
    if (!cfg.key) throw bad('KI ist nicht eingerichtet (Einstellungen → KI)');
    const d = await productDetails(db, { swId: p.sw_id, number: p.number }).catch(() => null);
    const facts = {
      Titel: d?.name || p.name, Marke: d?.manufacturer || p.manufacturer, Herstellernummer: d?.mpn || p.mpn, EAN: d?.ean || p.ean,
      Beschreibung: String(d?.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000),
      Merkmale: { ...(d?.properties ?? {}), ...(req.body?.specifics ?? {}) },
      Maße: d?.dims ? `${d.dims.length} × ${d.dims.width} × ${d.dims.height} mm` : null, Gewicht: d?.weight ? `${d.weight} kg` : null,
    };
    const onlyTitle = req.body?.only === 'title';
    const { data } = await chatJson(cfg,
      'Du schreibst verkaufsstarke, sachliche Texte für eBay.de für einen deutschen Fachhändler für Badausstattung. Titel höchstens 80 Zeichen: Marke zuerst, dann Serie/Modell, Produktart und wichtigste Merkmale (Farbe, Maß, Ausführung), die wichtigsten Suchwörter vorne; keine Sonderzeichen wie ! oder *, keine Wörter wie „TOP“, „NEU“ oder „günstig“. Beschreibung als einfaches HTML mit <h3>, <p> und <ul>: kurzer Einstieg mit Nutzen, dann die Merkmale als Liste, dann Lieferumfang nur wenn bekannt; ohne Links, ohne Bilder, ohne Skripte, ohne Preise und ohne Versand- oder Lieferversprechen. Nutze ausschließlich die gegebenen Angaben, erfinde keine Eigenschaften, Maße, Materialien oder Zertifikate. Keine Gedankenstriche. Antwort: {"title": "...", "description_html": "..."}',
      { angaben: facts, aktueller_titel: String(req.body?.title ?? '').slice(0, 200), nur_titel: onlyTitle }, { timeout: 90000 });
    const t = String(data.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!t) throw bad('Die KI hat keinen Titel geliefert');
    res.json({ title: t, description_html: onlyTitle ? null : cleanDescription(String(data.description_html ?? '')) });
  }));
  app.post('/api/ebay/listings/:itemId/jtl', wrap((req, res) => {
    const st = req.body?.state === 'imported' ? 'imported' : 'pending';
    db.prepare('UPDATE ebay_listings SET jtl_state=? WHERE item_id=? AND created_by_us=1').run(st, String(req.params.itemId));
    res.json({ ok: true });
  }));

  // --- Chancen und JTL-Export ---
  app.get('/api/opportunities', wrap((_req, res) => { const o = findOpportunities(db); res.json({ ...o, items: withSignals(db, o.items.slice(0, 1000), 'product_id'), total: o.items.length }); }));
  app.get('/api/export/jtl.csv', wrap((req, res) => {
    const r = jtlExport(db, { channel: ['shop', 'ebay'].includes(req.query.channel) ? req.query.channel : null });
    res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="preisvorschlaege-jtl-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send(r.csv);
  }));

  // --- SEO-Prüfung der eigenen Produktseiten ---
  app.get('/api/seo-audit', wrap((req, res) => {
    const q = req.query;
    const o = auditOverview(db, { issue: q.issue || null, sev: q.sev || null, q: q.q || '', important: q.important === '1', offset: Math.max(0, Number(q.offset) || 0), limit: Math.min(500, Math.max(1, Number(q.limit) || 100)) });
    res.json({ ...o, pages: withSignals(db, o.pages, 'product_id') });
  }));
  app.post('/api/seo-audit/start', wrap((req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
    if (!startAudit(db, { ids: ids?.length ? ids : null, manual: true, limit: ids?.length ? ids.length : Math.min(2000, Number(req.body?.limit) || 500) })) {
      throw bad(auditJob.running ? 'Es läuft bereits eine Prüfung' : 'Keine Seiten fällig (alle kürzlich geprüft)', 409);
    }
    res.json({ ok: true, job: { ...auditJob } });
  }));
  app.post('/api/seo-audit/stop', (_req, res) => { auditJob.stop = true; res.json({ ok: true }); });
  app.get('/api/products/:id/seo-audit', wrap((req, res) => res.json(auditOf(db, Number(req.params.id)))));
  app.post('/api/products/:id/seo-audit', wrap(async (req, res) => {
    const p = db.prepare('SELECT id, url, price, ean FROM products WHERE id=?').get(Number(req.params.id));
    if (!p?.url) throw bad('Für diesen Artikel ist keine Shop-URL bekannt');
    await auditProduct(db, p);
    res.json(auditOf(db, p.id));
  }));
  app.post('/api/products/:id/seo-suggest', wrap(async (req, res) => res.json(await suggestMeta(db, Number(req.params.id)))));

  // --- Keyword-Monitoring ---
  app.get('/api/keywords', wrap((_req, res) => {
    const o = kwOverview(db);
    const sig = productSignals(db, [...new Set(o.keywords.map((k) => k.product?.id).filter(Boolean))]);
    res.json({ ...o, keywords: o.keywords.map((k) => (k.product && sig.has(k.product.id) ? { ...k, product: { ...k.product, sig: sig.get(k.product.id) } } : k)), job: { posting: kwJob.posting, collecting: kwJob.collecting } });
  }));
  app.get('/api/keywords/suggestions', wrap((_req, res) => res.json({ suggestions: suggestions(db) })));
  app.post('/api/keywords', wrap(async (req, res) => {
    const r = addKeywords(db, req.body?.keywords ?? '', { tag: req.body?.tag, source: req.body?.source === 'suggestion' ? 'suggestion' : 'manual' });
    if (!r.added && r.over_limit) throw bad(`Höchstens ${MAX_KEYWORDS} Keywords. Entferne zuerst welche.`);
    // neue Keywords gleich prüfen (Ergebnis kommt nach einigen Minuten) und Suchvolumen holen
    if (r.ids.length && kwConfig(db).configured) {
      postChecks(db, r.ids).then(() => refreshVolumes(db)).catch((e) => { kwJob.error = e.message; });
    }
    res.json(r);
  }));
  app.put('/api/keywords/:id', wrap((req, res) => {
    const tag = req.body?.tag == null ? null : String(req.body.tag).trim().slice(0, 40) || null;
    db.prepare('UPDATE keywords SET tag=? WHERE id=?').run(tag, Number(req.params.id));
    res.json({ ok: true });
  }));
  app.delete('/api/keywords/:id', wrap((req, res) => {
    db.prepare('DELETE FROM kw_tasks WHERE keyword_id=?').run(Number(req.params.id));
    db.prepare('DELETE FROM keywords WHERE id=?').run(Number(req.params.id));
    res.json({ ok: true });
  }));
  app.get('/api/keywords/:id', wrap((req, res) => {
    const d = kwDetail(db, Number(req.params.id));
    if (!d) throw bad('Keyword nicht gefunden', 404);
    res.json(d);
  }));
  app.post('/api/keywords/check', wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
    const r = await postChecks(db, ids?.length ? ids : null);
    res.json(r);
  }));
  app.post('/api/keywords/collect', wrap(async (_req, res) => res.json(await collectChecks(db))));
  app.post('/api/keywords/test', wrap(async (_req, res) => res.json(await kwTest(db))));
  app.post('/api/keywords/suggestions/refresh', wrap((_req, res) => {
    if (!kwConfig(db).configured) throw bad('Zuerst DataForSEO unter Einstellungen verbinden');
    if (!startSuggestionJob(db)) throw bad('Vorschläge werden bereits geholt', 409);
    res.json({ ok: true });
  }));
  app.post('/api/keywords/suggestions/dismiss', wrap((req, res) => {
    const list = (Array.isArray(req.body?.keywords) ? req.body.keywords : [req.body?.keyword]).map(normKeyword).filter(Boolean);
    const ins = db.prepare('INSERT OR IGNORE INTO kw_dismissed(keyword) VALUES (?)');
    for (const k of list) ins.run(k);
    res.json({ ok: true, dismissed: list.length });
  }));

  app.get('/api/merchant', wrap((_req, res) => res.json({ ...merchantSummary(db), job: { ...mcJob } })));
  app.post('/api/merchant/test', wrap(async (_req, res) => res.json(await merchantTest(db))));
  app.post('/api/merchant/sync', wrap((_req, res) => {
    if (!startMerchantJob(db)) throw bad('Es läuft bereits ein Abgleich', 409);
    res.json({ ok: true, job: { ...mcJob } });
  }));
  // Mitbewerber aus einer Domain anlegen (z. B. aus der Google-Wettbewerbsübersicht): Sitemaps und Suchlink werden gesucht
  app.post('/api/competitors/from-domain', wrap(async (req, res) => {
    let base;
    try { base = new URL(/^https?:/.test(String(req.body?.domain)) ? req.body.domain : `https://${req.body?.domain}`).origin; } catch { throw bad('Domain ungültig'); }
    const host = new URL(base).hostname.replace(/^www\./, '');
    if (db.prepare('SELECT base_url FROM competitors').all().some((c) => { try { return new URL(c.base_url).hostname.replace(/^www\./, '') === host; } catch { return false; } })) throw bad('Dieser Mitbewerber ist schon angelegt', 409);
    const sitemaps = (await discoverSitemaps(base).catch(() => [])).filter((x) => { try { return new URL(x.url).hostname.replace(/^www\./, '') === host && !/(magazin|blog|document|news|ratgeber)/i.test(x.url); } catch { return false; } });
    const pick = sitemaps.filter((x) => x.kind === 'index').slice(0, 1).concat(sitemaps.filter((x) => x.kind === 'urlset')).slice(0, 3).map((x) => x.url);
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM competitors').get().p;
    const ins = db.prepare('INSERT INTO competitors(name, base_url, search_url, result_selector, price_selector, delay_ms, enabled, ai_mode, sitemap_url, position) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...compFields({ name: host, base_url: base, delay_ms: 2000, ai_mode: 'fallback', sitemap_url: pick.join('\n') }), pos);
    const link = await detectSearchLink(base).catch(() => null);
    if (link) db.prepare('UPDATE competitors SET manual_search_url=? WHERE id=?').run(link, Number(ins.lastInsertRowid));
    res.json({ id: Number(ins.lastInsertRowid), name: host, sitemaps: pick, search_link: link });
  }));

  // --- Tägliche Zusammenfassung per E-Mail ---
  app.get('/api/digest/preview', wrap((req, res) => { res.type('html').send(digestHtml(digestData(db), getSetting(db, 'app_url') || '')); }));
  app.post('/api/digest/test', wrap(async (req, res) => {
    const to = typeof req.body?.to === 'string' && /@/.test(req.body.to) ? [req.body.to.trim()] : null;
    res.json(await sendDigest(db, { to }));
  }));

  app.get('/api/products/:id/seo', wrap((req, res) => res.json(productSeo(db, Number(req.params.id)))));

  // --- Sichtbarkeit: Google Search Console ---
  app.get('/api/seo', wrap((_req, res) => {
    const o = seoOverview(db);
    const ids = [...new Set([...o.pages.map((p) => p.product?.id), ...o.opportunities.groups.flatMap((g) => g.items.map((i) => i.id))].filter(Boolean))];
    const sig = productSignals(db, ids);
    const pages = o.pages.map((p) => (p.product && sig.has(p.product.id) ? { ...p, product: { ...p.product, sig: sig.get(p.product.id) } } : p));
    const groups = o.opportunities.groups.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i, sig: sig.get(i.id) ?? null })) }));
    res.json({ ...o, pages, opportunities: { ...o.opportunities, groups }, job: { ...seoJob } });
  }));
  // Alles zu einem Artikel aus den übrigen Bereichen: Keywords, Chancen, Signale
  app.get('/api/products/:id/context', wrap((req, res) => {
    const id = Number(req.params.id);
    const p = db.prepare('SELECT id, url FROM products WHERE id=?').get(id);
    if (!p) throw bad('Artikel nicht gefunden', 404);
    const key = p.url ? pageKeyOf(p.url) : null;
    const kws = key ? db.prepare('SELECT id, keyword, position, url, volume, last_checked FROM keywords WHERE url IS NOT NULL').all().filter((k) => pageKeyOf(k.url) === key).sort((a, b) => a.position - b.position) : [];
    res.json({ signals: productSignals(db, [id]).get(id) ?? null, keywords: kws, opportunities: productOpportunities(db, id) });
  }));
  app.post('/api/seo/gsc/test', wrap(async (_req, res) => res.json({ sites: await gscSites(db), email: gscConfig(db).email })));
  app.post('/api/seo/gsc/sync', wrap((_req, res) => {
    if (!startSeoJob(db)) throw bad('Es läuft bereits ein Abgleich', 409);
    res.json({ ok: true, job: { ...seoJob } });
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
      Math.max(Number(process.env.MIN_DELAY_MS ?? 1000), Number(b.delay_ms) || 2000), b.enabled === false || b.enabled === 0 ? 0 : 1,
      ['off', 'fallback', 'always'].includes(b.ai_mode) ? b.ai_mode : 'fallback',
      sitemapField(b.sitemap_url),
    ];
  };
  // Suchlink für die manuelle Suche im Browser des Nutzers ({q} = Suchbegriff)
  const setManualSearch = (id, v) => {
    if (v === undefined) return;
    const t = String(v ?? '').trim();
    if (t && (!/^https?:\/\//.test(t) || !t.includes('{q}'))) throw bad('Suchlink: vollständige URL mit {q} als Platzhalter angeben');
    db.prepare('UPDATE competitors SET manual_search_url=? WHERE id=?').run(t || null, id);
  };
  app.post('/api/competitors/:id/search-link/detect', wrap(async (req, res) => {
    const comp = db.prepare('SELECT * FROM competitors WHERE id=?').get(Number(req.params.id));
    if (!comp) throw bad('Mitbewerber nicht gefunden', 404);
    const link = await detectSearchLink(comp.base_url);
    if (link) db.prepare('UPDATE competitors SET manual_search_url=? WHERE id=?').run(link, comp.id);
    res.json({ link });
  }));
  // Gelernte Abruf-Vorlagen eines Mitbewerbers entfernen
  app.delete('/api/competitors/:id/templates', wrap((req, res) => {
    removeTemplate(db, Number(req.params.id), String(req.body?.selector ?? ''));
    res.json({ ok: true, templates: loadTemplates(db, Number(req.params.id)) });
  }));
  // Kategorien aus der Sitemap: nur in den gewählten wird nach Treffern gesucht
  app.get('/api/competitors/:id/categories', wrap((req, res) => res.json(sitemapCategories(db, Number(req.params.id)))));
  app.put('/api/competitors/:id/categories', wrap((req, res) => {
    const list = Array.isArray(req.body?.categories) ? [...new Set(req.body.categories.map((x) => String(x).toLowerCase().replace(/^\/+|\/+$/g, '')))].slice(0, 500) : [];
    db.prepare('UPDATE competitors SET sitemap_categories=? WHERE id=?').run(list.length ? JSON.stringify(list) : null, Number(req.params.id));
    clearSitemapCache(Number(req.params.id));
    res.json({ ok: true, selected: list });
  }));
  app.post('/api/competitors', wrap((req, res) => {
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM competitors').get().p;
    const r = db.prepare('INSERT INTO competitors(name, base_url, search_url, result_selector, price_selector, delay_ms, enabled, ai_mode, sitemap_url, position) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...compFields(req.body), pos);
    setManualSearch(Number(r.lastInsertRowid), req.body?.manual_search_url);
    res.json({ id: Number(r.lastInsertRowid) });
  }));
  app.put('/api/competitors/:id', wrap((req, res) => {
    db.prepare('UPDATE competitors SET name=?, base_url=?, search_url=?, result_selector=?, price_selector=?, delay_ms=?, enabled=?, ai_mode=?, sitemap_url=? WHERE id=?').run(...compFields(req.body), Number(req.params.id));
    setManualSearch(Number(req.params.id), req.body?.manual_search_url);
    clearSitemapCache(Number(req.params.id));
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
        name, base_url: r.base_url, search_url: r.search_url, delay_ms: 2000, ai_mode: r.ai_mode, enabled: true,
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
    // gleich abrufen, unabhängig vom laufenden Abruf (bei gesetzter URL)
    if (u) await checkProductNow(db, Number(product_id), { competitorId: Number(competitor_id) }).catch(() => null);
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
  // Shopware-Abgleich (Preise, Einkaufspreise, Bestand, Verkäufe) im Hintergrund
  app.post('/api/shopware/sync', wrap((_req, res) => {
    if (!startShopwareJob(db)) throw bad('Es läuft bereits ein Shopware-Abgleich', 409);
    res.json({ ok: true, job: { ...swJob } });
  }));
  app.get('/api/shopware/status', wrap((_req, res) => res.json({ job: { ...swJob }, synced_at: getSetting(db, 'sw_synced_at'), last: JSON.parse(getSetting(db, 'sw_last') || 'null') })));
  app.post('/api/import/csv', wrap((req, res) => {
    const parsed = parseCsv(req.body?.text);
    // Einkaufspreise (netto) dürfen auch allein kommen: Artikelnummer;Einkaufspreis
    const ek = parsed.map((r) => ({ number: pick(r, ['Artikelnummer', 'productNumber', 'sku', 'Nummer', 'number']), ek: parsePrice(pick(r, ['Einkaufspreis', 'EK', 'EK netto', 'Einkaufspreis netto', 'purchase_price', 'purchasePrice'])) })).filter((r) => r.number && r.ek > 0);
    const setEk = db.prepare('UPDATE products SET purchase_price=? WHERE number=?');
    let ekSet = 0;
    const applyEk = () => tx(db, () => { for (const r of ek) ekSet += setEk.run(r.ek, r.number).changes; });
    const rows = parsed.map((r) => ({
      number: pick(r, ['Artikelnummer', 'productNumber', 'sku', 'Nummer', 'number']),
      ean: pick(r, ['EAN', 'GTIN', 'ean']),
      mpn: pick(r, ['Herstellernummer', 'manufacturerNumber', 'mpn', 'HAN']),
      name: pick(r, ['Name', 'Titel', 'Produktname', 'name', 'title']),
      manufacturer: pick(r, ['Hersteller', 'Marke', 'manufacturer', 'brand']),
      url: pick(r, ['URL', 'Link', 'url']),
      price: parsePrice(pick(r, ['Preis', 'Bruttopreis', 'price', 'gross'])),
    })).filter((r) => r.number && r.name);
    if (!rows.length && ek.length) { applyEk(); return res.json({ total: 0, created: 0, updated: 0, purchase_prices: ekSet }); }
    if (!rows.length) throw bad('Keine gültigen Zeilen gefunden. Benötigt: Artikelnummer und Name (optional EAN, Herstellernummer, Hersteller, Preis, Einkaufspreis, URL). Nur Einkaufspreise: Artikelnummer und Einkaufspreis.');
    const r = upsertProducts(db, rows, 'csv');
    applyEk();
    res.json({ total: rows.length, ...r, purchase_prices: ekSet });
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

  // --- „Täglich prüfen“ von Hand (Stufe A unabhängig von den automatischen Regeln) ---
  app.post('/api/products/pin', wrap((req, res) => {
    let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length && req.body?.query && typeof req.body.query === 'object') ids = listProducts(db, { ...req.body.query, ids: true, limit: 1 }).ids;
    if (!ids.length) throw bad('Keine Artikel ausgewählt');
    const v = req.body?.pin === false ? 0 : 1;
    const upd = db.prepare('UPDATE products SET tier_pin=? WHERE id=?');
    tx(db, () => { for (const id of ids) upd.run(v, id); });
    const dist = computeTiers(db, { force: true });
    res.json({ ok: true, changed: ids.length, tiers: dist, product: ids.length === 1 ? getProduct(db, ids[0]) : undefined });
  }));

  // --- Beobachtete Artikel (nur diese werden bei Mitbewerbern abgeglichen) ---
  app.post('/api/products/track', wrap((req, res) => {
    let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length && req.body?.query && typeof req.body.query === 'object') ids = listProducts(db, { ...req.body.query, ids: true, limit: 1 }).ids;
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
      mcp_enabled: mcpEnabled(db),
      seo: seoStatus(db),
      merchant: (() => { const m = merchantConfig(db); return { account: m.account, country: m.country, categories: m.categories.join(', '), configured: m.configured, synced_at: getSetting(db, 'mc_synced_at') }; })(),
      mail: (() => { const m = mailConfig(db); return { enabled: m.enabled, host: m.host, port: m.port, secure: m.secure, user: m.user, pass_set: Boolean(m.pass), from: m.from, to: m.to.join(', '), hour: m.hour, last_sent: getSetting(db, 'mail_last_sent') }; })(),
      min_margin: Number(getSetting(db, 'min_margin') ?? 10),
      ebay: (() => { const e = ebayConfig(db); return { client_id: e.clientId, secret_set: Boolean(e.clientSecret), runame: e.runame, sandbox: e.sandbox, connected: e.connected, username: e.username, fulfillment_policy: e.policies.fulfillment, payment_policy: e.policies.payment, return_policy: e.policies.return, location: e.location, postal_code: e.postalCode, condition: e.condition, max_qty: e.maxQty, browse_per_day: e.perDay, callback: `${getSetting(db, 'app_url') || ''}/api/ebay/callback` }; })(),
      seo_pages_per_day: auditConfig(db).perDay,
      keywords: (() => { const k = kwConfig(db); return { login: k.login, password_set: Boolean(k.password), configured: k.configured, device: k.device, depth: k.depth, hour: k.hour, every_days: k.everyDays, own_host: k.ownHost, from_env: !getSetting(db, 'dfs_login') && Boolean(process.env.DATAFORSEO_LOGIN) }; })(),
      sw_synced_at: getSetting(db, 'sw_synced_at'),
      openai_key_set: Boolean(aiConfig(db).key),
      openai_from_env: !hasSetting(db, 'openai_api_key') && Boolean(process.env.OPENAI_API_KEY),
      openai_model: aiConfig(db).model,
      openai_default_model: DEFAULT_MODEL,
      ai_usage: aiUsage(),
      ai_daily_default: DEFAULT_AI_DAILY_LIMIT,
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
      for (const [k, key] of [['batch', 'scrape_batch'], ['interval', 'scrape_interval'], ['jitter', 'scrape_jitter'], ['refresh', 'scrape_refresh_hours'], ['tier_a_size', 'tier_a_size'], ['tier_b_days', 'tier_b_days']]) {
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
    if (b.min_margin !== undefined && b.min_margin !== '') {
      const n = Number(String(b.min_margin).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n >= 95) throw bad('Mindestmarge: Zahl zwischen 0 und 94 (Prozent)');
      setSetting(db, 'min_margin', String(n));
    }
    // E-Mail
    for (const k of ['mail_host', 'mail_user', 'mail_from', 'mail_to']) if (typeof b[k] === 'string') setSetting(db, k, b[k].trim());
    if (b.mail_pass) setSetting(db, 'mail_pass', String(b.mail_pass), { secret: true });
    if (b.seo_pages_per_day !== undefined && b.seo_pages_per_day !== '') {
      const n = Number(b.seo_pages_per_day);
      if (!Number.isInteger(n) || n < 0 || n > 20000) throw bad('Seiten pro Tag: 0 bis 20000');
      setSetting(db, 'seo_pages_per_day', String(n));
    }
    for (const k of ['ebay_client_id', 'ebay_runame', 'ebay_fulfillment_policy', 'ebay_payment_policy', 'ebay_return_policy', 'ebay_location', 'ebay_postal_code']) if (typeof b[k] === 'string') setSetting(db, k, b[k].trim());
    if (b.ebay_client_secret) { setSetting(db, 'ebay_client_secret', String(b.ebay_client_secret).trim(), { secret: true }); resetAppToken(); }
    if (b.ebay_sandbox !== undefined) setSetting(db, 'ebay_sandbox', b.ebay_sandbox === true || b.ebay_sandbox === '1' || b.ebay_sandbox === 'on' ? '1' : '0');
    for (const [k, lo, hi, label] of [['ebay_condition', 1000, 1500, 'Zustand'], ['ebay_max_qty', 1, 999, 'Menge je Angebot: 1 bis 999'], ['ebay_browse_per_day', 0, 5000, 'eBay-Prüfungen pro Tag: 0 bis 5000']]) {
      if (b[k] === undefined || b[k] === '') continue;
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < lo || n > hi) throw bad(label);
      setSetting(db, k, String(n));
    }
    if (typeof b.dfs_login === 'string') setSetting(db, 'dfs_login', b.dfs_login.trim());
    if (b.dfs_password) setSetting(db, 'dfs_password', String(b.dfs_password).trim(), { secret: true });
    if (b.dfs_remove === true) { setSetting(db, 'dfs_login', ''); setSetting(db, 'dfs_password', ''); }
    if (b.kw_device !== undefined) setSetting(db, 'kw_device', b.kw_device === 'mobile' ? 'mobile' : 'desktop');
    for (const [k, lo, hi, label] of [['kw_depth', 10, 50, 'Tiefe: 10 bis 50'], ['kw_hour', 0, 23, 'Uhrzeit: volle Stunde 0 bis 23'], ['kw_every_days', 1, 7, 'Rhythmus: 1 bis 7 Tage']]) {
      if (b[k] === undefined || b[k] === '') continue;
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < lo || n > hi) throw bad(label);
      setSetting(db, k, String(n));
    }
    if (b.mail_port !== undefined && b.mail_port !== '') { const n = Number(b.mail_port); if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad('SMTP-Port ungültig'); setSetting(db, 'mail_port', String(n)); }
    if (b.mail_hour !== undefined && b.mail_hour !== '') { const n = Number(b.mail_hour); if (!Number.isInteger(n) || n < 0 || n > 23) throw bad('Uhrzeit: volle Stunde 0 bis 23'); setSetting(db, 'mail_hour', String(n)); }
    if (b.mail_secure !== undefined) setSetting(db, 'mail_secure', b.mail_secure === true || b.mail_secure === 'on' || b.mail_secure === '1' ? '1' : '0');
    if (b.mail_enabled !== undefined) setSetting(db, 'mail_enabled', b.mail_enabled === true || b.mail_enabled === 'on' || b.mail_enabled === '1' ? '1' : '0');
    // Merchant Center
    if (typeof b.mc_account === 'string') { const v = b.mc_account.replace(/\D/g, ''); if (b.mc_account.trim() && !v) throw bad('Merchant-Center-Konto-ID: nur Ziffern'); setSetting(db, 'mc_account', v); }
    if (typeof b.mc_country === 'string' && /^[a-z]{2}$/i.test(b.mc_country.trim())) setSetting(db, 'mc_country', b.mc_country.trim().toUpperCase());
    if (typeof b.mc_categories === 'string') setSetting(db, 'mc_categories', b.mc_categories.split(/[\s,;]+/).map((x) => x.replace(/\D/g, '')).filter(Boolean).slice(0, 10).join(','));
    // Search Console
    if (typeof b.gsc_site === 'string') {
      const site = b.gsc_site.trim();
      if (site && !/^(sc-domain:[a-z0-9.-]+|https?:\/\/\S+\/)$/i.test(site)) throw bad('Property: „sc-domain:belkai.de“ (Domain-Property) oder vollständige URL mit / am Ende, z. B. „https://www.belkai.de/“');
      setSetting(db, 'gsc_site', site);
    }
    if (b.gsc_service_account && String(b.gsc_service_account).trim()) saveServiceAccount(db, String(b.gsc_service_account).trim());
    if (b.gsc_remove) { setSetting(db, 'gsc_service_account', ''); }
    if (b.ai_daily_limit !== undefined && b.ai_daily_limit !== '') {
      const n = Number(b.ai_daily_limit);
      if (!Number.isInteger(n) || n < 0 || n > 100000) throw bad('KI-Tagesgrenze: ganze Zahl zwischen 0 und 100000');
      setSetting(db, 'ai_daily_limit', String(n));
    }
    res.json({ ok: true });
  }));
  app.post('/api/settings/mcp-token', wrap((_req, res) => res.json({ token: createMcpToken(db) })));
  app.delete('/api/settings/mcp-token', wrap((_req, res) => { revokeMcpToken(db); res.json({ ok: true }); }));
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
    const lines = [['Artikelnummer', 'EAN', 'Hersteller', 'Name', 'Offline seit', `${ownName()} Preis`, ...comps.flatMap((c) => [`${c.name} Preis`, `${c.name} URL`])].map(csvEscape).join(';')];
    for (const p of products) {
      lines.push([p.number, p.ean, p.manufacturer, p.name, p.offline_since ? p.offline_since.slice(0, 10) : '', fmt(p.price), ...comps.flatMap((c) => {
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
    refresh: clamp(getSetting(db, 'scrape_refresh_hours'), 8, 168, 12), // Mindestabstand je Artikel in Stunden (mind. 8, höchstens zweimal täglich)
    tier_a_size: tierConfig(db).size, // Artikel, die täglich geprüft werden (Stufe A)
    tier_b_days: tierConfig(db).bDays, // übrige Artikel alle x Tage (Stufe B)
    hours: SCRAPE_HOURS,
  };
}

/** Merchant-Center-Abgleich im Hintergrund. */
export const mcJob = { running: false, startedAt: null, finishedAt: null, result: null, error: null };
export function startMerchantJob(db) {
  if (mcJob.running) return false;
  Object.assign(mcJob, { running: true, startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null });
  syncMerchant(db)
    .then((r) => { mcJob.result = r; })
    .catch((e) => { mcJob.error = e.message; console.error('Merchant Center:', e.message); })
    .finally(() => { mcJob.running = false; mcJob.finishedAt = new Date().toISOString(); });
  return true;
}

/** Shopware-Abgleich im Hintergrund. */
export const swJob = { running: false, startedAt: null, finishedAt: null, result: null, error: null };
export function startShopwareJob(db) {
  if (swJob.running) return false;
  Object.assign(swJob, { running: true, startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null });
  syncShopware(db)
    .then((r) => { swJob.result = r; setSetting(db, 'sw_synced_at', new Date().toISOString()); setSetting(db, 'sw_last', JSON.stringify(r)); try { computeTiers(db, { force: true }); } catch { /* beim nächsten Lauf */ } })
    .catch((e) => { swJob.error = e.message; console.error('Shopware-Abgleich:', e.message); })
    .finally(() => { swJob.running = false; swJob.finishedAt = new Date().toISOString(); });
  return true;
}

/** Abgleich mit der Search Console im Hintergrund (dauert je nach Datenmenge bis zu einigen Minuten). */
export const seoJob = { running: false, startedAt: null, finishedAt: null, result: null, error: null };
export function startSeoJob(db) {
  if (seoJob.running) return false;
  Object.assign(seoJob, { running: true, startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null });
  syncGsc(db)
    .then((r) => { seoJob.result = r; })
    .catch((e) => { seoJob.error = e.message; console.error('Abgleich Search Console:', e.message); })
    .finally(() => { seoJob.running = false; seoJob.finishedAt = new Date().toISOString(); });
  return true;
}

export function startScheduler(db) {
  const done = new Set(); // "YYYY-MM-DD-HH" – pro Zeitfenster nur ein Lauf (Modus slots)
  let ownRefreshing = false;
  let pause = null; // Pause nach dem Ende des letzten Laufs (Sekunden), je Lücke neu ausgewürfelt
  const tick = () => {
    let next = 30;
    try {
      const cfg = scheduleConfig(db);
      // Search Console täglich abgleichen (fehlgeschlagene Versuche frühestens nach 6 Stunden erneut)
      const retryOk = Date.now() - (Date.parse(getSetting(db, 'gsc_tried_at') || 0) || 0) > 6 * 3600 * 1000;
      if (!seoJob.running && gscConfig(db).configured && Date.now() - (Date.parse(getSetting(db, 'gsc_synced_at') || 0) || 0) > 24 * 3600 * 1000 && retryOk) {
        setSetting(db, 'gsc_tried_at', new Date().toISOString());
        startSeoJob(db);
      }
      // Merchant Center täglich
      if (!mcJob.running && merchantConfig(db).configured && Date.now() - (Date.parse(getSetting(db, 'mc_synced_at') || 0) || 0) > 24 * 3600 * 1000 && Date.now() - (Date.parse(getSetting(db, 'mc_tried_at') || 0) || 0) > 6 * 3600 * 1000) {
        setSetting(db, 'mc_tried_at', new Date().toISOString());
        startMerchantJob(db);
      }
      // Keyword-Monitoring: Aufträge abgeben und fertige abholen
      kwTick(db);
      // eBay: Mitbewerberpreise und eigene Angebote
      ebayTick(db);
      // SEO-Prüfung der eigenen Seiten, schonend verteilt
      if (!ownImportState.running) auditTick(db);
      // Tägliche Zusammenfassung per E-Mail
      maybeSendDigest(db).then((r) => r && console.log(`Zusammenfassung an ${r.to.join(', ')} gesendet`)).catch((e) => console.error('E-Mail:', e.message));
      // Shopware täglich (Verkäufe, Einkaufspreise, Bestand)
      if (!swJob.running && shopwareConfig(db).configured && Date.now() - (Date.parse(getSetting(db, 'sw_synced_at') || 0) || 0) > 24 * 3600 * 1000 && Date.now() - (Date.parse(getSetting(db, 'sw_tried_at') || 0) || 0) > 6 * 3600 * 1000) {
        setSetting(db, 'sw_tried_at', new Date().toISOString());
        startShopwareJob(db);
      }
      // Eigene Sitemap täglich neu einlesen (erkennt offline gegangene Artikel)
      const ownUrls = sitemapList({ sitemap_url: getSetting(db, 'own_sitemap_url') });
      const lastOwn = Date.parse(getSetting(db, 'own_sitemap_fetched_at') || 0) || 0;
      if (ownUrls.length && !ownRefreshing && !ownImportState.running && Date.now() - lastOwn > 24 * 3600 * 1000) {
        ownRefreshing = true;
        refreshOwnSitemap(db, ownUrls).then((r) => r.offline && console.log(`Eigene Sitemap: ${r.offline} Artikel offline`)).catch((e) => console.error('Eigene Sitemap:', e.message)).finally(() => { ownRefreshing = false; });
      }
      if (cfg.mode === 'rolling') {
        // Neuer Lauf erst, wenn der vorige beendet ist (auch der eigene Artikel-Import) und danach die Pause verstrichen ist
        if (!scrapeState.running && !ownImportState.running) {
          // War der letzte Lauf nur wegen der Zeitgrenze zu Ende (noch Arbeit offen), kurz durchatmen statt lange Pause
          pause ??= scrapeState.backlog ? 20 + Math.random() * 20 : cfg.interval + Math.random() * cfg.jitter;
          const since = scrapeState.finishedAt ? (Date.now() - scrapeState.finishedAt) / 1000 : Infinity;
          if (since >= pause) {
            startScrape(db, { trigger: 'rolling', limitPerCompetitor: cfg.batch, minIntervalH: cfg.refresh, fill: true });
            pause = null;
            if (!scrapeState.running) scrapeState.finishedAt = Date.now(); // nichts fällig: eine Pause abwarten
          } else next = Math.max(5, pause - since);
        }
      } else {
        const d = new Date();
        const slot = `${d.toISOString().slice(0, 10)}-${d.getHours()}`;
        if (SCRAPE_HOURS.includes(d.getHours()) && !done.has(slot) && !ownImportState.running && startScrape(db, { trigger: 'schedule' })) {
          done.add(slot);
          if (done.size > 10) done.delete(done.values().next().value);
        }
        next = 60;
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
    const vals = [base, c.search_url ?? null, c.result_selector ?? null, c.price_selector ?? null, Number(c.delay_ms) || 2000, c.enabled === false ? 0 : 1, ['off', 'fallback', 'always'].includes(c.ai_mode) ? c.ai_mode : 'fallback', c.sitemap_url ? [].concat(c.sitemap_url).join('\n') : null];
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
/** Für Mitbewerber ohne Suchlink einmalig versuchen, ihn von der Startseite zu ermitteln. */
export async function backfillSearchLinks(db) {
  for (const c of db.prepare('SELECT id, name, base_url FROM competitors WHERE manual_search_url IS NULL').all()) {
    if (getSetting(db, `search_link_tried_${c.id}`)) continue;
    setSetting(db, `search_link_tried_${c.id}`, '1');
    const link = await detectSearchLink(c.base_url).catch(() => null);
    if (link) { db.prepare('UPDATE competitors SET manual_search_url=? WHERE id=?').run(link, c.id); console.log(`Suchlink für ${c.name}: ${link}`); }
  }
}

export async function applyBootstrap(db, file = process.env.BOOTSTRAP_FILE || './data/bootstrap.json') {
  if (!fs.existsSync(file)) return null;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cfg.id || getSetting(db, 'bootstrap_done') === cfg.id) return null;
  for (const c of cfg.competitors ?? []) {
    if (!c?.name || !c?.base_url) continue;
    const have = db.prepare('SELECT id, manual_search_url FROM competitors WHERE name=?').get(c.name);
    if (have) {
      if (c.manual_search_url && !have.manual_search_url) db.prepare('UPDATE competitors SET manual_search_url=? WHERE id=?').run(c.manual_search_url, have.id);
      continue;
    }
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM competitors').get().p;
    db.prepare('INSERT INTO competitors(name, base_url, search_url, delay_ms, enabled, ai_mode, sitemap_url, position) VALUES (?,?,?,?,1,?,?,?)')
      .run(c.name, new URL(c.base_url).origin, c.search_url ?? null, Number(c.delay_ms) || 2000, ['off', 'fallback', 'always'].includes(c.ai_mode) ? c.ai_mode : 'fallback', c.sitemap_url ? [].concat(c.sitemap_url).join('\n') : null, pos);
    if (c.manual_search_url) db.prepare('UPDATE competitors SET manual_search_url=? WHERE name=?').run(c.manual_search_url, c.name);
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
  await backfillSearchLinks(db);
  console.log('Bootstrap abgeschlossen');
  return cfg.id;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const seeded = seedCompetitors(db);
  if (seeded) console.log(`${seeded} Mitbewerber aus Datei übernommen`);
  const port = Number(process.env.PORT || 3000);
  createApp(db, { dataDir: path.dirname(process.env.DB_PATH || './data/preisradar.db') }).listen(port, () => console.log(`Preisradar läuft auf Port ${port}`));
  closeStaleRuns(db); // Läufe eines vorherigen Prozesses abschließen
  startScheduler(db);
  setTimeout(() => warmPriceList(db), 1500); // Preisliste vorbereiten und aktuell halten, damit das Öffnen schnell ist
  applyBootstrap(db).catch((e) => console.error('Bootstrap fehlgeschlagen:', e.message));
}
