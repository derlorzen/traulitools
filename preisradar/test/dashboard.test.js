import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, upsertProducts } from '../src/db.js';
import { setSetting, initSecrets } from '../src/settings.js';
import { syncShopwareDaily } from '../src/shopware.js';
import { dashboard } from '../src/dashboard.js';
import { findOpportunities } from '../src/opportunities.js';
import { channel, profit } from '../src/channels.js';

const berlin = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d);
const ago = (n) => berlin(new Date(Date.now() - n * 86400000));

test('Übersicht: Tageszahlen aus Shopware, Zeiträume mit Vergleich, Werbekosten-Anteil, Rückblick', async () => {
  initSecrets(null);
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/oauth/token') return send({ access_token: 't' });
      const j = JSON.parse(b || '{}');
      if (req.url === '/api/search/order-line-item') {
        assert.equal(j.aggregations[0].type, 'histogram');
        const day = (n) => `${ago(n)} 00:00:00`;
        return send({ aggregations: {
          qty: { buckets: [{ key: day(1), p: { buckets: [{ key: 'sw1', s: { sum: 2 } }, { key: 'sw2', s: { sum: 1 } }] } }, { key: day(8), p: { buckets: [{ key: 'sw1', s: { sum: 1 } }] } }] },
          rev: { buckets: [{ key: day(1), p: { buckets: [{ key: 'sw1', s: { sum: 238 } }, { key: 'sw2', s: { sum: 60 } }] } }, { key: day(8), p: { buckets: [{ key: 'sw1', s: { sum: 119 } }] } }] },
        } });
      }
      if (req.url === '/api/search/order') return send({ aggregations: { orders: { buckets: [{ key: `${ago(1)} 00:00:00`, count: 2 }, { key: `${ago(8)} 00:00:00`, count: 1 }] } } });
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const db = openDb(':memory:');
    upsertProducts(db, [{ number: 'A1', name: 'Armatur', price: 119 }, { number: 'A2', name: 'Brause', price: 60 }], 'csv');
    db.prepare("UPDATE products SET sw_id='sw1', purchase_price=50, tax_rate=19 WHERE number='A1'").run();
    db.prepare("UPDATE products SET sw_id='sw2', tax_rate=19 WHERE number='A2'").run(); // ohne Einkaufspreis
    setSetting(db, 'shopware_url', `http://127.0.0.1:${srv.address().port}`);
    setSetting(db, 'shopware_client_id', 'id');
    setSetting(db, 'shopware_client_secret', 'secret', { secret: true });
    const shop = channel(db, 'shop');
    const r = await syncShopwareDaily(db, { profitOf: (g, p) => (p.purchase_price > 0 ? profit(g, p.purchase_price, shop, p.tax_rate) : null) });
    assert.equal(r.days, 2);
    const y = db.prepare('SELECT * FROM shop_daily WHERE day=?').get(ago(1));
    assert.deepEqual([y.revenue, y.units, y.orders, y.profit_base], [298, 3, 2, 238]);
    assert.equal(y.profit, Math.round(profit(119, 50, shop, 19) * 2 * 100) / 100);

    db.prepare('INSERT INTO ads_daily(day, cost, value, clicks, impressions, conversions) VALUES (?,?,?,?,?,?)').run(ago(1), 40, 200, 30, 900, 2);
    db.prepare("INSERT INTO competitors(name, base_url) VALUES ('M','https://m.test')").run();
    const mid = db.prepare("INSERT INTO matches(product_id, competitor_id, status, price, last_checked) VALUES (1, 1, 'ok', 110, ?)").run(new Date().toISOString()).lastInsertRowid;

    const d = dashboard(db, { user: 'marco', opportunities: findOpportunities(db) });
    assert.equal(d.user, 'marco');
    assert.deepEqual([d.yesterday_stats.revenue, d.yesterday_stats.orders, d.yesterday_stats.last_week], [298, 2, 119]);
    assert.equal(d.yesterday_stats.delta, Math.round(((298 - 119) / 119) * 1000) / 10);
    const c7 = d.numbers.d7.cur;
    assert.deepEqual([c7.revenue, c7.ads_cost, c7.ads_value, c7.orders], [298, 40, 200, 2]);
    // Gewinn hochgerechnet auf den Umsatz ohne Einkaufspreis
    assert.equal(c7.gross_profit, Math.round(y.profit * (298 / 238) * 100) / 100);
    assert.equal(c7.profit_after_ads, Math.round((c7.gross_profit - 40) * 100) / 100);
    assert.equal(c7.profit_coverage, 80);
    assert.equal(d.numbers.d7.prev.revenue, 119);
    assert.equal(d.numbers.d7.weeks.length, 12);
    assert.equal(d.ad_cost.per_100, 20);
    assert.ok(d.ad_cost.limit > 20 && d.ad_cost.ok);
    assert.equal(d.daily.length, 90);
    assert.ok(d.channels.some((c) => c.key === 'shop' && c.main === 2));
    assert.ok(d.channels.some((c) => c.key === 'ebay' && !c.connected));
    assert.ok(Number.isInteger(d.review.week) && d.review.week >= 1 && d.review.week <= 53);
    assert.ok(mid);
  } finally {
    srv.closeAllConnections(); srv.close();
  }
});
