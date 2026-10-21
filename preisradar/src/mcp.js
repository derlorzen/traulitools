import crypto from 'node:crypto';
import { analyse } from './analysis.js';
import { startScrape, scrapeState } from './scraper.js';
import { getSetting, setSetting } from './settings.js';
import { tx } from './db.js';

/**
 * MCP-Endpunkt (Streamable HTTP, JSON-RPC) – damit Claude Preisradar lesen und bedienen kann.
 * Zugriff nur mit Token (Einstellungen → Claude-Zugang): Header "Authorization: Bearer <Token>" oder ?token=<Token>.
 * Es wird nur der Hash des Tokens gespeichert.
 */
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
export const mcpEnabled = (db) => Boolean(getSetting(db, 'mcp_token_hash'));
export function createMcpToken(db) {
  const token = 'pr_' + crypto.randomBytes(24).toString('base64url');
  setSetting(db, 'mcp_token_hash', hash(token));
  return token;
}
export const revokeMcpToken = (db) => setSetting(db, 'mcp_token_hash', '');
function tokenOk(db, req) {
  const stored = getSetting(db, 'mcp_token_hash');
  if (!stored) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const given = m?.[1] ?? (typeof req.query.token === 'string' ? req.query.token : '');
  if (!given) return false;
  const a = Buffer.from(hash(given)), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const TOOLS = [
  { name: 'overview', description: 'Überblick: Anzahl Artikel (gesamt/beobachtet), Mitbewerber, laufender Abruf, letzter Lauf, Abrufplan.', inputSchema: obj() },
  { name: 'analysis_summary', description: 'Regelbasierte Preisanalyse: Zusammenfassung, Kennzahlen, Verteilung des Abstands, Vergleich je Mitbewerber und Marke, Preisbewegungen der letzten 7 Tage, Hinweise.', inputSchema: obj() },
  {
    name: 'recommendations',
    description: 'Preisempfehlungen je beobachtetem Artikel (senken, erhöhen, prüfen, halten), gefiltert und sortiert.',
    inputSchema: obj({
      action: { type: 'string', enum: ['senken', 'erhöhen', 'prüfen', 'halten', 'actionable', 'all'], description: 'Standard: actionable (alles außer halten)' },
      brand: { type: 'string' }, competitor: { type: 'string', description: 'Name des günstigsten Mitbewerbers' }, query: { type: 'string' },
      sort: { type: 'string', enum: ['gap', 'diff', 'price'], description: 'gap = Abstand in %, diff = Abstand in €' }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
  },
  {
    name: 'search_products',
    description: 'Artikel suchen (Name, Artikelnummer, EAN, Hersteller) inklusive Mitbewerberpreisen.',
    inputSchema: obj({ query: { type: 'string' }, brand: { type: 'string' }, tracked_only: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  },
  {
    name: 'get_product',
    description: 'Ein Artikel mit allen Mitbewerber-Treffern (Preis, Status, URL, Verfügbarkeit) und Preisverlauf.',
    inputSchema: obj({ id: { type: 'integer' }, number: { type: 'string', description: 'Artikelnummer, alternativ zur id' } }),
  },
  { name: 'list_competitors', description: 'Alle Mitbewerber mit Einstellungen und Anzahl bestätigter Preise.', inputSchema: obj() },
  { name: 'list_runs', description: 'Die letzten Abruf-Läufe.', inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 30 } }) },
  {
    name: 'start_scrape',
    description: 'Preisabruf bei Mitbewerbern starten (nur beobachtete Artikel). Optional für einen Mitbewerber oder Artikel.',
    inputSchema: obj({ competitor_id: { type: 'integer' }, product_id: { type: 'integer' }, force: { type: 'boolean', description: 'auch kürzlich geprüfte Artikel erneut abrufen' } }),
  },
  { name: 'stop_scrape', description: 'Laufenden Abruf stoppen.', inputSchema: obj() },
  {
    name: 'track_products',
    description: 'Artikel zur Beobachtung hinzufügen oder entfernen (nur beobachtete Artikel werden abgeglichen). Auswahl per ids, Artikelnummern oder Marke.',
    inputSchema: obj({ ids: { type: 'array', items: { type: 'integer' } }, numbers: { type: 'array', items: { type: 'string' } }, brand: { type: 'string' }, tracked: { type: 'boolean' } }, ['tracked']),
  },
  // --- Einstellungen, Import, Mitbewerber, Zuordnungen (über die App-eigenen Routen, mit deren Prüfungen) ---
  { name: 'get_settings', description: 'Einstellungen lesen: Shop-Name/-URL, eigene Sitemap, Abrufplan, ob Shopware/KI/MCP eingerichtet sind (Zugangsdaten werden nie ausgegeben).', inputSchema: obj() },
  {
    name: 'update_settings',
    description: 'Einstellungen ändern: Shop-Name, Shop-URL, eigene Sitemap-URL(s) (mehrere durch Leerzeichen/Zeilenumbruch) und Abrufplan. Zugangsdaten (API-Keys, Passwörter) lassen sich hier bewusst nicht setzen.',
    inputSchema: obj({
      own_name: { type: 'string' }, own_url: { type: 'string' }, own_sitemap_url: { type: 'string' },
      schedule: { type: 'object', properties: { mode: { type: 'string', enum: ['rolling', 'slots'] }, batch: { type: 'integer' }, interval: { type: 'integer', description: 'Sekunden zwischen Paketen' }, jitter: { type: 'integer', description: 'zufälliger Aufschlag in Sekunden' }, refresh: { type: 'integer', description: 'Mindestabstand je Artikel in Stunden' } }, additionalProperties: false },
    }),
  },
  { name: 'refresh_own_sitemap', description: 'Eigene Sitemap(s) neu einlesen (Voraussetzung für den Sitemap-Import).', inputSchema: obj() },
  { name: 'import_status', description: 'Stand des laufenden oder letzten Sitemap-Imports eigener Artikel.', inputSchema: obj() },
  {
    name: 'import_from_sitemap',
    description: 'Eigene Artikel aus der Sitemap importieren (Hintergrundjob). limit = nur die ersten N, all = auch bereits vorhandene aktualisieren, tracked = neue Artikel gleich beobachten.',
    inputSchema: obj({ limit: { type: 'integer', minimum: 1 }, all: { type: 'boolean' }, tracked: { type: 'boolean' } }),
  },
  { name: 'stop_import', description: 'Laufenden Sitemap-Import stoppen.', inputSchema: obj() },
  { name: 'import_shopware', description: 'Artikel über die Shopware-API importieren (Zugang muss unter Einstellungen eingerichtet sein).', inputSchema: obj() },
  { name: 'import_csv', description: 'Artikel aus CSV-Text importieren. Spalten: Artikelnummer, Name (Pflicht), EAN, Herstellernummer, Hersteller, Preis, URL.', inputSchema: obj({ text: { type: 'string' } }, ['text']) },
  { name: 'import_competitor_urls', description: 'Bekannte Mitbewerber-Produktlinks per CSV-Text setzen. Spalten: Artikelnummer, Mitbewerber, URL.', inputSchema: obj({ text: { type: 'string' } }, ['text']) },
  {
    name: 'create_competitor',
    description: 'Mitbewerber anlegen. Entweder search_url (mit {q}) und/oder sitemap_url(s). ai_mode: off | fallback | always.',
    inputSchema: obj({ name: { type: 'string' }, base_url: { type: 'string' }, search_url: { type: 'string' }, sitemap_url: { type: 'string' }, result_selector: { type: 'string' }, price_selector: { type: 'string' }, delay_ms: { type: 'integer' }, ai_mode: { type: 'string', enum: ['off', 'fallback', 'always'] } }, ['name', 'base_url']),
  },
  {
    name: 'update_competitor',
    description: 'Mitbewerber ändern (nur angegebene Felder).',
    inputSchema: obj({ id: { type: 'integer' }, name: { type: 'string' }, base_url: { type: 'string' }, search_url: { type: 'string' }, sitemap_url: { type: 'string' }, result_selector: { type: 'string' }, price_selector: { type: 'string' }, delay_ms: { type: 'integer' }, enabled: { type: 'boolean' }, ai_mode: { type: 'string', enum: ['off', 'fallback', 'always'] } }, ['id']),
  },
  { name: 'delete_competitor', description: 'Mitbewerber samt Treffern und Preisverlauf löschen (nicht umkehrbar). Nur mit confirm=true.', inputSchema: obj({ id: { type: 'integer' }, confirm: { type: 'boolean' } }, ['id', 'confirm']) },
  { name: 'autosetup_competitor', description: 'Mitbewerber aus einem Produktlink seines Shops einrichten. create=false analysiert nur, create=true legt ihn an.', inputSchema: obj({ product_url: { type: 'string' }, create: { type: 'boolean' }, name: { type: 'string' } }, ['product_url']) },
  { name: 'discover_sitemaps', description: 'Sitemaps eines Shops finden (robots.txt und übliche Pfade).', inputSchema: obj({ base_url: { type: 'string' } }, ['base_url']) },
  { name: 'refresh_competitor_sitemap', description: 'Sitemap eines Mitbewerbers neu einlesen.', inputSchema: obj({ id: { type: 'integer' } }, ['id']) },
  { name: 'confirm_match', description: 'Einen unbestätigten Treffer („zu prüfen“) bestätigen; er fließt dann in die Analyse ein.', inputSchema: obj({ match_id: { type: 'integer' } }, ['match_id']) },
  { name: 'reject_match', description: 'Einen Treffer verwerfen (falsches Produkt).', inputSchema: obj({ match_id: { type: 'integer' } }, ['match_id']) },
  { name: 'set_match_url', description: 'Produktlink eines Mitbewerbers für einen Artikel setzen (leer = Zuordnung zurücksetzen) und direkt abrufen.', inputSchema: obj({ product_id: { type: 'integer' }, competitor_id: { type: 'integer' }, url: { type: 'string' } }, ['product_id', 'competitor_id']) },
];
const WRITE = new Set(['start_scrape', 'stop_scrape', 'track_products', 'update_settings', 'refresh_own_sitemap', 'import_from_sitemap', 'stop_import', 'import_shopware', 'import_csv', 'import_competitor_urls', 'create_competitor', 'update_competitor', 'delete_competitor', 'autosetup_competitor', 'refresh_competitor_sitemap', 'confirm_match', 'reject_match', 'set_match_url']);

function handlers(db, ownName, schedule, call) {
  const counts = () => db.prepare('SELECT COUNT(*) AS gesamt, COALESCE(SUM(tracked),0) AS beobachtet FROM products WHERE active=1').get();
  const matchesOf = (ids) => {
    if (!ids.length) return new Map();
    const rows = db.prepare(`SELECT m.product_id, c.name AS competitor, m.status, m.price, m.availability, m.url, m.last_checked FROM matches m JOIN competitors c ON c.id=m.competitor_id WHERE m.product_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const by = new Map();
    for (const r of rows) { if (!by.has(r.product_id)) by.set(r.product_id, []); by.get(r.product_id).push({ ...r, product_id: undefined }); }
    return by;
  };
  const slim = (p, by) => ({ id: p.id, number: p.number, name: p.name, brand: p.manufacturer, ean: p.ean, price: p.price, tracked: Boolean(p.tracked), competitors: by.get(p.id) ?? [] });
  return {
    get_settings: () => call('GET', '/api/settings'),
    update_settings: (a = {}) => {
      const body = {};
      for (const k of ['own_name', 'own_url', 'own_sitemap_url', 'schedule']) if (a[k] !== undefined) body[k] = a[k];
      if (!Object.keys(body).length) throw new Error('Nichts zu ändern');
      return call('PUT', '/api/settings', body).then(() => call('GET', '/api/settings'));
    },
    refresh_own_sitemap: () => call('POST', '/api/settings/own-sitemap/refresh', {}),
    import_status: () => call('GET', '/api/import/sitemap/status'),
    import_from_sitemap: (a = {}) => call('POST', '/api/import/sitemap', { limit: a.limit, all: a.all === true, tracked: a.tracked === true }),
    stop_import: () => call('POST', '/api/import/sitemap/stop', {}),
    import_shopware: () => call('POST', '/api/import/shopware', {}),
    import_csv: (a = {}) => call('POST', '/api/import/csv', { text: a.text }),
    import_competitor_urls: (a = {}) => call('POST', '/api/import/urls', { text: a.text }),
    create_competitor: (a = {}) => call('POST', '/api/competitors', a),
    update_competitor: async ({ id, ...rest } = {}) => {
      const cur = db.prepare('SELECT * FROM competitors WHERE id=?').get(id);
      if (!cur) throw new Error('Mitbewerber nicht gefunden');
      await call('PUT', `/api/competitors/${id}`, { ...cur, ...rest });
      return db.prepare('SELECT id, name, base_url, search_url, sitemap_url, delay_ms, enabled, ai_mode FROM competitors WHERE id=?').get(id);
    },
    delete_competitor: ({ id, confirm } = {}) => { if (confirm !== true) throw new Error('confirm=true nötig'); return call('DELETE', `/api/competitors/${id}`); },
    autosetup_competitor: (a = {}) => call('POST', '/api/competitors/autosetup', a),
    discover_sitemaps: (a = {}) => call('POST', '/api/sitemaps/discover', a),
    refresh_competitor_sitemap: (a = {}) => call('POST', `/api/competitors/${a.id}/sitemap/refresh`, {}),
    confirm_match: (a = {}) => call('POST', `/api/matches/${a.match_id}/confirm`, {}),
    reject_match: (a = {}) => call('POST', `/api/matches/${a.match_id}/reject`, {}),
    set_match_url: (a = {}) => call('PUT', '/api/matches', a),
    overview: () => ({
      shop: ownName(), artikel: counts(),
      mitbewerber: db.prepare('SELECT id, name, enabled FROM competitors ORDER BY position, id').all(),
      abruf: { ...scrapeState }, letzter_lauf: db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() ?? null, abrufplan: schedule(),
    }),
    analysis_summary: () => { const a = analyse(db); const { rows, ...rest } = a; return { ...rest, brands: rest.brands.slice(0, 30) }; },
    recommendations: ({ action = 'actionable', brand, competitor, query, sort = 'gap', limit = 30 } = {}) => {
      const a = analyse(db);
      const q = String(query ?? '').toLowerCase();
      let rows = a.rows.filter((r) => (action === 'all' ? true : action === 'actionable' ? r.action !== 'halten' : r.action === action)
        && (!brand || (r.brand || '') === brand) && (!competitor || r.cheapest_competitor === competitor)
        && (!q || [r.name, r.number, r.brand].some((v) => String(v ?? '').toLowerCase().includes(q))));
      const s = { gap: (x, y) => Math.abs(y.gap_percent) - Math.abs(x.gap_percent), diff: (x, y) => Math.abs(y.diff) - Math.abs(x.diff), price: (x, y) => y.own_price - x.own_price }[sort] ?? (() => 0);
      rows = rows.sort(s);
      return { treffer: rows.length, regeln: a.rules, artikel: rows.slice(0, Math.min(200, Number(limit) || 30)) };
    },
    search_products: ({ query = '', brand, tracked_only = false, limit = 20 } = {}) => {
      const like = `%${String(query).trim()}%`;
      const rows = db.prepare(`SELECT * FROM products WHERE active=1 ${tracked_only ? 'AND tracked=1' : ''} ${brand ? 'AND manufacturer=?' : ''}
        AND (name LIKE ? OR number LIKE ? OR ean LIKE ? OR manufacturer LIKE ? OR mpn LIKE ?) ORDER BY manufacturer, name LIMIT ?`)
        .all(...(brand ? [brand] : []), like, like, like, like, like, Math.min(100, Number(limit) || 20));
      const by = matchesOf(rows.map((r) => r.id));
      return { treffer: rows.length, artikel: rows.map((p) => slim(p, by)) };
    },
    get_product: ({ id, number } = {}) => {
      const p = id != null ? db.prepare('SELECT * FROM products WHERE id=?').get(id) : db.prepare('SELECT * FROM products WHERE number=?').get(String(number ?? ''));
      if (!p) throw new Error('Artikel nicht gefunden');
      const ms = db.prepare('SELECT m.id, c.name AS competitor, m.status, m.price, m.availability, m.url, m.title, m.last_checked, m.last_error, m.ai_note FROM matches m JOIN competitors c ON c.id=m.competitor_id WHERE m.product_id=?').all(p.id);
      return {
        artikel: { id: p.id, number: p.number, name: p.name, brand: p.manufacturer, ean: p.ean, mpn: p.mpn, price: p.price, tracked: Boolean(p.tracked) },
        mitbewerber: ms.map((m) => ({ ...m, verlauf: db.prepare('SELECT price, at FROM price_history WHERE match_id=? ORDER BY at DESC LIMIT 30').all(m.id).reverse().map((h) => ({ price: h.price, at: h.at })) })),
        eigener_preisverlauf: db.prepare('SELECT price, at FROM product_price_history WHERE product_id=? ORDER BY at DESC LIMIT 30').all(p.id).reverse().map((h) => ({ price: h.price, at: h.at })),
      };
    },
    list_competitors: () => db.prepare(`SELECT c.id, c.name, c.base_url, c.enabled, c.ai_mode, c.delay_ms, c.sitemap_url, c.sitemap_fetched_at,
      (SELECT COUNT(*) FROM sitemap_urls s WHERE s.competitor_id=c.id) AS sitemap_urls,
      (SELECT COUNT(*) FROM matches m WHERE m.competitor_id=c.id AND m.status='ok') AS bestaetigte_preise FROM competitors c ORDER BY position, id`).all().map((r) => ({ ...r, enabled: Boolean(r.enabled) })),
    list_runs: ({ limit = 10 } = {}) => db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(Math.min(30, Number(limit) || 10)),
    start_scrape: ({ competitor_id = null, product_id = null, force = false } = {}) => {
      if (!startScrape(db, { trigger: 'manual', competitorId: competitor_id, productId: product_id, force })) throw new Error('Es läuft bereits ein Abruf');
      return { gestartet: true, artikel: scrapeState.total };
    },
    stop_scrape: () => { scrapeState.stop = true; return { ok: true }; },
    track_products: ({ ids = [], numbers = [], brand, tracked } = {}) => {
      const set = new Set(ids.map(Number).filter(Number.isInteger));
      for (const n of numbers) { const r = db.prepare('SELECT id FROM products WHERE number=?').get(String(n)); if (r) set.add(r.id); }
      if (brand) for (const r of db.prepare('SELECT id FROM products WHERE active=1 AND manufacturer=?').all(brand)) set.add(r.id);
      if (!set.size) throw new Error('Keine Artikel ausgewählt (ids, numbers oder brand angeben)');
      const upd = db.prepare('UPDATE products SET tracked=? WHERE id=?');
      tx(db, () => { for (const id of set) upd.run(tracked ? 1 : 0, id); });
      return { geaendert: set.size, artikel: counts() };
    },
  };
}

export function mountMcp(app, db, { ownName, schedule, internalKey }) {
  app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Nur POST (MCP Streamable HTTP)' }));
  app.delete('/mcp', (_req, res) => res.status(405).end());
  app.post('/mcp', async (req, res) => {
    if (!tokenOk(db, req)) return res.status(401).set('WWW-Authenticate', 'Bearer').json({ jsonrpc: '2.0', error: { code: -32001, message: 'Token fehlt oder ungültig' }, id: null });
    // Ruft die App-eigenen Routen über Loopback auf (mit allen Prüfungen), nur für diese Anfrage gültig
    const call = async (method, path, body) => {
      const r = await fetch(`http://127.0.0.1:${req.socket.localPort}${path}`, { method, headers: { 'content-type': 'application/json', 'x-internal-mcp': internalKey }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Fehler ${r.status}`);
      return j;
    };
    const h = handlers(db, ownName, schedule, call);
    const msgs = Array.isArray(req.body) ? req.body : [req.body];
    const out = [];
    for (const m of msgs) {
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') { out.push({ jsonrpc: '2.0', error: { code: -32600, message: 'Ungültige Anfrage' }, id: m?.id ?? null }); continue; }
      if (m.id === undefined) continue; // Notification
      const reply = (result) => out.push({ jsonrpc: '2.0', id: m.id, result });
      const fail = (code, message) => out.push({ jsonrpc: '2.0', id: m.id, error: { code, message } });
      if (m.method === 'initialize') reply({ protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'preisradar', version: '1.0.0' }, instructions: 'Preisradar: Preisvergleich für den eigenen Shop gegenüber Mitbewerbern. Lesen: overview, analysis_summary, recommendations, search_products, get_product, get_settings, list_competitors, list_runs, import_status. Ändern: Abrufe, Beobachtung, Import (Sitemap/CSV/Shopware), Einstellungen, Mitbewerber, Treffer. Preise im Shop selbst werden nie geändert, Zugangsdaten nicht gesetzt.' });
      else if (m.method === 'ping') reply({});
      else if (m.method === 'tools/list') reply({ tools: TOOLS.map((t) => ({ ...t, annotations: { readOnlyHint: !WRITE.has(t.name) } })) });
      else if (m.method === 'tools/call') {
        const fn = h[m.params?.name];
        if (!fn) { fail(-32602, `Unbekanntes Tool: ${m.params?.name}`); continue; }
        try { reply({ content: [{ type: 'text', text: JSON.stringify(await fn(m.params.arguments ?? {})) }] }); }
        catch (e) { reply({ isError: true, content: [{ type: 'text', text: String(e.message) }] }); }
      } else fail(-32601, 'Methode nicht unterstützt');
    }
    if (!out.length) return res.status(202).end();
    res.json(Array.isArray(req.body) ? out : out[0]);
  });
}
