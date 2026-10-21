import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.MIN_DELAY_MS = '0';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { scrapeState } from '../src/scraper.js';

const page = (name, price, ids = {}) => `<html><head><title>${name}</title><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Product', name, ...ids, offers: { '@type': 'Offer', price, priceCurrency: 'EUR' } })}</script></head><body><h1>${name}</h1></body></html>`;

function mockShop() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, type = 'text/html') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (u.pathname === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /admin\n', 'text/plain');
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q');
      if (q === '4015241210108') return send(200, '<div class="product-box"><a href="/p/wrong">w</a></div><div class="product-box"><a href="/p/kludi">k</a></div>');
      if (q === '10276-001') return send(200, '<div class="product-box"><a href="/p/hsk">h</a></div>');
      return send(200, '<html><body>keine Treffer</body></html>');
    }
    if (u.pathname === '/p/wrong') return send(200, page('Anderes Produkt', '19.90', { gtin13: '1111111111116' }));
    if (u.pathname === '/p/kludi') return send(200, page('KLUDI Showersystem Logo', '215.00', { gtin13: '4015241210108' }));
    if (u.pathname === '/p/hsk') return send(200, page('HSK Duschsystem RS 200 AquaSwitch Rund Ablage weiß', '640.00'));
    send(404, 'nope');
  });
}

test('Kompletter Ablauf: Import, Mitbewerber, Abruf, Übersicht', async () => {
  const shop = mockShop();
  await new Promise((r) => shop.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${shop.address().port}`;
  const db = openDb(':memory:');
  const app = createApp(db);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const api = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const call = async (path, body, method) => {
    const res = await fetch(api + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.getSetCookie?.()[0];
    if (sc && !sc.includes('Max-Age=0')) cookie = sc.split(';')[0];
    return { status: res.status, json: await res.json() };
  };

  try {
    // Ohne Anmeldung kein Zugriff, Einrichtung nur einmal
    assert.equal((await call('/api/overview')).status, 401);
    assert.equal((await call('/api/auth/state')).json.setup, true);
    assert.equal((await call('/api/auth/setup', { username: 'marco', password: 'kurz' })).status, 400);
    assert.equal((await call('/api/auth/setup', { username: 'marco', password: 'ein-langes-passwort' })).status, 200);
    assert.equal((await call('/api/overview')).status, 200);
    assert.equal((await call('/api/auth/setup', { username: 'x1x', password: 'ein-langes-passwort' })).status, 409);
    const saved = cookie; cookie = '';
    assert.equal((await call('/api/auth/login', { username: 'marco', password: 'falsch' })).status, 401);
    assert.equal((await call('/api/auth/login', { username: 'marco', password: 'ein-langes-passwort' })).status, 200);
    assert.ok(cookie && cookie !== saved);

    // Einstellungen: Secret wird nie zurückgegeben
    await call('/api/settings', { own_name: 'BelKai', own_url: 'https://www.belkai.de/x', shopware_url: 'https://www.belkai.de', shopware_client_id: 'SWIA123', shopware_client_secret: 'geheim' }, 'PUT');
    const st = (await call('/api/settings')).json;
    assert.equal(st.shopware_secret_set, true);
    assert.equal(st.own_url, 'https://www.belkai.de');
    assert.ok(!JSON.stringify(st).includes('geheim'));
    assert.equal((await call('/api/overview')).json.config.shopware, true);

    const csv = 'Artikelnummer;Name;EAN;Hersteller;Preis\n10484;KLUDI Showersystem Logo Basic Dual;4015241210108;KLUDI;239,00\n10276-001;HSK Duschsystem RS 200 AquaSwitch Rund Ablage weiß;;HSK;669,00\n';
    const imp = await call('/api/import/csv', { text: csv });
    assert.deepEqual([imp.json.created, imp.json.updated], [2, 0]);

    const c = await call('/api/competitors', { name: 'Testshop', base_url: base, search_url: `${base}/search?q={q}`, delay_ms: 1 });
    assert.ok(c.json.id);

    assert.equal((await call('/api/scrape', { force: true })).status, 200);
    for (let i = 0; i < 300 && scrapeState.running; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(scrapeState.running, false);

    const ov = (await call('/api/overview')).json;
    const kludi = ov.products.find((p) => p.number === '10484');
    const hsk = ov.products.find((p) => p.number === '10276-001');
    const mk = kludi.matches[c.json.id];
    assert.equal(mk.status, 'ok');            // per EAN verifiziert, falscher Treffer übersprungen
    assert.equal(mk.price, 215);
    const mh = hsk.matches[c.json.id];
    assert.equal(mh.status, 'review');        // nur per Namensähnlichkeit gefunden
    assert.equal(mh.price, 640);

    const confirm = await call(`/api/matches/${mh.id}/confirm`, {});
    assert.equal(confirm.status, 200);
    const hist = (await call(`/api/products/${kludi.id}/history`)).json;
    assert.equal(hist.series[0].points.length, 1);
    assert.equal(hist.own.length, 1);

    const csvOut = await (await fetch(api + '/api/export.csv', { headers: { cookie } })).text();
    assert.match(csvOut, /215,00/);
  } finally {
    srv.closeAllConnections(); srv.close(); shop.closeAllConnections(); shop.close();
  }
});
