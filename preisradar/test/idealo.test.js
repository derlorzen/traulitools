import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, upsertProducts } from '../src/db.js';
import { setSetting, initSecrets } from '../src/settings.js';
import { money, normOffer, normProduct, lookupBatch, idealoView, productIdealo, discoveredShops, dueIdealo, idealoOverview, spendMonth, startIdealoJob, idealoJob, competitorMatcher } from '../src/idealo.js';

test('Preise und Angebote verschiedener Actors lesen', () => {
  assert.equal(money('87,99'), 87.99);
  assert.equal(money('1.234,56 €'), 1234.56);
  assert.equal(money('4.95'), 4.95);
  assert.equal(money('1.299'), 1299);
  assert.equal(money('Versandkostenfrei'), 0);
  assert.equal(money(null), null);
  // s-r: Gesamtpreis, Versand als Text oder „inklusive“
  assert.deepEqual(
    (({ shop, price, shipping, total }) => ({ shop, price, shipping, total }))(normOffer({ shop: 'megabad.com', total_price: 104.9, price_text: '99,95', shipping_included: false, shipping_cost_text: '4,95 € Versand' }, 0)),
    { shop: 'megabad.com', price: 99.95, shipping: 4.95, total: 104.9 },
  );
  assert.equal(normOffer({ shop: 'X', total_price: 50, shipping_included: true }, 0).price, 50);
  // firsthand: andere Feldnamen
  const f = normOffer({ shopName: 'Amazon Marketplace', price: 48.5, shippingCost: 0, totalPrice: 48.5 }, 2);
  assert.equal(f.marketplace, 'amazon');
  assert.equal(f.position, 3);
  assert.equal(normOffer({ shop: '', total_price: 3 }, 0), null);
  const p = normProduct({ gtin: '4005176314964', product_id: 77, offers: [{ shop: 'B', total_price: 20 }, { shop: 'A', total_price: 10 }] });
  assert.equal(p.ean, '4005176314964');
  assert.deepEqual(p.offers.map((o) => o.shop), ['A', 'B']); // nach Gesamtpreis sortiert
});

// Nachgebautes Apify
const calls = [];
let mode = 'ok';
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{"error":{"message":"User was not found or authentication token is not valid"}}'); }
    if (req.url === '/v2/users/me') return res.end('{"data":{"username":"marco","plan":{"id":"FREE"}}}');
    if (req.url.startsWith('/v2/acts/s-r~idealo-scraper/run-sync-get-dataset-items')) {
      if (mode === 'pay') { res.statusCode = 402; return res.end('{"error":{"message":"Not enough credit"}}'); }
      const { eans } = JSON.parse(b);
      const out = [];
      if (eans.includes('4005176314964')) out.push({ ean: '4005176314964', found: true, idealo_sku: '123', url: 'https://www.idealo.de/preisvergleich/OffersOfProduct/123.html', title: 'Grohe Eurosmart', offer_count: 4, offers: [
        { shop: 'Megabad', total_price: 95.9, price_text: '95,90', shipping_included: true, position: 1 },
        { shop: 'BelKai', total_price: 99.9, price_text: '94,95', shipping_cost_text: '4,95 €', position: 2 },
        { shop: 'Reuter.de', total_price: 109, price_text: '109,00', shipping_included: true, position: 3 },
        { shop: 'Amazon', total_price: 112.5, price_text: '112,50', shipping_included: true, position: 4 },
      ] });
      if (eans.includes('4005176000001')) out.push({ ean: '4005176000001', found: true, offers: [
        { shop: 'BelKai', total_price: 50, shipping_included: true }, { shop: 'Megabad', total_price: 59, shipping_included: true },
      ] });
      return res.end(JSON.stringify(out));
    }
    res.statusCode = 404; res.end('{"error":{"message":"Actor not found"}}');
  });
});

test('idealo-Abgleich über Apify', async (t) => {
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  process.env.APIFY_API_BASE = `http://127.0.0.1:${srv.address().port}`;
  initSecrets(null);
  const db = openDb(':memory:');
  setSetting(db, 'own_name', 'BelKai');
  upsertProducts(db, [
    { number: 'A1', ean: '4005176314964', name: 'Grohe Eurosmart', price: 99.9 },
    { number: 'A2', ean: '4005176000001', name: 'Ablauf', price: 50 },
    { number: 'A3', ean: '4005176999999', name: 'Gibt es nicht', price: 10 },
    { number: 'A4', ean: '', name: 'Ohne EAN', price: 10 },
  ], 'test');
  db.prepare("INSERT INTO competitors(name, base_url) VALUES ('Reuter', 'https://www.reuter.de')").run();
  const ids = Object.fromEntries(db.prepare('SELECT id, number FROM products').all().map((p) => [p.number, p.id]));

  // ohne Token: nichts
  await assert.rejects(lookupBatch(db, [{ id: ids.A1, ean: '4005176314964' }]), /Token/);
  setSetting(db, 'apify_token', 'tok', { secret: true });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='apify_token'").get().value.startsWith('enc:'), true, 'Token verschlüsselt');

  // Fällig: nur Artikel mit EAN
  assert.deepEqual(dueIdealo(db, 10).map((p) => p.id).sort(), [ids.A1, ids.A2, ids.A3].sort());

  const r = await lookupBatch(db, dueIdealo(db, 10));
  assert.deepEqual(r, { found: 2, missing: 1 });
  assert.deepEqual(calls.at(-1).body, { eans: ['4005176314964', '4005176000001', '4005176999999'], country: 'de', concurrency: 3 });

  // Artikel 1: eigenes Angebot auf Platz 2, Megabad günstiger
  const v = productIdealo(db, ids.A1);
  assert.equal(v.min_total, 95.9);
  assert.equal(v.min_shop, 'Megabad');
  assert.equal(v.own_rank, 2);
  assert.equal(v.own_total, 99.9);
  assert.equal(v.kind, 'dearer');
  assert.equal(v.gap_pct, 4.2);
  assert.equal(v.offers_list.find((o) => o.shop === 'Reuter.de').competitor, 'Reuter', 'Händler dem Mitbewerber zugeordnet');
  assert.equal(v.offers_list.find((o) => o.shop === 'Amazon').marketplace, 'amazon');
  assert.equal(v.offers_list.find((o) => o.shop === 'BelKai').shipping, 4.95);
  assert.equal(v.history.length, 1);
  // Artikel 2: günstigster, 18 % Luft bis zum nächsten
  const v2 = productIdealo(db, ids.A2);
  assert.equal(v2.kind, 'cheapest');
  assert.equal(v2.headroom_pct, 18);
  // Artikel 3: nicht gefunden, erst nach 30 Tagen wieder fällig
  assert.equal(productIdealo(db, ids.A3).found, false);
  assert.equal(dueIdealo(db, 10).length, 0);
  db.prepare("UPDATE idealo_products SET checked_at='2020-01-01T00:00:00Z' WHERE product_id=?").run(ids.A3);
  assert.deepEqual(dueIdealo(db, 10).map((p) => p.id), [ids.A3]);

  // Entdeckte Händler: Megabad (nicht angelegt) und Amazon, nicht Reuter (angelegt) und nicht BelKai (eigener Shop)
  const shops = discoveredShops(db);
  assert.deepEqual(shops.map((s) => s.shop).sort(), ['Amazon', 'Megabad']);
  assert.equal(shops.find((s) => s.shop === 'Megabad').cheaper, 1);
  assert.equal(shops.find((s) => s.shop === 'Megabad').products, 2);

  // Kosten: 1 Lauf, 2 gefundene Artikel nach s-r-Tarif
  assert.equal(Math.round(spendMonth(db).usd * 1000) / 1000, 0.01);
  const o = idealoOverview(db);
  assert.equal(o.found, 2);
  assert.equal(o.listed, 2);
  assert.equal(o.dearer, 1);

  // Budget erreicht: kein neuer Lauf
  setSetting(db, 'idealo_budget', '0.005');
  assert.equal(startIdealoJob(db, { ids: [ids.A1] }), false);
  assert.match(idealoJob.error, /Monatsbudget/);
  setSetting(db, 'idealo_budget', '10');

  // Guthaben leer: Lauf bricht ab, Fehler bleibt sichtbar, Daten bleiben erhalten
  mode = 'pay';
  assert.equal(startIdealoJob(db, { ids: [ids.A1, ids.A2] }), true);
  while (idealoJob.running) await new Promise((res) => setTimeout(res, 20));
  assert.match(idealoJob.error, /Guthaben/);
  assert.equal(productIdealo(db, ids.A1).min_total, 95.9);
  mode = 'ok';

  // falsches Token
  setSetting(db, 'apify_token', 'falsch', { secret: true });
  await assert.rejects(lookupBatch(db, [{ id: ids.A1, ean: '4005176314964' }]), /Token ungültig/);
});

test('idealo-Händler Mitbewerbern zuordnen', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competitors(name, base_url) VALUES ('Megabad', 'https://www.megabad.com'), ('Sanitär Heinze', 'https://www.sanitaer-heinze.com')").run();
  const of = competitorMatcher(db);
  assert.ok(of('megabad.com'));
  assert.ok(of('MEGABAD GmbH'));
  assert.ok(of('sanitaer-heinze.com'));
  assert.equal(of('Amazon'), null);
  assert.equal(idealoView(null), null);
});
