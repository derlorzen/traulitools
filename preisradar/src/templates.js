import * as cheerio from 'cheerio';
import { parsePrice } from './util.js';

/**
 * Abruf-Vorlagen je Mitbewerber: Hat die KI auf einer Seite den Preis gefunden, sucht Preisradar die Stelle im
 * HTML, an der genau dieser Preis steht, und merkt sich einen CSS-Selektor dafür. Ab dann werden alle Seiten
 * dieses Shops ohne KI ausgelesen. Mehrere Vorlagen je Shop sind möglich (z. B. Aktionspreis und Normalpreis-Layout).
 */

const MAX_TEMPLATES = 5;
const BAD_CLASS = /(old|strike|uvp|was|pseudo|list-?price|regular|before|crossed|saving|discount|ersparnis|statt|instead|unit|grundpreis|base-?price|per-|shipping|versand|related|cross|upsell|slider|recommend|similar)/i;
const BAD_ANCESTOR = 'header, footer, nav, del, s, strike, [class*="cross-selling"], [class*="crossselling"], [class*="related"], [class*="similar"], [class*="recommend"], [class*="slider"], [class*="upsell"]';
const STABLE = (c) => c && c.length <= 40 && !/\d{3,}/.test(c) && !/^(js-|is-|has-|active|show|hidden|d-|col-|row|mb-|mt-|p-|m-|text-|fw-|fs-)/.test(c) && /^[a-z][\w-]*$/i.test(c);

const priceOf = ($el) => {
  for (const a of ['content', 'data-price', 'data-value', 'value']) {
    const v = $el.attr(a);
    if (v != null && v !== '') {
      const p = parsePrice(v, { dotDecimal: /^\d+(\.\d+)?$/.test(v.trim()) });
      if (p != null) return p;
    }
  }
  const t = $el.text().replace(/\s+/g, ' ').trim();
  if (!t.length || t.length > 40) return null;
  const m = /\d{1,3}(?:[.\s]\d{3})*,\d{2}|\d+,\d{2}|\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}|\d+(?=\s*(?:€|EUR|,-))/.exec(t);
  return m ? parsePrice(m[0].replace(/\s/g, '')) : null;
};

function selectorFor($, el) {
  const $el = $(el);
  const tag = el.tagName.toLowerCase();
  const out = [];
  const ip = $el.attr('itemprop');
  if (ip) out.push(`${tag}[itemprop="${ip}"]`);
  for (const a of ['data-price', 'data-testid', 'data-qa']) if ($el.attr(a) != null && a !== 'data-price') out.push(`${tag}[${a}="${$el.attr(a)}"]`);
  if ($el.attr('data-price') != null) out.push(`${tag}[data-price]`);
  const id = $el.attr('id');
  if (id && STABLE(id)) out.push(`#${id}`);
  const cls = String($el.attr('class') ?? '').split(/\s+/).filter(STABLE).filter((c) => !BAD_CLASS.test(c)).slice(0, 3);
  if (cls.length) {
    out.push(`${tag}.${cls.join('.')}`);
    const parent = $el.parent();
    const pcls = String(parent.attr('class') ?? '').split(/\s+/).filter(STABLE).filter((c) => !BAD_CLASS.test(c)).slice(0, 2);
    if (pcls.length) out.push(`.${pcls.join('.')} > ${tag}.${cls.join('.')}`);
  }
  return out;
}

/** Selektoren ableiten, die auf dieser Seite genau den bekannten Preis liefern. */
export function deriveTemplates(html, price) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();
  const hits = [];
  $('body *').each((_, el) => {
    const $el = $(el);
    if ($el.closest(BAD_ANCESTOR).length) return;
    if (BAD_CLASS.test(String($el.attr('class') ?? ''))) return;
    if ($el.children().length > 3) return; // nur kleine Elemente nahe am Preis
    const p = priceOf($el);
    if (p == null || Math.abs(p - price) > 0.005) return;
    hits.push(el);
  });
  // Nur die innerste Stelle: Container, die einen anderen Treffer enthalten, fallen weg
  const leaves = hits.filter((el) => !hits.some((o) => o !== el && $(el).find(o).length));
  const out = [];
  for (const el of leaves) {
    for (const sel of selectorFor($, el)) {
      if (out.includes(sel)) continue;
      let first;
      try { first = $(sel).first(); } catch { continue; }
      if (!first.length || first[0] !== el) continue; // Selektor muss genau diese Stelle als erste treffen
      out.push(sel);
    }
  }
  // Attribut-Selektoren (itemprop, data-*) sind am stabilsten, dann IDs, dann Klassen
  const rank = (s) => (s.includes('[') ? 0 : s.startsWith('#') ? 1 : s.includes('>') ? 3 : 2);
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, 2);
}

/** Vorlagen der Reihe nach probieren (beste zuerst). Liefert { price, selector } oder null. */
export function applyTemplates(html, templates) {
  if (!templates?.length) return null;
  const $ = cheerio.load(html);
  for (const t of templates) {
    let el;
    try { el = $(t.selector).first(); } catch { continue; }
    if (!el.length || el.closest('del, s, strike').length) continue;
    const p = priceOf(el);
    if (p != null && p > 0) return { price: p, selector: t.selector };
  }
  return null;
}

export function loadTemplates(db, compId) {
  try { return JSON.parse(db.prepare('SELECT templates FROM competitors WHERE id=?').get(compId)?.templates || '[]'); } catch { return []; }
}
const save = (db, compId, list) => db.prepare('UPDATE competitors SET templates=? WHERE id=?').run(list.length ? JSON.stringify(list) : null, compId);

/** Neue Vorlagen übernehmen (ohne Dubletten, höchstens fünf, die erfolgreichsten bleiben). */
export function learnTemplates(db, compId, selectors, { source = 'ki', url = null } = {}) {
  const list = loadTemplates(db, compId);
  let added = 0;
  for (const selector of selectors) {
    if (list.some((t) => t.selector === selector)) continue;
    list.push({ selector, source, url, created: new Date().toISOString(), hits: 0, fails: 0 });
    added++;
  }
  list.sort((a, b) => b.hits - b.fails - (a.hits - a.fails));
  save(db, compId, list.slice(0, MAX_TEMPLATES));
  return added;
}

/** Treffer bzw. Fehlschläge zählen; Vorlagen, die öfter scheitern als treffen, fallen nach fünf Fehlschlägen weg. */
export function scoreTemplates(db, compId, usedSelector) {
  const list = loadTemplates(db, compId);
  if (!list.length) return;
  for (const t of list) {
    if (t.selector === usedSelector) { t.hits++; t.last_hit = new Date().toISOString(); break; }
    t.fails++;
  }
  const kept = list.filter((t) => !(t.fails >= 5 && t.fails > t.hits * 2));
  kept.sort((a, b) => b.hits - b.fails - (a.hits - a.fails));
  save(db, compId, kept);
}

export function removeTemplate(db, compId, selector) {
  save(db, compId, loadTemplates(db, compId).filter((t) => t.selector !== selector));
}
