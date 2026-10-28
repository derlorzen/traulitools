const UA =
  process.env.SCRAPER_USER_AGENT ||
  'Mozilla/5.0 (compatible; PreisradarBot/1.0; +Preisvergleich fuer den eigenen Shop)';

const robotsCache = new Map(); // host -> { at, rules }
const ROBOTS_TTL = 6 * 3600 * 1000;

export async function fetchText(url, { timeout = 20000, headers = {}, raw = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'de-DE,de;q=0.9,en;q=0.5',
        ...headers,
      },
    });
    const buf = raw ? Buffer.from(await res.arrayBuffer()) : null;
    const text = raw ? '' : await res.text();
    if (res.status === 429 || res.status === 503) notePace(url, { status: res.status, retryAfter: res.headers.get('retry-after') });
    return { status: res.status, text, buf, finalUrl: res.url || url, contentType: res.headers.get('content-type') || '' };
  } catch (e) {
    if (e.name === 'AbortError') { notePace(url, { error: true }); throw new Error('Zeitüberschreitung beim Abruf'); }
    throw new Error(`Abruf fehlgeschlagen: ${e.cause?.code || e.message}`);
  } finally {
    clearTimeout(t);
  }
}

function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else if (key === 'crawl-delay' && cur) {
      const n = Number(val.replace(',', '.'));
      if (Number.isFinite(n) && n > 0) cur.crawlDelay = Math.min(n, 120);
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && 'preisradarbot'.includes(a)));
  const star = groups.find((g) => g.agents.includes('*'));
  const g = mine || star;
  return { rules: g?.rules ?? [], crawlDelay: g?.crawlDelay ?? 0 };
}

function ruleMatches(path, pattern) {
  if (!pattern) return false;
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'),
  );
  return re.test(path);
}

/** Respektiert robots.txt: true = Abruf erlaubt. */
export async function robotsAllows(url) {
  const u = new URL(url);
  let entry = robotsCache.get(u.host);
  if (!entry || Date.now() - entry.at > ROBOTS_TTL) {
    let parsed = { rules: [], crawlDelay: 0 };
    try {
      const r = await fetchText(`${u.protocol}//${u.host}/robots.txt`, { timeout: 10000 });
      if (r.status === 200 && !/html/i.test(r.contentType)) parsed = parseRobots(r.text);
    } catch {
      /* robots.txt nicht erreichbar -> erlaubt */
    }
    entry = { at: Date.now(), ...parsed };
    robotsCache.set(u.host, entry);
  }
  const target = u.pathname + u.search;
  let best = null;
  for (const r of entry.rules) {
    if (ruleMatches(target, r.path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

export function clearRobotsCache() {
  robotsCache.clear();
  pace.clear();
}

/*
 * Tempo je Shop: Mindestabstand ist der eingestellte Abstand, aber nie weniger als der Crawl-delay aus der
 * robots.txt. Antwortet ein Shop mit 429/503 oder gar nicht, wird der Abstand verdoppelt (bis 16-fach) und ein
 * Retry-After beachtet; danach nähert er sich mit jedem erfolgreichen Abruf wieder dem eingestellten Wert.
 */
const pace = new Map(); // host -> { factor, until, ok, slow, speed, streak }
const FAST_MS = 1500; // Antwortzeit, unter der ein Shop als entspannt gilt
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
export function crawlDelayMs(url) { return (robotsCache.get(hostOf(url))?.crawlDelay ?? 0) * 1000; }
/*
 * Automatisches Tempo: Antwortet ein Shop 20-mal hintereinander schnell und ohne Ablehnung, wird der Abstand um
 * 10 % kürzer, höchstens bis auf die Hälfte des eingestellten Werts und nie unter 1,5 Sekunden (und nie unter dem
 * Crawl-delay). Bei der ersten Ablehnung oder Zeitüberschreitung gilt sofort wieder der eingestellte Abstand plus Bremse.
 */
export function pacingMs(url, baseMs) {
  const p = pace.get(hostOf(url));
  const floor = Math.min(baseMs, Math.max(1500, baseMs * 0.5));
  const base = Math.max(Math.max(floor, baseMs * (p?.speed ?? 1)), crawlDelayMs(url));
  const wait = p?.until && p.until > Date.now() ? p.until - Date.now() : 0;
  return Math.round(Math.max(base * (p?.factor ?? 1), wait));
}
export function notePace(url, { status = 200, error = false, retryAfter = null, ms = null } = {}) {
  const h = hostOf(url);
  const p = pace.get(h) ?? { factor: 1, until: 0, ok: 0, slow: 0, speed: 1, streak: 0 };
  if (error || status === 429 || status === 503) {
    p.factor = Math.min(16, p.factor * 2);
    p.speed = 1; p.streak = 0;
    p.slow++;
    const ra = Number(retryAfter);
    if (Number.isFinite(ra) && ra > 0) p.until = Date.now() + Math.min(ra, 600) * 1000;
  } else {
    p.ok++;
    p.factor = Math.max(1, p.factor * 0.85);
    if (ms != null && ms < FAST_MS && p.factor === 1) {
      if (++p.streak >= 20) { p.speed = Math.max(0.5, p.speed * 0.9); p.streak = 0; }
    } else if (ms != null && ms >= FAST_MS * 2) { p.speed = Math.min(1, p.speed / 0.9); p.streak = 0; } // langsamer Shop: wieder vorsichtiger
  }
  pace.set(h, p);
}
export function paceInfo(url, baseMs = null) {
  const p = pace.get(hostOf(url));
  return { factor: Math.round((p?.factor ?? 1) * 10) / 10, speed: Math.round((p?.speed ?? 1) * 100) / 100, slowdowns: p?.slow ?? 0, crawl_delay_s: crawlDelayMs(url) / 1000, effective_ms: baseMs != null ? pacingMs(url, baseMs) : null };
}
