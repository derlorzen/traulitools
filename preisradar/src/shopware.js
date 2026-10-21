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

async function api(cfg, path, { token, body } = {}) {
  const res = await fetch(`${cfg.url}/api${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
