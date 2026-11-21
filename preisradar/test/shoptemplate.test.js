import test from 'node:test';
import assert from 'node:assert/strict';
import { validGtin, learnShopTemplate, applyShopTemplate, readLabeled } from '../src/shoptemplate.js';
import { extractProduct } from '../src/extract.js';
import { verify } from '../src/scraper.js';

const page = (price, ean, mpn, old = '999,00') => `<html><body><h1>HSK Walk-In Pro</h1>
  <div class="related"><span class="price">12,34 €</span></div>
  <div class="buybox"><del class="old">${old} €</del><span class="product-price-current">${price} €</span></div>
  <table class="props"><tr><th>EAN</th><td>${ean}</td></tr><tr><th>Hersteller-Nr.</th><td>${mpn}</td></tr><tr><th>Lieferzeit</th><td>3 Tage</td></tr></table>
</body></html>`;

test('GTIN-Prüfziffer', () => {
  assert.equal(validGtin('4006501181237'), true);
  assert.equal(validGtin('4006501181238'), false);
  assert.equal(validGtin('40065'), false);
});

test('Auslese-Vorlage: anlernen und auf andere Seiten anwenden (ohne KI)', () => {
  const html = page('504,81', '4006501181237', '1101090-41-50');
  const r = learnShopTemplate(html, { known: { price: 504.81, ean: '4006501181237', mpn: '1101090-41-50' } });
  assert.ok(r.tpl, r.notes.join(' | '));
  assert.equal(r.tpl.price.mode, 'selector');
  assert.deepEqual(r.tpl.ids.map((x) => x.kind), ['ean', 'mpn']);

  const other = page('1.288,00', '4006501190901', 'E87120-41');
  const t = applyShopTemplate(other, r.tpl);
  assert.equal(t.price, 1288);
  assert.equal(t.ean, '4006501190901');
  assert.equal(t.mpn, 'E87120-41');

  // Im normalen Auslesen: Quelle „vorlage“, und der Treffer ist über die EAN sicher
  const ext = extractProduct(other, { tpl: r.tpl });
  assert.equal(ext.source, 'vorlage');
  assert.equal(ext.price, 1288);
  assert.equal(verify({ ean: '4006501190901', name: 'x' }, ext), 'match');
});

test('Auslese-Vorlage: strukturierte Daten bevorzugt, ohne Preis Kandidaten', () => {
  const ld = `<html><head><script type="application/ld+json">{"@type":"Product","name":"A","offers":{"price":"788.00","priceCurrency":"EUR"}}</script></head><body>${page('788,00', '4006501181237', 'X1')}</body></html>`;
  const base = extractProduct(ld);
  const r = learnShopTemplate(ld, { jsonld: { price: base.price } });
  assert.equal(r.tpl.price.mode, 'jsonld');
  const none = learnShopTemplate(page('504,81', '1', '2'), {});
  assert.equal(none.tpl, null);
  assert.ok(none.candidates.some((c) => c.price === 504.81));
  assert.ok(!none.candidates.some((c) => c.price === 999));
});

test('Beschriftete Werte lesen', () => {
  assert.equal(readLabeled('Artikel EAN: 4006501181237 Farbe', { kind: 'ean', label: 'EAN' }), '4006501181237');
  assert.equal(readLabeled('EAN: 4006501181238', { kind: 'ean', label: 'EAN' }), null);
  assert.equal(readLabeled('Hersteller-Nr.: E87120-41 Lieferzeit 3 Tage', { kind: 'mpn', label: 'Hersteller-Nr.' }), 'E87120-41');
});

test('Marken-Eingrenzung je Mitbewerber', async () => {
  const { brandFilter } = await import('../src/scraper.js');
  const ok = brandFilter({ brands: 'HSK, Kermi' });
  assert.equal(ok({ manufacturer: 'HSK' }), true);
  assert.equal(ok({ manufacturer: 'hsk Duschsysteme' }), true);
  assert.equal(ok({ manufacturer: 'Grohe' }), false);
  assert.equal(ok({ manufacturer: null }), false);
  assert.equal(brandFilter({ brands: '' })({ manufacturer: 'Grohe' }), true);
});
