import * as cheerio from 'cheerio';
import { chatJson } from './ai.js';

/**
 * KI-gestütztes Auslesen von Mitbewerber-Seiten (Prinzip wie bei AI-Scrapern):
 * Die Seite wird auf das Wesentliche reduziert, das Sprachmodell liefert strukturierte Daten.
 * Ohne Browser: JavaScript-lastige Shops, die ihre Inhalte erst im Browser laden, sieht die KI nicht.
 */

export const CONFIDENT = 0.85;
const MAX_CALLS = () => Number(process.env.AI_MAX_CALLS_PER_RUN || 400);
const budget = { calls: 0 };
export const resetAiBudget = () => { budget.calls = 0; };
export const aiBudgetLeft = () => budget.calls < MAX_CALLS();

const SKIP_PATH = /(login|anmeld|konto|account|warenkorb|cart|checkout|merkzettel|wishlist|impressum|agb|datenschutz|kontakt|versand|widerruf|newsletter|blog|ratgeber)/i;

function clean($) {
  $('script,style,noscript,svg,iframe,nav,footer,header,form[action*="newsletter"]').remove();
}

/** Seite für die KI aufbereiten: Titel, strukturierte Daten, sichtbarer Text. */
export function pageDigest(html, { maxText = 6000 } = {}) {
  const $ = cheerio.load(html);
  const ld = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t) ld.push(t.slice(0, 2000));
  });
  const meta = [];
  $('meta[property^="product:"],meta[property^="og:title"],meta[itemprop="price"],meta[itemprop="gtin13"],meta[itemprop="sku"]').each((_, el) => {
    meta.push(`${$(el).attr('property') || $(el).attr('itemprop')}=${$(el).attr('content')}`);
  });
  const title = $('title').first().text().trim();
  clean($);
  const text = $('main').length ? $('main').text() : $('body').text();
  return { title, ld: ld.join('\n').slice(0, 3500), meta: meta.join('\n'), text: text.replace(/\s+/g, ' ').trim().slice(0, maxText) };
}

/** Verlinkte Treffer einer Suchergebnisseite (mit Umfeldtext) für die Auswahl durch die KI. */
export function linkList(html, baseUrl, { max = 40 } = {}) {
  const $ = cheerio.load(html);
  clean($);
  const base = new URL(baseUrl);
  const seen = new Set();
  const out = [];
  $('a[href]').each((_, el) => {
    if (out.length >= max) return false;
    let u;
    try { u = new URL($(el).attr('href'), base); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || u.hostname !== base.hostname) return;
    u.hash = '';
    if (u.pathname === '/' || u.pathname === base.pathname || SKIP_PATH.test(u.pathname)) return;
    const url = u.toString();
    if (seen.has(url)) return;
    const a = $(el);
    const text = (a.text() || a.attr('title') || a.find('img').attr('alt') || '').replace(/\s+/g, ' ').trim();
    if (text.length < 4) return;
    const ctx = a.closest('li,article,.product-box,.product,[class*="product"],[class*="item"]').first().text().replace(/\s+/g, ' ').trim();
    seen.add(url);
    out.push({ url, text: text.slice(0, 120), context: (ctx || text).slice(0, 220) });
  });
  return out;
}

const productInfo = (p) => ({ name: p.name, brand: p.manufacturer, article_number: p.number, ean: p.ean, manufacturer_number: p.mpn });

const PICK_SYSTEM = `Du hilfst bei einem Preisvergleich für einen deutschen Onlineshop. Du bekommst unser Produkt und eine nummerierte Liste von Links einer Suchergebnisseite eines Mitbewerbers.
Wähle den Link, der DASSELBE Produkt zeigt (gleiche Marke, Serie, Maße, Farbe/Oberfläche, Ausführung, gleicher Set-Umfang). Zubehör, Ersatzteile und ähnliche Produkte sind ein anderes Produkt.
Passt keiner sicher, gib index null zurück. Antworte mit {"index": Zahl oder null, "confidence": 0..1, "reason": "max. 120 Zeichen"}`;

export async function aiPick(cfg, product, links) {
  if (!links.length || !aiBudgetLeft()) return null;
  budget.calls++;
  const { data } = await chatJson(cfg, PICK_SYSTEM, { product: productInfo(product), links: links.map((l, i) => ({ index: i, text: l.text, context: l.context })) });
  const i = Number.isInteger(data.index) ? data.index : null;
  if (i == null || i < 0 || i >= links.length) return null;
  return { url: links[i].url, confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0)), reason: String(data.reason ?? '').slice(0, 140) };
}

const EXTRACT_SYSTEM = `Du liest die Produktseite eines Onlineshops für einen Preisvergleich aus. Du bekommst unser Produkt zum Vergleich und den Inhalt der Seite (Titel, strukturierte Daten, sichtbarer Text).
Regeln:
- is_product_page: true nur, wenn die Seite ein einzelnes Produkt mit Preis zeigt (keine Liste, keine Kategorie).
- price: aktueller Brutto-Verkaufspreis des Hauptprodukts in EUR als Zahl mit Punkt (kein UVP/Streichpreis, keine Versandkosten, keine Preise von Zubehör oder "Ähnliche Produkte"). Nur Zahlen, die auf der Seite stehen. Unsicher: null.
- same_product: ob es dasselbe Produkt wie unseres ist (Marke, Serie/Modell, Maße, Farbe, Ausführung, Set-Umfang). Eine übereinstimmende EAN oder Herstellernummer ist ein starkes Indiz.
- confidence: 0..1 für same_product. Reichen die Angaben nicht, niedrig ansetzen.
- availability: "in_stock", "out_of_stock" oder null.
Antworte mit {"is_product_page": bool, "title": "...", "price": Zahl|null, "availability": "...", "same_product": bool, "confidence": 0..1, "reason": "max. 140 Zeichen"}`;

/** Ist der Preis tatsächlich auf der Seite belegt? Schützt vor erfundenen Zahlen. */
export function priceInText(price, ...texts) {
  let t = texts.join(' \n ');
  for (let i = 0; i < 3; i++) t = t.replace(/(\d)[.\s](\d{3})(?!\d)/g, '$1$2'); // Tausendertrenner
  const fixed = price.toFixed(2);
  const forms = [fixed, fixed.replace('.', ',')];
  if (Number.isInteger(price)) forms.push(String(price));
  return forms.some((f) => new RegExp(`(^|[^\\d.,])${f.replace('.', '\\.')}(?![\\d])`).test(t));
}

export async function aiExtract(cfg, product, digest, url) {
  if (!aiBudgetLeft()) return null;
  budget.calls++;
  const { data } = await chatJson(cfg, EXTRACT_SYSTEM, { our_product: productInfo(product), page: { url, ...digest } });
  const price = typeof data.price === 'number' && Number.isFinite(data.price) && data.price > 0 ? Math.round(data.price * 100) / 100 : null;
  const grounded = price != null && priceInText(price, digest.text, digest.ld, digest.meta);
  return {
    isProductPage: data.is_product_page === true,
    title: String(data.title ?? digest.title ?? '').slice(0, 300) || null,
    price: grounded ? price : null,
    priceUngrounded: price != null && !grounded,
    availability: ['in_stock', 'out_of_stock'].includes(data.availability) ? data.availability : null,
    same: data.same_product === true,
    confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0)),
    reason: String(data.reason ?? '').slice(0, 140),
  };
}

/** Urteil der KI als gleiche Stufen wie die Regelprüfung. */
export const aiVerdict = (r) => (r.same && r.confidence >= CONFIDENT ? 'match' : r.same && r.confidence >= 0.5 ? 'maybe' : 'no');
export const aiNote = (r) => `KI (${Math.round(r.confidence * 100)} %): ${r.same ? 'passt' : 'passt nicht'} – ${r.reason}`.slice(0, 220);
