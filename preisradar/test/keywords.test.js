import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, upsertProducts } from '../src/db.js';
import { setSetting, initSecrets } from '../src/settings.js';

// Nachgebautes DataForSEO
const posted = [];
let ownRank = 7;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = body ? JSON.parse(body) : null;
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status_code: 20000, cost: 0.003, ...o })); };
    if (req.headers.authorization !== `Basic ${Buffer.from('api@test:pw').toString('base64')}`) { res.statusCode = 401; return res.end('{"status_code":40100}'); }
    if (req.url === '/v3/appendix/user_data') return send({ tasks: [{ result: [{ login: 'api@test', money: { balance: 12.5 } }] }] });
    if (req.url === '/v3/serp/google/organic/task_post') { posted.push(...j); return send({ tasks: j.map((t) => ({ id: `t-${t.tag}`, status_code: 20100, data: t })) }); }
    if (req.url === '/v3/serp/google/organic/tasks_ready') return send({ tasks: [{ result: posted.map((t) => ({ id: `t-${t.tag}`, tag: t.tag })) }] });
    const m = /task_get\/regular\/t-(\d+)/.exec(req.url);
    if (m) {
      const items = Array.from({ length: 50 }, (_, i) => ({ type: 'organic', rank_group: i + 1, domain: i + 1 === ownRank ? 'www.belkai.de' : i === 1 ? 'www.unidomo.de' : `shop${i}.test`, url: i + 1 === ownRank ? 'https://www.belkai.de/p/a1/' : `https://x${i}.test/`, title: `T${i}` }));
      items.splice(3, 0, { type: 'paid', rank_group: 1, domain: 'ads.test' });
      return send({ tasks: [{ status_code: 20000, result: [{ items }] }] });
    }
    if (req.url === '/v3/keywords_data/google_ads/search_volume/live') return send({ tasks: [{ result: j[0].keywords.map((k, i) => ({ keyword: k, search_volume: 1000 - i * 100, cpc: 0.5 })) }] });
    if (req.url === '/v3/dataforseo_labs/google/ranked_keywords/live') return send({ tasks: [{ result: [{ items: [{ keyword_data: { keyword: j[0].target === 'unidomo.de' ? 'regendusche set' : 'thermostat armatur', keyword_info: { search_volume: 2400 } }, ranked_serp_element: { serp_item: { rank_group: 3, url: 'https://u.test/x' } } }] }] }] });
    res.statusCode = 404; res.end('{}');
  });
});

test('Keyword-Monitoring: anlegen, abrufen, auswerten, Vorschläge', async (t) => {
  t.after(() => srv.close());
  await new Promise((r) => srv.listen(0, r));
  process.env.DATAFORSEO_API_BASE = `http://127.0.0.1:${srv.address().port}`;
  process.env.MAX_KEYWORDS = '5';
  const kw = await import(`../src/keywords.js?x=${Date.now()}`);
  process.env.SECRET_KEY ||= 'test-schluessel-test-schluessel-1234';
  initSecrets(null);
  const db = openDb(':memory:');
  upsertProducts(db, [{ number: 'A1', name: 'Hansgrohe Talis E Waschtischarmatur 110 chrom', manufacturer: 'Hansgrohe', price: 99, url: 'https://www.belkai.de/p/a1/' }], 'csv');
  db.prepare("INSERT INTO competitors(name, base_url) VALUES ('unidomo','https://www.unidomo.de')").run();
  db.prepare("INSERT INTO seo_queries(page, query, clicks, impressions, ctr, position) VALUES ('belkai.de/p/a1','Talis E 110',4,300,0.013,9.2),('belkai.de/p/a1','hansgrohe armatur',1,50,0.02,14)").run();
  db.prepare('INSERT INTO product_sales(product_id, units_30, revenue_30, units_90, revenue_90) VALUES (1,2,200,6,600)').run();
  setSetting(db, 'dfs_login', 'api@test');
  setSetting(db, 'dfs_password', 'pw', { secret: true });

  assert.equal((await kw.kwTest(db)).balance, 12.5);
  const add = kw.addKeywords(db, 'Talis E 110\nhansgrohe armatur\nTALIS e 110\nx\nwaschtisch armatur\nregendusche\nbadarmatur\nzu viel', { tag: 'Armaturen' });
  assert.equal(add.added, 5);
  assert.equal(add.over_limit, 1);
  assert.equal(add.duplicate, 0); // „x“ ist zu kurz, „TALIS e 110“ wird schon in der Eingabe zusammengefasst
  assert.equal(kw.addKeywords(db, 'talis e 110').duplicate, 1);
  assert.equal(kw.addKeywords(db, 'ganz neu').over_limit, 1);

  const p = await kw.postChecks(db);
  assert.equal(p.posted, 5);
  assert.equal(posted[0].depth, 50);
  assert.equal(posted[0].location_code, 2276);
  assert.equal((await kw.postChecks(db)).posted, 0); // nichts doppelt abgeben, solange Aufträge offen sind
  const c = await kw.collectChecks(db);
  assert.equal(c.saved, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kw_tasks').get().n, 0);
  await kw.refreshVolumes(db);

  let o = kw.kwOverview(db);
  const talis = o.keywords.find((k) => k.keyword === 'talis e 110');
  assert.equal(talis.position, 7); // Anzeigen zählen nicht
  assert.equal(talis.product.name, 'Hansgrohe Talis E Waschtischarmatur 110 chrom');
  assert.equal(talis.better, 1); // unidomo auf Platz 2
  assert.equal(talis.gsc.position, 9.2);
  assert.ok(talis.volume > 0);
  assert.equal(o.summary.top10, 5);
  assert.ok(o.cost_month > 0);

  // zweiter Tag: Platz 3 → Veränderung +4
  db.prepare('UPDATE keyword_ranks SET date=?').run(new Date(Date.now() - 86400e3).toISOString().slice(0, 10));
  ownRank = 3;
  posted.length = 0;
  await kw.postChecks(db);
  await kw.collectChecks(db);
  o = kw.kwOverview(db);
  assert.equal(o.keywords.find((k) => k.keyword === 'talis e 110').change1, 4);
  assert.equal(o.summary.up, 5);

  const d = kw.kwDetail(db, talis.id);
  assert.equal(d.serp.length, 50);
  assert.ok(d.serp.find((r) => r.rank === 3).own);
  assert.ok(d.serp.find((r) => r.rank === 2).competitor);

  // Vorschläge: Search Console (ohne bereits beobachtete), Labs, Bestseller
  db.prepare('DELETE FROM keywords WHERE keyword=?').run('hansgrohe armatur');
  kw.startSuggestionJob(db);
  while (kw.sugJob.running) await new Promise((r) => setTimeout(r, 20));
  const s = kw.suggestions(db);
  const ks = s.map((x) => x.keyword);
  assert.ok(ks.includes('hansgrohe armatur'));
  assert.ok(!ks.includes('talis e 110'));
  assert.ok(ks.includes('regendusche set'));
  assert.match(s.find((x) => x.keyword === 'regendusche set').reasons[0], /unidomo\.de auf Platz 3; du nicht/);
  assert.ok(ks.includes('hansgrohe talis e waschtischarmatur chrom'));
  db.prepare("INSERT INTO kw_dismissed(keyword) VALUES ('regendusche set')").run();
  assert.ok(!kw.suggestions(db).some((x) => x.keyword === 'regendusche set'));
  srv.close();
});
