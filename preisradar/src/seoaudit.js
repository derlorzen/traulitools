import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { fetchText, robotsAllows } from './fetcher.js';
import { jsonLdNodes } from './extract.js';
import { parsePrice } from './util.js';
import { getSetting, setSetting } from './settings.js';
import { pageKey } from './gsc.js';
import { aiConfig, chatJson } from './ai.js';
import { aiBudgetLeft, spendAi } from './aiscrape.js';

/**
 * SEO-Prüfung der eigenen Produktseiten: Grundlagen (Titel, Beschreibung, H1, Canonical, noindex), strukturierte
 * Produktdaten (Preis, Lieferbarkeit, EAN, Marke – JSON-LD oder Microdata, wie Shopware sie ausgibt), Textumfang,
 * doppelte Inhalte, Bilder ohne Alternativtext und Antwortzeit. Die Befunde werden nach Wichtigkeit des Artikels
 * (Verkäufe, Google-Nachfrage, Prüf-Stufe) sortiert, damit zuerst die Seiten drankommen, die Umsatz bringen.
 * Abgerufen wird schonend im Hintergrund (robots.txt gilt auch für den eigenen Shop).
 */

// Befunde: Schwere error (kostet Sichtbarkeit), warn (sollte behoben werden), info (Verbesserung)
export const ISSUES = {
  http_error: { sev: 'error', label: 'Seite nicht erreichbar', hint: 'Die Seite liefert einen Fehler. Google entfernt sie aus dem Index.' },
  noindex: { sev: 'error', label: 'Für Google gesperrt (noindex)', hint: 'Die Seite verbietet Google die Aufnahme in den Index. Meist ein Versehen in den Artikel- oder Theme-Einstellungen.' },
  canonical_other: { sev: 'warn', label: 'Canonical zeigt auf andere Seite', hint: 'Google soll statt dieser Seite eine andere anzeigen. Bei Varianten gewollt, sonst ein Fehler.' },
  redirect: { sev: 'info', label: 'Weiterleitung', hint: 'Die Adresse aus der Sitemap leitet weiter. Sitemap und interne Links sollten direkt auf die Zieladresse zeigen.' },
  title_missing: { sev: 'error', label: 'Seitentitel fehlt', hint: 'Ohne Titel erfindet Google selbst einen.' },
  title_long: { sev: 'warn', label: 'Seitentitel zu lang', hint: 'Über etwa 60 Zeichen schneidet Google den Titel ab. Wichtiges nach vorne: Marke, Serie, Produktart.' },
  title_short: { sev: 'info', label: 'Seitentitel sehr kurz', hint: 'Unter 30 Zeichen bleibt Platz für Marke, Produktart oder ein Merkmal ungenutzt.' },
  title_dup: { sev: 'warn', label: 'Seitentitel mehrfach vergeben', hint: 'Mehrere Seiten haben denselben Titel. Google kann sie schlechter unterscheiden.' },
  desc_missing: { sev: 'warn', label: 'Meta-Beschreibung fehlt', hint: 'Google nimmt dann irgendeinen Textausschnitt. Eine gute Beschreibung mit Vorteilen (Versand, Lieferzeit) bringt mehr Klicks.' },
  desc_long: { sev: 'info', label: 'Meta-Beschreibung zu lang', hint: 'Über etwa 160 Zeichen wird sie abgeschnitten.' },
  desc_short: { sev: 'info', label: 'Meta-Beschreibung sehr kurz', hint: 'Unter 70 Zeichen bleibt Platz ungenutzt.' },
  desc_dup: { sev: 'warn', label: 'Meta-Beschreibung mehrfach vergeben', hint: 'Mehrere Seiten haben dieselbe Beschreibung, oft eine Vorlage ohne Produktbezug.' },
  h1_missing: { sev: 'warn', label: 'Keine Hauptüberschrift (H1)', hint: 'Die Produktbezeichnung sollte als H1 auf der Seite stehen.' },
  h1_multiple: { sev: 'info', label: 'Mehrere H1-Überschriften', hint: 'Eine H1 je Seite ist eindeutiger.' },
  schema_missing: { sev: 'error', label: 'Keine Produktdaten für Google', hint: 'Ohne strukturierte Produktdaten (schema.org Product) zeigt Google weder Preis noch Lieferbarkeit im Suchergebnis.' },
  schema_price_missing: { sev: 'error', label: 'Preis fehlt in den Produktdaten', hint: 'Ohne Preis in den strukturierten Daten keine Preisanzeige bei Google.' },
  schema_price_mismatch: { sev: 'error', label: 'Preis in den Produktdaten weicht ab', hint: 'Der Preis für Google stimmt nicht mit dem Shop-Preis überein. Das führt zu Ablehnungen im Merchant Center.' },
  schema_availability_missing: { sev: 'warn', label: 'Lieferbarkeit fehlt in den Produktdaten', hint: 'Google zeigt „Auf Lager“ nur, wenn es in den Produktdaten steht.' },
  schema_gtin_missing: { sev: 'warn', label: 'EAN fehlt in den Produktdaten', hint: 'Mit EAN (gtin13) ordnet Google das Produkt sicher zu und zeigt es im Preisvergleich.' },
  schema_brand_missing: { sev: 'info', label: 'Marke fehlt in den Produktdaten', hint: 'Die Marke hilft Google bei der Zuordnung.' },
  schema_image_missing: { sev: 'info', label: 'Bild fehlt in den Produktdaten', hint: 'Ein Produktbild in den Daten verbessert die Darstellung.' },
  thin_content: { sev: 'warn', label: 'Wenig Produkttext', hint: 'Unter 80 Wörtern Beschreibung hat Google wenig, woran es die Seite erkennt.' },
  dup_content: { sev: 'info', label: 'Gleicher Text auf mehreren Seiten', hint: 'Derselbe Beschreibungstext steht auf mehreren eigenen Seiten. Eigene Sätze zu Einsatz und Vorteilen heben die Seite ab.' },
  img_alt_missing: { sev: 'info', label: 'Bilder ohne Alternativtext', hint: 'Alternativtexte helfen in der Google-Bildersuche und bei Barrierefreiheit.' },
  og_missing: { sev: 'info', label: 'Keine Vorschau für soziale Netzwerke', hint: 'Ohne Open-Graph-Angaben fehlt beim Teilen Bild und Titel.' },
  slow: { sev: 'info', label: 'Langsame Antwort', hint: 'Der Server brauchte über 1,5 Sekunden für die Seite. Schnelle Seiten ranken und verkaufen besser.' },
};
const SEV_W = { error: 100, warn: 10, info: 1 };

const text = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Strukturierte Produktdaten lesen: JSON-LD, sonst Microdata (Shopware 6 nutzt Microdata). */
export function productSchema($) {
  const node = jsonLdNodes($).find((n) => asArray(n['@type']).map(String).some((t) => /Product$/i.test(t)));
  if (node) {
    const offers = asArray(node.offers).flatMap((o) => (o?.offers ? asArray(o.offers) : [o])).filter(Boolean);
    const o = offers[0] ?? {};
    const price = parsePrice(o.price ?? o.lowPrice ?? o.priceSpecification?.price, { dotDecimal: true });
    return {
      type: 'json-ld', name: text(node.name) || null,
      price: price ?? null, currency: o.priceCurrency ?? o.priceSpecification?.priceCurrency ?? null,
      availability: o.availability ? String(o.availability).replace(/^https?:\/\/schema\.org\//, '') : null,
      gtin: node.gtin13 || node.gtin || node.gtin14 || node.gtin8 || null,
      brand: typeof node.brand === 'object' ? text(node.brand?.name) || null : text(node.brand) || null,
      image: Boolean(asArray(node.image).length), sku: node.sku ?? null,
      rating: node.aggregateRating?.ratingValue ?? null,
    };
  }
  const scope = $('[itemtype*="schema.org/Product"]').first();
  if (!scope.length) return null;
  const prop = (name, root = scope) => {
    const el = root.find(`[itemprop="${name}"]`).first();
    if (!el.length) return null;
    return text(el.attr('content') ?? el.attr('href') ?? el.attr('src') ?? el.text()) || null;
  };
  const offer = scope.find('[itemprop="offers"]').first();
  const price = parsePrice(prop('price', offer.length ? offer : scope), { dotDecimal: true }) ?? parsePrice(prop('price', offer.length ? offer : scope));
  const brandEl = scope.find('[itemprop="brand"]').first();
  return {
    type: 'microdata', name: prop('name'),
    price: price ?? null, currency: prop('priceCurrency', offer.length ? offer : scope),
    availability: (prop('availability', offer.length ? offer : scope) ?? '').replace(/^https?:\/\/schema\.org\//, '') || null,
    gtin: prop('gtin13') || prop('gtin') || prop('gtin14') || prop('gtin8'),
    brand: brandEl.length ? text(brandEl.find('[itemprop="name"]').attr('content') ?? brandEl.find('[itemprop="name"]').text() ?? brandEl.attr('content') ?? brandEl.text()) || null : null,
    image: Boolean(scope.find('[itemprop="image"]').length), sku: prop('sku'), rating: prop('ratingValue'),
  };
}

const DESC_SEL = ['.product-detail-description-text', '[itemprop="description"]', '.product-detail-description', '#description', '.product-description', '.description'];

/** Eine Seite auswerten (ohne Abgleich über mehrere Seiten, der kommt in der Übersicht). */
export function auditHtml(html, { url, finalUrl = url, status = 200, ms = null, product = {} } = {}) {
  const $ = cheerio.load(html);
  const title = text($('head title').first().text()) || null;
  const description = text($('meta[name="description" i]').attr('content')) || null;
  const h1s = $('h1').map((_, e) => text($(e).text())).get().filter(Boolean);
  const canonical = $('link[rel="canonical" i]').attr('href') ?? null;
  const robots = [$('meta[name="robots" i]').attr('content'), $('meta[name="googlebot" i]').attr('content')].filter(Boolean).join(', ').toLowerCase() || null;
  const schema = productSchema($);
  let desc = '';
  for (const sel of DESC_SEL) { const t = text($(sel).first().text()); if (t.length > desc.length) desc = t; if (desc.length > 200) break; }
  if (!desc && schema?.type === 'json-ld') {
    const n = jsonLdNodes($).find((x) => asArray(x['@type']).map(String).some((t) => /Product$/i.test(t)));
    desc = text(String(n?.description ?? '').replace(/<[^>]+>/g, ' '));
  }
  const words = desc ? desc.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length : 0;
  const body = $('body').clone();
  body.find('header, footer, nav, script, noscript').remove();
  const imgs = body.find('img').filter((_, e) => !/(logo|icon|sprite|payment|trust|badge)/i.test(`${$(e).attr('src') ?? ''} ${$(e).attr('class') ?? ''}`));
  const noAlt = imgs.filter((_, e) => !text($(e).attr('alt'))).length;
  const og = Boolean($('meta[property="og:title"]').length && $('meta[property="og:image"]').length);

  const issues = [];
  const add = (code, detail = null) => issues.push(detail ? { code, detail } : { code });
  if (robots && /noindex/.test(robots)) add('noindex', robots);
  if (canonical) {
    try { if (pageKey(new URL(canonical, finalUrl).href) !== pageKey(finalUrl)) add('canonical_other', canonical); } catch { /* ungültig */ }
  }
  if (finalUrl && url && pageKey(finalUrl) !== pageKey(url)) add('redirect', finalUrl);
  if (!title) add('title_missing');
  else if (title.length > 60) add('title_long', `${title.length} Zeichen`);
  else if (title.length < 30) add('title_short', `${title.length} Zeichen`);
  if (!description) add('desc_missing');
  else if (description.length > 160) add('desc_long', `${description.length} Zeichen`);
  else if (description.length < 70) add('desc_short', `${description.length} Zeichen`);
  if (!h1s.length) add('h1_missing');
  else if (h1s.length > 1) add('h1_multiple', `${h1s.length} H1`);
  if (!schema) add('schema_missing');
  else {
    if (schema.price == null) add('schema_price_missing');
    else if (product.price != null && Math.abs(schema.price - product.price) > 0.01) add('schema_price_mismatch', `${schema.price.toFixed(2).replace('.', ',')} € statt ${Number(product.price).toFixed(2).replace('.', ',')} €`);
    if (!schema.availability) add('schema_availability_missing');
    if (!schema.gtin && product.ean) add('schema_gtin_missing', `EAN ${product.ean}`);
    if (!schema.brand) add('schema_brand_missing');
    if (!schema.image) add('schema_image_missing');
  }
  if (words < 80) add('thin_content', `${words} Wörter`);
  if (noAlt) add('img_alt_missing', `${noAlt} von ${imgs.length}`);
  if (!og) add('og_missing');
  if (ms != null && ms > 1500) add('slow', `${(ms / 1000).toFixed(1).replace('.', ',')} s`);
  return {
    title, description, h1: h1s[0] ?? null, h1_count: h1s.length, canonical, robots, schema, words,
    text_hash: words >= 30 ? crypto.createHash('sha1').update(desc.toLowerCase()).digest('hex').slice(0, 16) : null,
    images: imgs.length, images_no_alt: noAlt, og, issues, http_status: status, final_url: finalUrl, ms,
  };
}

/** Eine Produktseite abrufen, prüfen und speichern. */
export async function auditProduct(db, product) {
  const now = new Date().toISOString();
  const save = (r) => db.prepare(`INSERT OR REPLACE INTO seo_audit(product_id, url, checked_at, http_status, final_url, ms, bytes, title, description, h1, h1_count, canonical, robots, schema, words, text_hash, images, images_no_alt, og, issues, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(product.id, product.url, now, r.http_status ?? null, r.final_url ?? null, r.ms ?? null, r.bytes ?? null, r.title ?? null, r.description ?? null, r.h1 ?? null, r.h1_count ?? null,
    r.canonical ?? null, r.robots ?? null, r.schema ? JSON.stringify(r.schema) : null, r.words ?? null, r.text_hash ?? null, r.images ?? null, r.images_no_alt ?? null, r.og ? 1 : 0, JSON.stringify(r.issues ?? []), r.error ?? null);
  if (!(await robotsAllows(product.url))) { save({ issues: [], error: 'robots.txt untersagt den Abruf' }); return null; }
  const t0 = Date.now();
  let res;
  try { res = await fetchText(product.url, { timeout: 30000 }); } catch (e) { save({ issues: [{ code: 'http_error', detail: e.message }], error: e.message }); return null; }
  const ms = Date.now() - t0;
  if (res.status >= 400) { save({ http_status: res.status, final_url: res.finalUrl, ms, issues: [{ code: 'http_error', detail: `HTTP ${res.status}` }] }); return null; }
  const r = auditHtml(res.text, { url: product.url, finalUrl: res.finalUrl, status: res.status, ms, product });
  save({ ...r, bytes: Buffer.byteLength(res.text) });
  return r;
}

// ---------- Hintergrundprüfung ----------
export const auditJob = { running: false, stop: false, total: 0, done: 0, errors: 0, startedAt: null, finishedAt: null, manual: false };

export function auditConfig(db) {
  const v = Number(getSetting(db, 'seo_pages_per_day'));
  return { perDay: Number.isFinite(v) && getSetting(db, 'seo_pages_per_day') != null ? Math.min(20000, Math.max(0, Math.round(v))) : 3000 };
}

/** Fällige Seiten: nie geprüft zuerst, dann wichtige nach 7 Tagen, übrige nach 30 Tagen; wichtigste zuerst. */
export function dueProducts(db, { limit = 100, ids = null } = {}) {
  const now = Date.now();
  const rows = db.prepare(`SELECT p.id, p.url, p.price, p.ean, p.tier, s.revenue_90, a.checked_at FROM products p
    LEFT JOIN product_sales s ON s.product_id=p.id LEFT JOIN seo_audit a ON a.product_id=p.id
    WHERE p.active=1 AND p.url IS NOT NULL AND p.url<>'' AND p.offline_since IS NULL ${ids ? `AND p.id IN (${ids.map(() => '?').join(',') || 'NULL'})` : ''}`).all(...(ids ?? []));
  const imp = new Map(db.prepare('SELECT page, impressions FROM seo_pages').all().map((r) => [r.page, r.impressions]));
  const weight = (r) => (r.tier === 'A' ? 1e9 : 0) + (r.revenue_90 ?? 0) * 1000 + (imp.get(pageKey(r.url)) ?? 0);
  return rows
    .filter((r) => ids || !r.checked_at || now - Date.parse(r.checked_at) > (r.tier === 'A' ? 7 : 30) * 86400e3)
    .sort((a, b) => (a.checked_at ? 1 : 0) - (b.checked_at ? 1 : 0) || weight(b) - weight(a))
    .slice(0, limit);
}

/** Einen Durchgang starten: manuell zügig (1,5 s Abstand), sonst gemäß Seiten pro Tag verteilt. */
export function startAudit(db, { ids = null, limit = null, manual = false } = {}) {
  if (auditJob.running) return false;
  const cfg = auditConfig(db);
  const list = dueProducts(db, { ids, limit: limit ?? (manual ? 500 : 50) });
  if (!list.length) return false;
  Object.assign(auditJob, { running: true, stop: false, total: list.length, done: 0, errors: 0, startedAt: new Date().toISOString(), finishedAt: null, manual });
  const gap = manual ? 1500 : Math.max(1500, Math.round(86400e3 / Math.max(1, cfg.perDay)));
  (async () => {
    for (const p of list) {
      if (auditJob.stop) break;
      try { const r = await auditProduct(db, p); if (!r) auditJob.errors++; } catch (e) { auditJob.errors++; console.error('SEO-Prüfung:', e.message); }
      auditJob.done++;
      if (auditJob.done < list.length) await new Promise((r) => setTimeout(r, gap));
    }
  })().finally(() => { auditJob.running = false; auditJob.finishedAt = new Date().toISOString(); setSetting(db, 'seo_audit_at', auditJob.finishedAt); });
  return true;
}

/** Planer: läuft ohne Pause im Hintergrund weiter, solange Seiten fällig sind. */
let idleUntil = 0;
export function auditTick(db) {
  if (auditJob.running || !auditConfig(db).perDay || Date.now() < idleUntil) return;
  if (!startAudit(db, { limit: 50 })) idleUntil = Date.now() + 10 * 60e3; // nichts fällig: in 10 Minuten wieder schauen
}

// ---------- Auswertung ----------
function loadAudits(db) {
  const prods = new Map(db.prepare(`SELECT p.id, p.name, p.number, p.manufacturer, p.url, p.price, p.tier, s.units_90, s.revenue_90 FROM products p LEFT JOIN product_sales s ON s.product_id=p.id WHERE p.active=1 AND p.offline_since IS NULL`).all().map((p) => [p.id, p]));
  const imp = new Map(db.prepare('SELECT page, impressions, clicks, ctr, position FROM seo_pages').all().map((r) => [r.page, r]));
  const rows = db.prepare('SELECT * FROM seo_audit').all().filter((a) => prods.has(a.product_id));
  // Abgleich über alle Seiten: doppelte Titel, Beschreibungen, Texte
  const count = (key) => { const m = new Map(); for (const a of rows) { const v = key(a); if (v) m.set(v, (m.get(v) ?? 0) + 1); } return m; };
  const titles = count((a) => a.title?.toLowerCase()), descs = count((a) => a.description?.toLowerCase()), texts = count((a) => a.text_hash);
  return rows.map((a) => {
    const p = prods.get(a.product_id);
    const issues = JSON.parse(a.issues || '[]');
    if (a.title && titles.get(a.title.toLowerCase()) > 1) issues.push({ code: 'title_dup', detail: `${titles.get(a.title.toLowerCase())} Seiten` });
    if (a.description && descs.get(a.description.toLowerCase()) > 1) issues.push({ code: 'desc_dup', detail: `${descs.get(a.description.toLowerCase())} Seiten` });
    if (a.text_hash && texts.get(a.text_hash) > 2) issues.push({ code: 'dup_content', detail: `${texts.get(a.text_hash)} Seiten` });
    const g = p.url ? imp.get(pageKey(p.url)) : null;
    const importance = (p.tier === 'A' ? 3 : 1) * (1 + Math.log10(1 + (p.revenue_90 ?? 0)) + Math.log10(1 + (g?.impressions ?? 0)));
    const sev = issues.reduce((s, i) => s + (SEV_W[ISSUES[i.code]?.sev] ?? 0), 0);
    return { ...a, schema: a.schema ? JSON.parse(a.schema) : null, issues, product: p, gsc: g ?? null, importance, priority: sev * importance };
  });
}

export function auditOverview(db, { issue = null, sev = null, q = '', limit = 200, offset = 0, important = false } = {}) {
  const all = loadAudits(db);
  const total = db.prepare("SELECT COUNT(*) AS n FROM products WHERE active=1 AND url IS NOT NULL AND url<>'' AND offline_since IS NULL").get().n;
  const byIssue = {};
  for (const a of all) for (const i of a.issues) {
    const x = (byIssue[i.code] ??= { code: i.code, ...ISSUES[i.code], count: 0, important: 0 });
    x.count++;
    if (a.product.tier === 'A' || a.product.units_90 > 0) x.important++;
  }
  const sevOf = (a) => (a.error && !a.issues.length ? 'skipped' : a.issues.some((i) => ISSUES[i.code]?.sev === 'error') ? 'error' : a.issues.some((i) => ISSUES[i.code]?.sev === 'warn') ? 'warn' : a.issues.length ? 'info' : 'ok');
  const counts = { error: 0, warn: 0, info: 0, ok: 0, skipped: 0 };
  for (const a of all) counts[sevOf(a)]++;
  const rated = all.length - counts.skipped;
  const withSchema = all.filter((a) => a.schema).length;
  const text = String(q).trim().toLowerCase();
  const pages = all
    .filter((a) => (!issue || a.issues.some((i) => i.code === issue)) && (!sev || sevOf(a) === sev) && (!important || a.product.tier === 'A' || a.product.units_90 > 0)
      && (!text || [a.product.name, a.product.number, a.title].some((v) => String(v ?? '').toLowerCase().includes(text))))
    .sort((x, y) => y.priority - x.priority || y.importance - x.importance);
  return {
    job: { ...auditJob }, config: auditConfig(db), checked: all.length, total, last: getSetting(db, 'seo_audit_at'),
    score: rated ? Math.round(((counts.ok + counts.info) / rated) * 100) : null,
    counts, schema_share: all.length ? Math.round((withSchema / all.length) * 100) : null,
    issues: Object.values(byIssue).sort((a, b) => SEV_W[b.sev] - SEV_W[a.sev] || b.important - a.important || b.count - a.count),
    filtered: pages.length,
    pages: pages.slice(offset, offset + limit).map(slim),
  };
}
const slim = (a) => ({
  product_id: a.product_id, name: a.product.name, number: a.product.number, url: a.url, price: a.product.price, tier: a.product.tier, units_90: a.product.units_90 ?? null,
  checked_at: a.checked_at, http_status: a.http_status, title: a.title, description: a.description, h1: a.h1, words: a.words, ms: a.ms, schema: a.schema,
  issues: a.issues.map((i) => ({ ...i, sev: ISSUES[i.code]?.sev, label: ISSUES[i.code]?.label })).sort((x, y) => SEV_W[y.sev] - SEV_W[x.sev]),
  gsc: a.gsc ? { impressions: a.gsc.impressions, clicks: a.gsc.clicks, position: Math.round(a.gsc.position * 10) / 10 } : null,
  error: a.error,
});

/** Prüfung eines Artikels (für die Detailansicht und die Preisliste). */
export function auditOf(db, productId) {
  const a = loadAudits(db).find((x) => x.product_id === productId);
  const ai = db.prepare('SELECT title, description, notes, created_at FROM seo_ai WHERE product_id=?').get(productId) ?? null;
  return { audit: a ? slim(a) : null, ai, issues: ISSUES };
}

/** Zahl der schweren Befunde je Artikel (für Filter in der Preisliste). */
export function auditFlags(db) {
  const m = new Map();
  for (const a of db.prepare('SELECT product_id, issues FROM seo_audit').all()) {
    const list = JSON.parse(a.issues || '[]');
    m.set(a.product_id, { errors: list.filter((i) => ISSUES[i.code]?.sev === 'error').length, warns: list.filter((i) => ISSUES[i.code]?.sev === 'warn').length });
  }
  return m;
}

/** KI-Vorschlag für Seitentitel und Meta-Beschreibung, mit den Suchanfragen aus der Search Console. */
export async function suggestMeta(db, productId) {
  const cfg = aiConfig(db);
  if (!cfg.key) throw new Error('KI ist nicht eingerichtet (Einstellungen → KI)');
  if (!aiBudgetLeft()) throw new Error('Die KI-Tagesgrenze ist erreicht');
  const p = db.prepare('SELECT id, name, manufacturer, number, ean, price, url FROM products WHERE id=?').get(productId);
  if (!p) throw new Error('Artikel nicht gefunden');
  const a = db.prepare('SELECT title, description, h1 FROM seo_audit WHERE product_id=?').get(productId) ?? {};
  const queries = p.url ? db.prepare('SELECT query, impressions, clicks, position FROM seo_queries WHERE page=? ORDER BY impressions DESC LIMIT 10').all(pageKey(p.url)) : [];
  const shop = getSetting(db, 'own_name') || 'der Shop';
  spendAi();
  const { data } = await chatJson(cfg,
    'Du bist SEO-Texter für einen deutschen Onlineshop für Badausstattung. Schreibe einen Seitentitel (höchstens 60 Zeichen) und eine Meta-Beschreibung (140 bis 155 Zeichen) für eine Produktseite. Regeln: Marke und Produktbezeichnung vorne, wichtigste Suchbegriffe natürlich einbauen, keine Übertreibungen, keine erfundenen Eigenschaften, Preise oder Versandversprechen; nur Angaben aus den Daten verwenden. Deutsch, Sie-Form vermeiden. Antwortformat: {"title": "...", "description": "...", "notes": "ein Satz, warum"}',
    { shop, produkt: { name: p.name, marke: p.manufacturer, artikelnummer: p.number, ean: p.ean, preis: p.price }, aktuell: { titel: a.title ?? null, beschreibung: a.description ?? null, h1: a.h1 ?? null }, suchanfragen_google: queries.map((q) => ({ anfrage: q.query, impressionen: q.impressions, klicks: q.clicks, platz: Math.round(q.position) })) },
    { timeout: 60000 });
  const out = { title: text(data.title).slice(0, 80), description: text(data.description).slice(0, 200), notes: text(data.notes).slice(0, 300) || null };
  if (!out.title) throw new Error('Die KI hat keinen Vorschlag geliefert');
  db.prepare('INSERT OR REPLACE INTO seo_ai(product_id, title, description, notes, created_at) VALUES (?,?,?,?,?)').run(productId, out.title, out.description, out.notes, new Date().toISOString());
  return out;
}
