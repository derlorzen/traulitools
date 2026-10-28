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

export async function fetchShopwareProducts(cfg) {
  if (!cfg.configured) throw new Error('Shopware-Zugang fehlt (Einstellungen → Shopware)');
  const tok = await api(cfg, '/oauth/token', {
    body: { grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret },
  });
  const token = tok.access_token;
  if (!token) throw new Error('Shopware: Kein Zugriffstoken erhalten');

  const all = [];
  for (let page = 1; page < 200; page++) {
    const res = await api(cfg, '/search/product', {
      token,
      body: {
        page,
        limit: 500,
        'total-count-mode': 1,
        filter: [{ type: 'equals', field: 'active', value: true }],
        associations: { manufacturer: {} },
        includes: {
          product: ['id', 'productNumber', 'ean', 'manufacturerNumber', 'active', 'price', 'parentId', 'childCount', 'name', 'translated', 'manufacturer'],
          product_manufacturer: ['id', 'name', 'translated'],
        },
      },
    });
    const data = res.data ?? [];
    all.push(...data);
    if (all.length >= (res.total ?? 0) || data.length === 0) break;
  }

  const byId = new Map(all.map((p) => [p.id, p]));
  const gross = (p) => {
    const list = Array.isArray(p?.price) ? p.price : p?.price ? [p.price] : [];
    const v = list[0]?.gross;
    return typeof v === 'number' ? Math.round(v * 100) / 100 : null;
  };
  const rows = [];
  for (const p of all) {
    if (p.childCount > 0) continue; // Eltern-Produkte mit Varianten sind nicht kaufbar
    const parent = p.parentId ? byId.get(p.parentId) : null;
    const name = p.translated?.name || p.name || parent?.translated?.name || parent?.name;
    const price = gross(p) ?? gross(parent);
    if (!p.productNumber || !name) continue;
    rows.push({
      number: String(p.productNumber),
      ean: p.ean || parent?.ean || null,
      mpn: p.manufacturerNumber || parent?.manufacturerNumber || null,
      name,
      manufacturer: p.manufacturer?.translated?.name || p.manufacturer?.name || parent?.manufacturer?.translated?.name || null,
      url: `${cfg.ownUrl || cfg.url}/detail/${p.id}`,
      price,
    });
  }
  return rows;
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
        associations: { tax: {} },
        includes: { product: ['id', 'productNumber', 'active', 'price', 'purchasePrices', 'stock', 'availableStock', 'parentId', 'childCount', 'tax', 'taxId'], tax: ['taxRate'] },
      },
    });
    const data = res.data ?? [];
    all.push(...data);
    if (all.length >= (res.total ?? 0) || !data.length) break;
  }
  const byId = new Map(all.map((p) => [p.id, p]));
  const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;
  const known = new Map(db.prepare('SELECT id, number, price FROM products').all().map((p) => [p.number, p]));
  const now = new Date().toISOString();
  const upd = db.prepare('UPDATE products SET sw_id=?, price=COALESCE(?, price), purchase_price=COALESCE(?, purchase_price), tax_rate=COALESCE(?, tax_rate), stock=?, updated_at=? WHERE id=?');
  const hist = db.prepare('INSERT INTO product_price_history(product_id, price, at) VALUES (?,?,?)');
  const swToLocal = new Map();
  let updated = 0, unknown = 0, withPurchase = 0;
  db.exec('BEGIN');
  try {
    for (const p of all) {
      if (p.childCount > 0) continue;
      const local = known.get(String(p.productNumber));
      if (!local) { unknown++; continue; }
      const parent = p.parentId ? byId.get(p.parentId) : null;
      const price = money(first(p.price)?.gross ?? first(parent?.price)?.gross);
      const purchase = money(first(p.purchasePrices)?.net ?? first(parent?.purchasePrices)?.net);
      const tax = p.tax?.taxRate ?? parent?.tax?.taxRate ?? null;
      upd.run(p.id, price, purchase && purchase > 0 ? purchase : null, tax, p.stock ?? p.availableStock ?? null, now, local.id);
      if (price != null && price !== local.price) hist.run(local.id, price, now);
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
  const ins = db.prepare('INSERT INTO product_sales(product_id, units_30, revenue_30, units_90, revenue_90, updated_at) VALUES (?,?,?,?,?,?)');
  let sold = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM product_sales');
    for (const [swId, localId] of swToLocal) {
      const u90 = s90.units.get(swId) ?? 0;
      if (!u90) continue;
      ins.run(localId, s30.units.get(swId) ?? 0, money(s30.revenue.get(swId) ?? 0), u90, money(s90.revenue.get(swId) ?? 0), now);
      sold++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { products: all.length, updated, unknown, with_purchase: withPurchase, sold_90: sold };
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
