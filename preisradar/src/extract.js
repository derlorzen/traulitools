import * as cheerio from 'cheerio';
import { normId, parsePrice } from './util.js';

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const typesOf = (n) => asArray(n?.['@type']).map(String);

function collectNodes(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => collectNodes(n, out));
  out.push(node);
  if (node['@graph']) collectNodes(node['@graph'], out);
}

export function jsonLdNodes($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      collectNodes(JSON.parse(raw), out);
    } catch {
      try {
        collectNodes(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ')), out);
      } catch {
        /* defektes JSON-LD ignorieren */
      }
    }
  });
  return out;
}

function offerPrices(offers) {
  const prices = [];
  let currency = null;
  let availability = null;
  for (const o of asArray(offers)) {
    if (!o || typeof o !== 'object') continue;
    const cands = [o.price, o.lowPrice, o.priceSpecification?.price, ...asArray(o.priceSpecification).map((p) => p?.price)];
    for (const c of cands) {
      const p = parsePrice(c, { dotDecimal: true });
      if (p != null && p > 0) {
        prices.push(p);
        break;
      }
    }
    currency ||= o.priceCurrency || o.priceSpecification?.priceCurrency || null;
    availability ||= o.availability || null;
    if (o.offers) {
      const sub = offerPrices(o.offers);
      prices.push(...sub.prices);
      currency ||= sub.currency;
      availability ||= sub.availability;
    }
  }
  return { prices, currency, availability };
}

function mapAvailability(a) {
  const s = String(a ?? '').toLowerCase();
  if (!s) return null;
  if (s.includes('instock') || s.includes('limitedavailability') || s.includes('onlineonly')) return 'in_stock';
  if (s.includes('outofstock') || s.includes('soldout') || s.includes('discontinued')) return 'out_of_stock';
  if (s.includes('preorder') || s.includes('backorder')) return 'preorder';
  return 'other';
}

/**
 * Produktdaten aus einer HTML-Seite lesen.
 * Reihenfolge: eigener CSS-Selektor, JSON-LD Product, Open-Graph/Meta, Microdata.
 */
export function extractProduct(html, { priceSelector } = {}) {
  const $ = cheerio.load(html);
  const nodes = jsonLdNodes($);
  const product = nodes.find((n) => typesOf(n).includes('Product'));

  const ids = new Set();
  let title = null;
  let price = null;
  let currency = null;
  let availability = null;
  let source = null;

  if (product) {
    for (const k of ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'ean', 'mpn', 'sku', 'productID']) {
      const v = product[k];
      if (v != null && typeof v !== 'object') ids.add(normId(v));
    }
    title = product.name ? String(product.name) : null;
    const o = offerPrices(product.offers);
    if (o.prices.length) {
      price = Math.min(...o.prices);
      source = 'jsonld';
    }
    currency = o.currency;
    availability = mapAvailability(o.availability);
  }

  if (priceSelector) {
    const el = $(priceSelector).first();
    const p = parsePrice(el.attr('content') ?? el.text());
    if (p != null) {
      price = p;
      source = 'selector';
    }
  }

  if (price == null) {
    const metaSel = [
      'meta[property="product:price:amount"]',
      'meta[property="og:price:amount"]',
      'meta[itemprop="price"]',
      '[itemprop="price"]',
    ];
    for (const sel of metaSel) {
      const el = $(sel).first();
      if (!el.length) continue;
      const raw = el.attr('content') ?? el.attr('value') ?? el.text();
      const p = parsePrice(raw, { dotDecimal: el.attr('content') != null });
      if (p != null && p > 0) {
        price = p;
        source = 'meta';
        break;
      }
    }
    if (price != null && !availability) {
      const av = $('[itemprop="availability"]').first();
      availability = mapAvailability(av.attr('href') ?? av.attr('content') ?? av.text());
    }
  }

  const h1 = $('h1').first().text();
  title ||= $('meta[property="og:title"]').attr('content') || h1 || $('title').text() || null;
  title = title ? title.replace(/\s+/g, ' ').trim() : null;

  for (const sel of ['[itemprop="gtin13"]', '[itemprop="gtin"]', '[itemprop="mpn"]', '[itemprop="sku"]']) {
    $(sel).each((_, el) => {
      const v = $(el).attr('content') ?? $(el).text();
      if (v) ids.add(normId(v));
    });
  }
  ids.delete('');

  const headText = normId(
    [title, h1, $('title').text(), $('meta[name="description"]').attr('content'), $('meta[property="og:title"]').attr('content')].join(' '),
  );
  $('script, style, noscript').remove();
  const bodyText = normId($('body').text()).slice(0, 600000);

  return {
    found: price != null,
    isProductPage: Boolean(product) || source === 'meta',
    title,
    price,
    currency,
    availability,
    source,
    ids,
    headText,
    bodyText,
  };
}

const SKIP_PATH = /\/(account|checkout|cart|warenkorb|wishlist|merkzettel|login|register|kontakt|impressum|datenschutz|agb|search|suche|widgets|navigation)(\/|$|\?)/i;
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|pdf|css|js|ico|zip)(\?|$)/i;

/** Kandidaten-Links für Produktseiten aus einer Suchergebnisseite lesen. */
export function findCandidates(html, baseUrl, { resultSelector, limit = 6 } = {}) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const host = (h) => h.replace(/^www\./, '');
  const seen = new Set();
  const urls = [];
  const add = (href) => {
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    let u;
    try {
      u = new URL(href, baseUrl);
    } catch {
      return;
    }
    u.hash = '';
    if (host(u.hostname) !== host(base.hostname)) return;
    if (SKIP_PATH.test(u.pathname) || SKIP_EXT.test(u.pathname)) return;
    if (u.pathname === '/' || u.pathname === base.pathname) return;
    const key = u.toString();
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(key);
  };

  if (resultSelector) {
    $(resultSelector).each((_, el) => add($(el).attr('href') || $(el).find('a[href]').first().attr('href')));
  } else {
    for (const n of jsonLdNodes($)) {
      if (typesOf(n).includes('ItemList')) {
        for (const it of asArray(n.itemListElement)) add(it?.url || it?.item?.url || (typeof it?.item === 'string' ? it.item : null));
      }
    }
    if (!urls.length) {
      $('[itemtype*="schema.org/Product"] a[href], [class*="product"] a[href], [class*="Product"] a[href], article a[href]').each((_, el) => add($(el).attr('href')));
    }
  }
  return urls.slice(0, limit);
}
