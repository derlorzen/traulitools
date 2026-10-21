import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
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
    if (u.pathname === '/robots.txt') return send(200, `User-agent: *\nDisallow: /admin\nSitemap: http://${req.headers.host}/sitemap-index.xml\n`, 'text/plain');
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q');
      if (q === '4015241210108') return send(200, '<div class="product-box"><a href="/p/wrong">w</a></div><div class="product-box"><a href="/p/kludi">k</a></div>');
      if (q === '10276-001') return send(200, '<div class="product-box"><a href="/p/hsk">h</a></div>');
      return send(200, '<html><body>keine Treffer</body></html>');
    }
    if (u.pathname === '/p/wrong') return send(200, page('Anderes Produkt', '19.90', { gtin13: '1111111111116' }));
    if (u.pathname === '/p/kludi') return send(200, page('KLUDI Showersystem Logo', '215.00', { gtin13: '4015241210108' }));
    if (u.pathname === '/p/hsk') return send(200, page('HSK Duschsystem RS 200 AquaSwitch Rund Ablage weiß', '640.00'));
    if (u.pathname === '/sitemap.xml') {
      const o = `http://${req.headers.host}`;
      return send(200, `<?xml version="1.0"?><urlset><url><loc>${o}/bad/duschsysteme/kludi-logo-thermostat-dual-shower-system_192921_179614/</loc></url><url><loc>${o}/bad/armaturen/hansgrohe-metropol-mischer_1_2/</loc></url><url><loc>${o}/bad/xx/kludi-ersatzteil-dichtung_9_9/</loc></url></urlset>`, 'application/xml');
    }
    if (u.pathname.startsWith('/bad/duschsysteme/kludi-logo')) return send(200, page('KLUDI LOGO Duschsystem Dual Shower Thermostat', '259.00', { gtin13: '4015241210108' }));
    if (u.pathname.startsWith('/bad/xx/')) return send(200, page('KLUDI Ersatzteil Dichtung', '4.90', { gtin13: '2222222222222' }));
    if (u.pathname === '/sitemap-index.xml') {
      const o = `http://${req.headers.host}`;
      return send(200, `<sitemapindex><sitemap><loc>${o}/s/kategorien.xml</loc></sitemap><sitemap><loc>${o}/s/artikel-1.xml.gz</loc></sitemap></sitemapindex>`, 'application/xml');
    }
    if (u.pathname === '/s/artikel-1.xml.gz') {
      const o = `http://${req.headers.host}`;
      const gz = zlib.gzipSync(`<urlset><url><loc>${o}/bad/duschsysteme/kludi-logo-thermostat-dual-shower-system_192921_179614/</loc></url><url><loc>${o}/bad/xx/kludi-ersatzteil-dichtung_9_9/</loc></url></urlset>`);
      res.writeHead(200, { 'content-type': 'application/x-gzip' });
      return res.end(gz);
    }
    if (u.pathname === '/s/kategorien.xml') return send(200, '<urlset><url><loc>http://x/kategorie</loc></url></urlset>', 'application/xml');
    if (u.pathname === '/own-sitemap.xml') {
      const o = `http://${req.headers.host}`;
      return send(200, `<urlset><url><loc>${o}/kludi-showersystem-logo-basic-dual/10484/</loc></url><url><loc>${o}/neues-produkt/20001/</loc></url><url><loc>${o}/kategorie/unterkategorie/</loc></url></urlset>`, 'application/xml');
    }
    const own = (sku, name, ean, price) => `<html><head><title>${name} | Shop</title></head><body><h1>${name}</h1><span itemprop="sku">${sku}</span><meta itemprop="gtin13" content="${ean}"><meta itemprop="mpn" content="MPN-${sku}"><meta property="product:brand" content="Testmarke"><meta property="product:price:amount" content="${price}"><meta property="product:price:currency" content="EUR"></body></html>`;
    if (u.pathname === '/neues-produkt/20001/') return send(200, own('20001', 'Neues Produkt', '4000000000017', '99.9'));
    if (u.pathname === '/kludi-showersystem-logo-basic-dual/10484/') return send(200, own('10484', 'KLUDI Showersystem Logo Basic Dual', '4015241210108', '239.00'));
    if (u.pathname === '/redir') { res.writeHead(302, { location: '/admin/suche' }); return res.end(); }
    // Shop ohne maschinenlesbare Produktdaten: nur die KI kann ihn auslesen
    if (u.pathname === '/ki-search') {
      return u.searchParams.get('q') === '10276-001'
        ? send(200, '<html><body><ul><li><a href="/x/other">Duschstange Basic</a> 19,90 €</li><li><a href="/x/hsk-ai">HSK Duschsystem RS 200 AquaSwitch Rund Ablage weiß</a> 640,00 €</li></ul></body></html>')
        : send(200, '<html><body>keine Treffer</body></html>');
    }
    if (u.pathname === '/x/hsk-ai') return send(200, '<html><head><title>HSK Duschsystem</title></head><body><h1>HSK Duschsystem RS 200 AquaSwitch Rund Ablage weiß</h1><p>Unser Preis: 640,00 € inkl. MwSt.</p></body></html>');
    if (u.pathname === '/x/other') return send(200, '<html><body><h1>Duschstange Basic</h1><p>19,90 €</p></body></html>');
    send(404, 'nope');
  });
}

function mockOpenAi(calls) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      calls.push({ auth: req.headers.authorization, model: j.model, json: j.response_format?.type });
      const sys = j.messages[0].content;
      const user = JSON.parse(j.messages[1].content === 'Test' ? '{}' : j.messages[1].content);
      let out = { ok: true };
      if (sys.includes('nummerierte Liste')) {
        const hit = user.links.find((l) => l.text.includes('HSK'));
        out = { index: hit ? hit.index : null, confidence: 0.9, reason: 'Gleiche Serie' };
      } else if (sys.includes('liest die Produktseite')) {
        const ok = user.page.url.includes('/x/hsk-ai');
        out = { is_product_page: ok, title: 'HSK Duschsystem RS 200', price: ok ? 640 : 19.9, availability: 'in_stock', same_product: ok, confidence: ok ? 0.95 : 0.1, reason: ok ? 'Gleiche Serie und Maße' : 'Anderes Produkt' };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { total_tokens: 42 } }));
    });
  });
}

test('Kompletter Ablauf: Import, Mitbewerber, Abruf, Übersicht', async () => {
  const shop = mockShop();
  const aiCalls = [];
  const ai = mockOpenAi(aiCalls);
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${ai.address().port}/v1`;
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
    const raw = await res.text(); let json; try { json = JSON.parse(raw); } catch { json = { raw: raw.slice(0, 120), path, status: res.status }; }
    return { status: res.status, json };
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

    // Benutzerverwaltung
    assert.equal((await call('/api/users', { username: 'zweiter', password: 'noch-ein-passwort' })).status, 200);
    assert.equal((await call('/api/users', { username: 'zweiter', password: 'noch-ein-passwort' })).status, 409);
    assert.equal((await call('/api/users', { username: 'x', password: 'noch-ein-passwort' })).status, 400);
    const dup = await call('/api/users', { username: 'zweiter', password: 'noch-ein-passwort' });
    assert.match(dup.json.error, /gibt es schon/);
    const list = (await call('/api/users')).json;
    assert.equal(list.length, 2);
    assert.ok(list.find((u) => u.username === 'marco').me);
    const meId = list.find((u) => u.me).id;
    assert.equal((await call(`/api/users/${meId}`, null, 'DELETE')).status, 409);
    const secondId = list.find((u) => !u.me).id;
    assert.equal((await call(`/api/users/${secondId}/password`, { password: 'kurz' }, 'PUT')).status, 400);
    assert.equal((await call(`/api/users/${secondId}/password`, { password: 'neues-passwort-123' }, 'PUT')).status, 200);
    const mine = cookie; cookie = '';
    assert.equal((await call('/api/auth/login', { username: 'zweiter', password: 'neues-passwort-123' })).status, 200);
    cookie = mine;
    assert.equal((await call(`/api/users/${secondId}`, null, 'DELETE')).status, 200);
    assert.equal((await call('/api/users')).json.length, 1);

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

    // Regelanalyse: nur bestätigte Preise zählen, unsichere Treffer werden vermerkt
    const an = (await call('/api/analysis')).json;
    assert.equal(an.stats.compared, 1);
    assert.equal(an.stats.unconfirmedOnly, 1);
    assert.equal(an.rows[0].action, 'senken');
    assert.equal(an.rows[0].suggested_price, 215);
    assert.equal(an.rows[0].gap_percent, 11.2);

    // KI-Zugang speichern (Schlüssel wird nie zurückgegeben)
    await call('/api/settings', { openai_api_key: 'sk-test-123', openai_model: 'test-model' }, 'PUT');
    const st2 = (await call('/api/settings')).json;
    assert.equal(st2.openai_key_set, true);
    assert.equal(st2.openai_model, 'test-model');
    assert.ok(!JSON.stringify(st2).includes('sk-test-123'));
    assert.equal(st2.own_name, 'BelKai'); // teilweises Speichern lässt andere Einstellungen unberührt
    assert.equal((await call('/api/settings/openai/test', {})).json.ok, true);

    const confirm = await call(`/api/matches/${mh.id}/confirm`, {});
    assert.equal(confirm.status, 200);
    assert.equal((await call('/api/analysis')).json.stats.compared, 2);

    // KI-Scraping: Shop ohne Produktdaten, Regeln finden nichts, die KI wählt den Treffer und liest den Preis
    const kc = await call('/api/competitors', { name: 'KI-Shop', base_url: base, search_url: `${base}/ki-search?q={q}`, delay_ms: 1, ai_mode: 'off' });
    const runAll = async () => {
      assert.equal((await call('/api/scrape', { force: true })).status, 200);
      for (let i = 0; i < 300 && scrapeState.running; i++) await new Promise((r) => setTimeout(r, 100));
    };
    await runAll();
    let kh = (await call('/api/overview')).json.products.find((p) => p.number === '10276-001').matches[kc.json.id];
    assert.equal(kh.status, 'not_found'); // KI aus: nichts gefunden
    await call(`/api/competitors/${kc.json.id}`, { name: 'KI-Shop', base_url: base, search_url: `${base}/ki-search?q={q}`, delay_ms: 1, ai_mode: 'fallback' }, 'PUT');
    await runAll();
    kh = (await call('/api/overview')).json.products.find((p) => p.number === '10276-001').matches[kc.json.id];
    assert.equal(kh.status, 'ok');
    assert.equal(kh.price, 640);
    assert.match(kh.ai_note, /KI \(95 %\)/);
    assert.ok(aiCalls.some((x) => x.auth === 'Bearer sk-test-123' && x.model === 'test-model' && x.json === 'json_object'));

    // Sitemap-Mitbewerber ohne Such-URL: Kandidaten über URL-Bezeichnung, Verifikation über EAN
    const sc = await call('/api/competitors', { name: 'Sitemap-Shop', base_url: base, sitemap_url: `${base}/sitemap.xml`, delay_ms: 1, ai_mode: 'off' });
    assert.ok(sc.json.id);
    assert.equal((await call('/api/competitors', { name: 'X', base_url: base, sitemap_url: 'kein-url' })).status, 400);
    const rf = (await call(`/api/competitors/${sc.json.id}/sitemap/refresh`, {})).json;
    assert.equal(rf.count, 3);
    await runAll();
    const sm = (await call('/api/overview')).json.products.find((p) => p.number === '10484').matches[sc.json.id];
    assert.equal(sm.status, 'ok'); // EAN auf der Produktseite stimmt
    assert.equal(sm.price, 259);
    assert.match(sm.url, /kludi-logo-thermostat/);
    const sh = (await call('/api/overview')).json.products.find((p) => p.number === '10276-001').matches[sc.json.id];
    assert.equal(sh.status, 'not_found');

    // Sitemaps automatisch finden (robots.txt), Index + .gz lesen, nur Artikel-Teil-Sitemaps
    const dis = (await call('/api/sitemaps/discover', { base_url: base })).json.sitemaps;
    assert.ok(dis.some((d) => d.kind === 'index' && d.url.endsWith('/sitemap-index.xml')));
    assert.ok(dis.some((d) => d.kind === 'urlset' && d.url.endsWith('/sitemap.xml')));
    const gz = await call('/api/competitors', { name: 'Index-Shop', base_url: base, sitemap_url: `${base}/sitemap-index.xml`, delay_ms: 1, ai_mode: 'off' });
    assert.equal((await call(`/api/competitors/${gz.json.id}/sitemap/refresh`, {})).json.count, 2);

    // Eigene Sitemap: URLs werden eigenen Artikeln zugeordnet (Artikelnummer im Pfad)
    await call('/api/settings', { own_sitemap_url: `${base}/own-sitemap.xml` }, 'PUT');
    assert.equal((await call('/api/settings')).json.own_sitemap_url, `${base}/own-sitemap.xml`);
    const own = (await call('/api/settings/own-sitemap/refresh', {})).json;
    assert.deepEqual([own.count, own.assigned], [3, 1]);
    assert.match((await call('/api/overview')).json.products.find((p) => p.number === '10484').url, /\/10484\/$/);

    // Artikelbasis aus der eigenen Sitemap importieren (nur Produktseiten, Hintergrundjob)
    assert.equal((await call('/api/import/sitemap', { limit: 0 })).status, 200);
    for (let i = 0; i < 100; i++) { if (!(await call('/api/import/sitemap/status')).json.running) break; await new Promise((r) => setTimeout(r, 100)); }
    const ist = (await call('/api/import/sitemap/status')).json;
    assert.deepEqual([ist.running, ist.total, ist.created, ist.updated, ist.errors], [false, 2, 1, 1, 0]);
    const np = (await call('/api/overview')).json.products.find((p) => p.number === '20001');
    assert.deepEqual([np.name, np.manufacturer, np.ean, np.mpn, np.price], ['Neues Produkt', 'Testmarke', '4000000000017', 'MPN-20001', 99.9]);
    // zweiter Lauf: bereits importierte Seiten werden übersprungen
    await call('/api/import/sitemap', { limit: 0 });
    for (let i = 0; i < 100; i++) { if (!(await call('/api/import/sitemap/status')).json.running) break; await new Promise((r) => setTimeout(r, 100)); }
    assert.equal((await call('/api/import/sitemap/status')).json.total, 0);

    // Weiterleitung auf eine per robots.txt gesperrte Seite wird nicht abgerufen
    const rd = (await call('/api/competitors/test', { search_url: `${base}/redir?q={q}`, query: 'x' })).json;
    assert.equal(rd.blocked, true);
    assert.match(rd.message, /weiter/);

    // Einrichtungshilfe: Seite mit KI auslesen
    const t = (await call('/api/competitors/test', { product_url: `${base}/x/hsk-ai`, use_ai: true })).json;
    assert.equal(t.product.found, false);
    assert.equal(t.ai.price, 640);
    assert.equal(t.ai.isProductPage, true);

    const hist = (await call(`/api/products/${kludi.id}/history`)).json;
    assert.equal(hist.series[0].points.length, 1);
    assert.equal(hist.own.length, 1);

    const csvOut = await (await fetch(api + '/api/export.csv', { headers: { cookie } })).text();
    assert.match(csvOut, /215,00/);
  } finally {
    srv.closeAllConnections(); srv.close(); shop.closeAllConnections(); shop.close(); ai.closeAllConnections(); ai.close();
  }
});
