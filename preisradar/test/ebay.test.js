import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, upsertProducts } from '../src/db.js';
import { setSetting, initSecrets } from '../src/settings.js';
import { profit, floorPrice, targetPrice, roundToEnding, channel, updateChannel } from '../src/channels.js';

test('Kanal-Rechner', () => {
  const eb = { fee_percent: 11, fee_fixed: 0.35, shipping_cost: 4.9, target_margin: 20, min_profit: 3, ending: '99' };
  assert.equal(roundToEnding(12.34, '99'), 12.99);
  assert.equal(roundToEnding(12.995, '99'), 13.99);
  assert.equal(roundToEnding(12.34, '00'), 13);
  const t = targetPrice(50, eb);
  assert.equal(t, 98.99);
  assert.equal(profit(floorPrice(50, eb), 50, eb), 3); // Untergrenze = genau Mindestgewinn
  assert.equal(profit(100, null, eb), null);
  const db = openDb(':memory:');
  assert.equal(channel(db, 'ebay').fee_percent, 11);
  assert.equal(updateChannel(db, 'ebay', { fee_percent: '12,5', ending: '95' }).fee_percent, 12.5);
  assert.throws(() => updateChannel(db, 'ebay', { fee_percent: 80 }), /Gebühr/);
});

// Nachgebautes eBay
const calls = [];
const trade = (name, body) => {
  if (name === 'GetUser') return '<GetUserResponse><Ack>Success</Ack><User><UserID>belkai_de</UserID></User></GetUserResponse>';
  if (name === 'GetMyeBaySelling') return `<GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult><ItemArray>
    <Item><ItemID>111</ItemID><Title>Grohe Eurosmart</Title><SKU>A2</SKU><Quantity>5</Quantity><QuantityAvailable>4</QuantityAvailable><SellingStatus><CurrentPrice>129.00</CurrentPrice><QuantitySold>1</QuantitySold></SellingStatus><ListingDetails><ViewItemURL>https://www.ebay.de/itm/111</ViewItemURL></ListingDetails></Item>
    <Item><ItemID>222</ItemID><Title>Fremd</Title><SKU>XYZ</SKU><Quantity>1</Quantity><SellingStatus><CurrentPrice>9.00</CurrentPrice></SellingStatus></Item>
  </ItemArray></ActiveList></GetMyeBaySellingResponse>`;
  if (name === 'VerifyAddFixedPriceItem' || name === 'AddFixedPriceItem') {
    if (!/<SKU>A1<\/SKU>/.test(body)) return '<R><Ack>Failure</Ack><Errors><SeverityCode>Error</SeverityCode><LongMessage>SKU fehlt</LongMessage></Errors></R>';
    return `<R><Ack>Warning</Ack><Errors><SeverityCode>Warning</SeverityCode><LongMessage>Hinweis X</LongMessage></Errors>${name === 'AddFixedPriceItem' ? '<ItemID>333</ItemID>' : ''}<Fees><Fee><Name>InsertionFee</Name><Fee>0.0</Fee></Fee><Fee><Name>Other</Name><Fee>0.35</Fee></Fee></Fees></R>`;
  }
  return '<R><Ack>Failure</Ack></R>';
};
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    calls.push({ url: req.url, call: req.headers['x-ebay-api-call-name'], body: b, auth: req.headers.authorization || req.headers['x-ebay-api-iaf-token'] });
    if (req.url === '/identity/v1/oauth2/token') {
      const f = new URLSearchParams(b);
      res.setHeader('content-type', 'application/json');
      if (f.get('grant_type') === 'authorization_code' && f.get('code') !== 'good') { res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
      return res.end(JSON.stringify({ access_token: `tok-${f.get('grant_type')}`, expires_in: 7200, refresh_token: 'refresh-1' }));
    }
    if (req.url === '/ws/api.dll') return res.end(trade(req.headers['x-ebay-api-call-name'], b));
    if (req.url.startsWith('/buy/browse/v1/item_summary/search')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ itemSummaries: [
        { itemId: 'v1', title: 'A', price: { value: '95.00' }, shippingOptions: [{ shippingCost: { value: '4.90' } }], seller: { username: 'badshop' }, itemWebUrl: 'https://ebay.de/itm/v1' },
        { itemId: 'v2', title: 'B', price: { value: '90.00' }, shippingOptions: [{ shippingCost: { value: '0.00' } }], seller: { username: 'belkai_de' }, itemWebUrl: 'https://ebay.de/itm/v2' },
        { itemId: 'v3', title: 'C', price: { value: '97.50' }, seller: { username: 'other' }, itemWebUrl: 'https://ebay.de/itm/v3' },
      ] }));
    }
    if (req.url.includes('get_category_suggestions')) return res.end(JSON.stringify({ categorySuggestions: [{ category: { categoryId: '20667', categoryName: 'Armaturen' }, categoryTreeNodeAncestors: [{ categoryName: 'Bad' }, { categoryName: 'Heimwerker' }] }] }));
    if (req.url.includes('get_item_aspects_for_category')) return res.end(JSON.stringify({ aspects: [{ localizedAspectName: 'Marke', aspectConstraint: { aspectRequired: true } }, { localizedAspectName: 'Farbe', aspectConstraint: { aspectUsage: 'RECOMMENDED', aspectMode: 'SELECTION_ONLY' }, aspectValues: [{ localizedValue: 'Chrom' }] }, { localizedAspectName: 'Unwichtig', aspectConstraint: { aspectUsage: 'OPTIONAL' } }] }));
    res.statusCode = 404; res.end('{}');
  });
});

test('eBay: Verbinden, Angebote lesen, Mitbewerber, Einstellen, Chancen, JTL-Export', async (t) => {
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  process.env.EBAY_API_BASE = `http://127.0.0.1:${srv.address().port}`;
  process.env.EBAY_AUTH_BASE = 'https://auth.test';
  process.env.SECRET_KEY ||= 'test-schluessel-test-schluessel-1234';
  initSecrets(null);
  const eb = await import('../src/ebay.js');
  const op = await import('../src/opportunities.js');
  const db = openDb(':memory:');
  upsertProducts(db, [
    { number: 'A1', name: 'Hansgrohe Talis E 110', manufacturer: 'Hansgrohe', price: 120, ean: '4059625000001', mpn: '71710000' },
    { number: 'A2', name: 'Grohe Eurosmart', price: 119, ean: '4005176000002' },
    { number: 'A3', name: 'Ladenhüter', price: 50 },
  ], 'csv');
  db.prepare('UPDATE products SET purchase_price=?, tax_rate=19, stock=? WHERE number=?').run(55, 6, 'A1');
  db.prepare('UPDATE products SET purchase_price=?, tax_rate=19, stock=? WHERE number=?').run(100, 3, 'A2');
  db.prepare('UPDATE products SET purchase_price=?, tax_rate=19, stock=? WHERE number=?').run(20, 10, 'A3');
  db.prepare('INSERT INTO product_sales(product_id, units_30, revenue_30, units_90, revenue_90) VALUES (1,18,2160,30,3600),(2,1,119,2,238)').run();
  setSetting(db, 'ebay_client_id', 'app');
  setSetting(db, 'ebay_client_secret', 'sec', { secret: true });
  setSetting(db, 'ebay_runame', 'Belkai-RuName');

  const url = eb.authorizeUrl(db);
  assert.match(url, /^https:\/\/auth\.test\/oauth2\/authorize\?client_id=app&redirect_uri=Belkai-RuName/);
  const state = new URL(url).searchParams.get('state');
  await assert.rejects(eb.exchangeCode(db, 'good', 'falsch'), /abgelaufen oder ungültig/);
  eb.authorizeUrl(db); // neuer state
  const st2 = (await import('../src/settings.js')).getSetting(db, 'ebay_oauth_state').split('|')[0];
  assert.notEqual(st2, state);
  await eb.exchangeCode(db, 'good', st2);
  const cfg = eb.ebayConfig(db);
  assert.equal(cfg.connected, true);
  assert.equal(cfg.username, 'belkai_de');

  const s = await eb.syncListings(db);
  assert.deepEqual(s, { listings: 2, matched: 1, unmatched: 1 });
  const l = db.prepare("SELECT * FROM ebay_listings WHERE item_id='111'").get();
  assert.equal(l.product_id, 2);
  assert.equal(l.quantity, 4);

  // Mitbewerber: eigenes Angebot (belkai_de) zählt nicht, günstigstes inkl. Versand
  const m = await eb.marketCheck(db, { id: 1, ean: '4059625000001' });
  assert.equal(m.offers, 2);
  assert.equal(m.min_total, 97.5);
  assert.equal(m.min_seller, 'other');
  assert.equal(m.own_rank, 1);
  assert.match(calls.find((c) => c.url.startsWith('/buy/')).url, /gtin=4059625000001/);
  assert.equal((await eb.marketCheck(db, { id: 3, ean: null })), null);

  assert.equal((await eb.suggestCategories(db, 'Talis'))[0].path, 'Heimwerker › Bad › Armaturen');
  assert.deepEqual((await eb.aspects(db, '20667')).map((a) => a.name), ['Marke', 'Farbe']);

  // Entwurf ohne Shopware: Preisvorschlag unter dem günstigsten eBay-Angebot, nie unter der Untergrenze
  const d = await eb.draft(db, 1);
  assert.equal(d.defaults.sku, 'A1');
  assert.equal(d.defaults.price, 97.49); // unter dem günstigsten eBay-Angebot (97,50)
  assert.equal(d.defaults.quantity, 3); // höchstens 3 je Angebot (Einstellung)
  assert.equal(d.defaults.specifics.Marke, 'Hansgrohe');
  assert.equal(d.policies_ok, false);
  await assert.rejects(eb.createListing(db, 1, { title: 'x', category_id: '1', price: 97, quantity: 1 }), /Versandsrichtlinie|Versand/);
  for (const [k, v] of [['ebay_fulfillment_policy', 'F1'], ['ebay_payment_policy', 'P1'], ['ebay_return_policy', 'R1'], ['ebay_location', 'Süderbrarup'], ['ebay_postal_code', '24392']]) setSetting(db, k, v);
  await assert.rejects(eb.createListing(db, 1, { title: 'Talis', category_id: '20667', price: 40, quantity: 1 }), /Verlustgrenze/);
  await assert.rejects(eb.createListing(db, 2, { title: 'x', category_id: '1', price: 200, quantity: 1 }), /läuft bereits ein eBay-Angebot/);
  const v = await eb.createListing(db, 1, { title: 'Hansgrohe Talis E 110 Waschtischarmatur chrom', category_id: '20667', price: 97.49, quantity: 3, ean: '4059625000001', specifics: { Marke: 'Hansgrohe', Leer: '' }, images: ['https://x/1.jpg', 'http://unsicher/2.jpg'], description: '<p>Text <a href="https://fremd">Link</a></p><script>alert(1)</script>' }, { verify: true });
  assert.equal(v.item_id, null);
  assert.equal(v.fees, 0.35);
  assert.deepEqual(v.warnings, ['Hinweis X']);
  const sent = calls.filter((c) => c.call === 'VerifyAddFixedPriceItem').pop().body;
  assert.match(sent, /<SKU>A1<\/SKU>/);
  assert.match(sent, /<EAN>4059625000001<\/EAN>/);
  assert.ok(!/<script|alert|fremd|unsicher|Leer/.test(sent));
  assert.match(sent, /<ShippingProfileID>F1<\/ShippingProfileID>/);
  const r = await eb.createListing(db, 1, { title: 'Hansgrohe Talis E 110', category_id: '20667', price: 97.49, quantity: 3 });
  assert.equal(r.item_id, '333');
  assert.equal(db.prepare("SELECT jtl_state FROM ebay_listings WHERE item_id='333'").get().jtl_state, 'pending');
  await assert.rejects(eb.createListing(db, 1, { title: 'x', category_id: '1', price: 99, quantity: 1 }), /läuft bereits/);

  // Chancen: A3 Ladenhüter, A2 eBay zu wenig Gewinn, A1 bald ausverkauft (6 Stück bei 18 in 30 Tagen)
  const o = op.findOpportunities(db);
  const types = (n) => o.items.filter((i) => i.number === n).map((i) => i.type).sort();
  assert.deepEqual(types('A3'), ['slow_mover']);
  assert.ok(types('A1').includes('stockout'));
  assert.ok(types('A2').includes('low_profit'));
  db.prepare("DELETE FROM ebay_listings WHERE item_id='333'").run();
  assert.ok(op.findOpportunities(db).items.some((i) => i.number === 'A1' && i.type === 'ebay_missing'));
  const csv = op.jtlExport(db).csv;
  assert.match(csv, /^﻿Artikelnummer;Artikelname;Kanal/);
  assert.match(csv, /A2;Grohe Eurosmart;eBay;129,00;/);
});
