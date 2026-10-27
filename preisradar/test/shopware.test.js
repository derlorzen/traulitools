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
    assert.deepEqual([r.updated, r.unknown, r.with_purchase, r.sold_90], [2, 1, 1, 2]);
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
