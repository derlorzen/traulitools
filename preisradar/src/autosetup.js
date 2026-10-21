import { fetchText, robotsAllows } from './fetcher.js';
import { extractProduct, findCandidates } from './extract.js';
import { discoverSitemaps } from './sitemap.js';
import { pageDigest, aiExtract } from './aiscrape.js';
import { sleep } from './util.js';

/**
 * Mitbewerber per Produktlink einrichten: Shop-Name, Art der Preiserkennung, funktionierende Such-URL
 * (nur wenn robots.txt sie erlaubt und sie das Produkt wirklich findet) und Sitemaps werden ermittelt.
 */

const SEARCH_PATTERNS = [
  '/search?search={q}', // Shopware 6
  '/search?q={q}',
  '/suche?q={q}',
  '/suche/?query={q}',
  '/search/?query={q}',
  '/catalogsearch/result/?q={q}', // Magento
  '/?s={q}&post_type=product', // WooCommerce
  '/search?type=product&q={q}', // Shopify
  '/index.php?route=product/search&search={q}', // OpenCart
  '/suche?sSearch={q}', // Shopware 5
  '/search?sSearch={q}',
];

const hostName = (u) => new URL(u).hostname.replace(/^www\./, '');
const samePath = (a, b) => { try { return new URL(a).pathname.replace(/\/+$/, '') === new URL(b).pathname.replace(/\/+$/, ''); } catch { return false; } };

export async function autoSetup(productUrl, { ai = null, delayMs = Math.max(Number(process.env.MIN_DELAY_MS ?? 1000), 0) } = {}) {
  let u;
  try { u = new URL(productUrl); } catch { throw Object.assign(new Error('Produkt-URL ungültig (mit https:// angeben)'), { status: 400 }); }
  const base = u.origin;
  const out = { name: hostName(productUrl), base_url: base, product: null, price_method: null, search_url: null, sitemaps: [], ai_mode: 'fallback', notes: [] };

  if (!(await robotsAllows(productUrl))) {
    out.notes.push('Die robots.txt untersagt den Abruf dieser Produktseite.');
    return out;
  }
  const page = await fetchText(productUrl);
  if (page.finalUrl !== productUrl && !(await robotsAllows(page.finalUrl))) {
    out.notes.push('Die Produktseite leitet auf eine laut robots.txt gesperrte Seite weiter.');
    return out;
  }
  if (page.status >= 400) {
    out.notes.push(`Die Produktseite antwortet mit HTTP ${page.status}.`);
    return out;
  }

  // 1) Preis: Regeln (JSON-LD, Meta, Microdata), sonst KI
  const ext = extractProduct(page.text);
  if (ext.found) {
    out.product = { title: ext.title, price: ext.price, ids: [...ext.ids].slice(0, 6) };
    out.price_method = { jsonld: 'JSON-LD (strukturierte Daten)', meta: 'Meta-Tags', microdata: 'Microdata' }[ext.source] ?? ext.source;
  } else if (ai) {
    try {
      const a = await aiExtract(ai.cfg, { name: '', manufacturer: null, number: null, ean: null, mpn: null }, pageDigest(page.text), page.finalUrl);
      if (a?.price != null) {
        out.product = { title: a.title, price: a.price, ids: [] };
        out.price_method = 'KI (kein Selektor nötig)';
        out.ai_mode = 'always';
      }
    } catch (e) {
      out.notes.push(`KI-Auslesen fehlgeschlagen: ${e.message}`);
    }
  }
  if (!out.product) out.notes.push('Auf der Seite wurde kein Preis erkannt. Ein Preis-Selektor oder die KI (OpenAI-Zugang) wird benötigt.');

  // 2) Sitemaps
  try { out.sitemaps = (await discoverSitemaps(base)).filter((x) => hostName(x.url) === hostName(base) && !/magazin|blog|document/i.test(x.url)); } catch { /* optional */ }

  // 3) Such-URL: Produkt über Kennung (EAN o. ä.) oder Titel suchen, Treffer muss die Ausgangsseite enthalten
  const query = out.product?.ids?.find((x) => /^\d{8,14}$/.test(x)) ?? out.product?.ids?.[0] ?? String(out.product?.title ?? '').split(/\s+/).slice(0, 4).join(' ');
  if (query) {
    let blocked = 0;
    for (const pat of SEARCH_PATTERNS) {
      const tpl = base + pat;
      const url = tpl.replace('{q}', encodeURIComponent(query));
      try {
        if (!(await robotsAllows(url))) { blocked++; continue; }
        await sleep(delayMs);
        const r = await fetchText(url);
        if (r.finalUrl !== url && !(await robotsAllows(r.finalUrl))) { blocked++; continue; }
        if (r.status >= 400) continue;
        const links = findCandidates(r.text, r.finalUrl, {});
        if (samePath(r.finalUrl, productUrl) || links.some((l) => samePath(l, productUrl))) { out.search_url = tpl; break; }
      } catch { /* nächstes Muster */ }
    }
    if (!out.search_url) out.notes.push(blocked ? 'Keine nutzbare Suche gefunden (gesperrt oder per JavaScript geladen).' : 'Keine Such-URL gefunden, die das Produkt findet.');
  } else {
    out.notes.push('Ohne Kennung oder Titel kann keine Suche getestet werden.');
  }

  if (!out.search_url && !out.sitemaps.length) out.notes.push('Weder Suche noch Sitemap nutzbar. Produkt-URLs lassen sich nur manuell hinterlegen.');
  else if (!out.search_url) out.notes.push('Zuordnung läuft über die Sitemap.');
  return out;
}
