import { fetchText, robotsAllows } from './fetcher.js';
import { extractProduct, findCandidates } from './extract.js';
import { normId, sleep, tokens, jaccard } from './util.js';

export const scrapeState = {
  running: false,
  stop: false,
  runId: null,
  trigger: null,
  total: 0,
  done: 0,
  found: 0,
  errors: 0,
  startedAt: null,
  current: null,
};

const HOUR = 3600 * 1000;
const MIN_INTERVAL_H = Number(process.env.MIN_INTERVAL_HOURS || 10);
const MAX_PAGES_PER_ITEM = 6;

/** Wie sicher passt die Seite zum eigenen Produkt? 'match' | 'maybe' | 'no' */
export function verify(product, ext) {
  const ean = normId(product.ean);
  const idCands = [normId(product.mpn), normId(product.number)].filter((x) => x.length >= 5);
  if (ean.length >= 8 && (ext.ids.has(ean) || ext.headText.includes(ean))) return 'match';
  for (const id of idCands) {
    if (ext.ids.has(id) || ext.headText.includes(id)) return 'match';
  }
  if (ean.length >= 8 && ext.bodyText.includes(ean)) return 'maybe';
  for (const id of idCands) if (ext.bodyText.includes(id)) return 'maybe';
  const sim = jaccard(tokens(product.name), tokens(ext.title));
  return sim >= 0.6 ? 'maybe' : 'no';
}

function updateMatch(db, id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE matches SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => fields[k] ?? null), id);
}

function recordPrice(db, matchId, price, now) {
  const last = db.prepare('SELECT price, at FROM price_history WHERE match_id=? ORDER BY at DESC LIMIT 1').get(matchId);
  if (!last || last.price !== price || Date.parse(now) - Date.parse(last.at) > 10 * HOUR) {
    db.prepare('INSERT INTO price_history(match_id, price, at) VALUES (?,?,?)').run(matchId, price, now);
  }
}

async function loadPage(url) {
  if (!(await robotsAllows(url))) return { blocked: true };
  const r = await fetchText(url);
  if (r.status === 404 || r.status === 410) return { gone: true };
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return { r };
}

function searchUrl(comp, q) {
  const tpl = comp.search_url.includes('{q}') ? comp.search_url : `${comp.search_url}${comp.search_url.includes('?') ? '&' : '?'}q={q}`;
  return tpl.replace('{q}', encodeURIComponent(q));
}

function searchQueries(product) {
  const qs = [product.ean, product.mpn, product.number].map((x) => String(x ?? '').trim()).filter((x) => x.length >= 4);
  return [...new Set(qs)];
}

/** Einen Treffer (Produkt x Mitbewerber) prüfen: erst bekannte URL, sonst Suche. */
export async function processItem(db, comp, product, match, now = new Date().toISOString()) {
  const save = (ext, url, verdict) => {
    updateMatch(db, match.id, {
      url,
      status: verdict === 'match' ? 'ok' : 'review',
      price: ext.price,
      title: ext.title,
      availability: ext.availability,
      last_checked: now,
      last_error: null,
    });
    recordPrice(db, match.id, ext.price, now);
    return { found: true };
  };
  const fail = (status, msg) => {
    updateMatch(db, match.id, { status, last_checked: now, last_error: msg, ...(status === 'not_found' ? { price: null } : {}) });
    return { found: false, error: status === 'error' };
  };

  try {
    // 1) Bekannte Produkt-URL direkt prüfen
    if (match.url) {
      const p = await loadPage(match.url);
      if (p.blocked) return fail('blocked', 'robots.txt des Mitbewerbers untersagt den Abruf dieser Seite');
      if (!p.gone) {
        const ext = extractProduct(p.r.text, { priceSelector: comp.price_selector });
        if (!ext.found) return fail('error', 'Kein Preis auf der Seite gefunden (ggf. Preis-Selektor setzen)');
        return save(ext, p.r.finalUrl, match.status === 'review' ? 'maybe' : 'match');
      }
      if (match.source === 'manual') return fail('error', 'Seite nicht mehr erreichbar (404)');
      updateMatch(db, match.id, { url: null });
    }
    if (match.source === 'manual') return fail('nourl', 'Keine URL hinterlegt');

    // 2) Suche beim Mitbewerber
    if (!comp.search_url) return fail('nourl', 'Keine Such-URL beim Mitbewerber und keine Produkt-URL hinterlegt');
    let pages = 0;
    let bestMaybe = null;
    let sawBlocked = false;
    for (const q of searchQueries(product)) {
      const su = searchUrl(comp, q);
      const sp = await loadPage(su);
      pages++;
      if (sp.blocked) { sawBlocked = true; break; }
      if (sp.gone) continue;
      await sleep(comp.delay_ms);

      // Direkttreffer: Suche leitet direkt auf eine Produktseite weiter
      const direct = extractProduct(sp.r.text, { priceSelector: comp.price_selector });
      const cands = [];
      if (direct.found && direct.isProductPage && sp.r.finalUrl !== su) cands.push({ url: sp.r.finalUrl, ext: direct });
      for (const url of findCandidates(sp.r.text, sp.r.finalUrl, { resultSelector: comp.result_selector })) {
        if (cands.some((c) => c.url === url)) continue;
        if (pages >= MAX_PAGES_PER_ITEM) break;
        const cp = await loadPage(url);
        pages++;
        await sleep(comp.delay_ms);
        if (cp.blocked || cp.gone) continue;
        const ext = extractProduct(cp.r.text, { priceSelector: comp.price_selector });
        if (ext.found) cands.push({ url: cp.r.finalUrl, ext });
        const v = ext.found ? verify(product, ext) : 'no';
        if (v === 'match') return save(ext, cp.r.finalUrl, 'match');
        if (v === 'maybe' && !bestMaybe) bestMaybe = { url: cp.r.finalUrl, ext };
      }
      for (const c of cands.filter((c) => c.url === sp.r.finalUrl)) {
        const v = verify(product, c.ext);
        if (v === 'match') return save(c.ext, c.url, 'match');
        if (v === 'maybe' && !bestMaybe) bestMaybe = c;
      }
      if (pages >= MAX_PAGES_PER_ITEM) break;
    }
    if (bestMaybe) return save(bestMaybe.ext, bestMaybe.url, 'maybe');
    if (sawBlocked) return fail('blocked', 'robots.txt des Mitbewerbers untersagt die Suche');
    return fail('not_found', 'Kein passendes Produkt gefunden');
  } catch (e) {
    return fail('error', e.message);
  }
}

function isDue(m, force, now) {
  if (force) return true;
  if (!m.last_checked) return true;
  const age = now - Date.parse(m.last_checked);
  if (m.status === 'ok' || m.status === 'review') return age > MIN_INTERVAL_H * HOUR;
  if (m.status === 'error') return age > 6 * HOUR;
  if (m.status === 'pending') return true;
  return age > 7 * 24 * HOUR; // not_found, nourl, blocked: nur selten erneut
}

/** Lauf starten (läuft im Hintergrund). Liefert false, wenn bereits einer läuft. */
export function startScrape(db, { trigger = 'manual', competitorId = null, productId = null, force = false } = {}) {
  if (scrapeState.running) return false;
  const now = Date.now();

  const comps = db.prepare(`SELECT * FROM competitors WHERE enabled=1 ${competitorId ? 'AND id=?' : ''} ORDER BY position, id`).all(...(competitorId ? [competitorId] : []));
  const prods = db.prepare(`SELECT * FROM products WHERE active=1 ${productId ? 'AND id=?' : ''}`).all(...(productId ? [productId] : []));
  const ensure = db.prepare("INSERT OR IGNORE INTO matches(product_id, competitor_id, status) VALUES (?,?,'pending')");
  db.exec('BEGIN');
  for (const c of comps) for (const p of prods) ensure.run(p.id, c.id);
  db.exec('COMMIT');

  const queues = comps.map((c) => {
    const rows = db.prepare('SELECT * FROM matches WHERE competitor_id=?').all(c.id);
    const byProduct = new Map(rows.map((r) => [r.product_id, r]));
    const items = prods
      .map((p) => ({ p, m: byProduct.get(p.id) }))
      .filter(({ m }) => m && isDue(m, force || Boolean(productId), now))
      .sort((a, b) => (a.m.last_checked ?? '').localeCompare(b.m.last_checked ?? ''));
    return { comp: c, items };
  });

  const total = queues.reduce((s, q) => s + q.items.length, 0);
  const startedAt = new Date().toISOString();
  const runId = db.prepare('INSERT INTO runs(started_at, trigger, total) VALUES (?,?,?)').run(startedAt, trigger, total).lastInsertRowid;
  Object.assign(scrapeState, { running: true, stop: false, runId, trigger, total, done: 0, found: 0, errors: 0, startedAt, current: null });

  (async () => {
    await Promise.all(
      queues.map(async ({ comp, items }) => {
        for (const { p, m } of items) {
          if (scrapeState.stop) break;
          scrapeState.current = `${comp.name}: ${p.name}`;
          const r = await processItem(db, comp, p, m);
          scrapeState.done++;
          if (r.found) scrapeState.found++;
          if (r.error) scrapeState.errors++;
          await sleep(comp.delay_ms);
        }
      }),
    );
  })()
    .catch((e) => console.error('Scrape-Lauf abgebrochen:', e))
    .finally(() => {
      db.prepare('UPDATE runs SET finished_at=?, checked=?, found=?, errors=?, note=? WHERE id=?').run(
        new Date().toISOString(),
        scrapeState.done,
        scrapeState.found,
        scrapeState.errors,
        scrapeState.stop ? 'abgebrochen' : null,
        runId,
      );
      scrapeState.running = false;
      scrapeState.current = null;
    });
  return true;
}
