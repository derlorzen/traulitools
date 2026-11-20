/**
 * Eigene Produkte über die Shopware-6-Admin-API lesen.
 * In Shopware unter Einstellungen -> System -> Integrationen eine Integration anlegen
 * (Lesezugriff auf Produkte reicht) und Client-ID/Secret als Umgebungsvariablen setzen.
 */
import { getSetting } from './settings.js';

export function shopwareConfig(db) {
  const g = (k, env) => (db ? getSetting(db, k) : null) || process.env[env] || '';
  const url = g('shopware_url', 'SHOPWARE_URL').replace(/\/+$/, '');
  return {
    url,
    clientId: g('shopware_client_id', 'SHOPWARE_CLIENT_ID'),
    clientSecret: g('shopware_client_secret', 'SHOPWARE_CLIENT_SECRET'),
    ownUrl: (g('own_url', 'OWN_SHOP_URL') || url).replace(/\/+$/, ''),
    get configured() {
      return Boolean(this.url && this.clientId && this.clientSecret);
    },
  };
}

async function api(cfg, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${cfg.url}/api${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Shopware antwortet mit HTTP ${res.status} (kein JSON)`);
  }
  if (!res.ok) {
    const detail = json?.errors?.[0]?.detail || json?.error_description || json?.message || `HTTP ${res.status}`;
    throw new Error(`Shopware: ${detail}`);
  }
  return json;
}

export async function testShopware(cfg) {
  if (!cfg.configured) throw new Error('Bitte Shop-URL, Client-ID und Secret ausfüllen');
  const tok = await api(cfg, '/oauth/token', { body: { grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret } });
  const res = await api(cfg, '/search/product', { token: tok.access_token, body: { limit: 1, 'total-count-mode': 1, filter: [{ type: 'equals', field: 'active', value: true }], includes: { product: ['id'] } } });
  return { products: res.total ?? 0 };
}

/*
 * Täglicher Abgleich mit Shopware 6.5 bis 6.7 (nur lesen; preisführend bleibt die Warenwirtschaft).
 * Ab 6.6 ist `stock` der verkaufbare Bestand (`availableStock` spiegelt ihn nur noch).
 * Benötigte Rechte der Integration (lesen): product, tax, order, order_line_item, state_machine_state.
 * Verkaufspreis, Einkaufspreis, Steuersatz und Bestand der bekannten Artikel sowie verkaufte Stück und Umsatz
 * der letzten 30 und 90 Tage (ohne stornierte Bestellungen).
 */
async function token(cfg) {
  const tok = await api(cfg, '/oauth/token', { body: { grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret } });
  if (!tok.access_token) throw new Error('Shopware: Kein Zugriffstoken erhalten');
  return tok.access_token;
}
const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

async function salesSince(cfg, tok, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const body = {
    limit: 1,
    filter: [
      { type: 'equals', field: 'type', value: 'product' },
      { type: 'range', field: 'order.orderDateTime', parameters: { gte: since } },
      { type: 'not', operator: 'or', queries: [{ type: 'equals', field: 'order.stateMachineState.technicalName', value: 'cancelled' }] },
    ],
    aggregations: [
      { name: 'units', type: 'terms', field: 'productId', limit: 50000, aggregation: { name: 'sum', type: 'sum', field: 'quantity' } },
      { name: 'revenue', type: 'terms', field: 'productId', limit: 50000, aggregation: { name: 'sum', type: 'sum', field: 'totalPrice' } },
    ],
    includes: { order_line_item: ['id'] },
  };
  const res = await api(cfg, '/search/order-line-item', { token: tok, body });
  const read = (name) => new Map((res.aggregations?.[name]?.buckets ?? []).filter((b) => b.key).map((b) => [b.key, Number(b.sum?.sum ?? 0)]));
  return { units: read('units'), revenue: read('revenue') };
}

/**
 * Umsatz, Stück und Gewinn je Tag (letzte 100 Tage) für die Übersicht. Zwei Abfragen über Tages-Histogramme
 * (Bestellpositionen je Artikel und Bestellungen), stornierte Bestellungen zählen nicht.
 * Gewinn je Position: Gewinn je Stück nach den Shop-Kanalregeln (Gebühren, Versand) mit dem Einkaufspreis;
 * Positionen ohne Einkaufspreis zählen nur zum Umsatz (profit_base hält fest, wie viel Umsatz einen Gewinn hat).
 */
export async function syncShopwareDaily(db, { channelOf, profitOf } = {}) {
  const cfg = shopwareConfig(db);
  if (!cfg.configured) throw new Error('Shopware-Zugang fehlt');
  const tok = await token(cfg);
  const since = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
  const notCancelled = { type: 'not', operator: 'or', queries: [{ type: 'equals', field: 'order.stateMachineState.technicalName', value: 'cancelled' }] };
  const li = await api(cfg, '/search/order-line-item', {
    token: tok,
    body: {
      limit: 1,
      filter: [{ type: 'equals', field: 'type', value: 'product' }, { type: 'range', field: 'order.orderDate', parameters: { gte: since } }, notCancelled],
      aggregations: [
        { name: 'qty', type: 'histogram', field: 'order.orderDate', interval: 'day', aggregation: { name: 'p', type: 'terms', field: 'productId', limit: 5000, aggregation: { name: 's', type: 'sum', field: 'quantity' } } },
        { name: 'rev', type: 'histogram', field: 'order.orderDate', interval: 'day', aggregation: { name: 'p', type: 'terms', field: 'productId', limit: 5000, aggregation: { name: 's', type: 'sum', field: 'totalPrice' } } },
      ],
      includes: { order_line_item: ['id'] },
    },
  });
  const ord = await api(cfg, '/search/order', {
    token: tok,
    body: {
      limit: 1,
      filter: [{ type: 'range', field: 'orderDate', parameters: { gte: since } }, { type: 'not', operator: 'or', queries: [{ type: 'equals', field: 'stateMachineState.technicalName', value: 'cancelled' }] }],
      aggregations: [{ name: 'orders', type: 'histogram', field: 'orderDate', interval: 'day' }],
      includes: { order: ['id'] },
    },
  });
  const dayOf = (k) => String(k ?? '').slice(0, 10);
  const days = new Map();
  const get = (d) => { if (!days.has(d)) days.set(d, { revenue: 0, units: 0, orders: 0, profit: 0, base: 0 }); return days.get(d); };
  const qty = new Map(); // Tag|Produkt -> Stück
  for (const b of li.aggregations?.qty?.buckets ?? []) for (const x of b.p?.buckets ?? []) qty.set(`${dayOf(b.key)}|${x.key}`, Number(x.s?.sum ?? 0));
  const bySw = new Map(db.prepare('SELECT id, sw_id, purchase_price, tax_rate FROM products WHERE sw_id IS NOT NULL').all().map((p) => [p.sw_id, p]));
  for (const b of li.aggregations?.rev?.buckets ?? []) {
    const d = dayOf(b.key);
    if (!d) continue;
    const row = get(d);
    for (const x of b.p?.buckets ?? []) {
      const rev = Number(x.s?.sum ?? 0), n = qty.get(`${d}|${x.key}`) ?? 0;
      row.revenue += rev; row.units += n;
      const p = bySw.get(x.key);
      const per = p && n > 0 && profitOf ? profitOf(rev / n, p) : null;
      if (per != null) { row.profit += per * n; row.base += rev; }
    }
  }
  for (const b of ord.aggregations?.orders?.buckets ?? []) { const d = dayOf(b.key); if (d) get(d).orders = Number(b.count ?? 0); }
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const up = db.prepare('INSERT INTO shop_daily(day, revenue, units, orders, profit, profit_base, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET revenue=excluded.revenue, units=excluded.units, orders=excluded.orders, profit=excluded.profit, profit_base=excluded.profit_base, updated_at=excluded.updated_at');
    db.prepare('DELETE FROM shop_daily WHERE day >= ?').run(since);
    for (const [d, v] of days) up.run(d, money(v.revenue), v.units, v.orders, money(v.profit), money(v.base), now);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { days: days.size };
}

/**
 * SEO-URLs der Produktseiten (kanonisch, nicht gelöscht) im Verkaufskanal der eigenen Domain.
 * Braucht Leserechte auf seo_url und sales_channel_domain; fehlen sie, kommen neue Artikel ohne Link
 * (die Sitemap trägt ihn nach) und der Abgleich läuft trotzdem.
 */
async function seoUrls(cfg, tok) {
  const map = new Map();
  try {
    let host = null;
    try { host = new URL(cfg.ownUrl).host.replace(/^www\./, ''); } catch { /* ohne eigene URL */ }
    const doms = await api(cfg, '/search/sales-channel-domain', { token: tok, body: { limit: 200, includes: { sales_channel_domain: ['url', 'salesChannelId', 'languageId'] } } });
    const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } };
    const list = doms.data ?? [];
    const dom = list.find((d) => host && hostOf(d.url) === host && !/\/[a-z]{2}(-[a-z]{2})?\/?$/i.test(new URL(d.url).pathname)) ?? list.find((d) => host && hostOf(d.url) === host) ?? null;
    const base = (dom?.url || cfg.ownUrl).replace(/\/+$/, '');
    const filter = [
      { type: 'equals', field: 'routeName', value: 'frontend.detail.page' },
      { type: 'equals', field: 'isCanonical', value: true },
      { type: 'equals', field: 'isDeleted', value: false },
      ...(dom ? [{ type: 'equals', field: 'salesChannelId', value: dom.salesChannelId }, { type: 'equals', field: 'languageId', value: dom.languageId }] : []),
    ];
    let seen = 0;
    for (let page = 1; page < 400; page++) {
      const res = await api(cfg, '/search/seo-url', { token: tok, body: { page, limit: 500, 'total-count-mode': 1, filter, includes: { seo_url: ['foreignKey', 'seoPathInfo'] } } });
      const data = res.data ?? [];
      seen += data.length;
      for (const u of data) if (u.foreignKey && u.seoPathInfo && !map.has(u.foreignKey)) map.set(u.foreignKey, `${base}/${String(u.seoPathInfo).replace(/^\/+/, '')}`);
      if (seen >= (res.total ?? 0) || !data.length) break;
    }
    return { map, error: null };
  } catch (e) {
    return { map, error: e.message };
  }
}

/**
 * Täglicher Abgleich: aktualisiert bekannte Artikel, legt neue aktive Artikel an und markiert in Shopware
 * deaktivierte als offline (nur diese hebt er bei Reaktivierung wieder auf; was die Sitemap als offline
 * erkennt, bleibt Sache der Sitemap). Vorhandene Links werden nie überschrieben, nur leere gefüllt.
 */
export async function syncShopware(db) {
  const cfg = shopwareConfig(db);
  if (!cfg.configured) throw new Error('Shopware-Zugang fehlt (Einstellungen → Shopware)');
  const tok = await token(cfg);
  const all = [];
  for (let page = 1; page < 400; page++) {
    const res = await api(cfg, '/search/product', {
      token: tok,
      body: {
        page, limit: 500, 'total-count-mode': 1,
        associations: { tax: {}, manufacturer: {} },
        includes: {
          product: ['id', 'productNumber', 'active', 'price', 'purchasePrices', 'stock', 'availableStock', 'parentId', 'childCount', 'tax', 'taxId', 'name', 'translated', 'ean', 'manufacturerNumber', 'manufacturer'],
          tax: ['taxRate'], product_manufacturer: ['name', 'translated'],
        },
      },
    });
    const data = res.data ?? [];
    all.push(...data);
    if (all.length >= (res.total ?? 0) || !data.length) break;
  }
  const seo = await seoUrls(cfg, tok);
  const byId = new Map(all.map((p) => [p.id, p]));
  const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;
  const nz = (v) => (v == null || v === '' ? null : String(v));
  const known = new Map(db.prepare('SELECT id, number, price, offline_since, sw_inactive FROM products').all().map((p) => [p.number, p]));
  const now = new Date().toISOString();
  const upd = db.prepare(`UPDATE products SET sw_id=?, price=COALESCE(?, price), purchase_price=COALESCE(?, purchase_price), tax_rate=COALESCE(?, tax_rate), stock=?,
    url=COALESCE(NULLIF(url,''), ?), ean=COALESCE(NULLIF(ean,''), ?), mpn=COALESCE(NULLIF(mpn,''), ?), manufacturer=COALESCE(NULLIF(manufacturer,''), ?), updated_at=? WHERE id=?`);
  const off = db.prepare('UPDATE products SET offline_since=COALESCE(offline_since, ?), sw_inactive=1 WHERE id=?');
  const on = db.prepare('UPDATE products SET offline_since=NULL, sw_inactive=0 WHERE id=?');
  const ins = db.prepare(`INSERT INTO products(number, ean, mpn, name, manufacturer, url, price, active, source, updated_at, tracked, sw_id, purchase_price, tax_rate, stock)
    VALUES (?,?,?,?,?,?,?,1,'shopware',?,1,?,?,?,?)`);
  const hist = db.prepare('INSERT INTO product_price_history(product_id, price, at) VALUES (?,?,?)');
  const swToLocal = new Map();
  let updated = 0, created = 0, deactivated = 0, reactivated = 0, skipped = 0, withPurchase = 0, withUrl = 0;
  db.exec('BEGIN');
  try {
    for (const p of all) {
      if (p.childCount > 0) continue; // Hauptartikel mit Varianten sind nicht kaufbar
      if (!p.productNumber) { skipped++; continue; }
      const parent = p.parentId ? byId.get(p.parentId) : null;
      const price = money(first(p.price)?.gross ?? first(parent?.price)?.gross);
      const purchase = money(first(p.purchasePrices)?.net ?? first(parent?.purchasePrices)?.net);
      const tax = p.tax?.taxRate ?? parent?.tax?.taxRate ?? null;
      const active = (p.active ?? parent?.active ?? true) !== false;
      const name = p.translated?.name || p.name || parent?.translated?.name || parent?.name || null;
      const ean = nz(p.ean ?? parent?.ean);
      const mpn = nz(p.manufacturerNumber ?? parent?.manufacturerNumber);
      const manu = p.manufacturer?.translated?.name || p.manufacturer?.name || parent?.manufacturer?.translated?.name || parent?.manufacturer?.name || null;
      const url = seo.map.get(p.id) || (parent ? seo.map.get(parent.id) : null) || null;
      const stock = p.stock ?? p.availableStock ?? null;
      if (url) withUrl++;
      const local = known.get(String(p.productNumber));
      if (!local) {
        if (!active || !name) { skipped++; continue; }
        const r = ins.run(String(p.productNumber), ean, mpn, name, manu, url, price, now, p.id, purchase && purchase > 0 ? purchase : null, tax, stock);
        if (price != null) hist.run(r.lastInsertRowid, price, now);
        swToLocal.set(p.id, Number(r.lastInsertRowid));
        if (purchase > 0) withPurchase++;
        created++;
        continue;
      }
      upd.run(p.id, price, purchase && purchase > 0 ? purchase : null, tax, stock, url, ean, mpn, manu, now, local.id);
      if (price != null && price !== local.price) hist.run(local.id, price, now);
      if (!active) { if (!local.sw_inactive) deactivated++; off.run(now, local.id); }
      else if (local.sw_inactive) { on.run(local.id); reactivated++; }
      if (purchase > 0) withPurchase++;
      swToLocal.set(p.id, local.id);
      updated++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Verkäufe
  const s30 = await salesSince(cfg, tok, 30);
  const s90 = await salesSince(cfg, tok, 90);
  const insSales = db.prepare('INSERT INTO product_sales(product_id, units_30, revenue_30, units_90, revenue_90, updated_at) VALUES (?,?,?,?,?,?)');
  let sold = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM product_sales');
    for (const [swId, localId] of swToLocal) {
      const u90 = s90.units.get(swId) ?? 0;
      if (!u90) continue;
      insSales.run(localId, s30.units.get(swId) ?? 0, money(s30.revenue.get(swId) ?? 0), u90, money(s90.revenue.get(swId) ?? 0), now);
      sold++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { products: all.length, created, updated, deactivated, reactivated, unknown: skipped, with_purchase: withPurchase, with_url: withUrl, seo_error: seo.error, sold_90: sold };
}

/**
 * Angebotsdaten eines Artikels für Marktplätze: Beschreibung, Bilder, Hersteller, Eigenschaften, Maße.
 * Mit `sw-inheritance` liefert Shopware bei Varianten die vom Hauptartikel geerbten Werte mit.
 */
export async function productDetails(db, { swId, number }) {
  const cfg = shopwareConfig(db);
  if (!cfg.configured) return null;
  const tok = await token(cfg);
  const res = await api(cfg, '/search/product', {
    token: tok,
    headers: { 'sw-inheritance': '1' },
    body: {
      limit: 1,
      filter: [swId ? { type: 'equals', field: 'id', value: swId } : { type: 'equals', field: 'productNumber', value: String(number) }],
      associations: { media: { sort: [{ field: 'position', order: 'ASC' }], associations: { media: {} } }, cover: { associations: { media: {} } }, manufacturer: {}, properties: { associations: { group: {} } }, options: { associations: { group: {} } } },
      includes: {
        product: ['id', 'productNumber', 'ean', 'manufacturerNumber', 'name', 'description', 'translated', 'media', 'cover', 'manufacturer', 'properties', 'options', 'stock', 'weight', 'width', 'height', 'length'],
        product_media: ['media', 'position'], media: ['url', 'alt'], product_manufacturer: ['name', 'translated'],
        property_group_option: ['name', 'translated', 'group'], property_group: ['name', 'translated'],
      },
    },
  });
  const p = res.data?.[0];
  if (!p) return null;
  const t = (x) => x?.translated?.name || x?.name || null;
  const urls = [];
  for (const m of [p.cover, ...(p.media ?? [])]) { const u = m?.media?.url; if (u && /^https:\/\//.test(u) && !urls.includes(u)) urls.push(u); }
  const props = {};
  for (const o of [...(p.properties ?? []), ...(p.options ?? [])]) {
    const g = t(o.group);
    if (!g) continue;
    props[g] = props[g] ? `${props[g]}, ${t(o)}` : t(o);
  }
  return {
    sw_id: p.id, number: p.productNumber, name: p.translated?.name || p.name, description: p.translated?.description || p.description || '',
    ean: p.ean || null, mpn: p.manufacturerNumber || null, manufacturer: t(p.manufacturer), images: urls.slice(0, 12), properties: props,
    stock: p.stock ?? null, weight: p.weight ?? null, dims: [p.length, p.width, p.height].every((v) => v) ? { length: p.length, width: p.width, height: p.height } : null,
  };
}
