import crypto from 'node:crypto';
import { getSetting, setSetting } from './settings.js';

/**
 * Google Search Console über ein Dienstkonto (nur Lesezugriff).
 * Einrichtung: Dienstkonto in Google Cloud anlegen, „Google Search Console API“ aktivieren, JSON-Schlüssel erzeugen und
 * die E-Mail-Adresse des Dienstkontos in der Search Console als Nutzer (eingeschränkt genügt) zur Property hinzufügen.
 */
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API = () => (process.env.GSC_API_BASE || 'https://www.googleapis.com/webmasters/v3').replace(/\/+$/, '');
const b64u = (b) => Buffer.from(b).toString('base64url');
const tokens = new Map(); // scope|email -> { value, exp }

export function gscConfig(db) {
  let key = null;
  const raw = getSetting(db, 'gsc_service_account');
  if (raw) { try { key = JSON.parse(raw); } catch { key = null; } }
  return { site: getSetting(db, 'gsc_site') || '', key, email: key?.client_email ?? null, configured: Boolean(key?.client_email && key?.private_key && getSetting(db, 'gsc_site')) };
}

/** Dienstkonto-JSON prüfen und verschlüsselt speichern. */
export function saveServiceAccount(db, text) {
  let k;
  try { k = JSON.parse(text); } catch { throw Object.assign(new Error('Das ist keine gültige JSON-Datei eines Dienstkontos'), { status: 400 }); }
  if (k.type !== 'service_account' || !k.client_email || !k.private_key) throw Object.assign(new Error('JSON-Schlüssel eines Dienstkontos erwartet (type „service_account“ mit client_email und private_key)'), { status: 400 });
  setSetting(db, 'gsc_service_account', JSON.stringify({ type: k.type, client_email: k.client_email, private_key: k.private_key, token_uri: k.token_uri || 'https://oauth2.googleapis.com/token' }), { secret: true });
  tokens.clear();
  return k.client_email;
}

/** Zugriffstoken für ein Dienstkonto (JWT, RS256), je Berechtigungsbereich zwischengespeichert. */
export async function googleToken(key, scope) {
  const id = `${scope}|${key.client_email}`;
  const hit = tokens.get(id);
  if (hit && hit.exp > Date.now() + 60000) return hit.value;
  const now = Math.floor(Date.now() / 1000);
  const aud = process.env.GSC_TOKEN_URL || key.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: key.client_email, scope, aud, iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key.private_key).toString('base64url');
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google-Anmeldung fehlgeschlagen: ${j.error_description || j.error || res.status}`);
  tokens.set(id, { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}
const accessToken = (cfg) => googleToken(cfg.key, SCOPE);

async function call(cfg, path, body) {
  const res = await fetch(`${API()}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${await accessToken(cfg)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j.error?.message || `HTTP ${res.status}`;
    if (res.status === 403) throw new Error(`Kein Zugriff auf die Property. Ist ${cfg.key.client_email} in der Search Console als Nutzer eingetragen? (${msg})`);
    throw new Error(`Search Console: ${msg}`);
  }
  return j;
}

/** Zugang testen: Liste der Properties, auf die das Dienstkonto zugreifen kann. */
export async function gscSites(db) {
  const cfg = gscConfig(db);
  if (!cfg.key) throw new Error('Dienstkonto-Schlüssel fehlt');
  const j = await call(cfg, '/sites');
  return (j.siteEntry ?? []).map((s) => ({ site: s.siteUrl, permission: s.permissionLevel }));
}

const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

async function query(cfg, body, max = 25000) {
  const rows = [];
  for (let start = 0; start < max; start += 5000) {
    const j = await call(cfg, `/sites/${encodeURIComponent(cfg.site)}/searchAnalytics/query`, { ...body, rowLimit: 5000, startRow: start, dataState: 'all' });
    rows.push(...(j.rows ?? []));
    if (!j.rows || j.rows.length < 5000) break;
  }
  return rows;
}

/** Seiten-URL ohne Protokoll, www und Schrägstrich am Ende (zum Zuordnen zu Artikeln). */
export const pageKey = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase(); } catch { return String(u ?? '').toLowerCase(); } };

/**
 * Daten der letzten 28 Tage (Seiten, Suchanfragen je Seite) und 90 Tage Tagesverlauf holen und speichern.
 * Search-Console-Daten sind 2–3 Tage verzögert.
 */
export async function syncGsc(db) {
  const cfg = gscConfig(db);
  if (!cfg.configured) throw new Error('Search Console ist nicht eingerichtet');
  const end = day(2), start = day(29), start90 = day(92);
  const pages = await query(cfg, { startDate: start, endDate: end, dimensions: ['page'] });
  const pq = await query(cfg, { startDate: start, endDate: end, dimensions: ['page', 'query'] }, 50000);
  const daily = await query(cfg, { startDate: start90, endDate: end, dimensions: ['date'] }, 5000);
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM seo_pages; DELETE FROM seo_queries; DELETE FROM seo_daily;');
    const ip = db.prepare('INSERT OR REPLACE INTO seo_pages(page, url, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?)');
    for (const r of pages) ip.run(pageKey(r.keys[0]), r.keys[0], r.clicks, r.impressions, r.ctr, r.position);
    // je Seite die 15 wichtigsten Suchanfragen
    const byPage = new Map();
    for (const r of pq) {
      const k = pageKey(r.keys[0]);
      if (!byPage.has(k)) byPage.set(k, []);
      byPage.get(k).push(r);
    }
    const iq = db.prepare('INSERT INTO seo_queries(page, query, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?)');
    for (const [k, list] of byPage) {
      list.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      for (const r of list.slice(0, 15)) iq.run(k, r.keys[1], r.clicks, r.impressions, r.ctr, r.position);
    }
    const id = db.prepare('INSERT INTO seo_daily(date, clicks, impressions, ctr, position) VALUES (?,?,?,?,?)');
    for (const r of daily) id.run(r.keys[0], r.clicks, r.impressions, r.ctr, r.position);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  setSetting(db, 'gsc_synced_at', now);
  setSetting(db, 'gsc_range', `${start}|${end}`);
  return { pages: pages.length, queries: pq.length, days: daily.length, range: { start, end } };
}
