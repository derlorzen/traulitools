import { fetchText, robotsAllows } from './fetcher.js';
import { extractProduct, findCandidates } from './extract.js';
import { normId, sleep, tokens, jaccard } from './util.js';
import { aiConfig } from './ai.js';
import { sitemapCandidates, hasSitemap, refreshSitemaps, sitemapDue } from './sitemap.js';
import { pageDigest, linkList, aiPick, aiExtract, aiVerdict, aiNote, aiBudgetLeft, resetAiBudget, aiCallCount, CONFIDENT } from './aiscrape.js';

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
  // Auch das Ziel einer Weiterleitung muss laut robots.txt erlaubt sein
  if (r.finalUrl && r.finalUrl !== url && !(await robotsAllows(r.finalUrl))) return { blocked: true };
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
const WEEK_MS = 7 * 24 * HOUR;
/**
 * Ein Artikel bei einem Mitbewerber. Die KI wird bei nicht gefundenen Artikeln höchstens einmal pro Woche erneut gefragt;
 * jeder Einsatz der KI wird am Treffer vermerkt.
 */
export async function processItem(db, comp, product, match, now = new Date().toISOString(), ai = null) {
  if (ai && match.status === 'not_found' && match.ai_tried_at && Date.now() - Date.parse(match.ai_tried_at) < WEEK_MS) ai = null;
  const before = aiCallCount();
  try {
    return await processItemInner(db, comp, product, match, now, ai);
  } finally {
    if (aiCallCount() > before) db.prepare('UPDATE matches SET ai_tried_at=? WHERE id=?').run(new Date().toISOString(), match.id);
  }
}

async function processItemInner(db, comp, product, match, now, ai) {
  let aiErr = null;
  /** Seite von der KI auslesen lassen; Fehler der KI brechen den Abruf nicht ab. */
  const aiRead = async (url, html) => {
    if (!ai || !aiBudgetLeft()) return null;
    try { return await aiExtract(ai.cfg, product, pageDigest(html), url); } catch (e) { aiErr = e.message; return null; }
  };
  const save = (ext, url, verdict, note = null) => {
    updateMatch(db, match.id, {
      url,
      status: verdict === 'match' ? 'ok' : 'review',
      price: ext.price,
      title: ext.title,
      availability: ext.availability,
      last_checked: now,
      last_error: null,
      ai_note: note,
    });
    recordPrice(db, match.id, ext.price, now);
    return { found: true };
  };
  const fail = (status, msg) => {
    updateMatch(db, match.id, { status, last_checked: now, last_error: aiErr ? `${msg} (KI: ${aiErr})` : msg, ...(status === 'not_found' ? { price: null } : {}) });
    return { found: false, error: status === 'error' };
  };

  /** Eine geladene Produktseite bewerten: Regeln zuerst, dann KI (fehlender Preis bzw. unsicherer Treffer). */
  const evalPage = async (cp) => {
    let ext = extractProduct(cp.r.text, { priceSelector: comp.price_selector });
    let v = ext.found ? verify(product, ext) : 'no';
    let note = null;
    if (ai && (!ext.found || (v === 'maybe' && ai.mode === 'always'))) {
      const a = await aiRead(cp.r.finalUrl, cp.r.text);
      if (a?.isProductPage && a.price != null && !ext.found) {
        ext = { found: true, price: a.price, title: a.title, availability: a.availability };
        v = aiVerdict(a);
        note = aiNote(a);
      } else if (a && ext.found && a.confidence >= CONFIDENT) {
        v = a.same ? 'match' : 'no';
        note = aiNote(a);
      }
    }
    return { ext, v, note };
  };

  try {
    // 1) Bekannte Produkt-URL direkt prüfen
    if (match.url) {
      const p = await loadPage(match.url);
      if (p.blocked) return fail('blocked', 'robots.txt des Mitbewerbers untersagt den Abruf dieser Seite');
      if (!p.gone) {
        const ext = extractProduct(p.r.text, { priceSelector: comp.price_selector });
        const verdict = match.status === 'review' ? 'maybe' : 'match';
        if (!ext.found) {
          const a = await aiRead(p.r.finalUrl, p.r.text);
          if (a?.price != null) return save({ price: a.price, title: a.title, availability: a.availability }, p.r.finalUrl, verdict, aiNote(a));
          return fail('error', 'Kein Preis auf der Seite gefunden (ggf. Preis-Selektor setzen oder KI aktivieren)');
        }
        return save(ext, p.r.finalUrl, verdict);
      }
      if (match.source === 'manual') return fail('error', 'Seite nicht mehr erreichbar (404)');
      updateMatch(db, match.id, { url: null });
    }
    if (match.source === 'manual') return fail('nourl', 'Keine URL hinterlegt');

    // 2a) Sitemap des Mitbewerbers: URLs per Marke/Name vorauswählen
    let pages = 0;
    let bestMaybe = null;
    let sawBlocked = false;
    let aiTried = false;
    const tried = new Set();
    if (hasSitemap(db, comp.id)) {
      const cands = sitemapCandidates(db, comp.id, product, { limit: 4 });
      for (const c of cands) {
        let cp;
        try { cp = await loadPage(c.url); } catch { continue; }
        pages++;
        tried.add(c.url);
        await sleep(comp.delay_ms);
        if (cp.blocked) { sawBlocked = true; continue; }
        if (cp.gone) continue;
        tried.add(cp.r.finalUrl);
        const { ext, v, note } = await evalPage(cp);
        if (!ext.found) continue;
        if (v === 'match') return save(ext, cp.r.finalUrl, 'match', note);
        if (v === 'maybe' && !bestMaybe) bestMaybe = { url: cp.r.finalUrl, ext, note };
      }
      // KI wählt aus den ähnlichsten URLs, wenn die Regeln nichts Sicheres fanden
      if (ai && !bestMaybe && aiBudgetLeft()) {
        const more = sitemapCandidates(db, comp.id, product, { limit: 25, min: 0.15 }).filter((c) => !tried.has(c.url));
        if (more.length) {
          aiTried = true;
          let pick = null;
          try { pick = await aiPick(ai.cfg, product, more.map((c) => ({ url: c.url, text: c.slug.replace(/-/g, ' '), context: c.slug }))); } catch (e) { aiErr = e.message; }
          if (pick && pick.confidence >= 0.5) {
            const cp = await loadPage(pick.url);
            pages++;
            await sleep(comp.delay_ms);
            if (!cp.blocked && !cp.gone) {
              const { ext, v, note } = await evalPage(cp);
              if (ext.found && v === 'match') return save(ext, cp.r.finalUrl, 'match', note);
              if (ext.found && v === 'maybe') bestMaybe = { url: cp.r.finalUrl, ext, note };
            }
          }
        }
      }
      if (bestMaybe) return save(bestMaybe.ext, bestMaybe.url, 'maybe', bestMaybe.note);
      if (!comp.search_url) return fail(sawBlocked ? 'blocked' : 'not_found', sawBlocked ? 'robots.txt des Mitbewerbers untersagt den Abruf' : 'Kein passendes Produkt in der Sitemap gefunden');
    }

    // 2) Suche beim Mitbewerber
    if (!comp.search_url) return fail('nourl', 'Keine Such-URL beim Mitbewerber und keine Produkt-URL hinterlegt');
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
        tried.add(url).add(cp.r.finalUrl);
        const { ext, v, note } = await evalPage(cp);
        if (ext.found) cands.push({ url: cp.r.finalUrl, ext });
        if (v === 'match') return save(ext, cp.r.finalUrl, 'match', note);
        if (v === 'maybe' && !bestMaybe) bestMaybe = { url: cp.r.finalUrl, ext, note };
      }
      for (const c of cands.filter((c) => c.url === sp.r.finalUrl)) {
        const v = verify(product, c.ext);
        if (v === 'match') return save(c.ext, c.url, 'match');
        if (v === 'maybe' && !bestMaybe) bestMaybe = c;
      }
      // KI: Regeln haben nichts Brauchbares gefunden, die KI wählt den Treffer aus der Ergebnisseite
      if (ai && !aiTried && !bestMaybe && aiBudgetLeft()) {
        const links = linkList(sp.r.text, sp.r.finalUrl).filter((l) => !tried.has(l.url));
        if (links.length) {
          aiTried = true;
          let pick = null;
          try { pick = await aiPick(ai.cfg, product, links); } catch (e) { aiErr = e.message; }
          if (pick && pick.confidence >= 0.5) {
            const cp = await loadPage(pick.url);
            pages++;
            await sleep(comp.delay_ms);
            if (!cp.blocked && !cp.gone) {
              const ext = extractProduct(cp.r.text, { priceSelector: comp.price_selector });
              const a = await aiRead(cp.r.finalUrl, cp.r.text);
              const price = ext.found ? ext.price : a?.price;
              let v = ext.found ? verify(product, ext) : 'no';
              let note = null;
              if (a && v !== 'match') { v = aiVerdict(a); note = aiNote(a); }
              if (price != null && v !== 'no') {
                const e = ext.found ? ext : { price, title: a.title, availability: a.availability };
                if (v === 'match') return save(e, cp.r.finalUrl, 'match', note);
                bestMaybe = { url: cp.r.finalUrl, ext: e, note };
              }
            }
          }
        }
      }
      if (pages >= MAX_PAGES_PER_ITEM) break;
    }
    if (bestMaybe) return save(bestMaybe.ext, bestMaybe.url, 'maybe', bestMaybe.note);
    if (sawBlocked) return fail('blocked', 'robots.txt des Mitbewerbers untersagt die Suche');
    return fail('not_found', 'Kein passendes Produkt gefunden');
  } catch (e) {
    return fail('error', e.message);
  }
}

function isDue(m, force, now, minH = MIN_INTERVAL_H) {
  if (force) return true;
  if (!m.last_checked) return true;
  const age = now - Date.parse(m.last_checked);
  if (m.status === 'ok' || m.status === 'review') return age > minH * HOUR;
  if (m.status === 'error') return age > 6 * HOUR;
  if (m.status === 'pending') return true;
  return age > 7 * 24 * HOUR; // not_found, nourl, blocked: nur selten erneut
}

/** Lauf starten (läuft im Hintergrund). Liefert false, wenn bereits einer läuft. */
/**
 * limitPerCompetitor: höchstens so viele Prüfungen je Mitbewerber (Rolling-Modus, die ältesten zuerst).
 * minIntervalH: Mindestabstand zwischen zwei Prüfungen desselben Artikels.
 */
const STALE_MS = 3 * 60 * 1000;
/**
 * Läufe, die nicht mehr laufen (Neustart, Absturz), als unterbrochen abschließen. Läuft ein Lauf mit frischem
 * Lebenszeichen (z. B. in einem zweiten Container während eines Deploys), gilt er als aktiv.
 */
export function closeStaleRuns(db, now = Date.now()) {
  const cutoff = new Date(now - STALE_MS).toISOString();
  db.prepare("UPDATE runs SET finished_at=COALESCE(heartbeat, started_at), note=COALESCE(note, 'unterbrochen') WHERE finished_at IS NULL AND COALESCE(heartbeat, started_at) < ?").run(cutoff);
  return db.prepare('SELECT id FROM runs WHERE finished_at IS NULL').get() ?? null;
}

export function startScrape(db, { trigger = 'manual', competitorId = null, productId = null, force = false, limitPerCompetitor = null, minIntervalH = MIN_INTERVAL_H, fill = false } = {}) {
  if (scrapeState.running) return false;
  const now = Date.now();
  if (closeStaleRuns(db, now)) return false; // ein anderer Lauf ist noch aktiv: erst nach dessen Ende starten

  const comps = db.prepare(`SELECT * FROM competitors WHERE enabled=1 ${competitorId ? 'AND id=?' : ''} ORDER BY position, id`).all(...(competitorId ? [competitorId] : []));
  const prods = db.prepare(`SELECT * FROM products WHERE active=1 ${productId ? 'AND id=?' : 'AND tracked=1 AND offline_since IS NULL'}`).all(...(productId ? [productId] : []));
  const ensure = db.prepare("INSERT OR IGNORE INTO matches(product_id, competitor_id, status) VALUES (?,?,'pending')");
  db.exec('BEGIN');
  for (const c of comps) for (const p of prods) ensure.run(p.id, c.id);
  db.exec('COMMIT');

  resetAiBudget();
  const aiCfg = aiConfig(db);
  const queues = comps.map((c) => {
    const rows = db.prepare('SELECT * FROM matches WHERE competitor_id=?').all(c.id);
    const byProduct = new Map(rows.map((r) => [r.product_id, r]));
    const items = prods
      .map((p) => ({ p, m: byProduct.get(p.id) }))
      .filter(({ m }) => m)
      .sort((a, b) => (a.m.last_checked ?? '').localeCompare(b.m.last_checked ?? ''));
    const due = items.filter(({ m }) => isDue(m, force || Boolean(productId), now, minIntervalH));
    // Volle Pakete: sind weniger Artikel fällig als die Paketgröße, wird mit den am längsten nicht geprüften aufgefüllt
    // (frühestens eine Stunde nach der letzten Prüfung).
    if (fill && limitPerCompetitor && due.length < limitPerCompetitor) {
      const taken = new Set(due.map(({ p }) => p.id));
      for (const it of items) {
        if (due.length >= limitPerCompetitor) break;
        if (taken.has(it.p.id) || (it.m.last_checked && now - Date.parse(it.m.last_checked) < HOUR)) continue;
        if (['not_found', 'nourl', 'blocked'].includes(it.m.status)) continue; // nicht gefunden: nur wöchentlich (über isDue)
        due.push(it);
      }
    }
    return { comp: c, items: due.slice(0, limitPerCompetitor ?? undefined) };
  });

  const total = queues.reduce((s, q) => s + q.items.length, 0);
  if (trigger === 'rolling' && !total) return false; // nichts fällig: keinen leeren Lauf protokollieren
  const startedAt = new Date().toISOString();
  const runId = db.prepare('INSERT INTO runs(started_at, trigger, total, heartbeat) VALUES (?,?,?,?)').run(startedAt, trigger, total, startedAt).lastInsertRowid;
  const beat = setInterval(() => { try { db.prepare('UPDATE runs SET heartbeat=?, checked=? WHERE id=?').run(new Date().toISOString(), scrapeState.done, runId); } catch { /* DB geschlossen */ } }, 30000);
  beat.unref?.();
  Object.assign(scrapeState, { running: true, stop: false, runId, trigger, total, done: 0, found: 0, errors: 0, startedAt, current: null });

  (async () => {
    for (const c of comps) {
      if (!sitemapDue(db, c)) continue;
      scrapeState.current = `${c.name}: Sitemap einlesen`;
      try { await refreshSitemaps(db, c); } catch (e) { console.error('Sitemap-Fehler:', e.message); }
    }
    await Promise.all(
      queues.map(async ({ comp, items }) => {
        for (const { p, m } of items) {
          if (scrapeState.stop) break;
          scrapeState.current = `${comp.name}: ${p.name}`;
          const ai = aiCfg.key && comp.ai_mode !== 'off' ? { cfg: aiCfg, mode: comp.ai_mode } : null;
          const r = await processItem(db, comp, p, m, undefined, ai);
          scrapeState.done++;
          if (r.found) scrapeState.found++;
          if (r.error) scrapeState.errors++;
          await sleep(comp.delay_ms * (1 + Math.random() * 0.5)); // Pausen leicht streuen
        }
      }),
    );
  })()
    .catch((e) => console.error('Scrape-Lauf abgebrochen:', e))
    .finally(() => {
      clearInterval(beat);
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
      scrapeState.finishedAt = Date.now();
    });
  return true;
}

/**
 * Einen Artikel sofort bei allen aktiven Mitbewerbern prüfen, unabhängig vom laufenden Abruf
 * (je Mitbewerber eine Anfrage, parallel). Höchstens drei solcher Prüfungen gleichzeitig.
 */
const checking = new Set();
export async function checkProductNow(db, productId, { competitorId = null } = {}) {
  if (checking.has(productId)) throw Object.assign(new Error('Dieser Artikel wird gerade geprüft'), { status: 409 });
  if (checking.size >= 3) throw Object.assign(new Error('Es laufen schon mehrere Sofortprüfungen, bitte kurz warten'), { status: 429 });
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!p) throw Object.assign(new Error('Artikel nicht gefunden'), { status: 404 });
  checking.add(productId);
  try {
    const comps = db.prepare(`SELECT * FROM competitors WHERE ${competitorId ? 'id=?' : 'enabled=1'} ORDER BY position, id`).all(...(competitorId ? [competitorId] : []));
    const aiCfg = aiConfig(db);
    const ensure = db.prepare("INSERT OR IGNORE INTO matches(product_id, competitor_id, status) VALUES (?,?,'pending')");
    const results = await Promise.all(comps.map(async (c) => {
      ensure.run(p.id, c.id);
      const m = db.prepare('SELECT * FROM matches WHERE product_id=? AND competitor_id=?').get(p.id, c.id);
      const ai = aiCfg.key && c.ai_mode !== 'off' ? { cfg: aiCfg, mode: c.ai_mode } : null;
      try {
        const r = await processItem(db, c, p, m, undefined, ai);
        return { competitor: c.name, found: Boolean(r.found), error: r.error ?? null };
      } catch (e) {
        return { competitor: c.name, found: false, error: e.message };
      }
    }));
    return results;
  } finally {
    checking.delete(productId);
  }
}
