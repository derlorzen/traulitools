import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { openDb, upsertProducts } from '../src/db.js';
import { saveServiceAccount } from '../src/gsc.js';
import { syncMerchant, merchantSummary, merchantTest } from '../src/merchant.js';
import { listProducts } from '../src/pricelist.js';
import { setSetting, initSecrets } from '../src/settings.js';

test('Merchant Center: Vergleichspreise, Preisvorschläge, Wettbewerber', async () => {
  initSecrets(null);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const queries = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const send = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/token') return send({ access_token: 'mc', expires_in: 3600 });
      assert.equal(req.url, '/reports/v1/accounts/12345/reports:search');
      const q = JSON.parse(b).query;
      queries.push(q);
      const m = (v) => ({ amountMicros: String(Math.round(v * 1e6)), currencyCode: 'EUR' });
      if (q.includes('FROM product_view')) return send({ results: [{ productView: { offerId: 'A1' } }] });
      if (q.includes('price_competitiveness_product_view')) return send({ results: [
        { priceCompetitivenessProductView: { offerId: 'A1', title: 'Armatur', price: m(119), benchmarkPrice: m(105) } },
        { priceCompetitivenessProductView: { offerId: 'a2', title: 'Brause', price: m(50), benchmarkPrice: m(55) } },
      ] });
      if (q.includes('price_insights_product_view')) return send({ results: [{ priceInsightsProductView: { offerId: 'A1', price: m(119), suggestedPrice: m(109), predictedClicksChangeFraction: 0.18, predictedConversionsChangeFraction: 0.12, effectiveness: 'HIGH' } }] });
      if (q.includes('competitive_visibility_competitor_view')) {
        assert.match(q, /report_category_id = 574/);
        return send({ results: [
          { competitiveVisibilityCompetitorView: { domain: 'meinshop.test', isYourDomain: true, rank: 3 } },
          { competitiveVisibilityCompetitorView: { domain: 'www.neu.test', isYourDomain: false, rank: 1, relativeVisibility: 2.1, pageOverlapRate: 0.4, higherPositionRate: 0.6 } },
          { competitiveVisibilityCompetitorView: { domain: 'bekannt.test', isYourDomain: false, rank: 2, relativeVisibility: 1.2, pageOverlapRate: 0.2, higherPositionRate: 0.3 } },
        ] });
      }
      send({ error: { message: 'unbekannt' } }, 400);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  Object.assign(process.env, { MERCHANT_API_BASE: base, GSC_TOKEN_URL: `${base}/token` });
  try {
    const db = openDb(':memory:');
    upsertProducts(db, [{ number: 'A1', name: 'Armatur', price: 119 }, { number: 'A2', name: 'Brause', price: 50 }], 'csv');
    db.prepare("INSERT INTO competitors(name, base_url) VALUES ('Bekannt','https://www.bekannt.test')").run();
    saveServiceAccount(db, JSON.stringify({ type: 'service_account', client_email: 'sa@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    setSetting(db, 'mc_account', '12345');
    setSetting(db, 'mc_categories', '574');
    assert.equal((await merchantTest(db)).sample, 'A1');
    const r = await syncMerchant(db);
    assert.deepEqual([r.prices, r.insights, r.competitors, r.warnings.length], [2, 1, 3, 0]);
    const s = merchantSummary(db);
    assert.equal(s.matched, 2); // Angebots-ID ohne Rücksicht auf Groß-/Kleinschreibung
    assert.deepEqual([s.benchmark.total, s.benchmark.above, s.benchmark.below], [2, 1, 1]);
    assert.equal(s.above_benchmark[0].gap_percent, 13.3);
    assert.equal(s.suggestions[0].suggested, 109);
    assert.deepEqual(s.competitors.map((c) => [c.domain, c.known]), [['neu.test', false], ['bekannt.test', true]]);
    const row = listProducts(db, { q: 'armatur' }).rows[0];
    assert.equal(row.google.benchmark, 105);
  } finally {
    srv.closeAllConnections(); srv.close();
  }
});
