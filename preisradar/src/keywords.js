import { getSetting, setSetting } from './settings.js';
import { pageKey } from './gsc.js';

/**
 * Keyword-Monitoring: Google-Platzierung ausgewählter Suchbegriffe (bis 200) in den ersten 50 Ergebnissen.
 * Die Suchergebnisse kommen von DataForSEO (SERP API, Standard-Warteschlange: Aufträge werden abgegeben und
 * einige Minuten später abgeholt). Google selbst wird nicht abgerufen: dessen robots.txt sperrt /search.
 * Vorschläge kommen aus der Search Console, den Bestsellern (Shopware) und optional aus DataForSEO Labs
 * (Begriffe, für die der eigene Shop bzw. die Mitbewerber ranken).
 */
export const MAX_KEYWORDS = Math.max(1, Number(process.env.MAX_KEYWORDS) || 200);
export const MAX_DEPTH = 50;
const API = () => (process.env.DATAFORSEO_API_BASE || 'https://api.dataforseo.com').replace(/\/+$/, '');
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const hostOf = (u) => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const sameSite = (domain, host) => Boolean(host) && (domain === host || domain.endsWith(`.${host}`));
export const normKeyword = (k) => String(k ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);

export function kwConfig(db) {
  const login = getSetting(db, 'dfs_login') || process.env.DATAFORSEO_LOGIN || '';
  const password = getSetting(db, 'dfs_password') || process.env.DATAFORSEO_PASSWORD || '';
  const num = (k, d, lo, hi) => { const v = Number(getSetting(db, k)); return Number.isFinite(v) && getSetting(db, k) != null ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
  return {
    login, password, configured: Boolean(login && password),
    device: getSetting(db, 'kw_device') === 'mobile' ? 'mobile' : 'desktop',
    depth: num('kw_depth', MAX_DEPTH, 10, MAX_DEPTH),
    hour: num('kw_hour', 6, 0, 23),
    everyDays: num('kw_every_days', 1, 1, 7),
    location: num('kw_location', 2276, 1, 99999999), // 2276 = Deutschland
    language: (getSetting(db, 'kw_language') || 'de').slice(0, 5),
    ownHost: ownHost(db),
  };
}

/** Eigene Domain: aus den Einstellungen, sonst aus den Artikel-URLs. */
export function ownHost(db) {
  const set = getSetting(db, 'own_url') || process.env.OWN_SHOP_URL;
  if (set) return hostOf(set);
  const u = db.prepare("SELECT url FROM products WHERE url IS NOT NULL AND url<>'' LIMIT 1").get()?.url;
  return u ? hostOf(u) : '';
}

async function call(cfg, path, body, { method = body ? 'POST' : 'GET' } = {}) {
  const res = await fetch(`${API()}${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`${cfg.login}:${cfg.password}`).toString('base64')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 || j.status_code === 40100) throw new Error('DataForSEO: Anmeldung fehlgeschlagen (API-Login und API-Passwort prüfen, nicht das Konto-Passwort)');
  if (!res.ok || (j.status_code && j.status_code >= 40000)) throw new Error(`DataForSEO: ${j.status_message || `HTTP ${res.status}`}`);
  if (j.cost) addCost(cfg.db, j.cost);
  return j;
}
function addCost(db, cost) {
  if (!db) return;
  const k = `kw_cost_${day().slice(0, 7)}`;
  setSetting(db, k, String(Math.round(((Number(getSetting(db, k)) || 0) + Number(cost)) * 10000) / 10000));
}
const withDb = (db) => ({ ...kwConfig(db), db });

/** Zugang testen: Guthaben abfragen. */
export async function kwTest(db) {
  const cfg = withDb(db);
  if (!cfg.configured) throw new Error('API-Login und API-Passwort von DataForSEO fehlen');
  const j = await call(cfg, '/v3/appendix/user_data');
  const r = j.tasks?.[0]?.result?.[0] ?? {};
  return { ok: true, balance: r.money?.balance ?? null, login: r.login ?? cfg.login };
}

// ---------- Keywords verwalten ----------
export function addKeywords(db, list, { tag = null, source = 'manual' } = {}) {
  const words = [...new Set((Array.isArray(list) ? list : String(list ?? '').split(/[\n;]+/)).map(normKeyword).filter((k) => k.length >= 2))];
  const have = db.prepare('SELECT COUNT(*) AS n FROM keywords').get().n;
  const ins = db.prepare('INSERT OR IGNORE INTO keywords(keyword, tag, source, created_at) VALUES (?,?,?,?)');
  const added = [], skipped = [];
  let n = have;
  const exists = db.prepare('SELECT 1 FROM keywords WHERE keyword=?');
  for (const k of words) {
    if (exists.get(k)) continue;
    if (n >= MAX_KEYWORDS) { skipped.push(k); continue; }
    if (ins.run(k, tag ? String(tag).trim().slice(0, 40) || null : null, source, new Date().toISOString()).changes) { added.push(k); n++; }
  }
  if (added.length) db.prepare(`DELETE FROM kw_dismissed WHERE keyword IN (${added.map(() => '?').join(',')})`).run(...added);
  const ids = added.length ? db.prepare(`SELECT id FROM keywords WHERE keyword IN (${added.map(() => '?').join(',')})`).all(...added).map((r) => r.id) : [];
  return { added: added.length, ids, duplicate: words.length - added.length - skipped.length, over_limit: skipped.length, limit: MAX_KEYWORDS, total: n };
}

// ---------- Abruf (Standard-Warteschlange) ----------
export const kwJob = { posting: false, collecting: false, lastPost: null, lastCollect: null, error: null };

/** Aufträge für die angegebenen (sonst alle fälligen) Keywords abgeben. */
export async function postChecks(db, ids = null) {
  const cfg = withDb(db);
  if (!cfg.configured) throw new Error('DataForSEO ist nicht eingerichtet');
  const pending = new Set(db.prepare('SELECT keyword_id FROM kw_tasks').all().map((r) => r.keyword_id));
  const rows = (ids ? db.prepare(`SELECT id, keyword FROM keywords WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids) : db.prepare('SELECT id, keyword FROM keywords').all())
    .filter((r) => !pending.has(r.id));
  if (!rows.length) return { posted: 0 };
  kwJob.posting = true;
  let posted = 0;
  try {
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const j = await call(cfg, '/v3/serp/google/organic/task_post', chunk.map((r) => ({
        keyword: r.keyword, location_code: cfg.location, language_code: cfg.language, device: cfg.device, depth: cfg.depth, tag: String(r.id),
      })));
      const ins = db.prepare('INSERT OR REPLACE INTO kw_tasks(task_id, keyword_id, posted_at) VALUES (?,?,?)');
      for (const t of j.tasks ?? []) {
        if (t.status_code === 20100 && t.id) { ins.run(t.id, Number(t.data?.tag), new Date().toISOString()); posted++; }
        else if (t.status_message) kwJob.error = `${t.data?.keyword ?? ''}: ${t.status_message}`;
      }
    }
    kwJob.lastPost = new Date().toISOString();
    setSetting(db, 'kw_posted_at', kwJob.lastPost);
  } finally { kwJob.posting = false; }
  return { posted };
}

/** Fertige Aufträge abholen und speichern. */
export async function collectChecks(db) {
  const cfg = withDb(db);
  if (!cfg.configured || kwJob.collecting) return { saved: 0 };
  const open = new Map(db.prepare('SELECT task_id, keyword_id, posted_at FROM kw_tasks').all().map((r) => [r.task_id, r]));
  if (!open.size) return { saved: 0 };
  kwJob.collecting = true;
  let saved = 0;
  try {
    const j = await call(cfg, '/v3/serp/google/organic/tasks_ready');
    const ready = (j.tasks?.[0]?.result ?? []).filter((t) => open.has(t.id));
    for (const t of ready) {
      const g = await call(cfg, `/v3/serp/google/organic/task_get/regular/${t.id}`);
      const task = g.tasks?.[0];
      const kwId = open.get(t.id).keyword_id;
      if (task?.status_code === 20000) { saveSerp(db, kwId, task.result?.[0]?.items ?? [], cfg); saved++; }
      db.prepare('DELETE FROM kw_tasks WHERE task_id=?').run(t.id);
    }
    // Aufträge, die nach 26 Stunden nicht fertig sind, verwerfen
    db.prepare('DELETE FROM kw_tasks WHERE posted_at < ?').run(new Date(Date.now() - 26 * 3600e3).toISOString());
    kwJob.lastCollect = new Date().toISOString();
    if (saved) kwJob.error = null;
  } finally { kwJob.collecting = false; }
  return { saved };
}

/** Ein Suchergebnis speichern: eigene Position, Mitbewerber-Positionen, die ersten 50 Treffer. */
export function saveSerp(db, keywordId, items, cfg = kwConfig(db)) {
  const organic = items.filter((x) => x.type === 'organic').map((x) => ({ rank: x.rank_group, domain: hostOf(x.domain || x.url), url: x.url, title: x.title ?? null }))
    .filter((x) => x.rank && x.rank <= cfg.depth).sort((a, b) => a.rank - b.rank);
  const own = organic.find((x) => sameSite(x.domain, cfg.ownHost));
  const comps = db.prepare('SELECT base_url FROM competitors').all().map((c) => hostOf(c.base_url)).filter(Boolean);
  const today = day();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM keyword_serp WHERE keyword_id=?').run(keywordId);
    const is = db.prepare('INSERT OR IGNORE INTO keyword_serp(keyword_id, rank, domain, url, title) VALUES (?,?,?,?,?)');
    for (const x of organic) is.run(keywordId, x.rank, x.domain, x.url, x.title);
    db.prepare('INSERT OR REPLACE INTO keyword_ranks(keyword_id, date, position, url) VALUES (?,?,?,?)').run(keywordId, today, own?.rank ?? null, own?.url ?? null);
    const ic = db.prepare('INSERT OR REPLACE INTO keyword_comp_ranks(keyword_id, date, domain, position) VALUES (?,?,?,?)');
    for (const c of comps) ic.run(keywordId, today, c, organic.find((x) => sameSite(x.domain, c))?.rank ?? null);
    db.prepare('UPDATE keywords SET last_checked=?, position=?, url=? WHERE id=?').run(new Date().toISOString(), own?.rank ?? null, own?.url ?? null, keywordId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return own?.rank ?? null;
}

/** Suchvolumen (Google Ads, monatlich) für Keywords ohne oder mit altem Wert. */
export async function refreshVolumes(db, { force = false } = {}) {
  const cfg = withDb(db);
  if (!cfg.configured) return { updated: 0 };
  const old = new Date(Date.now() - 30 * 86400e3).toISOString();
  const rows = db.prepare(`SELECT id, keyword FROM keywords ${force ? '' : 'WHERE volume_at IS NULL OR volume_at < ?'}`).all(...(force ? [] : [old]))
    .filter((r) => r.keyword.split(' ').length <= 10 && !/[^\p{L}\p{N}\s.\-+&'/]/u.test(r.keyword));
  if (!rows.length) return { updated: 0 };
  const j = await call(cfg, '/v3/keywords_data/google_ads/search_volume/live', [{ keywords: rows.map((r) => r.keyword).slice(0, 1000), location_code: cfg.location, language_code: cfg.language }]);
  const by = new Map((j.tasks?.[0]?.result ?? []).map((x) => [normKeyword(x.keyword), x]));
  const upd = db.prepare('UPDATE keywords SET volume=?, cpc=?, volume_at=? WHERE id=?');
  const now = new Date().toISOString();
  let n = 0;
  for (const r of rows) { const x = by.get(r.keyword); upd.run(x?.search_volume ?? null, x?.cpc ?? null, now, r.id); if (x) n++; }
  return { updated: n };
}

/** Labs: Begriffe, für die eine Domain in den ersten 20 rankt (nach Suchvolumen). */
async function rankedKeywords(cfg, domain, limit = 150) {
  const j = await call(cfg, '/v3/dataforseo_labs/google/ranked_keywords/live', [{
    target: domain, location_code: cfg.location, language_code: cfg.language, limit,
    filters: ['ranked_serp_element.serp_item.rank_group', '<=', 20],
    order_by: ['keyword_data.keyword_info.search_volume,desc'],
  }]);
  return (j.tasks?.[0]?.result?.[0]?.items ?? []).map((x) => ({
    keyword: normKeyword(x.keyword_data?.keyword), volume: x.keyword_data?.keyword_info?.search_volume ?? null,
    position: x.ranked_serp_element?.serp_item?.rank_group ?? null, url: x.ranked_serp_element?.serp_item?.url ?? null,
  })).filter((x) => x.keyword);
}

export const sugJob = { running: false, finishedAt: null, result: null, error: null };
/** Vorschläge aus DataForSEO Labs holen (eigener Shop und Mitbewerber). Kostet je Domain etwa 2 Cent. */
export function startSuggestionJob(db) {
  if (sugJob.running) return false;
  const cfg = withDb(db);
  Object.assign(sugJob, { running: true, result: null, error: null });
  (async () => {
    const domains = [cfg.ownHost, ...db.prepare('SELECT base_url FROM competitors WHERE enabled=1').all().map((c) => hostOf(c.base_url))].filter(Boolean).slice(0, 8);
    const out = { domains: 0, keywords: 0, warnings: [] };
    for (const d of [...new Set(domains)]) {
      try {
        const list = await rankedKeywords(cfg, d);
        const src = d === cfg.ownHost ? 'labs_own' : 'labs_comp';
        db.prepare('DELETE FROM kw_suggestions WHERE domain=?').run(d);
        const ins = db.prepare('INSERT OR REPLACE INTO kw_suggestions(keyword, source, domain, position, volume, url, fetched_at) VALUES (?,?,?,?,?,?,?)');
        for (const x of list) ins.run(x.keyword, src, d, x.position, x.volume, x.url, new Date().toISOString());
        out.domains++; out.keywords += list.length;
      } catch (e) { out.warnings.push(`${d}: ${e.message}`); }
    }
    if (!out.domains && out.warnings.length) throw new Error(out.warnings.join(' | '));
    setSetting(db, 'kw_sug_fetched_at', new Date().toISOString());
    return out;
  })().then((r) => { sugJob.result = r; }).catch((e) => { sugJob.error = e.message; })
    .finally(() => { sugJob.running = false; sugJob.finishedAt = new Date().toISOString(); });
  return true;
}

/** Bestseller-Name zu einem Suchbegriff kürzen: Hersteller + die ersten Wörter ohne Maße und Nummern. */
export function productKeyword(p) {
  const brand = String(p.manufacturer ?? '').trim();
  let name = String(p.name ?? '');
  if (brand && name.toLowerCase().startsWith(brand.toLowerCase())) name = name.slice(brand.length);
  const words = name.replace(/\([^)]*\)/g, ' ').split(/[\s,|/]+/)
    .filter((w) => w && !/\d/.test(w) && !/^(mit|und|für|in|aus|von|der|die|das|-|–)$/i.test(w));
  const k = normKeyword([brand, ...words.slice(0, 4)].filter(Boolean).join(' '));
  return k.split(' ').length >= 2 ? k : null;
}

/** Vorschläge aus allen Quellen, ohne bereits beobachtete oder verworfene Begriffe. */
export function suggestions(db, { limit = 150 } = {}) {
  const taken = new Set(db.prepare('SELECT keyword FROM keywords').all().map((r) => r.keyword.toLowerCase()));
  const dismissed = new Set(db.prepare('SELECT keyword FROM kw_dismissed').all().map((r) => r.keyword.toLowerCase()));
  const by = new Map();
  const add = (keyword, s) => {
    const k = normKeyword(keyword);
    if (!k || k.length < 3 || taken.has(k) || dismissed.has(k)) return;
    const cur = by.get(k) ?? { keyword: k, score: 0, volume: null, reasons: [], sources: new Set(), own_position: null, comps: [], gap: false, sold: 0, soldN: 0 };
    cur.score = Math.max(cur.score, s.score);
    if (s.volume != null) cur.volume = Math.max(cur.volume ?? 0, s.volume);
    if (s.own_position != null) cur.own_position = cur.own_position == null ? s.own_position : Math.min(cur.own_position, s.own_position);
    if (s.comp) { cur.comps.push(s.comp); if (s.gap) cur.gap = true; }
    else if (s.sold) { cur.sold += s.sold; cur.soldN++; }
    else if (s.reason && !cur.reasons.includes(s.reason)) cur.reasons.push(s.reason);
    cur.sources.add(s.source);
    by.set(k, cur);
  };
  // Search Console: Suchanfragen mit Impressionen, gewichtete Position
  for (const q of db.prepare(`SELECT lower(query) AS query, SUM(impressions) AS imp, SUM(clicks) AS clicks, SUM(position * impressions) / NULLIF(SUM(impressions),0) AS pos
    FROM seo_queries GROUP BY lower(query) HAVING imp >= 20 ORDER BY imp DESC LIMIT 400`).all()) {
    add(q.query, { source: 'gsc', score: q.imp, own_position: q.pos ? Math.round(q.pos) : null, reason: `Search Console: ${Math.round(q.imp)} Impressionen, Ø Platz ${(Math.round(q.pos * 10) / 10).toString().replace('.', ',')}` });
  }
  // DataForSEO Labs: eigener Shop und Mitbewerber
  const own = new Map(db.prepare("SELECT keyword, position FROM kw_suggestions WHERE source='labs_own'").all().map((r) => [r.keyword.toLowerCase(), r.position]));
  for (const r of db.prepare('SELECT * FROM kw_suggestions').all()) {
    if (r.source === 'labs_own') add(r.keyword, { source: 'labs_own', score: r.volume ?? 0, volume: r.volume, own_position: r.position, reason: `du laut DataForSEO auf Platz ${r.position}` });
    else {
      const mine = own.get(r.keyword.toLowerCase());
      add(r.keyword, { source: 'labs_comp', score: (r.volume ?? 0) * (mine == null ? 1.2 : 1), volume: r.volume, own_position: mine ?? null, comp: `${r.domain} auf Platz ${r.position}`, gap: mine == null });
    }
  }
  // Bestseller (Shopware): Hersteller + Produktbezeichnung
  for (const p of db.prepare('SELECT p.name, p.manufacturer, s.units_90, s.revenue_90 FROM product_sales s JOIN products p ON p.id=s.product_id WHERE p.active=1 AND s.units_90 > 0 ORDER BY s.revenue_90 DESC LIMIT 40').all()) {
    const k = productKeyword(p);
    if (k) add(k, { source: 'sales', score: 10 + p.units_90, sold: p.units_90 });
  }
  const order = { labs_comp: 0, labs_own: 1, gsc: 2, sales: 3 };
  return [...by.values()]
    .map(({ comps, gap, sold, soldN, ...x }) => ({
      ...x,
      reasons: [
        ...(comps.length ? [`${comps.join(', ')}${gap ? '; du nicht unter den ersten 20' : ''}`] : []),
        ...x.reasons,
        ...(soldN ? [`Bestseller: ${soldN > 1 ? `${soldN} Artikel, zusammen ` : ''}${sold} verkauft (90 Tage)`] : []),
      ],
      sources: [...x.sources].sort((a, b) => order[a] - order[b]),
    }))
    // mit Suchvolumen zuerst nach Volumen, sonst nach Impressionen; Bestseller ans Ende ihrer Gruppe
    .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || b.score - a.score)
    .slice(0, limit);
}

// ---------- Auswertung ----------
export function kwOverview(db) {
  const cfg = kwConfig(db);
  const kws = db.prepare('SELECT * FROM keywords ORDER BY keyword').all();
  const since = day(new Date(Date.now() - 90 * 86400e3));
  const hist = new Map();
  for (const r of db.prepare('SELECT keyword_id, date, position FROM keyword_ranks WHERE date >= ? ORDER BY date').all(since)) {
    if (!hist.has(r.keyword_id)) hist.set(r.keyword_id, []);
    hist.get(r.keyword_id).push({ d: r.date, p: r.position });
  }
  const lastComp = new Map();
  for (const r of db.prepare(`SELECT c.keyword_id, c.domain, c.position FROM keyword_comp_ranks c
    JOIN (SELECT keyword_id, MAX(date) AS d FROM keyword_comp_ranks GROUP BY keyword_id) m ON m.keyword_id=c.keyword_id AND m.d=c.date`).all()) {
    if (!lastComp.has(r.keyword_id)) lastComp.set(r.keyword_id, []);
    lastComp.get(r.keyword_id).push({ domain: r.domain, position: r.position });
  }
  const gsc = new Map(db.prepare(`SELECT lower(query) AS q, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(position * impressions) / NULLIF(SUM(impressions),0) AS position FROM seo_queries GROUP BY lower(query)`).all().map((r) => [r.q, r]));
  const prodByPage = new Map(db.prepare("SELECT id, name, url FROM products WHERE url IS NOT NULL AND url<>''").all().map((p) => [pageKey(p.url), p]));
  const pending = new Set(db.prepare('SELECT keyword_id FROM kw_tasks').all().map((r) => r.keyword_id));
  const at = (h, daysAgo) => {
    // Position am Stichtag (letzter Wert an oder vor dem Tag)
    const cut = day(new Date(Date.now() - daysAgo * 86400e3));
    const prev = h.filter((x) => x.d <= cut);
    return prev.length ? prev[prev.length - 1] : null;
  };
  const rows = kws.map((k) => {
    const h = hist.get(k.id) ?? [];
    const last = h[h.length - 1] ?? null;
    const before = h.length > 1 ? h[h.length - 2] : null;
    const week = at(h, 7);
    const comps = (lastComp.get(k.id) ?? []).sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
    const g = gsc.get(k.keyword.toLowerCase());
    const prod = k.url ? prodByPage.get(pageKey(k.url)) : null;
    const delta = (from) => (from && last && from !== last ? (from.p ?? MAX_DEPTH + 1) - (last.p ?? MAX_DEPTH + 1) : null); // positiv = verbessert
    return {
      id: k.id, keyword: k.keyword, tag: k.tag, source: k.source, volume: k.volume, cpc: k.cpc,
      position: k.last_checked ? k.position : undefined, url: k.url, last_checked: k.last_checked, pending: pending.has(k.id),
      change1: delta(before), change7: week && week !== last ? delta(week) : null,
      best: h.reduce((b, x) => (x.p != null && (b == null || x.p < b) ? x.p : b), null),
      history: h.slice(-30),
      comps, better: comps.filter((c) => c.position != null && (k.position == null || c.position < k.position)).length,
      gsc: g ? { impressions: g.impressions, clicks: g.clicks, position: Math.round(g.position * 10) / 10 } : null,
      product: prod ? { id: prod.id, name: prod.name } : null,
    };
  });
  const checked = rows.filter((r) => r.position !== undefined);
  const inTop = (n) => checked.filter((r) => r.position != null && r.position <= n).length;
  const vis = checked.reduce((s, r) => s + (r.position != null ? ctrAt(r.position) * (r.volume ?? 0) : 0), 0);
  return {
    configured: cfg.configured, limit: MAX_KEYWORDS, depth: cfg.depth, device: cfg.device, own_host: cfg.ownHost,
    every_days: cfg.everyDays, hour: cfg.hour,
    cost_month: Number(getSetting(db, `kw_cost_${day().slice(0, 7)}`)) || 0,
    est_month: Math.round(kws.length * Math.ceil(cfg.depth / 10) * 0.0006 * (30 / cfg.everyDays) * 100) / 100,
    posted_at: getSetting(db, 'kw_posted_at'), pending: pending.size, error: kwJob.error,
    sug: { running: sugJob.running, error: sugJob.error, result: sugJob.result, fetched_at: getSetting(db, 'kw_sug_fetched_at') },
    summary: {
      count: rows.length, checked: checked.length, top3: inTop(3), top10: inTop(10), top20: inTop(20), top50: inTop(cfg.depth), out: checked.filter((r) => r.position == null).length,
      avg: (() => { const p = checked.filter((r) => r.position != null); return p.length ? Math.round((p.reduce((s, r) => s + r.position, 0) / p.length) * 10) / 10 : null; })(),
      up: rows.filter((r) => r.change1 > 0).length, down: rows.filter((r) => r.change1 < 0).length,
      clicks_est: Math.round(vis), // geschätzte Klicks pro Monat aus Suchvolumen × üblicher Klickrate
    },
    trend: trend(db),
    tags: [...new Set(kws.map((k) => k.tag).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')),
    competitors: [...new Set(db.prepare('SELECT base_url FROM competitors').all().map((c) => hostOf(c.base_url)).filter(Boolean))],
    keywords: rows,
  };
}
const CTR = [0.2, 0.12, 0.08, 0.06, 0.045, 0.035, 0.028, 0.022, 0.018, 0.015];
const ctrAt = (p) => (p <= 10 ? CTR[p - 1] : p <= 20 ? 0.01 : 0.003);

/** Verlauf: Anteil Top 3 / Top 10 / Top 50 und Ø Position je Tag (nur Keywords, die an dem Tag geprüft wurden). */
function trend(db) {
  return db.prepare(`SELECT date, COUNT(*) AS n, SUM(position <= 3) AS top3, SUM(position <= 10) AS top10, SUM(position IS NOT NULL) AS found, AVG(position) AS avg
    FROM keyword_ranks WHERE date >= ? GROUP BY date ORDER BY date`).all(day(new Date(Date.now() - 90 * 86400e3)))
    .map((r) => ({ date: r.date, n: r.n, top3: r.top3, top10: r.top10, found: r.found, avg: r.avg ? Math.round(r.avg * 10) / 10 : null }));
}

/** Einzelnes Keyword: letzte Suchergebnisse (bis Platz 50) und Verlauf mit Mitbewerbern. */
export function kwDetail(db, id) {
  const k = db.prepare('SELECT * FROM keywords WHERE id=?').get(id);
  if (!k) return null;
  const cfg = kwConfig(db);
  const comps = new Set(db.prepare('SELECT base_url FROM competitors').all().map((c) => hostOf(c.base_url)).filter(Boolean));
  const serp = db.prepare('SELECT rank, domain, url, title FROM keyword_serp WHERE keyword_id=? ORDER BY rank').all(id)
    .map((r) => ({ ...r, own: sameSite(r.domain, cfg.ownHost), competitor: [...comps].some((c) => sameSite(r.domain, c)) }));
  const since = day(new Date(Date.now() - 180 * 86400e3));
  return {
    keyword: k,
    serp,
    history: db.prepare('SELECT date, position, url FROM keyword_ranks WHERE keyword_id=? AND date >= ? ORDER BY date').all(id, since),
    comp_history: db.prepare('SELECT date, domain, position FROM keyword_comp_ranks WHERE keyword_id=? AND date >= ? ORDER BY date').all(id, since),
  };
}

/** Planer: täglich (bzw. alle x Tage) ab der eingestellten Stunde abgeben, laufend abholen, Suchvolumen monatlich. */
let lastCollectTry = 0;
export function kwTick(db) {
  const cfg = kwConfig(db);
  if (!cfg.configured) return;
  const now = new Date();
  const last = Date.parse(getSetting(db, 'kw_posted_at') || 0) || 0;
  const tried = Date.parse(getSetting(db, 'kw_tried_at') || 0) || 0;
  const due = now.getHours() >= cfg.hour && day(new Date(last)) <= day(new Date(now.getTime() - cfg.everyDays * 86400e3)) && Date.now() - tried > 3 * 3600e3;
  if (due && !kwJob.posting && db.prepare('SELECT COUNT(*) AS n FROM keywords').get().n) {
    setSetting(db, 'kw_tried_at', now.toISOString());
    postChecks(db).then(() => refreshVolumes(db)).catch((e) => { kwJob.error = e.message; console.error('Keywords:', e.message); });
  }
  // fertige Aufträge jede Minute abholen (tasks_ready: höchstens 20 Aufrufe je Minute)
  if (Date.now() - lastCollectTry > 60000 && db.prepare('SELECT 1 FROM kw_tasks LIMIT 1').get()) {
    lastCollectTry = Date.now();
    collectChecks(db).catch((e) => { kwJob.error = e.message; console.error('Keywords abholen:', e.message); });
  }
}
