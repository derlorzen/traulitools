import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.OWN_IMPORT_DELAY_MS = '0';
import { openDb } from '../src/db.js';
import { applyBootstrap } from '../src/server.js';

test('Bootstrap: eigene Sitemap, Import mit Limit (beobachtet), Mitbewerber anlegen, nur einmal', async () => {
  const page = (n) => `<html><body><h1>Artikel ${n}</h1><span itemprop="sku">${n}0001</span><meta property="product:price:amount" content="${n}9.90"></body></html>`;
  const srv = http.createServer((req, res) => {
    const o = `http://${req.headers.host}`;
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/sm.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<urlset>${[1, 2, 3].map((n) => `<url><loc>${o}/artikel-${n}/${n}0001/</loc></url>`).join('')}</urlset>`); }
    const m = /artikel-(\d)/.exec(req.url);
    if (m) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(m[1])); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bs-')), 'bootstrap.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'x1', own_sitemap_url: [`${base}/sm.xml`], import: { limit: 2, tracked: true }, competitors: [{ name: 'Test-Mitbewerber', base_url: base, sitemap_url: [`${base}/sm.xml`] }] }));
  const db = openDb(':memory:');
  try {
    assert.equal(await applyBootstrap(db, file), 'x1');
    const rows = db.prepare('SELECT number, tracked FROM products ORDER BY number').all();
    assert.deepEqual(rows.map((r) => [r.number, r.tracked]), [['10001', 1], ['20001', 1]]);
    assert.equal(db.prepare("SELECT sitemap_url FROM competitors WHERE name='Test-Mitbewerber'").get().sitemap_url, `${base}/sm.xml`);
    assert.equal(await applyBootstrap(db, file), null); // bereits erledigt
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM competitors').get().n, 1);
  } finally {
    srv.closeAllConnections(); srv.close();
  }
});
