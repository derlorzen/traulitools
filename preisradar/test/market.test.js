import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertProducts } from '../src/db.js';
import { setSetting, getSetting, initSecrets } from '../src/settings.js';
import { money, normOffer } from '../src/sources/util.js';
import idealo from '../src/sources/idealo.js';
import { lookupBatch, sourceView, productMarket, marketMap, discoveredShops, dueFor, sourceOverview, spendMonth, startJob, jobs, competitorMatcher, setSelected, saveMarketSettings, sourceConfig, activeSources } from '../src/market.js';

test('Preise und Angebote verschiedener Actors lesen', () => {
  assert.equal(money('87,99'), 87.99);
  assert.equal(money('1.234,56 €'), 1234.56);
  assert.equal(money('4.95'), 4.95);
  assert.equal(money('1.299'), 1299);
  assert.equal(money('Versandkostenfrei'), 0);
  assert.equal(money({ value: 12.5 }), 12.5);
  assert.equal(money(null), null);
  // s-r: Gesamtpreis, Versand als Text oder „inklusive“
  assert.deepEqual(
    (({ shop, price, shipping, total }) => ({ shop, price, shipping, total }))(normOffer({ shop: 'megabad.com', total_price: 104.9, price_text: '99,95', shipping_included: false, shipping_cost_text: '4,95 € Versand' }, 0)),
    { shop: 'megabad.com', price: 99.95, shipping: 4.95, total: 104.9 },
  );
  assert.equal(normOffer({ shop: 'X', total_price: 50, shipping_included: true }, 0).price, 50);
  // firsthand: andere Feldnamen
  const f = normOffer({ shopName: 'Amazon Marketplace', price: 48.5, shippingCost: 0, totalPrice: 48.5 }, 2);
  assert.equal(f.marketplace, 'amazon');
  assert.equal(f.position, 3);
  assert.equal(normOffer({ shop: '', total_price: 3 }, 0), null);
  const p = idealo.normProduct({ gtin: '4005176314964', product_id: 77, offers: [{ shop: 'B', total_price: 20 }, { shop: 'A', total_price: 10 }] });
  assert.equal(p.ean, '4005176314964');
  assert.equal(p.ext_id, '77');
  assert.deepEqual(p.offers.map((o) => o.shop), ['A', 'B']); // nach Gesamtpreis sortiert
  assert.equal(idealo.normProduct({ found: false }), null);
});

// Nachgebautes Apify
const calls = [];
let mode = 'ok';
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{"error":{"message":"User was not found or authentication token is not valid"}}'); }
    if (req.url === '/v2/users/me') return res.end('{"data":{"username":"marco","plan":{"id":"FREE"}}}');
    if (req.url.startsWith('/v2/acts/s-r~idealo-scraper/run-sync-get-dataset-items')) {
      if (mode === 'pay') { res.statusCode = 402; return res.end('{"error":{"message":"Not enough credit"}}'); }
      const { eans } = JSON.parse(b);
      const out = [];
      if (eans.includes('4005176314964')) out.push({ ean: '4005176314964', found: true, idealo_sku: '123', url: 'https://www.idealo.de/preisvergleich/OffersOfProduct/123.html', title: 'Grohe Eurosmart', offer_count: 4, offers: [
        { shop: 'Megabad', total_price: 95.9, price_text: '95,90', shipping_included: true, position: 1 },
        { shop: 'BelKai', total_price: 99.9, price_text: '94,95', shipping_cost_text: '4,95 €', position: 2 },
        { shop: 'Reuter.de', total_price: 109, price_text: '109,00', shipping_included: true, position: 3 },
        { shop: 'Amazon', total_price: 112.5, price_text: '112,50', shipping_included: true, position: 4 },
      ] });
      if (eans.includes('4005176000001')) out.push({ ean: '4005176000001', found: true, offers: [
        { shop: 'BelKai', total_price: 50, shipping_included: true }, { shop: 'Megabad', total_price: 59, shipping_included: true },
      ] });
      return res.end(JSON.stringify(out));
    }
    res.statusCode = 404; res.end('{"error":{"message":"Actor not found"}}');
  });
});

test('Marktquelle idealo über Apify', async (t) => {
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  process.env.APIFY_API_BASE = `http://127.0.0.1:${srv.address().port}`;
  initSecrets(null);
  const db = openDb(':memory:');
  setSetting(db, 'own_name', 'BelKai');
  upsertProducts(db, [
    { number: 'A1', ean: '4005176314964', name: 'Grohe Eurosmart', price: 99.9 },
    { number: 'A2', ean: '4005176000001', name: 'Ablauf', price: 50 },
    { number: 'A3', ean: '4005176999999', name: 'Gibt es nicht', price: 10 },
    { number: 'A4', ean: '', name: 'Ohne EAN', price: 10 },
  ], 'test');
  db.prepare("INSERT INTO competitors(name, base_url) VALUES ('Reuter', 'https://www.reuter.de')").run();
  const ids = Object.fromEntries(db.prepare('SELECT id, number FROM products').all().map((p) => [p.number, p.id]));

  // ohne Token: nichts, und keine aktiven Quellen für die Oberfläche
  assert.deepEqual(activeSources(db), []);
  await assert.rejects(lookupBatch(db, 'idealo', [{ id: ids.A1, ean: '4005176314964' }]), /Token/);
  setSetting(db, 'apify_token', 'tok', { secret: true });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='apify_token'").get().value.startsWith('enc:'), true, 'Token verschlüsselt');
  assert.deepEqual(activeSources(db).map((s) => s.key), ['idealo']);

  // Nichts vorgemerkt: nichts fällig; vorgemerkt: nur Artikel mit EAN; herausgenommen: nicht mehr fällig
  assert.deepEqual(dueFor(db, 'idealo', 10), []);
  const c = setSelected(db, 'idealo', Object.values(ids), true);
  assert.deepEqual({ ...c }, { n: 4, no_ean: 1 });
  assert.deepEqual(dueFor(db, 'idealo', 10).map((p) => p.id).sort(), [ids.A1, ids.A2, ids.A3].sort());
  setSelected(db, 'idealo', [ids.A2], false);
  assert.deepEqual(dueFor(db, 'idealo', 10).map((p) => p.id).sort(), [ids.A1, ids.A3].sort());
  setSelected(db, 'idealo', [ids.A2], true);
  assert.throws(() => setSelected(db, 'gibtsnicht', [ids.A1], true), /Unbekannte Marktquelle/);

  const r = await lookupBatch(db, 'idealo', dueFor(db, 'idealo', 10));
  assert.deepEqual(r, { found: 2, missing: 1 });
  assert.deepEqual(calls.at(-1).body, { eans: ['4005176314964', '4005176000001', '4005176999999'], country: 'de', concurrency: 3 });

  // Artikel 1: eigenes Angebot auf Platz 2, Megabad günstiger
  const v = productMarket(db, ids.A1).sources.idealo;
  assert.equal(v.selected, true);
  assert.equal(v.data.min_total, 95.9);
  assert.equal(v.data.min_shop, 'Megabad');
  assert.equal(v.data.own_rank, 2);
  assert.equal(v.data.own_total, 99.9);
  assert.equal(v.data.kind, 'dearer');
  assert.equal(v.data.gap_pct, 4.2);
  assert.equal(v.data.offers_list.find((o) => o.shop === 'Reuter.de').competitor, 'Reuter', 'Händler dem Mitbewerber zugeordnet');
  assert.equal(v.data.offers_list.find((o) => o.shop === 'Amazon').marketplace, 'amazon');
  assert.equal(v.data.offers_list.find((o) => o.shop === 'BelKai').shipping, 4.95);
  assert.equal(v.data.history.length, 1);
  assert.equal(productMarket(db, ids.A1).best.source, 'idealo');
  // Artikel 2: günstigster, 18 % Luft bis zum nächsten
  const m = marketMap(db);
  assert.equal(m.get(ids.A2).best.kind, 'cheapest');
  assert.equal(m.get(ids.A2).per.idealo.headroom_pct, 18);
  assert.equal(m.get(ids.A2).headroom, true);
  assert.deepEqual(m.get(ids.A4).sel, ['idealo'], 'vorgemerkt auch ohne Ergebnis');
  // Artikel 3: nicht gefunden, erst nach 30 Tagen wieder fällig
  assert.equal(productMarket(db, ids.A3).sources.idealo.data.found, false);
  assert.equal(dueFor(db, 'idealo', 10).length, 0);
  db.prepare("UPDATE market_products SET checked_at='2020-01-01T00:00:00Z' WHERE product_id=?").run(ids.A3);
  assert.deepEqual(dueFor(db, 'idealo', 10).map((p) => p.id), [ids.A3]);

  // Entdeckte Händler: Megabad (nicht angelegt) und Amazon, nicht Reuter (angelegt) und nicht BelKai (eigener Shop)
  const shops = discoveredShops(db);
  assert.deepEqual(shops.map((s) => s.shop).sort(), ['Amazon', 'Megabad']);
  assert.equal(shops.find((s) => s.shop === 'Megabad').cheaper, 1);
  assert.equal(shops.find((s) => s.shop === 'Megabad').products, 2);
  assert.deepEqual(shops.find((s) => s.shop === 'Megabad').sources, ['idealo']);

  // Kosten: 1 Lauf, 2 gefundene Artikel nach s-r-Tarif
  assert.equal(Math.round(spendMonth(db, 'idealo').usd * 1000) / 1000, 0.01);
  const o = sourceOverview(db, 'idealo');
  assert.equal(o.found, 2);
  assert.equal(o.listed, 2);
  assert.equal(o.dearer, 1);
  assert.equal(o.selected, 4);
  assert.equal(o.with_ean, 3);

  // Einstellungen je Quelle
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  saveMarketSettings(db, { idealo_per_day: '30', idealo_budget: '5', idealo_actor: 'firsthand/idealo-api', idealo_country: 'at' }, bad);
  const cfg = sourceConfig(db, 'idealo');
  assert.equal(cfg.perDay, 30);
  assert.equal(cfg.budget, 5);
  assert.equal(cfg.actorId, 'firsthand~idealo-api');
  assert.equal(cfg.country, 'at');
  assert.throws(() => saveMarketSettings(db, { idealo_per_day: '-1' }, bad), /Artikel pro Tag/);
  assert.throws(() => saveMarketSettings(db, { idealo_actor: 'kein actor' }, bad), /Actor-ID/);
  saveMarketSettings(db, { idealo_actor: '', idealo_country: 'de', idealo_budget: '10' }, bad);

  // Budget erreicht: kein neuer Lauf
  setSetting(db, 'idealo_budget', '0.005');
  assert.equal(startJob(db, 'idealo', { ids: [ids.A1] }), false);
  assert.match(jobs.idealo.error, /Monatsbudget/);
  setSetting(db, 'idealo_budget', '10');

  // Guthaben leer: Lauf bricht ab, Fehler bleibt sichtbar, Daten bleiben erhalten
  mode = 'pay';
  assert.equal(startJob(db, 'idealo', { ids: [ids.A1, ids.A2] }), true);
  while (jobs.idealo.running) await new Promise((res) => setTimeout(res, 20));
  assert.match(jobs.idealo.error, /Guthaben/);
  assert.match(getSetting(db, 'idealo_error'), /Guthaben/);
  assert.equal(productMarket(db, ids.A1).sources.idealo.data.min_total, 95.9);
  mode = 'ok';

  // falsches Token
  setSetting(db, 'apify_token', 'falsch', { secret: true });
  await assert.rejects(lookupBatch(db, 'idealo', [{ id: ids.A1, ean: '4005176314964' }]), /Token ungültig/);
});

test('Händler Mitbewerbern zuordnen', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competitors(name, base_url) VALUES ('Megabad', 'https://www.megabad.com'), ('Sanitär Heinze', 'https://www.sanitaer-heinze.com')").run();
  const of = competitorMatcher(db);
  assert.ok(of('megabad.com'));
  assert.ok(of('MEGABAD GmbH'));
  assert.ok(of('sanitaer-heinze.com'));
  assert.equal(of('Amazon'), null);
  assert.equal(sourceView(null), null);
});

test('Übernahme der Daten aus der ersten idealo-Version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-migr-'));
  const file = path.join(dir, 'alt.db');
  // Alte Datenbank wie in der ersten idealo-Version
  let db = openDb(file);
  upsertProducts(db, [{ number: 'A1', ean: '4005176314964', name: 'X', price: 99.9 }, { number: 'A2', ean: '4005176000001', name: 'Y', price: 50 }], 'test');
  const [a1, a2] = db.prepare('SELECT id FROM products ORDER BY number').all().map((r) => r.id);
  db.exec(`CREATE TABLE IF NOT EXISTS idealo_products (product_id INTEGER PRIMARY KEY, ean TEXT, checked_at TEXT NOT NULL, found INTEGER NOT NULL DEFAULT 0, idealo_id TEXT, url TEXT, title TEXT, offers INTEGER, min_total REAL, min_shop TEXT, own_rank INTEGER, own_total REAL, next_total REAL, error TEXT);
    CREATE TABLE IF NOT EXISTS idealo_offers (product_id INTEGER NOT NULL, position INTEGER, shop TEXT NOT NULL, shop_id TEXT, price REAL, shipping REAL, total REAL NOT NULL, delivery TEXT, marketplace TEXT, own INTEGER NOT NULL DEFAULT 0, competitor_id INTEGER);
    CREATE TABLE IF NOT EXISTS idealo_history (product_id INTEGER NOT NULL, day TEXT NOT NULL, min_total REAL, own_total REAL, offers INTEGER, PRIMARY KEY(product_id, day));`);
  db.prepare("INSERT INTO idealo_products VALUES (?, '4005176314964', '2026-11-18T10:00:00Z', 1, '123', 'https://www.idealo.de/x', 'X', 2, 95.9, 'Megabad', 2, 99.9, NULL, NULL)").run(a1);
  db.prepare("INSERT INTO idealo_offers VALUES (?, 1, 'Megabad', NULL, 95.9, 0, 95.9, NULL, NULL, 0, NULL), (?, 2, 'BelKai', NULL, 94.95, 4.95, 99.9, NULL, NULL, 1, NULL)").run(a1, a1);
  db.prepare("INSERT INTO idealo_history VALUES (?, '2026-11-18', 95.9, 99.9, 1)").run(a1);
  db.prepare('UPDATE products SET idealo_on=1 WHERE id IN (?, ?)').run(a1, a2);
  setSetting(db, 'idealo_dismissed', 'Billigheimer');
  db.prepare("DELETE FROM settings WHERE key='migr_market_idealo'").run();
  db.close();

  // Neu öffnen: Übernahme läuft einmal
  db = openDb(file);
  const v = productMarket(db, a1).sources.idealo;
  assert.equal(v.selected, true);
  assert.equal(v.data.min_total, 95.9);
  assert.equal(v.data.own_rank, 2);
  assert.equal(v.data.offers_list.length, 2);
  assert.equal(v.data.history.length, 1);
  assert.equal(productMarket(db, a2).sources.idealo.selected, true);
  assert.equal(getSetting(db, 'market_dismissed'), 'Billigheimer');
  db.close();
  // Ein zweites Öffnen verdoppelt nichts
  db = openDb(file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_offers').get().n, 2);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(DatabaseSync);
});
