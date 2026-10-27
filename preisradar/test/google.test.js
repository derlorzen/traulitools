import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertProducts } from '../src/db.js';
import { listProducts, getProduct, invalidatePriceList } from '../src/pricelist.js';

test('Google-Filter, Suche über Suchanfragen und Klickpotenzial', () => {
  const db = openDb(':memory:');
  invalidatePriceList();
  upsertProducts(db, [
    { number: 'G1', name: 'Thermostat Brause', price: 120, url: 'https://shop.test/p/g1' },
    { number: 'G2', name: 'Waschtisch', price: 200, url: 'https://shop.test/p/g2' },
    { number: 'G3', name: 'Spiegel', price: 50, url: 'https://shop.test/p/g3' },
    { number: 'G4', name: 'Ablage', price: 30, url: 'https://shop.test/p/g4' },
  ], 'csv');
  db.prepare("INSERT INTO competitors(id, name, base_url) VALUES (1,'M','https://m.test')").run();
  // G1: gefragt, Platz 8, teurer als Mitbewerber; G2: Platz 2, kaum geklickt; G3: nicht bei Google, aber verkauft
  db.prepare(`INSERT INTO seo_pages(page, url, clicks, impressions, ctr, position) VALUES
    ('shop.test/p/g1','https://shop.test/p/g1',10,1000,0.01,8),('shop.test/p/g2','https://shop.test/p/g2',3,500,0.006,2)`).run();
  db.prepare("INSERT INTO seo_queries(page, query, clicks, impressions, ctr, position) VALUES ('shop.test/p/g2','unterschrank hängend weiß',3,300,0.01,2)").run();
  db.prepare("INSERT INTO matches(product_id, competitor_id, status, price) VALUES (1,1,'ok',100),(2,1,'ok',210)").run();
  db.prepare('INSERT INTO product_sales(product_id, units_30, revenue_30, units_90, revenue_90) VALUES (3,1,50,4,200)').run();
  db.prepare("INSERT INTO mc_products(offer_id, benchmark, suggested) VALUES ('G4', 25, 27)").run();

  const all = listProducts(db, { scope: 'all' });
  assert.equal(all.chips.gDemand, 2);
  assert.equal(all.chips.gDemandDear, 1);
  assert.equal(all.chips.gStriking, 1);
  assert.equal(all.chips.gLowCtr, 2); // G1: 1 % statt üblich 2,2 %, G2: 0,6 % statt 12 %
  assert.equal(all.chips.gSoldHidden, 1);
  assert.equal(all.chips.gAboveBench, 1);
  assert.equal(all.chips.gSuggest, 1);

  // Klickpotenzial: G1 Platz 8 → Ziel 8 % von 1000 = 80, minus 10 Klicks
  const g1 = all.rows.find((r) => r.number === 'G1');
  assert.equal(g1.g.potential, 70);
  assert.ok(g1.g.advice.some((x) => x.kind === 'price'));
  const pot = listProducts(db, { scope: 'all', sort: 'potential', dir: 'desc' });
  assert.equal(pot.rows[0].number, 'G1');
  assert.equal(pot.rows[1].g.potential, 57); // G2 auf Platz 2: 500 × 12 % − 3

  // Suche über Google-Suchanfrage
  const hit = listProducts(db, { scope: 'all', q: 'unterschrank weiß' });
  assert.equal(hit.total, 1);
  assert.equal(hit.rows[0].number, 'G2');
  assert.equal(hit.rows[0].hit, 'unterschrank hängend weiß');
  assert.equal(hit.rows[0].qtext, undefined); // Suchtexte gehen nicht an die Oberfläche
  assert.equal(listProducts(db, { scope: 'all', q: 'Spiegel' }).rows[0].hit, undefined);

  // Impressionen ab / Position bis
  assert.equal(listProducts(db, { scope: 'all', impMin: 600 }).total, 1);
  assert.equal(listProducts(db, { scope: 'all', posMax: 3 }).total, 1);

  const p = getProduct(db, 2);
  assert.equal(p.seo.top.query, 'unterschrank hängend weiß');
  assert.ok(p.g.flags.includes('lowCtr'));
});
