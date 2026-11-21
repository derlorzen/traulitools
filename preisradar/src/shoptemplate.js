import * as cheerio from 'cheerio';
import { parsePrice, normId } from './util.js';
import { deriveTemplates } from './templates.js';

/**
 * Auslese-Vorlage je Mitbewerber: einmal an einer Beispielseite angelernt (ohne KI), danach bei jedem Abruf
 * dieses Shops angewendet. Sie hält fest,
 *  - woher der Preis kommt: strukturierte Daten (JSON-LD) des Shops oder eine feste Stelle im HTML (CSS-Selektor),
 *  - wo EAN und Herstellernummer stehen (Beschriftung wie „EAN:“ oder „Hersteller-Nr.“ und der Wert dahinter).
 * Mit EAN bzw. Herstellernummer auf der Seite gilt ein Treffer als sicher, ohne dass die KI prüfen muss.
 *
 * Gespeichert als JSON in competitors.extract_tpl:
 *   { price: { mode: 'jsonld' } | { mode: 'selector', selector }, ids: [{ kind: 'ean'|'mpn', label }],
 *     sample: { url, price, ean, mpn }, check: { at, ok, total, pages: [...] }, created }
 */

const BAD_ANCESTOR = 'del, s, strike, [class*="old-price"], [class*="oldprice"], [class*="list-price"], [class*="pseudo"], [class*="uvp"], [class*="cross-selling"], [class*="related"], [class*="similar"], [class*="recommend"], [class*="slider"]';

/** GTIN-Prüfziffer (EAN-8/12/13/14). */
export function validGtin(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return false;
  const digits = d.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((a, n, i) => a + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Beschriftungen, hinter denen Shops EAN bzw. Herstellernummer zeigen (von spezifisch zu allgemein). */
const LABELS = {
  ean: ['EAN-Code', 'EAN Code', 'EAN-Nummer', 'EAN-Nr.', 'EAN', 'GTIN-13', 'GTIN', 'Barcode'],
  mpn: ['Herstellerartikelnummer', 'Hersteller-Artikelnummer', 'Herstellernummer', 'Hersteller-Nummer', 'Hersteller-Nr.', 'Herstellernr.', 'Herstellernr', 'Herst.-Nr.', 'Art.-Nr. Hersteller', 'Artikelnummer Hersteller', 'MPN'],
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelRe = (label, kind) => new RegExp(`${esc(label)}\\s*[:#.]?\\s*(${kind === 'ean' ? '\\d[\\d ]{6,16}\\d' : '[A-Z0-9][A-Z0-9./\\- ]{2,28}[A-Z0-9]'})`, 'i');

function pageText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();
  // Zellen und Blöcke mit Leerzeichen trennen, damit „EAN</td><td>4001…“ als „EAN 4001…“ lesbar wird
  $('td, th, dt, dd, li, div, p, span, br').each((_, el) => { $(el).append(' '); });
  return $('body').text().replace(/\s+/g, ' ');
}

/** Wert hinter einer Beschriftung lesen. */
export function readLabeled(text, { kind, label }) {
  const m = labelRe(label, kind).exec(text);
  if (!m) return null;
  let v = m[1].trim();
  if (kind === 'ean') { v = v.replace(/\D/g, ''); return validGtin(v) ? v : null; }
  v = v.split(/\s{2,}| (?=[A-ZÄÖÜ][a-zäöü]{3,})/)[0].trim(); // Folgetext („… Hersteller-Nr. 123-456 Lieferzeit“) abschneiden
  return v.length >= 3 ? v : null;
}

/** Preis an einer Stelle lesen (Attribute zuerst, dann sichtbarer Text). */
function priceAt($, el) {
  const $el = $(el);
  if ($el.closest(BAD_ANCESTOR).length) return null;
  for (const a of ['content', 'data-price', 'data-value', 'value']) {
    const v = $el.attr(a);
    if (v != null && v !== '') { const p = parsePrice(v, { dotDecimal: /^\d+(\.\d+)?$/.test(v.trim()) }); if (p != null && p > 0) return p; }
  }
  const t = $el.text().replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return null;
  const m = /\d{1,3}(?:[.\s]\d{3})*,\d{2}|\d+,\d{2}|\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}|\d+(?=\s*(?:€|EUR|,-))/.exec(t);
  return m ? parsePrice(m[0].replace(/\s/g, '')) : null;
}

/** Vorlage auf eine Seite anwenden: { price, ids:Set, ean, mpn } (fehlende Teile null). */
export function applyShopTemplate(html, tpl, jsonldPrice = null) {
  if (!tpl) return null;
  const out = { price: null, ids: new Set(), ean: null, mpn: null };
  if (tpl.price?.mode === 'jsonld') out.price = jsonldPrice;
  else if (tpl.price?.mode === 'selector') {
    const $ = cheerio.load(html);
    let els;
    try { els = $(tpl.price.selector); } catch { els = $(); }
    for (const el of els.toArray().slice(0, 5)) { const p = priceAt($, el); if (p != null) { out.price = p; break; } }
  }
  if (tpl.ids?.length) {
    const text = pageText(html);
    for (const r of tpl.ids) {
      const v = readLabeled(text, r);
      if (!v) continue;
      out[r.kind] ??= v;
      out.ids.add(normId(v));
    }
  }
  return out;
}

/**
 * Vorlage aus einer Beispielseite ableiten. `known` = { price?, ean?, mpn? } aus Preisradar oder vom Nutzer.
 * jsonld = { price } aus den strukturierten Daten der Seite (falls vorhanden).
 * Ohne bekannten Preis und ohne strukturierte Daten werden Preis-Kandidaten zur Auswahl geliefert.
 */
export function learnShopTemplate(html, { known = {}, jsonld = null } = {}) {
  const tpl = { ids: [] };
  const notes = [];
  // Preis
  const want = known.price != null ? Number(known.price) : null;
  if (jsonld?.price != null && (want == null || Math.abs(jsonld.price - want) < 0.01)) {
    tpl.price = { mode: 'jsonld' };
    notes.push(`Preis aus den strukturierten Daten des Shops (${jsonld.price.toFixed(2).replace('.', ',')} €)`);
  } else if (want != null) {
    const sels = deriveTemplates(html, want);
    if (sels.length) { tpl.price = { mode: 'selector', selector: sels[0] }; notes.push(`Preis an fester Stelle im HTML: ${sels[0]}`); }
    else notes.push(`Der Preis ${want.toFixed(2).replace('.', ',')} € steht so nicht auf der Seite (anderer Preis oder per JavaScript nachgeladen).`);
  }
  // EAN und Herstellernummer: welche Beschriftung liefert den richtigen Wert?
  const text = pageText(html);
  for (const kind of ['ean', 'mpn']) {
    const target = known[kind] ? normId(known[kind]) : null;
    for (const label of LABELS[kind]) {
      const v = readLabeled(text, { kind, label });
      if (!v) continue;
      if (target ? normId(v) === target || normId(v).includes(target) : kind === 'ean') {
        tpl.ids.push({ kind, label });
        notes.push(`${kind === 'ean' ? 'EAN' : 'Herstellernummer'} hinter „${label}“ (${v})`);
        break;
      }
    }
  }
  if (!tpl.ids.length) notes.push('Keine EAN oder Herstellernummer auf der Seite gefunden: Treffer werden über den Namen geprüft.');
  // Kandidaten, falls der Preis noch offen ist
  let candidates = [];
  if (!tpl.price) candidates = priceCandidates(html);
  return { tpl: tpl.price ? tpl : null, partial: tpl, notes, candidates };
}

/** Auffällige Preise auf der Seite (für die Auswahl, wenn nichts eindeutig ist). */
export function priceCandidates(html, limit = 6) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, header, footer, nav, select, option, input, button').remove();
  const seen = new Map();
  $('body *').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 0 && $el.attr('content') == null) return; // nur innerste Stellen
    const cls = `${$el.attr('class') ?? ''} ${$el.attr('id') ?? ''} ${$el.attr('itemprop') ?? ''}`;
    const p = priceAt($, el);
    if (p == null || p <= 0) return;
    const score = (/price|preis/i.test(cls) ? 3 : 0) + ($el.attr('itemprop') === 'price' ? 3 : 0) + (/€|EUR/.test($el.text()) ? 1 : 0) - (/old|uvp|statt|strike|pseudo|grund|unit|shipping|versand/i.test(cls) ? 5 : 0);
    const cur = seen.get(p);
    if (!cur || score > cur.score) seen.set(p, { price: p, score, context: $el.parent().text().replace(/\s+/g, ' ').trim().slice(0, 80) });
  });
  return [...seen.values()].filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
