import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  ean TEXT,
  mpn TEXT,
  name TEXT NOT NULL,
  manufacturer TEXT,
  url TEXT,
  price REAL,
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS product_price_history (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS competitors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  search_url TEXT,
  result_selector TEXT,
  price_selector TEXT,
  delay_ms INTEGER NOT NULL DEFAULT 3000,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  url TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'pending',
  price REAL,
  title TEXT,
  availability TEXT,
  last_checked TEXT,
  last_error TEXT,
  UNIQUE(product_id, competitor_id)
);
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_match ON price_history(match_id, at);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT,
  total INTEGER DEFAULT 0,
  checked INTEGER DEFAULT 0,
  found INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  note TEXT
);
`;

export function openDb(file = process.env.DB_PATH || './data/preisradar.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const nz = (v) => (v === undefined || v === '' ? null : v);

/** Eigene Produkte anlegen/aktualisieren (Schlüssel: Artikelnummer). */
export function upsertProducts(db, rows, source) {
  const now = new Date().toISOString();
  const sel = db.prepare('SELECT id, price FROM products WHERE number = ?');
  const ins = db.prepare(
    'INSERT INTO products(number, ean, mpn, name, manufacturer, url, price, active, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  const upd = db.prepare(
    'UPDATE products SET ean=?, mpn=?, name=?, manufacturer=?, url=COALESCE(?, url), price=?, active=?, source=?, updated_at=? WHERE id=?',
  );
  const hist = db.prepare('INSERT INTO product_price_history(product_id, price, at) VALUES (?,?,?)');
  let created = 0;
  let updated = 0;
  tx(db, () => {
    for (const r of rows) {
      const cur = sel.get(r.number);
      const vals = [nz(r.ean), nz(r.mpn), r.name, nz(r.manufacturer), nz(r.url)];
      const price = r.price ?? null;
      const active = r.active === false ? 0 : 1;
      if (!cur) {
        const res = ins.run(r.number, vals[0], vals[1], r.name, vals[3], vals[4], price, active, source, now);
        if (price != null) hist.run(res.lastInsertRowid, price, now);
        created++;
      } else {
        upd.run(vals[0], vals[1], r.name, vals[3], vals[4], price, active, source, now, cur.id);
        if (price != null && price !== cur.price) hist.run(cur.id, price, now);
        updated++;
      }
    }
  });
  return { created, updated };
}
