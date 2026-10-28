/**
 * Kanal-Rechner (aus dem Marktschreier übernommen): Gewinn je Verkauf, Marge, Preisuntergrenze und Zielpreis
 * je Verkaufskanal (eigener Shop, eBay, Amazon) aus Bruttopreis, Mehrwertsteuer, Gebühren, Versand und Netto-EK.
 *
 *   Gewinn = Preis / (1 + MwSt) − Preis × Gebühr% − feste Gebühr − Versand − EK netto
 *   Marge  = Gewinn in % vom Nettopreis
 *
 * Gebühren gelten auf den Bruttopreis (so rechnen eBay und Amazon die Provision vom Gesamtbetrag).
 */
export const DEFAULT_CHANNELS = [
  { key: 'shop', name: 'Eigener Shop', fee_percent: 1.5, fee_fixed: 0, shipping_cost: 0, target_margin: 25, min_profit: 3, ending: '99', active: 1, position: 1 },
  { key: 'ebay', name: 'eBay', fee_percent: 11, fee_fixed: 0.35, shipping_cost: 0, target_margin: 20, min_profit: 3, ending: '99', active: 1, position: 2 },
  { key: 'amazon', name: 'Amazon', fee_percent: 15, fee_fixed: 0, shipping_cost: 0, target_margin: 20, min_profit: 3, ending: '99', active: 0, position: 3 },
];
const ENDINGS = ['', '99', '95', '90', '00', '9'];

export function ensureChannels(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO channels(key, name, fee_percent, fee_fixed, shipping_cost, target_margin, min_profit, ending, active, position) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const c of DEFAULT_CHANNELS) ins.run(c.key, c.name, c.fee_percent, c.fee_fixed, c.shipping_cost, c.target_margin, c.min_profit, c.ending, c.active, c.position);
}

export const listChannels = (db) => db.prepare('SELECT * FROM channels ORDER BY position, key').all();
export const channel = (db, key) => db.prepare('SELECT * FROM channels WHERE key=?').get(key) ?? null;

export function updateChannel(db, key, b) {
  const c = channel(db, key);
  if (!c) throw Object.assign(new Error('Unbekannter Kanal'), { status: 404 });
  const num = (v, lo, hi, label) => {
    if (v === undefined || v === '' || v === null) return undefined;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n < lo || n > hi) throw Object.assign(new Error(`${label}: ${lo} bis ${hi}`), { status: 400 });
    return n;
  };
  const next = {
    fee_percent: num(b.fee_percent, 0, 60, 'Gebühr in %') ?? c.fee_percent,
    fee_fixed: num(b.fee_fixed, 0, 100, 'Feste Gebühr') ?? c.fee_fixed,
    shipping_cost: num(b.shipping_cost, 0, 500, 'Versandkosten') ?? c.shipping_cost,
    target_margin: num(b.target_margin, 0, 90, 'Zielmarge') ?? c.target_margin,
    min_profit: num(b.min_profit, 0, 1000, 'Mindestgewinn') ?? c.min_profit,
    ending: b.ending !== undefined && ENDINGS.includes(String(b.ending)) ? String(b.ending) : c.ending,
    active: b.active === undefined ? c.active : b.active === true || b.active === 1 || b.active === '1' || b.active === 'on' ? 1 : 0,
  };
  db.prepare('UPDATE channels SET fee_percent=?, fee_fixed=?, shipping_cost=?, target_margin=?, min_profit=?, ending=?, active=? WHERE key=?')
    .run(next.fee_percent, next.fee_fixed, next.shipping_cost, next.target_margin, next.min_profit, next.ending, next.active, key);
  return channel(db, key);
}

const r2 = (v) => Math.round(v * 100) / 100;
const vatOf = (p) => (p?.tax_rate ?? 19);

/** Gewinn je Verkauf (null ohne EK). */
export function profit(gross, costNet, ch, vat = 19) {
  if (gross == null || costNet == null || !(costNet > 0)) return null;
  const net = gross / (1 + vat / 100);
  return r2(net - gross * (ch.fee_percent / 100) - ch.fee_fixed - ch.shipping_cost - costNet);
}

/** Marge in % vom Nettopreis. */
export function margin(gross, costNet, ch, vat = 19) {
  const p = profit(gross, costNet, ch, vat);
  const net = gross / (1 + vat / 100);
  return p == null || !(net > 0) ? null : Math.round((p / net) * 1000) / 10;
}

/** Kleinster Preis ohne Verlust bzw. mit Mindestgewinn. */
export function floorPrice(costNet, ch, vat = 19, minProfit = ch.min_profit) {
  if (!(costNet > 0)) return null;
  const den = 1 / (1 + vat / 100) - ch.fee_percent / 100;
  return den > 0.01 ? r2((costNet + ch.fee_fixed + ch.shipping_cost + (minProfit ?? 0)) / den) : null;
}

/** Zielpreis nach Zielmarge, mindestens mit Mindestgewinn, auf die gewünschte Endung gerundet. */
export function targetPrice(costNet, ch, vat = 19) {
  if (!(costNet > 0)) return null;
  const vf = 1 + vat / 100;
  const den = (1 - ch.target_margin / 100) / vf - ch.fee_percent / 100;
  let price = den > 0.01 ? (costNet + ch.fee_fixed + ch.shipping_cost) / den : null;
  const min = floorPrice(costNet, ch, vat);
  if (min == null) return null;
  if (price == null || price < min) price = min;
  return roundToEnding(price, ch.ending);
}

/** Kleinster Preis mit der gewünschten Endung, der nicht unter dem Rohpreis liegt. */
export function roundToEnding(price, ending) {
  if (!ending) return r2(price);
  const cents = Number(ending.padStart(2, '0').slice(-2)) / 100;
  if (ending === '9') { const p = Math.ceil(price * 10) / 10 - 0.01; return r2(p < price - 1e-9 ? p + 0.1 : p); }
  if (ending === '00') return Math.ceil(price - 1e-9);
  let p = Math.floor(price) + cents;
  if (p < price - 1e-9) p += 1;
  return r2(p);
}

/**
 * Rechnung für einen Artikel über alle aktiven Kanäle.
 * prices: { shop, ebay, amazon } aktuelle Preise (sofern bekannt); market: günstigster Mitbewerber je Kanal.
 */
export function channelView(db, p, { prices = {}, market = {} } = {}) {
  const vat = vatOf(p);
  const cost = p.purchase_price > 0 ? p.purchase_price : null;
  return listChannels(db).filter((c) => c.active).map((c) => {
    const price = prices[c.key] ?? null;
    const floor = floorPrice(cost, c, vat);
    const mkt = market[c.key] ?? null;
    return {
      key: c.key, name: c.name, price,
      profit: price != null ? profit(price, cost, c, vat) : null,
      margin: price != null ? margin(price, cost, c, vat) : null,
      floor, target: targetPrice(cost, c, vat),
      // Vorschlag: am Markt knapp unter dem Günstigsten, aber nie unter der Untergrenze
      market: mkt,
      suggestion: mkt != null && floor != null ? Math.max(floor, r2(mkt - 0.01)) : null,
      market_reachable: mkt != null && floor != null ? floor <= mkt : null,
      fees: price != null ? r2(price * (c.fee_percent / 100) + c.fee_fixed) : null,
    };
  });
}
