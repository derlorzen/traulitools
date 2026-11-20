import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, upsertProducts } from '../src/db.js';
import { syncShopware } from '../src/shopware.js';
import { analyse } from '../src/analysis.js';
import { listProducts } from '../src/pricelist.js';
import { setSetting, initSecrets } from '../src/settings.js';

test('Shopware-Abgleich: Preise, Einkaufspreise, Bestand, Verkäufe; Mindestmarge begrenzt Senkungen', async () => {
  initSecrets(null);
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = b ? JSON.parse(b) : {};
      bodies.push([req.url, j]);
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/oauth/token') return send({ access_token: 't' });
      if (req.url === '/api/search/product') return send({ total: 3, data: [
        { id: 'p1', productNumber: 'A1', childCount: 0, price: [{ gross: 119 }], purchasePrices: [{ net: 80 }], stock: 7, availableStock: 3, tax: { taxRate: 19 } },
        { id: 'p2', productNumber: 'A2', childCount: 0, price: [{ gross: 59.5 }], purchasePrices: null, availableStock: 0, tax: { taxRate: 19 } },
        { id: 'p3', productNumber: 'FREMD', childCount: 0, price: [{ gross: 1 }] },
      ] });
      if (req.url === '/api/search/order-line-item') {
        const days = Math.round((Date.now() - Date.parse(j.filter[1].parameters.gte)) / 864e5);
        const f = days > 40 ? 3 : 1;
        return send({ aggregations: {
          units: { buckets: [{ key: 'p1', sum: { sum: 4 * f } }, { key: 'p2', sum: { sum: 1 * f } }] },
          revenue: { buckets: [{ key: 'p1', sum: { sum: 476 * f } }, { key: 'p2', sum: { sum: 59.5 * f } }] },
        } });
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const db = openDb(':memory:');
    upsertProducts(db, [{ number: 'A1', name: 'Eins', price: 100 }, { number: 'A2', name: 'Zwei', price: 50 }], 'csv');
    setSetting(db, 'shopware_url', `http://127.0.0.1:${srv.address().port}`);
    setSetting(db, 'shopware_client_id', 'id');
    setSetting(db, 'shopware_client_secret', 'secret', { secret: true });
    const r = await syncShopware(db);
    assert.deepEqual([r.updated, r.created, r.unknown, r.with_purchase, r.sold_90], [2, 0, 1, 1, 2]);
    const p1 = db.prepare("SELECT price, purchase_price, tax_rate, stock, sw_id FROM products WHERE number='A1'").get();
    assert.deepEqual({ ...p1 }, { price: 119, purchase_price: 80, tax_rate: 19, stock: 7, sw_id: 'p1' });
    const s1 = db.prepare('SELECT units_30, units_90, revenue_90 FROM product_sales WHERE product_id=1').get();
    assert.deepEqual({ ...s1 }, { units_30: 4, units_90: 12, revenue_90: 1428 });
    const li = bodies.find(([u]) => u === '/api/search/order-line-item')[1];
    assert.equal(li.filter[2].type, 'not'); // stornierte Bestellungen ausgeschlossen

    // Mitbewerber günstiger: 99 € liegt unter der Untergrenze bei 10 % Mindestmarge (80 / 0,9 × 1,19 = 105,78 €)
    db.prepare("INSERT INTO competitors(id, name, base_url) VALUES (1,'M','https://m.example')").run();
    db.prepare("INSERT INTO matches(product_id, competitor_id, status, price) VALUES (1,1,'ok',99)").run();
    let row = analyse(db).rows.find((x) => x.id === 1);
    assert.equal(row.action, 'senken');
    assert.equal(row.suggested_price, 105.78);
    assert.equal(row.margin_limited, true);
    assert.equal(row.units_30, 4);
    setSetting(db, 'min_margin', '40'); // Untergrenze 158,67 € liegt über dem eigenen Preis
    row = analyse(db).rows.find((x) => x.id === 1);
    assert.equal(row.action, 'halten');
    assert.equal(row.margin_blocked, true);
    assert.equal(listProducts(db, { sort: 'units', dir: 'desc' }).rows[0].number, 'A1');
  } finally {
    srv.closeAllConnections(); srv.close();
  }
});

test('Shopware-Abgleich: legt neue Artikel mit SEO-Link an, überschreibt keine Links, Deaktivierte offline', async () => {
  initSecrets(null);
  let products = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = b ? JSON.parse(b) : {};
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/oauth/token') return send({ access_token: 't' });
      if (req.url === '/api/search/product') return send({ total: products.length, data: products });
      if (req.url === '/api/search/sales-channel-domain') return send({ data: [
        { url: 'https://www.shop.example/en', salesChannelId: 'sc1', languageId: 'en' },
        { url: 'https://www.shop.example', salesChannelId: 'sc1', languageId: 'de' },
        { url: 'https://anderer.example', salesChannelId: 'sc2', languageId: 'de' },
      ] });
      if (req.url === '/api/search/seo-url') {
        assert.ok(j.filter.some((f) => f.field === 'salesChannelId' && f.value === 'sc1'));
        assert.ok(j.filter.some((f) => f.field === 'languageId' && f.value === 'de'));
        return send({ total: 3, data: [
          { foreignKey: 'p1', seoPathInfo: 'eins/A1' }, { foreignKey: 'p2', seoPathInfo: '/zwei/A2' }, { foreignKey: 'parent', seoPathInfo: 'familie/' },
        ] });
      }
      if (req.url === '/api/search/order-line-item') return send({ aggregations: { units: { buckets: [] }, revenue: { buckets: [] } } });
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const db = openDb(':memory:');
    upsertProducts(db, [{ number: 'A1', name: 'Eins', price: 100, url: 'https://www.shop.example/eins-aus-sitemap' }], 'sitemap');
    setSetting(db, 'shopware_url', `http://127.0.0.1:${srv.address().port}`);
    setSetting(db, 'shopware_client_id', 'id');
    setSetting(db, 'shopware_client_secret', 'secret', { secret: true });
    setSetting(db, 'own_url', 'https://shop.example');
    products = [
      { id: 'p1', productNumber: 'A1', active: true, childCount: 0, price: [{ gross: 119 }], ean: '4001', name: 'Eins' },
      { id: 'p2', productNumber: 'A2', active: true, childCount: 0, price: [{ gross: 20 }], ean: '4002', manufacturerNumber: 'M2', translated: { name: 'Zwei' }, manufacturer: { name: 'Hersteller' }, purchasePrices: [{ net: 10 }], stock: 3 },
      { id: 'parent', productNumber: 'V', active: true, childCount: 2, name: 'Familie', price: [{ gross: 50 }] },
      { id: 'v1', productNumber: 'V-1', parentId: 'parent', active: null, childCount: 0 },
      { id: 'off', productNumber: 'X', active: false, childCount: 0, name: 'Inaktiv neu' },
    ];
    let r = await syncShopware(db);
    assert.deepEqual([r.created, r.updated, r.unknown, r.seo_error], [2, 1, 1, null]);
    const get = (n) => ({ ...db.prepare('SELECT name, url, ean, mpn, manufacturer, price, purchase_price, stock, source, tracked, offline_since FROM products WHERE number=?').get(n) });
    assert.equal(get('A1').url, 'https://www.shop.example/eins-aus-sitemap'); // vorhandener Link bleibt
    assert.equal(get('A1').ean, '4001'); // leere Felder werden gefüllt
    assert.deepEqual(get('A2'), { name: 'Zwei', url: 'https://www.shop.example/zwei/A2', ean: '4002', mpn: 'M2', manufacturer: 'Hersteller', price: 20, purchase_price: 10, stock: 3, source: 'shopware', tracked: 1, offline_since: null });
    assert.equal(get('V-1').name, 'Familie'); // Variante erbt Name, Preis und Link vom Hauptartikel
    assert.equal(get('V-1').price, 50);
    assert.equal(get('V-1').url, 'https://www.shop.example/familie/');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM products WHERE number IN ('V','X')").get().n, 0);

    // In Shopware deaktiviert: offline; wieder aktiv: zurück
    products[1] = { ...products[1], active: false };
    r = await syncShopware(db);
    assert.deepEqual([r.created, r.deactivated], [0, 1]);
    assert.ok(get('A2').offline_since);
    products[1] = { ...products[1], active: true };
    r = await syncShopware(db);
    assert.equal(r.reactivated, 1);
    assert.equal(get('A2').offline_since, null);

    // Von der Sitemap als offline erkannt: der Shopware-Abgleich hebt das nicht auf
    db.prepare("UPDATE products SET offline_since='2026-01-01' WHERE number='A1'").run();
    await syncShopware(db);
    assert.equal(get('A1').offline_since, '2026-01-01');
  } finally {
    srv.closeAllConnections(); srv.close();
  }
});

test('Shopware-Abgleich: ohne Rechte auf SEO-URLs trotzdem durch, neue Artikel ohne Link', async () => {
  initSecrets(null);
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/oauth/token') return send({ access_token: 't' });
      if (req.url === '/api/search/product') return send({ total: 1, data: [{ id: 'p9', productNumber: 'N9', active: true, childCount: 0, name: 'Neu', price: [{ gross: 9 }] }] });
      if (req.url === '/api/search/order-line-item') return send({ aggregations: {} });
      return send({ errors: [{ detail: 'Missing privilege sales_channel_domain:read' }] }, 403);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const db = openDb(':memory:');
    setSetting(db, 'shopware_url', `http://127.0.0.1:${srv.address().port}`);
    setSetting(db, 'shopware_client_id', 'id');
    setSetting(db, 'shopware_client_secret', 'secret', { secret: true });
    const r = await syncShopware(db);
    assert.equal(r.created, 1);
    assert.match(r.seo_error, /sales_channel_domain/);
    assert.equal(db.prepare("SELECT url FROM products WHERE number='N9'").get().url, null);
  } finally {
    srv.closeAllConnections(); srv.close();
  }
});
