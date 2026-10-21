import * as cheerio from 'cheerio';
import { fetchText, robotsAllows } from './fetcher.js';
import { extractProduct } from './extract.js';
import { upsertProducts } from './db.js';
import { sleep } from './util.js';

/**
 * Artikelbasis aus der eigenen Sitemap: Jede Produktseite wird abgerufen und ausgelesen
 * (Artikelnummer, Name, Marke, EAN, Herstellernummer, Preis). Läuft im Hintergrund und kann wiederholt
 * werden; bereits importierte Seiten werden übersprungen.
 */

export const ownImportState = { running: false, stop: false, total: 0, done: 0, created: 0, updated: 0, skipped: 0, errors: 0, lastError: null, startedAt: null, finishedAt: null };

/** Produktseiten erkennen: mindestens zwei Pfadsegmente, das letzte wie eine Artikelnummer (mit Ziffer). */
export function isProductUrl(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? '';
    return segs.length >= 2 && /\d/.test(last) && /^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$/.test(last);
  } catch {
    return false;
  }
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim() || null;

/** Eigene Produktseite lesen (Microdata, JSON-LD, Meta). Ohne Artikelnummer, Name und Preis gilt sie nicht als Produkt. */
export function extractOwnProduct(html, url) {
  const $ = cheerio.load(html);
  const val = (sel) => clean($(sel).first().attr('content') ?? $(sel).first().text());
  let ld = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (ld) return;
    try {
      const walk = (o) => {
        for (const x of Array.isArray(o) ? o : [o]) {
          if (!x || typeof x !== 'object') continue;
          if (/Product/.test([].concat(x['@type'] ?? []).join(','))) { ld = x; return; }
          if (x['@graph']) walk(x['@graph']);
        }
      };
      walk(JSON.parse($(el).text()));
    } catch { /* ignorieren */ }
  });
  const last = new URL(url).pathname.split('/').filter(Boolean).pop();
  const number = val('[itemprop=sku]') || clean(ld?.sku) || val('.product-detail-ordernumber') || (/\d/.test(last) ? last : null);
  const ext = extractProduct(html);
  const brand = clean($('meta[property="product:brand"]').attr('content')) || val('[itemprop=brand] [itemprop=name]') || val('[itemprop=brand]') || clean(ld?.brand?.name ?? ld?.brand);
  const name = clean($('h1').first().text()) || clean(ld?.name) || clean(String(ext.title ?? '').replace(/\s*\|\s*[^|]*$/, ''));
  const ean = val('[itemprop=gtin13]') || val('[itemprop=gtin]') || clean(ld?.gtin13 ?? ld?.gtin ?? ld?.gtin14 ?? ld?.gtin8);
  const mpn = val('[itemprop=mpn]') || clean(ld?.mpn);
  if (!number || !name || !ext.found) return null;
  return { number, name, manufacturer: brand, ean, mpn, price: ext.price, url };
}

export function startOwnImport(db, { limit = null, all = false, tracked = false, delayMs = Number(process.env.OWN_IMPORT_DELAY_MS ?? 400) } = {}) {
  if (ownImportState.running) return false;
  const known = new Set(db.prepare("SELECT url FROM products WHERE source='sitemap' AND url IS NOT NULL").all().map((r) => r.url));
  let urls = db.prepare('SELECT url FROM own_sitemap_urls').all().map((r) => r.url).filter(isProductUrl);
  const skipped = all ? 0 : urls.filter((u) => known.has(u)).length;
  if (!all) urls = urls.filter((u) => !known.has(u));
  if (limit) urls = urls.slice(0, limit);
  Object.assign(ownImportState, { running: true, stop: false, total: urls.length, done: 0, created: 0, updated: 0, skipped, errors: 0, lastError: null, startedAt: new Date().toISOString(), finishedAt: null });

  (async () => {
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const r = upsertProducts(db, batch, 'sitemap', { tracked }); // Standard: nicht beobachtet, die Auswahl trifft der Nutzer
      ownImportState.created += r.created;
      ownImportState.updated += r.updated;
      batch = [];
    };
    for (const url of urls) {
      if (ownImportState.stop) break;
      try {
        if (!(await robotsAllows(url))) throw new Error('robots.txt untersagt den Abruf');
        const r = await fetchText(url);
        if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
        const p = extractOwnProduct(r.text, r.finalUrl);
        if (p) batch.push(p);
        else ownImportState.skipped++; // keine Produktseite (z. B. Kategorie)
      } catch (e) {
        ownImportState.errors++;
        ownImportState.lastError = `${url.split('/').slice(-2, -1)[0]}: ${e.message}`;
      }
      ownImportState.done++;
      if (batch.length >= 25) flush();
      await sleep(delayMs);
    }
    flush();
  })()
    .catch((e) => { ownImportState.lastError = e.message; })
    .finally(() => { ownImportState.running = false; ownImportState.finishedAt = new Date().toISOString(); });
  return true;
}
