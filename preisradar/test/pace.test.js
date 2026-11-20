import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { robotsAllows, pacingMs, notePace, paceInfo, clearRobotsCache, fetchText } from '../src/fetcher.js';

test('Tempo je Shop: Crawl-delay, Bremse bei 429, Erholung', async (t) => {
  let busy = true;
  const srv = http.createServer((req, res) => {
    if (req.url === '/robots.txt') return res.end('User-agent: *\nCrawl-delay: 4\nDisallow: /intern/');
    if (req.url === '/p' && busy) { res.statusCode = 429; res.setHeader('retry-after', '2'); return res.end('zu viele'); }
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  clearRobotsCache();
  const url = `http://127.0.0.1:${srv.address().port}/p`;
  assert.equal(await robotsAllows(url), true);
  assert.equal(paceInfo(url).crawl_delay_s, 4);
  assert.equal(pacingMs(url, 1000), 4000); // robots.txt verlangt mehr als eingestellt
  assert.equal(pacingMs(url, 6000), 6000);
  await fetchText(url); // 429 mit Retry-After
  assert.equal(paceInfo(url).factor, 2);
  assert.ok(pacingMs(url, 1000) >= 8000);
  busy = false;
  for (let i = 0; i < 10; i++) notePace(url);
  assert.equal(paceInfo(url).factor, 1);
});

test('Bot-Schutz: Cloudflare-Challenge erkennen und Mitbewerber nach mehreren Treffern pausieren', async () => {
  const { botWall } = await import('../src/fetcher.js');
  const { noteBotWall, BOT_WALL_LIMIT } = await import('../src/scraper.js');
  const { openDb } = await import('../src/db.js');
  const { analyse } = await import('../src/analysis.js');
  const hdr = (o = {}) => ({ get: (k) => o[k] ?? null });
  assert.equal(botWall({ status: 403, headers: hdr({ 'cf-mitigated': 'challenge' }) }, ''), 'Cloudflare');
  assert.equal(botWall({ status: 403, headers: hdr() }, '<html><title>Just a moment...</title>'), 'Cloudflare');
  assert.equal(botWall({ status: 403, headers: hdr() }, '<html>Zugriff verweigert</html>'), null);
  assert.equal(botWall({ status: 200, headers: hdr() }, 'challenge-platform'), null);
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competitors(name, base_url, enabled) VALUES ('SSD','https://ssd.test',1)").run();
  const comp = db.prepare('SELECT * FROM competitors').get();
  for (let i = 1; i < BOT_WALL_LIMIT; i++) assert.equal(noteBotWall(db, comp, { error: true, botWall: 'Cloudflare' }), false);
  noteBotWall(db, comp, { found: true }); // ein Erfolg zwischendurch setzt zurück
  for (let i = 1; i < BOT_WALL_LIMIT; i++) noteBotWall(db, comp, { error: true, botWall: 'Cloudflare' });
  assert.equal(db.prepare('SELECT enabled FROM competitors').get().enabled, 1);
  assert.equal(noteBotWall(db, comp, { error: true, botWall: 'Cloudflare' }), true);
  assert.equal(db.prepare('SELECT enabled FROM competitors').get().enabled, 0);
  assert.match(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='comp_paused_1'").get().value).wall, /Cloudflare/);
  assert.ok(analyse(db).hints.some((x) => /SSD ist pausiert/.test(x.text)));
});
