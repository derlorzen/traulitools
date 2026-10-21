import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let key = null;

/**
 * Schlüssel zum Verschlüsseln gespeicherter Zugangsdaten (z. B. Shopware-Secret).
 * Reihenfolge: SECRET_KEY aus der Umgebung, sonst Datei secret.key neben der Datenbank (wird angelegt).
 * Ohne dataDir (Tests) nur für die Laufzeit.
 */
export function initSecrets(dataDir) {
  if (process.env.SECRET_KEY) {
    key = crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
    return;
  }
  if (!dataDir) {
    key = crypto.randomBytes(32);
    return;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) {
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  } else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  }
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(stored) {
  try {
    const buf = Buffer.from(stored.slice(4), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return ''; // Schlüssel passt nicht mehr -> Wert gilt als nicht gesetzt
  }
}

export function getSetting(db, name) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(name);
  if (!row) return null;
  return row.value.startsWith('enc:') ? decrypt(row.value) : row.value;
}

export function setSetting(db, name, value, { secret = false } = {}) {
  if (value == null || value === '') {
    db.prepare('DELETE FROM settings WHERE key=?').run(name);
    return;
  }
  db.prepare('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, secret ? encrypt(String(value)) : String(value));
}

export function hasSetting(db, name) {
  return Boolean(db.prepare('SELECT 1 FROM settings WHERE key=?').get(name));
}
