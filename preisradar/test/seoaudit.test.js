import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, upsertProducts } from '../src/db.js';
import { auditHtml, auditProduct, auditOverview, auditOf, productSchema } from '../src/seoaudit.js';
import * as cheerio from 'cheerio';

const words = (n) => Array.from({ length: n }, (_, i) => `Wort${i}`).join(' ');
// Shopware-6-typische Seite mit Microdata
const good = (price) => `<!doctype html><html><head><title>Hansgrohe Talis E Waschtischarmatur 110 chrom | BelKai</title>
<meta name="description" content="Hansgrohe Talis E 110 Waschtischarmatur in Chrom mit Ablaufgarnitur. Schnell geliefert von BelKai, Ihrem Fachhändler für Bad und Sanitär.">
<link rel="canonical" href="/p/good"><meta property="og:title" content="x"><meta property="og:image" content="x.jpg"></head><body>
<header><img src="logo.png"></header>
<div itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Hansgrohe Talis E 110</h1>
<meta itemprop="gtin13" content="4059625000000"><div itemprop="brand" itemscope itemtype="https://schema.org/Brand"><meta itemprop="name" content="Hansgrohe"></div>
<img itemprop="image" src="a.jpg" alt="Talis E"><div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="priceCurrency" content="EUR"><meta itemprop="price" content="${price}"><link itemprop="availability" href="http://schema.org/InStock"></div>
<div class="product-detail-description-text">${words(120)}</div></div></body></html>`;
const bad = `<!doctype html><html><head><title>Talis</title><meta name="robots" content="noindex,follow"></head><body><h1>A</h1><h1>B</h1><img src="x.jpg"><p>kurz</p></body></html>`;

test('SEO-Prüfung: Einzelseite, Produktdaten, Abgleich über Seiten', async (t) => {
  // Microdata wie Shopware
  const s = productSchema(cheerio.load(good('149.90')));
  assert.equal(s.type, 'microdata');
  assert.equal(s.price, 149.9);
  assert.equal(s.availability, 'InStock');
  assert.equal(s.gtin, '4059625000000');
  assert.equal(s.brand, 'Hansgrohe');

  const ok = auditHtml(good('149.90'), { url: 'http://x.test/p/good', product: { price: 149.9, ean: '4059625000000' } });
  assert.deepEqual(ok.issues.map((i) => i.code), []);
  const mism = auditHtml(good('139.90'), { url: 'http://x.test/p/good', product: { price: 149.9 } });
  assert.ok(mism.issues.some((i) => i.code === 'schema_price_mismatch'));
  const b = auditHtml(bad, { url: 'http://x.test/p/bad', product: { price: 10, ean: '123' } }).issues.map((i) => i.code);
  for (const c of ['noindex', 'title_short', 'desc_missing', 'h1_multiple', 'schema_missing', 'thin_content', 'img_alt_missing', 'og_missing']) assert.ok(b.includes(c), c);

  // JSON-LD
  const ld = productSchema(cheerio.load('<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"X","brand":{"@type":"Brand","name":"Grohe"},"gtin13":"1","image":"a.jpg","offers":{"@type":"Offer","price":"99.00","priceCurrency":"EUR","availability":"https://schema.org/OutOfStock"}}]}</script>'));
  assert.equal(ld.price, 99);
  assert.equal(ld.availability, 'OutOfStock');
  assert.equal(ld.brand, 'Grohe');

  // Abruf über HTTP, robots.txt, Fehlerseite, doppelte Titel
  const srv = http.createServer((req, res) => {
    if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /intern/');
    if (req.url === '/p/good') return res.end(good('149.90'));
    if (req.url === '/p/gone') { res.statusCode = 404; return res.end('weg'); }
    res.end(bad);
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const db = openDb(':memory:');
  upsertProducts(db, [
    { number: 'A', name: 'Talis', price: 149.9, ean: '4059625000000', url: `${base}/p/good` },
    { number: 'B', name: 'Talis 2', price: 149.9, url: `${base}/p/good2` },
    { number: 'C', name: 'Weg', price: 5, url: `${base}/p/gone` },
    { number: 'D', name: 'Intern', price: 5, url: `${base}/intern/x` },
  ], 'csv');
  db.prepare('INSERT INTO product_sales(product_id, units_30, revenue_30, units_90, revenue_90) VALUES (2,1,100,3,300)').run();
  for (const p of db.prepare('SELECT id, url, price, ean FROM products').all()) await auditProduct(db, p);
  const o = auditOverview(db);
  assert.equal(o.checked, 4);
  assert.equal(o.counts.ok, 1); // nur A ist sauber
  assert.equal(o.counts.skipped, 1); // D: robots.txt
  const codes = (n) => o.pages.find((p) => p.number === n).issues.map((i) => i.code);
  assert.ok(codes('C').includes('http_error'));
  assert.equal(o.pages.find((p) => p.number === 'D').error, 'robots.txt untersagt den Abruf');
  assert.ok(o.issues.find((i) => i.code === 'noindex').important >= 1); // B hat Verkäufe
  assert.equal(o.pages[0].number, 'B'); // verkauft und schwere Befunde zuerst
  const one = auditOf(db, 1);
  assert.equal(one.audit.schema.price, 149.9);
});
