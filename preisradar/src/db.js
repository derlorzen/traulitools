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
  tracked INTEGER NOT NULL DEFAULT 1,
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
  ai_mode TEXT NOT NULL DEFAULT 'fallback',
  sitemap_url TEXT,
  sitemap_fetched_at TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sitemap_urls (
  competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  slug TEXT NOT NULL,
  PRIMARY KEY (competitor_id, url)
);
CREATE TABLE IF NOT EXISTS own_sitemap_urls (
  url TEXT PRIMARY KEY,
  slug TEXT NOT NULL
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
  ai_note TEXT,
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
CREATE TABLE IF NOT EXISTS ai_reports (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  model TEXT,
  product_count INTEGER,
  analysed INTEGER,
  result TEXT NOT NULL,
  usage TEXT
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
  // Migration für bestehende Datenbanken
  if (!db.prepare('PRAGMA table_info(competitors)').all().some((c) => c.name === 'ai_mode')) db.exec("ALTER TABLE competitors ADD COLUMN ai_mode TEXT NOT NULL DEFAULT 'fallback'");
  if (!db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'tracked')) db.exec('ALTER TABLE products ADD COLUMN tracked INTEGER NOT NULL DEFAULT 1');
  const compCols = db.prepare('PRAGMA table_info(competitors)').all().map((c) => c.name);
  if (!compCols.includes('sitemap_url')) db.exec('ALTER TABLE competitors ADD COLUMN sitemap_url TEXT');
  if (!compCols.includes('sitemap_fetched_at')) db.exec('ALTER TABLE competitors ADD COLUMN sitemap_fetched_at TEXT');
  if (!db.prepare('PRAGMA table_info(matches)').all().some((c) => c.name === 'ai_note')) db.exec('ALTER TABLE matches ADD COLUMN ai_note TEXT');
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
/** tracked: gilt nur für neu angelegte Artikel (beobachtet = wird bei Mitbewerbern abgeglichen). */
export function upsertProducts(db, rows, source, { tracked = true } = {}) {
  const now = new Date().toISOString();
  const sel = db.prepare('SELECT id, price FROM products WHERE number = ?');
  const ins = db.prepare(
    'INSERT INTO products(number, ean, mpn, name, manufacturer, url, price, active, source, updated_at, tracked) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
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
        const res = ins.run(r.number, vals[0], vals[1], r.name, vals[3], vals[4], price, active, source, now, tracked ? 1 : 0);
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
