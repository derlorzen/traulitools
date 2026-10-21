import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertProducts } from '../src/db.js';
import { createApp } from '../src/server.js';

test('MCP: Token nötig, Tools lesen und ändern', async () => {
  const db = openDb(':memory:');
  upsertProducts(db, [{ number: 'A1', name: 'Hansgrohe Armatur', manufacturer: 'Hansgrohe', price: 100 }, { number: 'A2', name: 'Kludi Brause', manufacturer: 'Kludi', price: 50 }], 'csv');
  db.prepare("INSERT INTO competitors(name, base_url) VALUES ('Test','https://t.example')").run();
  db.prepare("INSERT INTO matches(product_id, competitor_id, status, price) VALUES (1,1,'ok',80)").run();
  const app = createApp(db);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const rpc = (body, headers = {}, q = '') => fetch(`${base}/mcp${q}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401); // noch kein Token
    // Token erzeugen braucht Anmeldung
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'testpasswort-123' }) });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/settings/mcp-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const { token } = await (await fetch(`${base}/api/settings/mcp-token`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })).json();
    assert.match(token, /^pr_/);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer falsch' })).status, 401);
    const auth = { authorization: `Bearer ${token}` };
    const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, auth)).json();
    assert.equal(init.result.serverInfo.name, 'preisradar');
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status, 202);
    const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, {}, `?token=${token}`)).json(); // auch per Query
    assert.ok(list.result.tools.find((t) => t.name === 'analysis_summary'));
    const call = async (name, args) => JSON.parse((await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, auth)).json()).result.content[0].text);
    assert.equal((await call('overview', {})).artikel.gesamt, 2);
    assert.equal((await call('search_products', { query: 'hans' })).artikel[0].competitors[0].price, 80);
    const rec = await call('recommendations', {});
    assert.equal(rec.artikel[0].action, 'senken');
    assert.equal((await call('get_product', { number: 'A1' })).artikel.id, 1);
    assert.equal((await call('track_products', { numbers: ['A2'], tracked: false })).artikel.beobachtet, 1);
    assert.ok((await call('analysis_summary', {})).kpi);
    const bad = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_product', arguments: { id: 99 } } }, auth)).json();
    assert.equal(bad.result.isError, true);
    // Abschalten
    await fetch(`${base}/api/settings/mcp-token`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' } });
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, auth)).status, 401);
  } finally { srv.closeAllConnections?.(); srv.close(); }
});
