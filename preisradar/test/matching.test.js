import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { sitemapCandidates, slugOf } from '../src/sitemap.js';
import { closeStaleRuns } from '../src/scraper.js';

test('Sitemap-Zuordnung: Herstellernummer/EAN in der URL schlägt Namensähnlichkeit', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competitors(id, name, base_url) VALUES (7,'H','https://h.example')").run();
  const urls = [
    'https://h.example/hsk-walk-in-atelier-duschkabine-frontelement-90-cm/hs-1732090-100',
    'https://h.example/hsk-walk-in-atelier-duschkabine-frontelement-90-cm/hs-173209060',
    'https://www.h.example/hsk-walk-in-atelier-duschkabine-frontelement-90-cm/hs-173209060',
    'https://h.example/grohe-eurosmart-4006501234567',
    'https://h.example/irgendwas-1732090600',
  ];
  for (const u of urls) db.prepare('INSERT INTO sitemap_urls(competitor_id, url, slug) VALUES (7,?,?)').run(u, slugOf(u));
  const hsk = sitemapCandidates(db, 7, { name: 'HSK Walk In Atelier Duschwand-Frontelement 90 x 200cm Mattglas', manufacturer: 'HSK - Die Badexperten', mpn: '1732090-60', number: '10067-003' }, { limit: 3 });
  assert.equal(hsk[0].url, urls[1]);
  assert.equal(hsk[0].via, 'Herstellernummer');
  assert.ok(!hsk.some((c) => c.url === urls[2])); // www-Dublette entfernt
  assert.ok(!hsk.some((c) => c.url === urls[4])); // nur ganze URL-Bestandteile, nicht Teil einer längeren Zahl
  const ean = sitemapCandidates(db, 7, { name: 'Ganz anderer Name', manufacturer: 'Grohe', ean: '4006501234567' });
  assert.equal(ean[0].via, 'EAN');
});

test('Läufe: alte offene Läufe werden abgeschlossen, aktive blockieren einen neuen Lauf', () => {
  const db = openDb(':memory:');
  const old = new Date(Date.now() - 3600e3).toISOString();
  db.prepare('INSERT INTO runs(started_at, trigger, total, heartbeat) VALUES (?,?,?,?)').run(old, 'rolling', 10, old);
  assert.equal(closeStaleRuns(db), null);
  assert.equal(db.prepare('SELECT note FROM runs').get().note, 'unterbrochen');
  const fresh = new Date().toISOString();
  db.prepare('INSERT INTO runs(started_at, trigger, total, heartbeat) VALUES (?,?,?,?)').run(fresh, 'rolling', 10, fresh);
  assert.ok(closeStaleRuns(db)); // läuft noch (z. B. anderer Container)
});
