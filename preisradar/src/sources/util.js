/** Hilfsfunktionen zum toleranten Lesen der Ergebnisse verschiedener Apify-Actors. */

/** Zahl aus „87,99“, „1.234,56 €“, „4.95“ oder 87.99; null, wenn keine Zahl erkennbar. */
export function money(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (typeof v === 'object') return money(v.value ?? v.amount ?? v.price ?? null);
  const m = String(v).replace(/\s/g, '').match(/-?\d[\d.,]*/);
  if (!m) return /kostenlos|gratis|frei|free/i.test(String(v)) ? 0 : null;
  let s = m[0];
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
export const first = (...v) => v.find((x) => x != null && x !== '');
export const digits = (v) => String(v ?? '').replace(/\D/g, '');
export const r2 = (v) => Math.round(v * 100) / 100;

/** Marktplätze in Händlernamen erkennen (für Kennzeichnung und damit sie nicht als Mitbewerber vorgeschlagen werden). */
export const MARKETPLACES = [['amazon', /\bamazon\b/i], ['ebay', /\bebay\b/i], ['kaufland', /\bkaufland\b/i], ['otto', /\botto(\.de)?\b/i], ['manomano', /\bmanomano\b/i]];
export const marketplaceOf = (text) => MARKETPLACES.find(([, re]) => re.test(text))?.[0] ?? null;

/** Ein Angebot mit Händler, Preis, Versand und Gesamtpreis aus den gängigen Feldnamen lesen. */
export function normOffer(o, i) {
  const total = money(first(o.total_price, o.totalPrice, o.total, o.priceWithShipping));
  let shipping = money(first(o.shippingCost, o.shipping_cost, o.shipping));
  if (shipping == null && (o.shipping_included === true || o.shippingIncluded === true)) shipping = 0;
  if (shipping == null) shipping = money(first(o.shipping_cost_text, o.shippingText));
  let price = money(first(o.price, o.price_text, o.priceText, o.formattedPrice));
  if (price == null && total != null && shipping != null) price = r2(total - shipping);
  const t = total ?? (price != null ? r2(price + (shipping ?? 0)) : null);
  const shop = String(first(o.shop, o.shopName, o.merchantName, o.merchant, o.seller, o.sellerName, '') ?? '').trim();
  if (!shop || t == null || !(t > 0)) return null;
  return {
    position: Number(first(o.position, i + 1)), shop, shop_id: first(o.shop_id, o.shopId, o.sellerId) != null ? String(first(o.shop_id, o.shopId, o.sellerId)) : null,
    price: price ?? t, shipping, total: t, delivery: String(first(o.delivery, o.deliveryText, o.deliveryStatusLabel, o.deliveryTime, '') ?? '').slice(0, 120) || null,
    marketplace: marketplaceOf(`${shop} ${o.marketplaceName ?? ''}`), url: first(o.url, o.offerUrl, o.link) ?? null,
  };
}
