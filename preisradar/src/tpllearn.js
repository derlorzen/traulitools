import { loadPage } from './scraper.js';
import { extractProduct } from './extract.js';
import { learnShopTemplate, applyShopTemplate } from './shoptemplate.js';
import { normId } from './util.js';

/**
 * Auslese-Vorlage für einen Mitbewerber anlernen: Beispielseite laden (robots.txt und Tempo wie beim Abruf),
 * Preisquelle sowie Stellen für EAN/Herstellernummer bestimmen, an bis zu vier weiteren Produktseiten des Shops
 * gegenprüfen und speichern. Ohne KI.
 */
export async function learnCompetitorTemplate(db, compId, { url, price = null, save = true, checkUrls = null } = {}) {
  const comp = db.prepare('SELECT * FROM competitors WHERE id=?').get(compId);
  if (!comp) throw Object.assign(new Error('Mitbewerber nicht gefunden'), { status: 404 });
  if (!/^https?:\/\//i.test(url ?? '')) throw Object.assign(new Error('Bitte die Adresse einer Produktseite angeben'), { status: 400 });
  const page = await loadPage(url);
  if (page.blocked) throw Object.assign(new Error('Die robots.txt des Shops erlaubt diese Seite nicht'), { status: 400 });
  if (page.gone) throw Object.assign(new Error('Seite nicht gefunden (HTTP 404)'), { status: 400 });
  const html = page.r.text;
  const base = extractProduct(html);
  const jsonld = base.source === 'jsonld' ? { price: base.price } : null;

  // Bekannte Werte: eigener Artikel, der zu dieser Seite gehört (über die Seite selbst oder einen vorhandenen Treffer)
  const known = { price: price != null && price !== '' ? Number(String(price).replace(',', '.')) : null };
  const prod = productFor(db, comp.id, url, base);
  if (prod) { known.ean = prod.ean; known.mpn = prod.mpn; }

  const learned = learnShopTemplate(html, { known, jsonld });
  const result = { url: page.r.finalUrl ?? url, notes: learned.notes, candidates: learned.candidates, product: prod?.name ?? null, saved: false };
  if (!learned.tpl) return { ...result, ok: false, message: known.price == null ? 'Kein eindeutiger Preis gefunden: bitte den angezeigten Preis angeben.' : 'Der angegebene Preis wurde auf der Seite nicht gefunden.' };

  const tpl = { ...learned.tpl, sample: { url: result.url, price: known.price ?? jsonld?.price ?? null, ean: known.ean ?? null, mpn: known.mpn ?? null }, created: new Date().toISOString() };
  tpl.check = await checkTemplate(db, comp, tpl, { exclude: [url, result.url], urls: checkUrls });
  result.check = tpl.check;
  result.tpl = tpl;
  result.ok = tpl.check.total === 0 || tpl.check.ok >= Math.ceil(tpl.check.total / 2);
  if (!result.ok) result.message = `Die Vorlage passt nur auf ${tpl.check.ok} von ${tpl.check.total} weiteren Seiten und wurde nicht gespeichert.`;
  if (save && result.ok) {
    db.prepare('UPDATE competitors SET extract_tpl=? WHERE id=?').run(JSON.stringify(tpl), comp.id);
    result.saved = true;
  }
  return result;
}

function productFor(db, compId, url, ext) {
  const m = db.prepare('SELECT p.* FROM matches m JOIN products p ON p.id=m.product_id WHERE m.competitor_id=? AND m.url=?').get(compId, url);
  if (m) return m;
  for (const id of ext.ids) {
    if (id.length < 6) continue;
    const p = db.prepare("SELECT * FROM products WHERE ean=? OR REPLACE(REPLACE(UPPER(mpn),'-',''),' ','')=? LIMIT 1").get(id, id);
    if (p) return p;
  }
  // EAN/Herstellernummer eigener Artikel im Seitentext (nur für die Seite selbst, daher günstig genug)
  const rows = db.prepare("SELECT * FROM products WHERE tracked=1 AND (ean IS NOT NULL AND ean<>'' OR mpn IS NOT NULL AND mpn<>'')").all();
  for (const p of rows) {
    const e = normId(p.ean);
    if (e.length >= 8 && ext.bodyText.includes(e)) return p;
  }
  return null;
}

/** Vorlage an weiteren Produktseiten des Shops prüfen: bekannte Treffer zuerst, sonst Adressen aus der Sitemap. */
export async function checkTemplate(db, comp, tpl, { exclude = [], limit = 4, urls = null } = {}) {
  let list = urls ?? db.prepare("SELECT url, price FROM matches WHERE competitor_id=? AND url IS NOT NULL AND status IN ('ok','review') ORDER BY last_checked DESC LIMIT 20").all(comp.id);
  list = list.map((x) => (typeof x === 'string' ? { url: x, price: null } : x)).filter((x) => !exclude.includes(x.url));
  if (list.length < limit && !urls) {
    const sm = db.prepare('SELECT url FROM sitemap_urls WHERE competitor_id=? ORDER BY RANDOM() LIMIT 12').all(comp.id);
    for (const s of sm) if (!exclude.includes(s.url) && !list.some((x) => x.url === s.url)) list.push({ url: s.url, price: null });
  }
  const pages = [];
  for (const it of list) {
    if (pages.length >= limit) break;
    let p;
    try { p = await loadPage(it.url); } catch (e) { pages.push({ url: it.url, ok: false, error: e.message }); continue; }
    if (!p.r) continue;
    const base = extractProduct(p.r.text);
    if (!base.isProductPage && base.price == null && !/\b(in den warenkorb|add to cart)\b/i.test(p.r.text)) continue; // keine Produktseite (Kategorie o. Ä.)
    const t = applyShopTemplate(p.r.text, tpl, base.source === 'jsonld' ? base.price : null);
    const priceOk = t?.price != null && (it.price == null || Math.abs(t.price - it.price) / it.price < 0.15);
    pages.push({ url: it.url, ok: priceOk, ids: t?.ids.size ?? 0, price: t?.price ?? null, expected: it.price ?? null, ean: t?.ean ?? null, mpn: t?.mpn ?? null });
  }
  return { at: new Date().toISOString(), ok: pages.filter((x) => x.ok).length, total: pages.length, with_ids: pages.filter((x) => x.ids > 0).length, pages };
}
