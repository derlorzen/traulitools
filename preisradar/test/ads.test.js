import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { openDb, upsertProducts } from '../src/db.js';
import { saveServiceAccount } from '../src/gsc.js';
import { syncAds, adsSummary, adsTest } from '../src/ads.js';
import { findOpportunities } from '../src/opportunities.js';
import { listProducts } from '../src/pricelist.js';
import { setSetting, initSecrets } from '../src/settings.js';

test('Google Ads: Kosten je Artikel, Gewinn nach Werbung, Chancen, Suchbegriffe gegen kostenlosen Platz', async () => {
  initSecrets(null);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const seen = { versions: new Set(), headers: null };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const send = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/token') return send({ access_token: 'ads', expires_in: 3600 });
      const m = /^\/(v\d+)\/customers\/1234567890\/googleAds:search$/.exec(req.url);
      if (!m) return send({ error: { message: 'falscher Pfad' } }, 400);
      seen.versions.add(m[1]);
      if (m[1] === 'v25') return send({ error: { message: 'not found' } }, 404); // älteste Version ausprobieren
      seen.headers = req.headers;
      const q = JSON.parse(b).query;
      const met = (cost, clicks, conv, value) => ({ impressions: String(clicks * 20), clicks: String(clicks), costMicros: String(Math.round(cost * 1e6)), conversions: conv, conversionsValue: value });
      if (q.includes('FROM customer ')) return send({ results: [{ customer: { descriptiveName: 'BelKai', currencyCode: 'EUR', id: '1234567890' } }] });
      if (q.includes('FROM campaign ')) return send({ results: [
        { campaign: { advertisingChannelType: 'PERFORMANCE_MAX' }, metrics: met(300, 400, 6, 900) },
        { campaign: { advertisingChannelType: 'SEARCH' }, metrics: met(100, 120, 2, 300) },
      ] });
      if (q.includes('shopping_performance_view')) return send({ results: [
        { segments: { productItemId: 'online:de:DE:A1', productTitle: 'Armatur' }, campaign: { advertisingChannelType: 'PERFORMANCE_MAX' }, metrics: met(150, 200, 1, 119) }, // Verlust
        { segments: { productItemId: 'a2', productTitle: 'Brause' }, campaign: { advertisingChannelType: 'PERFORMANCE_MAX' }, metrics: met(20, 50, 4, 200) }, // Gewinn
        { segments: { productItemId: 'a2' }, campaign: { advertisingChannelType: 'SHOPPING' }, metrics: met(10, 10, 0, 0) },
        { segments: { productItemId: 'A3' }, campaign: { advertisingChannelType: 'PERFORMANCE_MAX' }, metrics: met(30, 60, 3, 600) }, // lohnt sich noch, aber Mitbewerber viel günstiger
        { segments: { productItemId: 'fremd' }, campaign: { advertisingChannelType: 'PERFORMANCE_MAX' }, metrics: met(5, 5, 0, 0) },
      ] });
      if (q.includes('search_term_view')) return send({ results: [
        { searchTermView: { searchTerm: 'Brause Chrom' }, metrics: met(40, 50, 1, 50) },
        { searchTermView: { searchTerm: 'armatur kaufen' }, metrics: met(60, 70, 0, 0) },
      ] });
      send({ error: { message: 'unbekannt' } }, 400);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  Object.assign(process.env, { GOOGLE_ADS_API_BASE: base, GSC_TOKEN_URL: `${base}/token`, GOOGLE_ADS_API_VERSIONS: 'v25,v24' });
  try {
    const db = openDb(':memory:');
    upsertProducts(db, [{ number: 'A1', name: 'Armatur', price: 119 }, { number: 'A2', name: 'Brause', price: 50 }, { number: 'A3', name: 'Thermostat', price: 200 }, { number: 'A4', name: 'Duschkopf', price: 300 }], 'csv');
    db.prepare("UPDATE products SET purchase_price=price/1.19*0.6, tax_rate=19, stock=5").run();
    db.prepare("INSERT INTO product_sales(product_id, units_30, revenue_30, units_90, revenue_90, updated_at) VALUES (4, 3, 900, 9, 2700, '2026-11-01')").run();
    db.prepare("INSERT INTO competitors(name, base_url) VALUES ('M','https://m.test')").run();
    const im = db.prepare("INSERT INTO matches(product_id, competitor_id, status, price, availability, last_checked) VALUES (?, 1, 'ok', ?, 'in_stock', '2026-11-20')");
    im.run(3, 150); // A3: Mitbewerber 25 % günstiger
    im.run(4, 330); // A4: du bist günstiger, nicht beworben
    db.prepare("INSERT INTO seo_queries(page, query, clicks, impressions, ctr, position) VALUES ('belkai.de/brause', 'brause chrom', 40, 900, 0.04, 2.1)").run();
    saveServiceAccount(db, JSON.stringify({ type: 'service_account', client_email: 'sa@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    setSetting(db, 'ads_customer_id', '1234567890');
    setSetting(db, 'ads_login_customer_id', '9999999999');

    const t = await adsTest(db);
    assert.deepEqual([t.name, t.currency, t.version], ['BelKai', 'EUR', 'v24']);
    assert.equal(seen.headers['login-customer-id'], '9999999999');
    assert.equal(seen.headers['developer-token'], undefined);
    const r = await syncAds(db);
    assert.deepEqual([r.campaign_types, r.products, r.terms, r.warnings.length], [2, 4, 2, 0]);

    const s = adsSummary(db);
    assert.deepEqual([s.total.cost, s.total.value, s.total.roas], [400, 1200, 3]);
    assert.equal(s.types[0].name, 'Performance Max');
    assert.equal(s.products.matched, 3);
    const a1 = s.products.items.find((i) => i.number === 'A1');
    const a2 = s.products.items.find((i) => i.number === 'A2');
    assert.ok(a1.profit_after_ads < 0, 'A1 macht mit Werbung Verlust');
    assert.ok(a2.profit_after_ads > 0, 'A2 bringt mit Werbung Gewinn');
    assert.equal(a2.cost, 30); // Zeilen je Kampagne zusammengefasst
    assert.deepEqual(a2.types.sort(), ['PERFORMANCE_MAX', 'SHOPPING']);
    assert.equal(s.terms.paid_top3, 1);
    assert.equal(s.terms.items.find((x) => x.term === 'brause chrom').organic_position, 2.1);

    const o = findOpportunities(db);
    const types = (n) => o.items.filter((i) => i.number === n).map((i) => i.type);
    assert.ok(types('A1').includes('ads_loss'));
    assert.ok(types('A3').includes('ads_waste'));
    assert.ok(types('A4').includes('ads_potential'));
    assert.ok(!types('A2').some((x) => x.startsWith('ads_')));

    const pl = listProducts(db, { scope: 'all', filter: 'adsLoss' });
    assert.deepEqual(pl.rows.map((x) => x.number), ['A1']);
    assert.equal(pl.chips.adsOn, 3);
  } finally {
    srv.closeAllConnections(); srv.close();
  }
});

test('Google Ads: verständliche Meldung ohne Zugriff', async () => {
  initSecrets(null);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(req.url === '/token' ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/token' ? { access_token: 'x', expires_in: 3600 } : { error: { code: 403, message: "User doesn't have permission to access customer.", details: [{ errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' } }] }] } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  Object.assign(process.env, { GOOGLE_ADS_API_BASE: base, GSC_TOKEN_URL: `${base}/token`, GOOGLE_ADS_API_VERSIONS: 'v23' });
  try {
    const db = openDb(':memory:');
    saveServiceAccount(db, JSON.stringify({ type: 'service_account', client_email: 'sa2@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    setSetting(db, 'ads_customer_id', '1112223333');
    await assert.rejects(syncAds(db), /sa2@x\.iam\.gserviceaccount\.com.*Zugriff und Sicherheit/);
  } finally {
    srv.closeAllConnections(); srv.close();
  }
});
