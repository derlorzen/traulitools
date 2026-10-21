import crypto from 'node:crypto';

const SESSION_DAYS = 30;
const COOKIE = 'pr_session';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(req) {
  const m = /(?:^|;\s*)pr_session=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

export function createSession(db, userId, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

export function destroySession(db, req, res) {
  const t = readCookie(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(t));
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function currentUser(db, req) {
  const t = readCookie(req);
  if (!t) return null;
  return db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > ?').get(sha(t), new Date().toISOString()) ?? null;
}

export function hasUsers(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

/** Einfache Begrenzung von Anmeldeversuchen pro IP. */
const attempts = new Map();
export function tooManyAttempts(req) {
  const ip = req.ip || 'x';
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now > a.reset) {
    attempts.set(ip, { n: 1, reset: now + 15 * 60 * 1000 });
    return false;
  }
  a.n++;
  return a.n > 10;
}
export function clearAttempts(req) {
  attempts.delete(req.ip || 'x');
}
