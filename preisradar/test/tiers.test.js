import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertProducts } from '../src/db.js';
import { computeTiers, dueByTier, tierStatus } from '../src/tiers.js';
import { setSetting } from '../src/settings.js';

test('Prüf-Stufen: Auswahl, Reihenfolge, Abstände', () => {
  const db = openDb(':memory:');
  upsertProducts(db, Array.from({ length: 10 }, (_, i) => ({ number: `N${i}`, name: `Artikel ${i}`, price: 100, url: `https://shop.test/p/${i}` })), 'csv');
  db.prepare("INSERT INTO competitors(id, name, base_url) VALUES (1,'M','https://m.test')").run();
  // Verkäufe: N1 viel, N2 wenig; Google: N3; Preisbewegung: N4; von Hand: N9
  db.prepare('INSERT INTO product_sales(product_id, units_30, revenue_30, units_90, revenue_90) VALUES (2,5,500,9,900),(3,1,100,1,100)').run();
  db.prepare("INSERT INTO seo_pages(page, url, clicks, impressions, ctr, position) VALUES ('shop.test/p/3','https://shop.test/p/3',5,400,0.01,9)").run();
  db.prepare("INSERT INTO matches(id, product_id, competitor_id, status, price) VALUES (1,5,1,'ok',90)").run();
  const t = (d) => new Date(Date.now() - d * 864e5).toISOString();
  db.prepare('INSERT INTO price_history(match_id, price, at) VALUES (1,95,?),(1,90,?)').run(t(3), t(1));
  db.prepare("UPDATE products SET tier_pin=1 WHERE number='N9'").run();
  setSetting(db, 'tier_a_size', '3');
  const r = computeTiers(db, { force: true });
  const tier = Object.fromEntries(db.prepare('SELECT number, tier FROM products').all().map((x) => [x.number, x.tier]));
  // von Hand immer, dann die drei wichtigsten: Umsatz (N1, N2), dann Preisbewegung (N4) vor Google (N3)
  assert.deepEqual(['N9', 'N1', 'N2', 'N4'].map((n) => tier[n]), ['A', 'A', 'A', 'A']);
  assert.equal(tier.N3, 'B'); // Stufe A ist voll (Größe 3 + von Hand)
  assert.equal(tier.N0, 'B');
  assert.equal(r.a, 4);
  assert.match(db.prepare("SELECT tier_reason FROM products WHERE number='N1'").get().tier_reason, /9 verkauft/);

  const now = Date.now();
  const cfg = { refreshH: 8, bDays: 4 };
  const ago = (h) => new Date(now - h * 3600e3).toISOString();
  assert.equal(dueByTier({ status: 'pending' }, 'B', now, cfg), true);
  assert.equal(dueByTier({ status: 'ok', last_checked: ago(10) }, 'A', now, cfg), true);
  assert.equal(dueByTier({ status: 'ok', last_checked: ago(10) }, 'B', now, cfg), false);
  assert.equal(dueByTier({ status: 'ok', last_checked: ago(97) }, 'B', now, cfg), true);
  assert.equal(dueByTier({ status: 'not_found', last_checked: ago(24 * 8), miss_count: 1 }, 'A', now, cfg), true);
  assert.equal(dueByTier({ status: 'not_found', last_checked: ago(24 * 8), miss_count: 4 }, 'A', now, cfg), false); // nach 4 Fehlversuchen monatlich
  const st = tierStatus(db);
  assert.equal(st.a, 4);
  assert.equal(st.pinned, 1);
});
