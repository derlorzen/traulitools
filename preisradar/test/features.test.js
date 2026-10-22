import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.OWN_IMPORT_DELAY_MS = '0';
import { openDb, upsertProducts } from '../src/db.js';
import { listProducts } from '../src/pricelist.js';
import { refreshOwnSitemap, refreshSitemaps, sitemapCategories, sitemapCandidates, clearSitemapCache } from '../src/sitemap.js';
import { checkProductNow } from '../src/scraper.js';
import { searchLinkFromHtml } from '../src/autosetup.js';

function server(handler) {
  const srv = http.createServer(handler);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('Preisliste: Seiten, Sortierung, Filter, Zähler', () => {
  const db = openDb(':memory:');
  upsertProducts(db, Array.from({ length: 250 }, (_, i) => ({ number: `N${i}`, name: `Artikel ${String(i).padStart(3, '0')}`, manufacturer: i % 2 ? 'Grohe' : 'Kludi', price: 10 + i })), 'csv');
  db.prepare("INSERT INTO competitors(id, name, base_url) VALUES (1,'A','https://a.example')").run();
  db.prepare("INSERT INTO matches(product_id, competitor_id, status, price) VALUES (1,1,'ok',5),(2,1,'ok',100),(3,1,'not_found',NULL)").run();
  const p1 = listProducts(db, { limit: 100 });
  assert.equal(p1.total, 250);
  assert.equal(p1.rows.length, 100);
  const p3 = listProducts(db, { offset: 200, limit: 100 });
  assert.equal(p3.rows.length, 50);
  assert.equal(listProducts(db, { sort: 'price', dir: 'desc', limit: 1 }).rows[0].price, 259);
  assert.equal(listProducts(db, { sort: 'comp:1', dir: 'asc', limit: 1 }).rows[0].number, 'N0');
  assert.equal(listProducts(db, { brand: 'Grohe' }).total, 125);
  const u = listProducts(db, { filter: 'undercut' });
  assert.equal(u.total, 1);
  assert.equal(u.chips.cheapest, 1);
  assert.equal(u.chips.notFound, 1);
  assert.equal(listProducts(db, { q: 'artikel 00' }).total, 10);
});

test('Sitemap-Kategorien begrenzen die Suche; eigene Artikel werden offline markiert', async () => {
  let ownUrls = ['/p/eins/1/', '/p/zwei/2/', '/p/drei/3/'];
  const { srv, base } = await server((req, res) => {
    const o = `http://${req.headers.host}`;
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/own.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<urlset>${ownUrls.map((u) => `<url><loc>${o}${u}</loc></url>`).join('')}</urlset>`); }
    if (req.url === '/comp.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<urlset>${['/bad/armaturen/grohe-eurosmart-x/', '/bad/armaturen/grohe-eurosmart-y/', '/bad/brausen/grohe-tempesta/', '/heizung/kessel/grohe-eurosmart-kessel/', '/heizung/kessel/vaillant-a/', '/heizung/kessel/vaillant-b/'].map((u) => `<url><loc>${o}${u}</loc></url>`).join('')}</urlset>`);
    }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<script type="application/ld+json">{"potentialAction":{"@type":"SearchAction","target":"' + o + '/search?search={search_term_string}"}}</script>'); }
    if (req.url.startsWith('/bad/armaturen/grohe-eurosmart-x')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>Grohe Eurosmart X</title><meta property="product:price:amount" content="88.50"></head><body><h1>Grohe Eurosmart X</h1><span itemprop="sku">4005176</span></body></html>'); }
    res.writeHead(404); res.end();
  });
  try {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO competitors(id, name, base_url, sitemap_url) VALUES (1,'K',?,?)").run(base, `${base}/comp.xml`);
    await refreshSitemaps(db, db.prepare('SELECT * FROM competitors WHERE id=1').get());
    const cats = sitemapCategories(db, 1);
    assert.deepEqual(cats.categories.filter((c) => c.level === 1).map((c) => [c.path, c.count]), [['bad', 3], ['heizung', 3]]);
    const prod = { name: 'Grohe Eurosmart', manufacturer: 'Grohe' };
    assert.ok(sitemapCandidates(db, 1, prod, { min: 0.1 }).some((c) => c.url.includes('/heizung/')));
    db.prepare("UPDATE competitors SET sitemap_categories='[\"bad/armaturen\"]' WHERE id=1").run();
    clearSitemapCache(1);
    const only = sitemapCandidates(db, 1, prod, { min: 0.1 });
    assert.ok(only.length && only.every((c) => c.url.includes('/bad/armaturen/')));

    // Sofortprüfung über die Sitemap-Kandidaten
    upsertProducts(db, [{ number: 'G1', name: 'Grohe Eurosmart X', manufacturer: 'Grohe', mpn: '4005176', price: 99 }], 'csv');
    db.prepare('UPDATE competitors SET delay_ms=0').run();
    const r = await checkProductNow(db, 1);
    assert.equal(r[0].found, true);
    assert.equal(db.prepare('SELECT price FROM matches WHERE product_id=1').get().price, 88.5);

    // Suchlink aus der Startseite
    assert.equal(searchLinkFromHtml('<script>{"target":"https://x.de/search?search={search_term_string}"}</script>', 'https://x.de/'), 'https://x.de/search?search={q}');

    // Offline: Artikel verschwindet aus der eigenen Sitemap
    upsertProducts(db, ownUrls.map((u, i) => ({ number: `O${i}`, name: `Eigen ${i}`, url: `${base}${u}`, price: 1 })), 'sitemap');
    await refreshOwnSitemap(db, [`${base}/own.xml`]);
    ownUrls = ownUrls.slice(0, 2).concat(['/p/vier/4/']);
    const res = await refreshOwnSitemap(db, [`${base}/own.xml`]);
    assert.equal(res.offline, 1);
    assert.ok(db.prepare("SELECT offline_since FROM products WHERE number='O2'").get().offline_since);
    assert.equal(listProducts(db, { filter: 'offline' }).total, 1);
    // Zurück in der Sitemap: wieder online
    ownUrls.push('/p/drei/3/');
    assert.equal((await refreshOwnSitemap(db, [`${base}/own.xml`])).online, 1);
    // Sitemap plötzlich viel kleiner: kein Fehlalarm
    ownUrls = ['/p/eins/1/'];
    assert.equal((await refreshOwnSitemap(db, [`${base}/own.xml`])).offline, 0);
  } finally {
    srv.closeAllConnections(); srv.close();
  }
});

test('KI-Tagesgrenze: Zähler übersteht Neustart, Grenze einstellbar', async () => {
  const { initAiBudget, aiBudgetLeft, aiUsage } = await import('../src/aiscrape.js');
  const db = openDb(':memory:');
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  db.prepare("INSERT INTO settings(key, value) VALUES ('ai_calls_day', ?), ('ai_calls_count', '7'), ('ai_daily_limit', '8')").run(day);
  initAiBudget(db);
  assert.deepEqual(aiUsage(), { day, today: 7, limit: 8 });
  assert.equal(aiBudgetLeft(), true);
  db.prepare("UPDATE settings SET value='7' WHERE key='ai_daily_limit'").run();
  assert.equal(aiBudgetLeft(), false);
  db.prepare("UPDATE settings SET value='2026-01-01' WHERE key='ai_calls_day'").run();
  initAiBudget(db); // anderer Tag gespeichert: Zähler beginnt bei 0
  assert.equal(aiUsage().today, 0);
  initAiBudget(null);
});

test('KI lernt eine Abruf-Vorlage, danach werden weitere Seiten ohne KI gelesen', async () => {
  const calls = [];
  const { srv: ai, base: aiBase } = await server((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      const user = JSON.parse(j.messages[1].content);
      calls.push(user.page?.url);
      const out = { is_product_page: true, title: 'Artikel', price: 580.87, availability: 'in_stock', same_product: true, confidence: 0.95, reason: 'gleich' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
    });
  });
  const page = (name, price) => `<html><body><header><span class="price">9,99 €</span></header><h1>${name}</h1><div class="product-detail"><span class="price-old">999,00 €</span><div class="buy"><p class="product-detail-price">${price} €*</p></div></div><div class="cross-selling"><span class="product-price">1,00 €</span></div></body></html>`;
  const { srv, base } = await server((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/a') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page('Artikel A', '580,87')); }
    if (req.url === '/b') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page('Artikel B', '1.234,50')); }
    res.writeHead(404); res.end();
  });
  const prevBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `${aiBase}/v1`;
  try {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO settings(key, value) VALUES ('openai_api_key', 'sk-x')").run();
    db.prepare("INSERT INTO competitors(id, name, base_url, delay_ms, ai_mode) VALUES (1,'S',?,0,'fallback')").run(base);
    upsertProducts(db, [{ number: 'A', name: 'Artikel A', price: 600 }, { number: 'B', name: 'Artikel B', price: 1200 }], 'csv');
    db.prepare("INSERT INTO matches(product_id, competitor_id, status, url, source) VALUES (1,1,'ok',?,'manual'),(2,1,'ok',?,'manual')").run(`${base}/a`, `${base}/b`);
    await checkProductNow(db, 1);
    assert.equal(calls.length, 1); // erste Seite: KI liest den Preis
    const tpl = JSON.parse(db.prepare('SELECT templates FROM competitors WHERE id=1').get().templates);
    assert.equal(tpl[0].selector, 'p.product-detail-price');
    await checkProductNow(db, 2);
    assert.equal(calls.length, 1); // zweite Seite: Vorlage, keine KI
    assert.equal(db.prepare('SELECT price FROM matches WHERE product_id=2').get().price, 1234.5);
    assert.equal(JSON.parse(db.prepare('SELECT templates FROM competitors WHERE id=1').get().templates)[0].hits, 1);
  } finally {
    process.env.OPENAI_BASE_URL = prevBase;
    srv.closeAllConnections(); srv.close(); ai.closeAllConnections(); ai.close();
  }
});

test('Tagesgrenzen: höchstens zweimal täglich, mindestens acht Stunden Abstand', async () => {
  const { withinDailyLimits, berlinDay } = await import('../src/scraper.js');
  const now = Date.now();
  assert.equal(withinDailyLimits({ last_checked: null }, now), true);
  assert.equal(withinDailyLimits({ last_checked: new Date(now - 7 * 3600e3).toISOString() }, now), false);
  assert.equal(withinDailyLimits({ last_checked: new Date(now - 9 * 3600e3).toISOString(), check_day: berlinDay(now), check_count: 1 }, now), true);
  assert.equal(withinDailyLimits({ last_checked: new Date(now - 9 * 3600e3).toISOString(), check_day: berlinDay(now), check_count: 2 }, now), false);
});
