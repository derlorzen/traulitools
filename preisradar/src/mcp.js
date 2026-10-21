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
];
const WRITE = new Set(['start_scrape', 'stop_scrape', 'track_products']);

function handlers(db, ownName, schedule) {
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

export function mountMcp(app, db, { ownName, schedule }) {
  const h = handlers(db, ownName, schedule);
  app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Nur POST (MCP Streamable HTTP)' }));
  app.delete('/mcp', (_req, res) => res.status(405).end());
  app.post('/mcp', async (req, res) => {
    if (!tokenOk(db, req)) return res.status(401).set('WWW-Authenticate', 'Bearer').json({ jsonrpc: '2.0', error: { code: -32001, message: 'Token fehlt oder ungültig' }, id: null });
    const msgs = Array.isArray(req.body) ? req.body : [req.body];
    const out = [];
    for (const m of msgs) {
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') { out.push({ jsonrpc: '2.0', error: { code: -32600, message: 'Ungültige Anfrage' }, id: m?.id ?? null }); continue; }
      if (m.id === undefined) continue; // Notification
      const reply = (result) => out.push({ jsonrpc: '2.0', id: m.id, result });
      const fail = (code, message) => out.push({ jsonrpc: '2.0', id: m.id, error: { code, message } });
      if (m.method === 'initialize') reply({ protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'preisradar', version: '1.0.0' }, instructions: 'Preisradar: Preisvergleich für den eigenen Shop gegenüber Mitbewerbern. Lesen: overview, analysis_summary, recommendations, search_products, get_product. Ändern: start_scrape, stop_scrape, track_products. Preise im Shop selbst werden nicht geändert.' });
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
