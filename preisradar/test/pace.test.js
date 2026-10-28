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
