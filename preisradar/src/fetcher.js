const UA =
  process.env.SCRAPER_USER_AGENT ||
  'Mozilla/5.0 (compatible; PreisradarBot/1.0; +Preisvergleich fuer den eigenen Shop)';

const robotsCache = new Map(); // host -> { at, rules }
const ROBOTS_TTL = 6 * 3600 * 1000;

export async function fetchText(url, { timeout = 20000, headers = {} } = {}) {
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
    const text = await res.text();
    return { status: res.status, text, finalUrl: res.url || url, contentType: res.headers.get('content-type') || '' };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Zeitüberschreitung beim Abruf');
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
    } else lastWasAgent = false;
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && 'preisradarbot'.includes(a)));
  const star = groups.find((g) => g.agents.includes('*'));
  return (mine || star)?.rules ?? [];
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
    let rules = [];
    try {
      const r = await fetchText(`${u.protocol}//${u.host}/robots.txt`, { timeout: 10000 });
      if (r.status === 200 && !/html/i.test(r.contentType)) rules = parseRobots(r.text);
    } catch {
      /* robots.txt nicht erreichbar -> erlaubt */
    }
    entry = { at: Date.now(), rules };
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
}
