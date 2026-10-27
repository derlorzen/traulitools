import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openDb, upsertProducts } from '../src/db.js';
import { digestData, digestHtml, sendDigest, maybeSendDigest } from '../src/digest.js';
import { setSetting, initSecrets } from '../src/settings.js';

function smtp() {
  const mails = [];
  const srv = net.createServer((sock) => {
    let data = false, buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; sock.write('250 ok\r\n'); } else mails[mails.length - 1].body += line + '\n'; continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 test\r\n');
        else if (cmd === 'MAIL') { mails.push({ from: line, to: [], body: '' }); sock.write('250 ok\r\n'); }
        else if (cmd === 'RCPT') { mails[mails.length - 1].to.push(line); sock.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, mails, port: srv.address().port })));
}

test('Tägliche Zusammenfassung: Inhalt, Versand, einmal pro Tag', async () => {
  initSecrets(null);
  const db = openDb(':memory:');
  upsertProducts(db, [{ number: 'A', name: 'Armatur A', price: 100 }, { number: 'B', name: 'Brause B', price: 50 }], 'csv');
  db.prepare("INSERT INTO competitors(id, name, base_url) VALUES (1,'Rivale','https://r.example')").run();
  db.prepare("INSERT INTO matches(id, product_id, competitor_id, status, price) VALUES (1,1,1,'ok',95),(2,2,1,'ok',55)").run();
  const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  db.prepare('INSERT INTO price_history(match_id, price, at) VALUES (1,105,?),(1,95,?),(2,55,?)').run(t(48), t(2), t(30));
  const d = digestData(db);
  assert.equal(d.drops_total, 1);
  assert.equal(d.undercuts, 1); // von 105 € (über deinem Preis) auf 95 € (darunter)
  assert.equal(d.down[0].name, 'Armatur A');
  const html = digestHtml(d, 'https://app.example');
  assert.match(html, /jetzt günstiger als du/);
  assert.match(html, /Preisradar öffnen/);

  const { srv, mails, port } = await smtp();
  try {
    for (const [k, v] of Object.entries({ mail_host: '127.0.0.1', mail_port: String(port), mail_from: 'preisradar@shop.test', mail_to: 'a@shop.test, b@shop.test', mail_secure: '0', mail_hour: '0', mail_enabled: '1' })) setSetting(db, k, v);
    const r = await sendDigest(db);
    assert.match(r.subject, /1 Mitbewerber jetzt günstiger als du/);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to.length, 2);
    assert.ok(await maybeSendDigest(db)); // erster Versand des Tages
    assert.equal(await maybeSendDigest(db), null); // nicht ein zweites Mal
    assert.equal(mails.length, 2);
  } finally {
    srv.close();
  }
});
