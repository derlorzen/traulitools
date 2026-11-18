import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { eco, refreshEco } from '../src/eco.js';
import { pacingMs } from '../src/fetcher.js';
import { setSetting } from '../src/settings.js';

test('Sparmodus: bei Datei-Datenbank einmalig an, abschaltbar, bremst das Tempo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-eco-'));
  const file = path.join(dir, 'x.db');
  let db = openDb(file);
  assert.equal(refreshEco(db), true, 'bestehende Installation: Sparmodus an');
  setSetting(db, 'eco_mode', '0');
  db.close();
  db = openDb(file);
  assert.equal(refreshEco(db), false, 'abgeschaltet bleibt abgeschaltet');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(refreshEco(openDb(':memory:')), false, 'Tests und neue Speicher-Datenbanken: aus');

  const url = 'https://eco-test.example/p/1';
  eco.on = false;
  assert.equal(pacingMs(url, 2000), 2000);
  eco.on = true;
  assert.equal(pacingMs(url, 2000), 3000, '1,5-facher Abstand');
  eco.on = false;
});
