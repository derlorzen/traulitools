import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { openDb, upsertProducts } from '../src/db.js';
import { saveServiceAccount, syncGsc, gscSites } from '../src/gsc.js';
import { seoOverview, productSeo } from '../src/seo.js';
import { setSetting } from '../src/settings.js';
import { initSecrets } from '../src/settings.js';

const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ s, base: `http://127.0.0.1:${s.address().port}` })); });
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

test('Search Console: Anmeldung per Dienstkonto, Abgleich, Chancen, Detailansicht', async () => {
  initSecrets(null);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const gscCalls = [];
  const { s: g, base: gb } = await serve(async (req, res) => {
    const b = await body(req);
    const send = (j, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url === '/token') {
      const jwt = new URLSearchParams(b).get('assertion');
      const [h, c, sig] = jwt.split('.');
      const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'));
      return ok ? send({ access_token: 'tok', expires_in: 3600 }) : send({ error: 'invalid_grant' }, 400);
    }
    if (req.headers.authorization !== 'Bearer tok') return send({ error: { message: 'unauth' } }, 401);
    if (req.url === '/sites') return send({ siteEntry: [{ siteUrl: 'sc-domain:shop.test', permissionLevel: 'siteRestrictedUser' }] });
    const q = JSON.parse(b);
    gscCalls.push(q.dimensions.join(','));
    if (q.dimensions[0] === 'date') return send({ rows: Array.from({ length: 60 }, (_, i) => ({ keys: [new Date(Date.now() - (62 - i) * 864e5).toISOString().slice(0, 10)], clicks: 10 + i, impressions: 400, ctr: 0.03, position: 9 })) });
    if (q.dimensions.length === 1) return send({ rows: [
      { keys: ['https://www.shop.test/teuer/1/'], clicks: 5, impressions: 900, ctr: 0.005, position: 4 },
      { keys: ['https://www.shop.test/guenstig/2/'], clicks: 1, impressions: 20, ctr: 0.05, position: 18 },
    ] });
    return send({ rows: [{ keys: ['https://www.shop.test/teuer/1/', 'armatur teuer'], clicks: 4, impressions: 500, ctr: 0.008, position: 3.2 }] });
  });
  Object.assign(process.env, { GSC_API_BASE: gb, GSC_TOKEN_URL: `${gb}/token` });
  try {
    const db = openDb(':memory:');
    upsertProducts(db, [
      { number: '1', name: 'Teure Armatur', price: 120, url: 'https://www.shop.test/teuer/1/' },
      { number: '2', name: 'Günstige Brause', price: 50, url: 'https://shop.test/guenstig/2' },
    ], 'csv');
    db.prepare("INSERT INTO competitors(id, name, base_url) VALUES (1,'Rivale','https://www.rival.test')").run();
    db.prepare("INSERT INTO matches(product_id, competitor_id, status, price) VALUES (1,1,'ok',100),(2,1,'ok',60)").run();
    assert.throws(() => saveServiceAccount(db, '{"type":"user"}'), /Dienstkonto/);
    saveServiceAccount(db, JSON.stringify({ type: 'service_account', client_email: 'sa@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    setSetting(db, 'gsc_site', 'sc-domain:shop.test');
    assert.equal((await gscSites(db))[0].site, 'sc-domain:shop.test');
    const r = await syncGsc(db);
    assert.equal(r.pages, 2);
    assert.deepEqual(gscCalls, ['page', 'page,query', 'date']);

    const o = seoOverview(db);
    assert.equal(o.kpi.impressions, 28 * 400);
    assert.equal(o.pages[0].product.id, 1);
    assert.equal(o.coverage.with_data, 2);
    assert.equal(o.queries[0].query, 'armatur teuer');
    const g1 = o.opportunities.groups.find((x) => x.key === 'demand_price');
    assert.equal(g1.items[0].id, 1);
    const g2 = o.opportunities.groups.find((x) => x.key === 'cheap_hidden');
    assert.equal(g2.items[0].id, 2); // www/ohne www und Schrägstrich werden gleich behandelt
    assert.equal(o.opportunities.groups.find((x) => x.key === 'low_ctr').items[0].id, 1);
    const ps = productSeo(db, 1);
    assert.equal(ps.page.impressions, 900);
    assert.equal(ps.queries[0].query, 'armatur teuer');
  } finally {
    g.closeAllConnections(); g.close();
  }
});
