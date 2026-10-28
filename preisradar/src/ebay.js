import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { getSetting, setSetting } from './settings.js';
import { productDetails } from './shopware.js';
import { channel, channelView, floorPrice } from './channels.js';

/**
 * eBay (aus dem Marktschreier übernommen): OAuth mit Zustimmung des Verkäufers, REST (Konto, Kategorien, Suche)
 * und Trading API (XML) für eigene Angebote und das Einstellen.
 *
 * Arbeitsteilung mit JTL-Wawi: Preisradar liest eBay und stellt neue Angebote ein. Danach übernimmt JTL die
 * Angebote über den Angebotsimport (Zuordnung über eBay-SKU = JTL-Artikelnummer) und ist ab dann allein für
 * Bestand, Preis und Aufträge zuständig. Preisradar ändert bestehende Angebote nie.
 * Mitbewerberpreise kommen aus der öffentlichen Browse API (Suche über die EAN) und brauchen nur den App-Schlüssel.
 */
const SCOPES = ['https://api.ebay.com/oauth/api_scope', 'https://api.ebay.com/oauth/api_scope/sell.account.readonly'];
const TREE_DE = '77';
const SITE_DE = 77;
const COMPAT = 1349;
export const CONDITIONS = { 1000: 'Neu', 1500: 'Neu: Sonstige (siehe Artikelbeschreibung)' };

export function ebayConfig(db) {
  const g = (k, env) => getSetting(db, k) || process.env[env] || '';
  const sandbox = (getSetting(db, 'ebay_sandbox') ?? process.env.EBAY_SANDBOX) === '1';
  const n = (k, d) => { const v = Number(getSetting(db, k)); return Number.isFinite(v) && getSetting(db, k) != null ? v : d; };
  return {
    clientId: g('ebay_client_id', 'EBAY_CLIENT_ID'), clientSecret: g('ebay_client_secret', 'EBAY_CLIENT_SECRET'), runame: g('ebay_runame', 'EBAY_RUNAME'), sandbox,
    get app() { return Boolean(this.clientId && this.clientSecret); },
    get canConnect() { return Boolean(this.app && this.runame); },
    connected: Boolean(tokens(db)?.refresh_token), username: getSetting(db, 'ebay_username') || null,
    policies: { fulfillment: getSetting(db, 'ebay_fulfillment_policy') || '', payment: getSetting(db, 'ebay_payment_policy') || '', return: getSetting(db, 'ebay_return_policy') || '' },
    location: getSetting(db, 'ebay_location') || '', postalCode: getSetting(db, 'ebay_postal_code') || '',
    condition: n('ebay_condition', 1000), maxQty: n('ebay_max_qty', 3), perDay: Math.max(0, Math.min(5000, n('ebay_browse_per_day', 2000))),
  };
}
const base = (cfg, kind) => {
  if (kind === 'api' && process.env.EBAY_API_BASE) return process.env.EBAY_API_BASE;
  if (kind === 'auth' && process.env.EBAY_AUTH_BASE) return process.env.EBAY_AUTH_BASE;
  return kind === 'auth' ? (cfg.sandbox ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com') : (cfg.sandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com');
};
function tokens(db) { try { return JSON.parse(getSetting(db, 'ebay_tokens') || 'null'); } catch { return null; } }
const saveTokens = (db, t) => setSetting(db, 'ebay_tokens', JSON.stringify(t), { secret: true });

export function authorizeUrl(db) {
  const cfg = ebayConfig(db);
  if (!cfg.canConnect) throw new Error('Zuerst App-ID (Client ID), Cert-ID (Client Secret) und RuName unter Einstellungen → eBay eintragen');
  const state = crypto.randomBytes(16).toString('hex');
  setSetting(db, 'ebay_oauth_state', `${state}|${Date.now()}`);
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.runame, response_type: 'code', scope: SCOPES.join(' '), state, prompt: 'login' });
  return `${base(cfg, 'auth')}/oauth2/authorize?${q.toString().replace(/\+/g, '%20')}`;
}

async function tokenRequest(cfg, form) {
  const res = await fetch(`${base(cfg, 'api')}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams(form), signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`eBay verweigert das Token: ${j.error_description || j.error || `HTTP ${res.status}`}`);
  return j;
}

export async function exchangeCode(db, code, state) {
  const [want, at] = String(getSetting(db, 'ebay_oauth_state') || '').split('|');
  if (!want || want !== state || Date.now() - Number(at) > 30 * 60e3) throw new Error('Die eBay-Anmeldung ist abgelaufen oder ungültig. Bitte erneut verbinden.');
  setSetting(db, 'ebay_oauth_state', '');
  const cfg = ebayConfig(db);
  const j = await tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: cfg.runame });
  saveTokens(db, { access_token: j.access_token, access_expires_at: Date.now() + ((j.expires_in ?? 7200) - 120) * 1000, refresh_token: j.refresh_token ?? null });
  try {
    const doc = await trading(db, 'GetUser', '');
    const name = doc('User > UserID').first().text();
    if (name) setSetting(db, 'ebay_username', name);
  } catch { /* Name ist nur zur Anzeige */ }
  return true;
}

export function disconnect(db) { setSetting(db, 'ebay_tokens', ''); setSetting(db, 'ebay_username', ''); }

async function userToken(db) {
  const t = tokens(db);
  if (t?.access_token && t.access_expires_at > Date.now()) return t.access_token;
  if (!t?.refresh_token) throw new Error('eBay ist nicht verbunden');
  const cfg = ebayConfig(db);
  const j = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: t.refresh_token, scope: SCOPES.join(' ') });
  saveTokens(db, { ...t, access_token: j.access_token, access_expires_at: Date.now() + ((j.expires_in ?? 7200) - 120) * 1000 });
  return j.access_token;
}

let appTok = null;
async function appToken(db) {
  if (appTok && appTok.exp > Date.now()) return appTok.value;
  const cfg = ebayConfig(db);
  if (!cfg.app) throw new Error('eBay-App-Schlüssel fehlen (Einstellungen → eBay)');
  const j = await tokenRequest(cfg, { grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' });
  appTok = { value: j.access_token, exp: Date.now() + ((j.expires_in ?? 7200) - 120) * 1000 };
  return appTok.value;
}
export const resetAppToken = () => { appTok = null; };

async function rest(db, method, path, { query = {}, body, app = false } = {}) {
  const cfg = ebayConfig(db);
  for (let attempt = 1; ; attempt++) {
    const tok = app ? await appToken(db) : await userToken(db);
    const qs = new URLSearchParams(query).toString();
    const res = await fetch(`${base(cfg, 'api')}${path}${qs ? `?${qs}` : ''}`, {
      method, headers: { authorization: `Bearer ${tok}`, accept: 'application/json', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE', 'Accept-Language': 'de-DE', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`eBay: ${(j.errors ?? []).map((e) => e.longMessage || e.message).join(' ') || `HTTP ${res.status}`}`);
    return j;
  }
}

const x = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Trading-API-Aufruf; gibt ein cheerio-Dokument (XML) zurück. */
export async function trading(db, call, inner) {
  const cfg = ebayConfig(db);
  const xml = `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>de_DE</ErrorLanguage><WarningLevel>High</WarningLevel>${inner}</${call}Request>`;
  const res = await fetch(`${base(cfg, 'api')}/ws/api.dll`, {
    method: 'POST',
    headers: { 'X-EBAY-API-IAF-TOKEN': await userToken(db), 'X-EBAY-API-CALL-NAME': call, 'X-EBAY-API-SITEID': String(SITE_DE), 'X-EBAY-API-COMPATIBILITY-LEVEL': String(COMPAT), 'content-type': 'text/xml' },
    body: xml, signal: AbortSignal.timeout(90000),
  });
  const $ = cheerio.load(await res.text(), { xml: true });
  const ack = $('Ack').first().text();
  if (!ack) throw new Error(`eBay antwortet unverständlich (HTTP ${res.status})`);
  const errors = $('Errors').filter((_, e) => $(e).find('SeverityCode').text() === 'Error').map((_, e) => $(e).find('LongMessage').text() || $(e).find('ShortMessage').text()).get();
  if (ack === 'Failure' || errors.length) throw new Error(`eBay: ${[...new Set(errors)].join(' ') || 'Unbekannter Fehler'}`);
  $.warnings = $('Errors').filter((_, e) => $(e).find('SeverityCode').text() === 'Warning').map((_, e) => $(e).find('LongMessage').text() || $(e).find('ShortMessage').text()).get();
  return $;
}

/** Zugang prüfen: App-Token (immer) und, wenn verbunden, das Verkäuferkonto. */
export async function ebayTest(db) {
  resetAppToken();
  await appToken(db);
  const cfg = ebayConfig(db);
  return { ok: true, app: true, connected: cfg.connected, username: cfg.username };
}

// ---------- Eigene Angebote ----------
export async function syncListings(db) {
  const bySku = new Map(db.prepare('SELECT id, number FROM products').all().map((p) => [String(p.number).trim().toLowerCase(), p.id]));
  const seen = new Set();
  const now = new Date().toISOString();
  const up = db.prepare(`INSERT INTO ebay_listings(item_id, sku, product_id, title, price, quantity, sold, variation, url, status, checked_at) VALUES (?,?,?,?,?,?,?,?,?,'active',?)
    ON CONFLICT(item_id) DO UPDATE SET sku=excluded.sku, product_id=excluded.product_id, title=excluded.title, price=excluded.price, quantity=excluded.quantity, sold=excluded.sold, variation=excluded.variation, url=excluded.url, status='active', checked_at=excluded.checked_at`);
  let listings = 0, matched = 0;
  for (let page = 1, pages = 1; page <= pages && page <= 100; page++) {
    const $ = await trading(db, 'GetMyeBaySelling', `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`);
    pages = Number($('ActiveList > PaginationResult > TotalNumberOfPages').text()) || 1;
    $('ActiveList > ItemArray > Item').each((_, el) => {
      const it = $(el);
      const itemId = it.children('ItemID').text();
      const title = it.children('Title').text();
      const url = it.find('ListingDetails > ViewItemURL').text() || null;
      const vars = it.find('Variations > Variation');
      const rows = vars.length
        ? vars.map((_, v) => ({ sku: $(v).children('SKU').text(), price: Number($(v).children('StartPrice').text()), qty: Number($(v).children('Quantity').text()) - Number($(v).find('SellingStatus > QuantitySold').text() || 0), sold: Number($(v).find('SellingStatus > QuantitySold').text() || 0), variation: 1 })).get()
        : [{ sku: it.children('SKU').text(), price: Number(it.find('SellingStatus > CurrentPrice').text() || it.children('BuyItNowPrice').text() || 0), qty: Number(it.children('QuantityAvailable').text() || (Number(it.children('Quantity').text()) - Number(it.find('SellingStatus > QuantitySold').text() || 0))), sold: Number(it.find('SellingStatus > QuantitySold').text() || 0), variation: 0 }];
      listings++;
      rows.forEach((r, i) => {
        const id = rows.length > 1 ? `${itemId}:${r.sku || i}` : itemId;
        const pid = r.sku ? bySku.get(r.sku.trim().toLowerCase()) ?? null : null;
        if (pid) matched++;
        up.run(id, r.sku || null, pid, title, r.price || null, Math.max(0, r.qty || 0), r.sold || 0, r.variation, url, now);
        seen.add(id);
      });
    });
  }
  // nicht mehr aktive Angebote
  const all = db.prepare("SELECT item_id FROM ebay_listings WHERE status='active'").all();
  const end = db.prepare("UPDATE ebay_listings SET status='ended', checked_at=? WHERE item_id=?");
  for (const r of all) if (!seen.has(r.item_id)) end.run(now, r.item_id);
  setSetting(db, 'ebay_listings_at', now);
  return { listings, matched, unmatched: seen.size - matched };
}

// ---------- Mitbewerber auf eBay (Browse API, Suche über die EAN) ----------
export async function marketCheck(db, product) {
  const cfg = ebayConfig(db);
  const now = new Date().toISOString();
  const save = (r) => db.prepare(`INSERT OR REPLACE INTO ebay_market(product_id, checked_at, offers, min_total, min_price, min_shipping, min_seller, min_url, min_title, own_rank, error) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(product.id, now, r.offers ?? null, r.min_total ?? null, r.min_price ?? null, r.min_shipping ?? null, r.min_seller ?? null, r.min_url ?? null, r.min_title ?? null, r.own_rank ?? null, r.error ?? null);
  if (!product.ean) { save({ error: 'keine EAN' }); return null; }
  let j;
  try {
    j = await rest(db, 'GET', '/buy/browse/v1/item_summary/search', { app: true, query: { gtin: product.ean, filter: 'buyingOptions:{FIXED_PRICE},conditions:{NEW}', sort: 'price', limit: '50' } });
  } catch (e) { save({ error: e.message }); throw e; }
  const own = (cfg.username || '').toLowerCase();
  const offers = (j.itemSummaries ?? []).map((i) => {
    const price = Number(i.price?.value ?? NaN);
    const ship = i.shippingOptions?.length ? Math.min(...i.shippingOptions.map((s) => Number(s.shippingCost?.value ?? 0))) : 0;
    return { price, ship, total: Math.round((price + ship) * 100) / 100, seller: i.seller?.username ?? '', url: i.itemWebUrl ?? null, title: i.title ?? null };
  }).filter((o) => Number.isFinite(o.price) && o.price > 0).sort((a, b) => a.total - b.total);
  const others = offers.filter((o) => o.seller.toLowerCase() !== own);
  const ownIdx = own ? offers.findIndex((o) => o.seller.toLowerCase() === own) : -1;
  const m = others[0];
  const r = { offers: others.length, min_total: m?.total ?? null, min_price: m?.price ?? null, min_shipping: m?.ship ?? null, min_seller: m?.seller ?? null, min_url: m?.url ?? null, min_title: m?.title ?? null, own_rank: ownIdx >= 0 ? ownIdx + 1 : null };
  save(r);
  return r;
}

export const marketJob = { running: false, stop: false, total: 0, done: 0, errors: 0, finishedAt: null };
/** Fällige Artikel: mit EAN, beobachtet, aktiv; täglich geprüfte Artikel täglich, übrige wöchentlich. */
function dueMarket(db, limit) {
  const now = Date.now();
  return db.prepare(`SELECT p.id, p.ean, p.tier, s.revenue_90, m.checked_at, (SELECT 1 FROM ebay_listings l WHERE l.product_id=p.id AND l.status='active' LIMIT 1) AS listed
    FROM products p LEFT JOIN product_sales s ON s.product_id=p.id LEFT JOIN ebay_market m ON m.product_id=p.id
    WHERE p.active=1 AND p.tracked=1 AND p.offline_since IS NULL AND p.ean IS NOT NULL AND p.ean<>''`).all()
    .filter((r) => !r.checked_at || now - Date.parse(r.checked_at) > (r.tier === 'A' || r.listed ? 22 : 7 * 24) * 3600e3)
    // eigene eBay-Angebote zuerst, dann nie geprüfte, dann wichtige Artikel
    .sort((a, b) => (b.listed ?? 0) - (a.listed ?? 0) || (a.checked_at ? 1 : 0) - (b.checked_at ? 1 : 0) || (b.tier === 'A') - (a.tier === 'A') || (b.revenue_90 ?? 0) - (a.revenue_90 ?? 0))
    .slice(0, limit);
}
export function startMarketJob(db, { ids = null, manual = false } = {}) {
  if (marketJob.running) return false;
  const cfg = ebayConfig(db);
  if (!cfg.app) return false;
  const list = ids ? db.prepare(`SELECT id, ean FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : dueMarket(db, manual ? 300 : 30);
  if (!list.length) return false;
  Object.assign(marketJob, { running: true, stop: false, total: list.length, done: 0, errors: 0 });
  const gap = manual || ids ? 400 : Math.max(500, Math.round(86400e3 / Math.max(1, cfg.perDay)));
  (async () => {
    for (const p of list) {
      if (marketJob.stop) break;
      try { await marketCheck(db, p); } catch { marketJob.errors++; if (marketJob.errors > 5 && marketJob.errors > marketJob.done / 2) break; }
      marketJob.done++;
      await new Promise((r) => setTimeout(r, gap));
    }
  })().finally(() => { marketJob.running = false; marketJob.finishedAt = new Date().toISOString(); });
  return true;
}

let idle = 0;
/** Planer: Mitbewerberpreise laufend, eigene Angebote täglich. */
export function ebayTick(db) {
  const cfg = ebayConfig(db);
  if (!cfg.app) return;
  if (cfg.perDay && !marketJob.running && Date.now() > idle) { if (!startMarketJob(db)) idle = Date.now() + 15 * 60e3; }
  const last = Date.parse(getSetting(db, 'ebay_listings_at') || 0) || 0;
  const tried = Date.parse(getSetting(db, 'ebay_listings_tried') || 0) || 0;
  if (cfg.connected && Date.now() - last > 24 * 3600e3 && Date.now() - tried > 6 * 3600e3) {
    setSetting(db, 'ebay_listings_tried', new Date().toISOString());
    syncListings(db).catch((e) => console.error('eBay-Angebote:', e.message));
  }
}

// ---------- Kategorien, Merkmale, Richtlinien ----------
export async function suggestCategories(db, q) {
  const j = await rest(db, 'GET', `/commerce/taxonomy/v1/category_tree/${TREE_DE}/get_category_suggestions`, { app: true, query: { q: String(q).slice(0, 100) } });
  return (j.categorySuggestions ?? []).slice(0, 10).map((s) => ({
    id: String(s.category.categoryId), name: s.category.categoryName,
    path: [...(s.categoryTreeNodeAncestors ?? [])].reverse().map((a) => a.categoryName).concat(s.category.categoryName).join(' › '),
  }));
}

export async function aspects(db, categoryId) {
  const j = await rest(db, 'GET', `/commerce/taxonomy/v1/category_tree/${TREE_DE}/get_item_aspects_for_category`, { app: true, query: { category_id: String(categoryId) } });
  return (j.aspects ?? []).map((a) => ({
    name: a.localizedAspectName, required: Boolean(a.aspectConstraint?.aspectRequired), recommended: a.aspectConstraint?.aspectUsage === 'RECOMMENDED',
    free: (a.aspectConstraint?.aspectMode ?? 'FREE_TEXT') === 'FREE_TEXT', values: (a.aspectValues ?? []).slice(0, 80).map((v) => v.localizedValue),
  })).filter((a) => a.required || a.recommended);
}

export async function policies(db) {
  const mp = { marketplace_id: 'EBAY_DE' };
  const map = (list, key) => (list ?? []).map((p) => ({ id: p[key], name: p.name ?? p[key] }));
  try {
    const [f, p, r] = await Promise.all([
      rest(db, 'GET', '/sell/account/v1/fulfillment_policy', { query: mp }), rest(db, 'GET', '/sell/account/v1/payment_policy', { query: mp }), rest(db, 'GET', '/sell/account/v1/return_policy', { query: mp }),
    ]);
    return { fulfillment: map(f.fulfillmentPolicies, 'fulfillmentPolicyId'), payment: map(p.paymentPolicies, 'paymentPolicyId'), return: map(r.returnPolicies, 'returnPolicyId') };
  } catch (e) {
    if (/opt|business polic|SELLING_POLICY|Geschäftsrichtlinien/i.test(e.message)) throw new Error('Das eBay-Konto nutzt keine Rahmenbedingungen (Versand-, Zahlungs-, Rücknahmerichtlinien). In „Mein eBay → Konto → Rahmenbedingungen für Ihre Angebote“ aktivieren.');
    throw e;
  }
}

// ---------- Angebot vorbereiten und einstellen ----------
/** Beschreibung für eBay bereinigen: keine Skripte, Formulare, Einbettungen, keine Links nach außen. */
export function cleanDescription(html) {
  const $ = cheerio.load(`<div id="d">${html || ''}</div>`);
  $('script, style, iframe, object, embed, form, input, button, link, meta').remove();
  $('a').each((_, a) => $(a).replaceWith($(a).text()));
  $('*').each((_, e) => { for (const n of Object.keys(e.attribs ?? {})) if (/^on/i.test(n) || (n === 'src' && /^javascript:/i.test(e.attribs[n]))) $(e).removeAttr(n); });
  return $('#d').html().trim();
}

/** Entwurf aus Shopware-Daten, Kanal-Rechner und eBay-Markt. */
export async function draft(db, productId) {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!p) throw new Error('Artikel nicht gefunden');
  const cfg = ebayConfig(db);
  const sw = await productDetails(db, { swId: p.sw_id, number: p.number }).catch((e) => ({ error: e.message }));
  const d = sw && !sw.error ? sw : null;
  const mkt = db.prepare('SELECT * FROM ebay_market WHERE product_id=?').get(productId) ?? null;
  const existing = db.prepare("SELECT item_id, url, price FROM ebay_listings WHERE status='active' AND (product_id=? OR lower(sku)=lower(?))").get(productId, p.number) ?? null;
  const view = channelView(db, p, { prices: { shop: p.price }, market: { ebay: mkt?.min_total ?? null } }).find((c) => c.key === 'ebay');
  const ch = channel(db, 'ebay');
  // Preisvorschlag: unter dem günstigsten eBay-Angebot, nie unter der Untergrenze; sonst Zielpreis, sonst Shop-Preis
  const suggested = view?.suggestion ?? (view?.floor != null && p.price != null ? Math.max(view.floor, p.price) : p.price);
  const brand = d?.manufacturer || p.manufacturer || '';
  const mpn = d?.mpn || p.mpn || '';
  return {
    product: { id: p.id, number: p.number, name: p.name, price: p.price, purchase_price: p.purchase_price, tax_rate: p.tax_rate, stock: d?.stock ?? p.stock, ean: d?.ean || p.ean, url: p.url },
    shopware: d ? { images: d.images, properties: d.properties, has_description: Boolean(d.description) } : null, shopware_error: sw?.error ?? (sw ? null : 'Shopware nicht verbunden: ohne Bilder und Beschreibung'),
    existing, market: mkt, channel: ch, calc: view,
    defaults: {
      sku: p.number, title: (d?.name || p.name).slice(0, 80), description: cleanDescription(d?.description || ''),
      price: suggested, quantity: Math.max(0, Math.min(cfg.maxQty, d?.stock ?? p.stock ?? 0)), condition: cfg.condition,
      specifics: { Marke: brand, Herstellernummer: mpn, ...(d?.properties ?? {}) }, images: d?.images ?? [], ean: d?.ean || p.ean || '',
    },
    policies_ok: Boolean(cfg.policies.fulfillment && cfg.policies.payment && cfg.policies.return && cfg.location && cfg.postalCode),
    connected: cfg.connected,
  };
}

/**
 * Festpreis-Angebot prüfen (verify) oder einstellen. SKU ist immer die Artikelnummer (= JTL-Artikelnummer),
 * damit der JTL-Angebotsimport das Angebot dem vorhandenen Artikel zuordnet und keine Dublette anlegt.
 */
export async function createListing(db, productId, d, { verify = false } = {}) {
  const cfg = ebayConfig(db);
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!p) throw new Error('Artikel nicht gefunden');
  if (!cfg.connected) throw new Error('eBay ist nicht verbunden');
  for (const [k, label] of [['fulfillment', 'Versand'], ['payment', 'Zahlung'], ['return', 'Rücknahme']]) if (!cfg.policies[k]) throw new Error(`In den eBay-Einstellungen fehlt die ${label}srichtlinie`);
  if (!cfg.location || !cfg.postalCode) throw new Error('In den eBay-Einstellungen fehlen Artikelstandort und Postleitzahl');
  const dup = db.prepare("SELECT item_id FROM ebay_listings WHERE status='active' AND (product_id=? OR lower(sku)=lower(?))").get(productId, p.number);
  if (dup) throw new Error(`Für Artikelnummer ${p.number} läuft bereits ein eBay-Angebot (${dup.item_id})`);
  const title = String(d.title ?? '').trim();
  if (!title || title.length > 80) throw new Error('Titel: 1 bis 80 Zeichen');
  if (!d.category_id) throw new Error('Bitte eine eBay-Kategorie wählen');
  const price = Number(String(d.price).replace(',', '.'));
  if (!(price > 0)) throw new Error('Preis fehlt');
  const ch = channel(db, 'ebay');
  const floor = floorPrice(p.purchase_price > 0 ? p.purchase_price : null, ch, p.tax_rate ?? 19, 0);
  if (floor != null && price < floor && !d.allow_loss) throw new Error(`Der Preis liegt unter der Verlustgrenze von ${floor.toFixed(2).replace('.', ',')} € (Einkauf, Gebühren, Versand)`);
  const qty = Math.floor(Number(d.quantity));
  if (!(qty >= 1)) throw new Error('Menge mindestens 1');
  const specifics = Object.entries(d.specifics ?? {}).filter(([k, v]) => k.trim() && String(v ?? '').trim());
  const pics = (d.images ?? []).filter((u) => /^https:\/\//.test(u)).slice(0, 12);
  const ean = String(d.ean ?? p.ean ?? '').trim();
  const item = `<Title>${x(title)}</Title>`
    + `<Description><![CDATA[${String(cleanDescription(d.description || '') || x(p.name)).replace(/]]>/g, '')}]]></Description>`
    + `<PrimaryCategory><CategoryID>${x(d.category_id)}</CategoryID></PrimaryCategory>`
    + `<ConditionID>${Number(d.condition) || cfg.condition}</ConditionID>`
    + `<Country>DE</Country><Currency>EUR</Currency><Site>Germany</Site><Location>${x(cfg.location)}</Location><PostalCode>${x(cfg.postalCode)}</PostalCode>`
    + '<ListingDuration>GTC</ListingDuration><ListingType>FixedPriceItem</ListingType>'
    + `<SKU>${x(p.number)}</SKU><StartPrice currencyID="EUR">${price.toFixed(2)}</StartPrice><Quantity>${qty}</Quantity>`
    + (ean ? `<ProductListingDetails><EAN>${x(ean)}</EAN></ProductListingDetails>` : '')
    + (specifics.length ? `<ItemSpecifics>${specifics.map(([k, v]) => `<NameValueList><Name>${x(k.slice(0, 65))}</Name><Value>${x(String(v).slice(0, 65))}</Value></NameValueList>`).join('')}</ItemSpecifics>` : '')
    + (pics.length ? `<PictureDetails>${pics.map((u) => `<PictureURL>${x(u)}</PictureURL>`).join('')}</PictureDetails>` : '')
    + `<SellerProfiles><SellerShippingProfile><ShippingProfileID>${x(cfg.policies.fulfillment)}</ShippingProfileID></SellerShippingProfile><SellerReturnProfile><ReturnProfileID>${x(cfg.policies.return)}</ReturnProfileID></SellerReturnProfile><SellerPaymentProfile><PaymentProfileID>${x(cfg.policies.payment)}</PaymentProfileID></SellerPaymentProfile></SellerProfiles>`;
  const $ = await trading(db, verify ? 'VerifyAddFixedPriceItem' : 'AddFixedPriceItem', `<Item>${item}</Item>`);
  let fees = 0;
  $('Fees > Fee').each((_, f) => { fees += Number($(f).children('Fee').text() || 0); });
  const itemId = verify ? null : $('ItemID').first().text() || null;
  if (itemId) {
    const url = `https://www.ebay.de/itm/${itemId}`;
    db.prepare(`INSERT OR REPLACE INTO ebay_listings(item_id, sku, product_id, title, price, quantity, sold, variation, url, status, created_by_us, jtl_state, created_at, checked_at) VALUES (?,?,?,?,?,?,0,0,?,'active',1,'pending',?,?)`)
      .run(itemId, p.number, p.id, title, price, qty, url, new Date().toISOString(), new Date().toISOString());
  }
  return { item_id: itemId, fees: Math.round(fees * 100) / 100, warnings: [...new Set($.warnings)] };
}

// ---------- Übersicht ----------
export function ebayOverview(db) {
  const cfg = ebayConfig(db);
  const listings = db.prepare(`SELECT l.*, p.name, p.number, p.price AS shop_price, p.purchase_price, p.tax_rate, p.stock FROM ebay_listings l LEFT JOIN products p ON p.id=l.product_id WHERE l.status='active' ORDER BY l.created_by_us DESC, l.title`).all();
  const ch = channel(db, 'ebay');
  const market = new Map(db.prepare('SELECT * FROM ebay_market').all().map((m) => [m.product_id, m]));
  const rows = listings.map((l) => {
    const m = l.product_id ? market.get(l.product_id) : null;
    const v = l.product_id ? channelView(db, { purchase_price: l.purchase_price, tax_rate: l.tax_rate }, { prices: { ebay: l.price }, market: { ebay: m?.min_total ?? null } }).find((c) => c.key === 'ebay') : null;
    return { ...l, market: m ?? null, calc: v ?? null };
  });
  const stats = db.prepare('SELECT COUNT(*) AS n, SUM(min_total IS NOT NULL) AS with_offers, MAX(checked_at) AS last FROM ebay_market').get();
  return {
    config: { app: cfg.app, can_connect: cfg.canConnect, connected: cfg.connected, username: cfg.username, policies_ok: Boolean(cfg.policies.fulfillment && cfg.policies.payment && cfg.policies.return && cfg.location && cfg.postalCode), per_day: cfg.perDay, sandbox: cfg.sandbox },
    listings_at: getSetting(db, 'ebay_listings_at'),
    listings: rows, pending_jtl: rows.filter((r) => r.created_by_us && r.jtl_state === 'pending').length,
    unmatched: rows.filter((r) => !r.product_id).length,
    market: { checked: stats.n, with_offers: stats.with_offers ?? 0, last: stats.last, job: { ...marketJob } },
    fees: ch,
  };
}
