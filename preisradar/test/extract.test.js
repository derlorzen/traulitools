import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, parseCsv } from '../src/util.js';
import { extractProduct, findCandidates } from '../src/extract.js';

test('parsePrice: deutsche und englische Formate', () => {
  assert.equal(parsePrice('1.234,56 €'), 1234.56);
  assert.equal(parsePrice('239,00'), 239);
  assert.equal(parsePrice('ab 755,00 €'), 755);
  assert.equal(parsePrice('1234.56', { dotDecimal: true }), 1234.56);
  assert.equal(parsePrice('1.299'), 1299);
  assert.equal(parsePrice('kostenlos'), null);
});

test('parseCsv: Semikolon, Anführungszeichen, BOM', () => {
  const rows = parseCsv('﻿Artikelnummer;Name;Preis\r\n10277-024;"HSK ""RS 500"" Set";755,00\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Name, 'HSK "RS 500" Set');
  assert.equal(rows[0].Preis, '755,00');
});

test('extractProduct: JSON-LD mit @graph und Offer-Liste', () => {
  const html = `<html><head><script type="application/ld+json">
  {"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["Product"],"name":"Kludi Logo","gtin13":"4015241210108","mpn":"K-123",
  "offers":[{"@type":"Offer","price":"239.00","priceCurrency":"EUR","availability":"https://schema.org/InStock"},{"@type":"Offer","price":"249.00"}]}]}
  </script></head><body><h1>Kludi Logo</h1></body></html>`;
  const e = extractProduct(html);
  assert.equal(e.price, 239);
  assert.equal(e.availability, 'in_stock');
  assert.ok(e.ids.has('4015241210108'));
  assert.equal(e.source, 'jsonld');
});

test('extractProduct: Meta-Fallback und eigener Selektor', () => {
  const meta = '<html><head><meta property="product:price:amount" content="119.90"></head><body><h1>X</h1></body></html>';
  assert.equal(extractProduct(meta).price, 119.9);
  const sel = '<html><body><h1>X</h1><span class="pp">1.049,00 €</span></body></html>';
  assert.equal(extractProduct(sel, { priceSelector: '.pp' }).price, 1049);
});

test('findCandidates: filtert Navigation, fremde Hosts und Duplikate', () => {
  const html = `<body><a href="/account">Konto</a><div class="product-box"><a href="/p/a">A</a><a href="/p/a">A</a></div>
  <div class="product-box"><a href="https://fremd.de/x">X</a><a href="/p/b?x=1#frag">B</a></div></body>`;
  assert.deepEqual(findCandidates(html, 'https://shop.de/search?q=1'), ['https://shop.de/p/a', 'https://shop.de/p/b?x=1']);
});

test('priceInText: KI-Preise müssen auf der Seite belegt sein', async () => {
  const { priceInText } = await import('../src/aiscrape.js');
  assert.ok(priceInText(1299, 'Preis 1.299,00 € inkl. MwSt.'));
  assert.ok(priceInText(640, 'nur 640,00 €'));
  assert.ok(priceInText(19.9, 'statt 29,90 jetzt 19,90 EUR'));
  assert.ok(!priceInText(215, 'Artikel 12150 kostet 640,00 €'));
  assert.ok(!priceInText(99.99, 'Preis 640,00 €'));
});
