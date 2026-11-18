import { getSetting, setSetting } from './settings.js';

/**
 * idealo-Abgleich über Apify: zu jeder EAN alle Händlerangebote auf idealo.de mit Preis, Versand und Gesamtpreis.
 *
 * Preisradar ruft idealo nicht selbst ab. Ein Apify-Actor (ein fremder, bezahlter Scraper) liefert die Daten, das
 * Apify-Token liegt verschlüsselt in den Einstellungen. Die Actors verschiedener Anbieter liefern unterschiedliche
 * Feldnamen, daher werden Produkte und Angebote hier tolerant gelesen. Kosten werden je Abruf nach dem Tarif des
 * Actors geschätzt und gegen ein Monatsbudget gerechnet; ist es erreicht, pausiert der Abgleich bis zum Monatsende.
 */
export const ACTORS = {
  's-r~idealo-scraper': {
    label: 'Idealo Price Scraper (s-r)', note: 'erprobt, etwa 4,40 $ je 1.000 Artikel', per1000: 4.4, batch: 5,
    input: (eans, country) => ({ eans, country, concurrency: 3 }),
    cost: (runs, found) => runs * 0.002 + found * 0.004,
  },
  'firsthand~idealo-api': {
    label: 'Idealo API (firsthand)', note: 'günstig, etwa 1 $ je 1.000 Artikel, aber noch kaum genutzt', per1000: 1, batch: 25,
    input: (eans, country) => ({ eans, markets: [country], includeOffers: true, maxItems: 0 }),
    cost: (_runs, found) => found * 0.001,
  },
};
export const DEFAULT_ACTOR = 's-r~idealo-scraper';
// Eigener Actor: Eingabe mit den gängigen Feldnamen, Kosten vorsichtig wie beim teuersten bekannten Tarif
const CUSTOM = { label: 'Eigener Actor', note: 'Kosten geschätzt wie s-r', per1000: 4.4, batch: 5, input: (eans, country) => ({ eans, country, markets: [country], includeOffers: true }), cost: (runs, found) => runs * 0.002 + found * 0.004 };

const MARKETPLACES = [['amazon', /\bamazon\b/i], ['ebay', /\bebay\b/i], ['kaufland', /\bkaufland\b/i], ['otto', /\botto(\.de)?\b/i], ['manomano', /\bmanomano\b/i]];

export function idealoConfig(db) {
  const n = (k, d, lo, hi) => { const v = Number(getSetting(db, k)); return getSetting(db, k) != null && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const actorId = (getSetting(db, 'idealo_actor') || DEFAULT_ACTOR).trim().replace('/', '~');
  const token = getSetting(db, 'apify_token') || process.env.APIFY_TOKEN || '';
  return {
    token, actorId, actor: ACTORS[actorId] ?? CUSTOM,
    get configured() { return Boolean(this.token); },
    enabled: getSetting(db, 'idealo_enabled') !== '0',
    country: getSetting(db, 'idealo_country') === 'at' ? 'at' : 'de',
    perDay: n('idealo_per_day', 100, 0, 5000),
    daysA: n('idealo_days_a', 3, 1, 60),
    days: n('idealo_days', 14, 1, 90),
    budget: n('idealo_budget', 10, 0, 10000),
    ownNames: (getSetting(db, 'idealo_own_names') || defaultOwnNames(db)).split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean),
  };
}
function defaultOwnNames(db) {
  const name = getSetting(db, 'own_name') || process.env.OWN_SHOP_NAME || 'BelKai';
  const url = getSetting(db, 'own_url') || process.env.OWN_SHOP_URL || '';
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ohne URL nur der Name */ }
  return [name, host].filter(Boolean).join(', ');
}

const API = () => process.env.APIFY_API_BASE || 'https://api.apify.com';

// ---------- Kosten ----------
const month = () => new Date().toISOString().slice(0, 7);
export function spendMonth(db, service = 'idealo') {
  return db.prepare("SELECT COALESCE(SUM(usd),0) AS usd, COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(units),0) AS units FROM ext_spend WHERE service=? AND day LIKE ? || '%'").get(service, month());
}
const spendToday = (db, service = 'idealo') => db.prepare('SELECT COALESCE(SUM(units),0) AS units FROM ext_spend WHERE service=? AND day=?').get(service, new Date().toISOString().slice(0, 10)).units;
function addSpend(db, service, { calls = 0, units = 0, usd = 0 }) {
  db.prepare(`INSERT INTO ext_spend(day, service, calls, units, usd) VALUES (?,?,?,?,?)
    ON CONFLICT(day, service) DO UPDATE SET calls=calls+excluded.calls, units=units+excluded.units, usd=usd+excluded.usd`).run(new Date().toISOString().slice(0, 10), service, calls, units, usd);
}

// ---------- Apify ----------
async function apify(cfg, method, path, body, timeoutMs = 60000) {
  const res = await fetch(`${API()}${path}`, {
    method, headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* unten */ }
  if (!res.ok) {
    const msg = j?.error?.message || j?.message || `HTTP ${res.status}`;
    const hint = res.status === 401 ? ' (Token ungültig)' : res.status === 402 ? ' (Guthaben oder Tarif reicht nicht)' : res.status === 404 ? ' (Actor nicht gefunden: ID prüfen)' : '';
    throw Object.assign(new Error(`Apify: ${msg}${hint}`), { status: res.status });
  }
  return j;
}

export async function apifyTest(db) {
  const cfg = idealoConfig(db);
  if (!cfg.configured) throw new Error('Kein Apify-Token eingetragen');
  const me = await apify(cfg, 'GET', '/v2/users/me');
  const act = await apify(cfg, 'GET', `/v2/acts/${encodeURIComponent(cfg.actorId)}`).catch((e) => ({ error: e.message }));
  return { ok: true, username: me?.data?.username ?? null, plan: me?.data?.plan?.id ?? null, actor: act?.data ? { id: cfg.actorId, title: act.data.title ?? act.data.name } : { id: cfg.actorId, error: act.error } };
}

/** Einen Actor synchron laufen lassen und die Ergebnisse (Dataset) holen. */
async function runActor(cfg, input) {
  const items = await apify(cfg, 'POST', `/v2/acts/${encodeURIComponent(cfg.actorId)}/run-sync-get-dataset-items?timeout=280&clean=true`, input, 300000);
  return Array.isArray(items) ? items : [];
}

// ---------- Daten lesen (tolerant gegenüber den Feldnamen verschiedener Actors) ----------
/** Zahl aus „87,99“, „1.234,56 €“, „4.95“ oder 87.99; null, wenn keine Zahl erkennbar. */
export function money(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  const m = String(v).replace(/\s/g, '').match(/-?\d[\d.,]*/);
  if (!m) return /kostenlos|gratis|frei|free/i.test(String(v)) ? 0 : null;
  let s = m[0];
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
const first = (...v) => v.find((x) => x != null && x !== '');
const digits = (v) => String(v ?? '').replace(/\D/g, '');

export function normOffer(o, i) {
  const total = money(first(o.total_price, o.totalPrice, o.total, o.priceWithShipping));
  let shipping = money(first(o.shippingCost, o.shipping_cost, o.shipping));
  if (shipping == null && (o.shipping_included === true || o.shippingIncluded === true)) shipping = 0;
  if (shipping == null) shipping = money(first(o.shipping_cost_text, o.shippingText));
  let price = money(first(o.price, o.price_text, o.priceText, o.formattedPrice));
  if (price == null && total != null && shipping != null) price = Math.round((total - shipping) * 100) / 100;
  const t = total ?? (price != null ? Math.round((price + (shipping ?? 0)) * 100) / 100 : null);
  const shop = String(first(o.shop, o.shopName, o.merchantName, o.merchant, o.seller, '') ?? '').trim();
  if (!shop || t == null || !(t > 0)) return null;
  const mp = MARKETPLACES.find(([, re]) => re.test(`${shop} ${o.marketplaceName ?? ''}`));
  return {
    position: Number(first(o.position, i + 1)), shop, shop_id: first(o.shop_id, o.shopId) != null ? String(first(o.shop_id, o.shopId)) : null,
    price: price ?? t, shipping, total: t, delivery: String(first(o.delivery, o.deliveryText, o.deliveryStatusLabel, '') ?? '').slice(0, 120) || null,
    marketplace: mp ? mp[0] : null,
  };
}
export function normProduct(item) {
  const offers = (Array.isArray(item.offers) ? item.offers : []).map(normOffer).filter(Boolean).sort((a, b) => a.total - b.total);
  return {
    ean: digits(first(item.ean, item.gtin, item.matched_gtin, item.searchQuery)),
    idealo_id: first(item.idealo_sku, item.product_id, item.id, item.productId) != null ? String(first(item.idealo_sku, item.product_id, item.id, item.productId)) : null,
    url: first(item.url, item.productUrl) ?? null, title: first(item.title, item.name) ?? null,
    offers, count: Number(first(item.offer_count, item.offersCount, item.offers_count, offers.length)) || offers.length,
  };
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^https?:\/\//, '').replace(/^www\./, '')
  .replace(/\.(de|com|at|eu|net|shop|online)\b.*$/, '').replace(/\b(gmbh|ug|kg|ohg|ag|e\.?k\.?|shop|onlineshop|store|de)\b/g, '').replace(/[^a-z0-9]/g, '');
const hostKey = (u) => { try { return norm(new URL(u).hostname); } catch { return ''; } };
/** idealo-Händler einem angelegten Mitbewerber zuordnen (über Name oder Domain). */
export function competitorMatcher(db) {
  const comps = db.prepare('SELECT id, name, base_url FROM competitors').all().map((c) => ({ id: c.id, keys: [norm(c.name), hostKey(c.base_url)].filter((k) => k.length >= 3) }));
  return (shop) => { const k = norm(shop); if (k.length < 3) return null; return comps.find((c) => c.keys.some((x) => x === k || (x.length >= 5 && (k.includes(x) || x.includes(k)))))?.id ?? null; };
}
const ownMatcher = (cfg) => { const keys = cfg.ownNames.map(norm).filter((k) => k.length >= 3); return (shop) => { const k = norm(shop); return keys.some((x) => x === k || (x.length >= 5 && k.includes(x))); }; };

// ---------- Speichern ----------
function save(db, productId, ean, res, now, { cfg, compOf }) {
  if (!res) {
    db.prepare(`INSERT OR REPLACE INTO idealo_products(product_id, ean, checked_at, found, idealo_id, url, title, offers, min_total, min_shop, own_rank, own_total, next_total, error) VALUES (?,?,?,0,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL)`).run(productId, ean, now);
    db.prepare('DELETE FROM idealo_offers WHERE product_id=?').run(productId);
    return;
  }
  const isOwn = ownMatcher(cfg);
  const offers = res.offers.map((o) => ({ ...o, own: isOwn(o.shop) ? 1 : 0, competitor_id: compOf(o.shop) }));
  const others = offers.filter((o) => !o.own);
  const ownIdx = offers.findIndex((o) => o.own);
  const own = ownIdx >= 0 ? offers[ownIdx] : null;
  // nächstes fremdes Angebot über dem eigenen (für „Luft nach oben“)
  const next = own ? others.find((o) => o.total >= own.total) ?? null : null;
  db.prepare(`INSERT OR REPLACE INTO idealo_products(product_id, ean, checked_at, found, idealo_id, url, title, offers, min_total, min_shop, own_rank, own_total, next_total, error) VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,NULL)`)
    .run(productId, ean, now, res.idealo_id, res.url, res.title, Math.max(res.count, offers.length), others[0]?.total ?? null, others[0]?.shop ?? null, ownIdx >= 0 ? ownIdx + 1 : null, own?.total ?? null, next?.total ?? null);
  db.prepare('DELETE FROM idealo_offers WHERE product_id=?').run(productId);
  const ins = db.prepare('INSERT INTO idealo_offers(product_id, position, shop, shop_id, price, shipping, total, delivery, marketplace, own, competitor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  offers.forEach((o, i) => ins.run(productId, i + 1, o.shop, o.shop_id, o.price, o.shipping, o.total, o.delivery, o.marketplace, o.own, o.competitor_id));
  db.prepare('INSERT OR REPLACE INTO idealo_history(product_id, day, min_total, own_total, offers) VALUES (?,?,?,?,?)').run(productId, now.slice(0, 10), others[0]?.total ?? null, own?.total ?? null, others.length);
}

/** Eine Gruppe von Artikeln (höchstens Stapelgröße des Actors) abgleichen. Gibt { found, missing } zurück. */
export async function lookupBatch(db, products) {
  const cfg = idealoConfig(db);
  if (!cfg.configured) throw new Error('Kein Apify-Token eingetragen');
  const list = products.map((p) => ({ ...p, ean: digits(p.ean) })).filter((p) => p.ean.length >= 8 && p.ean.length <= 14);
  if (!list.length) return { found: 0, missing: 0 };
  const items = await runActor(cfg, cfg.actor.input([...new Set(list.map((p) => p.ean))], cfg.country));
  const byEan = new Map();
  for (const it of items) {
    if (it?.found === false || it?.error) continue;
    const r = normProduct(it);
    // ohne EAN im Ergebnis: bei nur einer angefragten EAN eindeutig
    const ean = r.ean || (list.length === 1 ? list[0].ean : '');
    if (ean && !byEan.has(ean)) byEan.set(ean, r);
    else if (ean) { const a = byEan.get(ean); if (r.offers.length > a.offers.length) byEan.set(ean, r); }
  }
  const now = new Date().toISOString();
  const compOf = competitorMatcher(db);
  let found = 0;
  const strip = (e) => e.replace(/^0+/, '');
  for (const p of list) {
    const r = byEan.get(p.ean) ?? [...byEan.entries()].find(([k]) => strip(k) === strip(p.ean))?.[1] ?? null;
    if (r) found++;
    save(db, p.id, p.ean, r, now, { cfg, compOf });
  }
  addSpend(db, 'idealo', { calls: 1, units: list.length, usd: cfg.actor.cost(1, found) });
  return { found, missing: list.length - found };
}

// ---------- Planung ----------
export const idealoJob = { running: false, stop: false, total: 0, done: 0, found: 0, errors: 0, error: null, startedAt: null, finishedAt: null };
/** Fällige Artikel: mit EAN, beobachtet, online; Prüf-Stufe A öfter, nicht gefundene nach 30 Tagen erneut. */
export function dueIdealo(db, limit) {
  const cfg = idealoConfig(db);
  const now = Date.now();
  return db.prepare(`SELECT p.id, p.ean, p.tier, s.revenue_90, i.checked_at, i.found FROM products p LEFT JOIN product_sales s ON s.product_id=p.id LEFT JOIN idealo_products i ON i.product_id=p.id
    WHERE p.active=1 AND p.tracked=1 AND p.offline_since IS NULL AND p.ean IS NOT NULL AND length(p.ean) >= 8`).all()
    .filter((r) => { if (!r.checked_at) return true; const days = r.found === 0 ? 30 : r.tier === 'A' ? cfg.daysA : cfg.days; return now - Date.parse(r.checked_at) > days * 86400e3 - 3600e3; })
    // nie geprüfte zuerst, dann wichtige Artikel, dann die ältesten
    .sort((a, b) => (a.checked_at ? 1 : 0) - (b.checked_at ? 1 : 0) || (b.tier === 'A') - (a.tier === 'A') || (b.revenue_90 ?? 0) - (a.revenue_90 ?? 0) || String(a.checked_at).localeCompare(String(b.checked_at)))
    .slice(0, limit);
}
export function budgetLeft(db) { const cfg = idealoConfig(db); return cfg.budget - spendMonth(db).usd; }

/** Abgleich starten. ids: bestimmte Artikel (sofort, ohne Tageskontingent, aber mit Budget). */
export function startIdealoJob(db, { ids = null, max = null } = {}) {
  const cfg = idealoConfig(db);
  if (idealoJob.running || !cfg.configured) return false;
  if (budgetLeft(db) <= 0) { idealoJob.error = `Monatsbudget von ${cfg.budget} $ erreicht`; return false; }
  const list = ids?.length
    ? db.prepare(`SELECT id, ean FROM products WHERE id IN (${ids.map(() => '?').join(',')}) AND ean IS NOT NULL AND length(ean) >= 8`).all(...ids)
    : dueIdealo(db, max ?? Math.max(0, cfg.perDay - spendToday(db)));
  if (!list.length) return false;
  Object.assign(idealoJob, { running: true, stop: false, total: list.length, done: 0, found: 0, errors: 0, error: null, startedAt: new Date().toISOString() });
  const size = cfg.actor.batch;
  (async () => {
    for (let i = 0; i < list.length; i += size) {
      if (idealoJob.stop) break;
      if (budgetLeft(db) <= 0) { idealoJob.error = `Monatsbudget von ${cfg.budget} $ erreicht`; break; }
      const batch = list.slice(i, i + size);
      try {
        const r = await lookupBatch(db, batch);
        idealoJob.found += r.found;
        setSetting(db, 'idealo_error', '');
      } catch (e) {
        idealoJob.errors++;
        idealoJob.error = e.message;
        setSetting(db, 'idealo_error', `${new Date().toISOString()}|${e.message}`);
        // Zugang, Guthaben oder Actor falsch: sofort aufhören, nicht weiter Geld oder Zeit verbrennen
        if ([401, 402, 403, 404].includes(e.status) || idealoJob.errors >= 3) break;
      }
      idealoJob.done += batch.length;
    }
  })().finally(() => {
    idealoJob.running = false;
    idealoJob.finishedAt = new Date().toISOString();
    setSetting(db, 'idealo_last_run', idealoJob.finishedAt);
  });
  return true;
}

let nextAt = 0;
/** Planer: verteilt das Tageskontingent in kleinen Paketen über den Tag (alle 15 Minuten ein Paket). */
export function idealoTick(db) {
  const cfg = idealoConfig(db);
  if (!cfg.configured || !cfg.enabled || !cfg.perDay || idealoJob.running || Date.now() < nextAt) return;
  const err = getSetting(db, 'idealo_error');
  // nach einem Fehler eine Stunde Pause
  if (err && Date.now() - Date.parse(err.split('|')[0]) < 3600e3) return;
  const left = cfg.perDay - spendToday(db);
  nextAt = Date.now() + 15 * 60e3;
  if (left <= 0) return;
  const slots = Math.max(1, Math.ceil(cfg.perDay / 96)); // 96 Viertelstunden am Tag
  startIdealoJob(db, { max: Math.min(left, Math.max(cfg.actor.batch, slots)) });
}
export const resetIdealoTick = () => { nextAt = 0; };

// ---------- Auswertung ----------
/** Kennzahlen je Artikel aus dem letzten Abgleich (für Preisliste, Signale, Chancen). */
export function idealoMap(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT i.*, p.price AS own_price FROM idealo_products i JOIN products p ON p.id=i.product_id').all()) m.set(r.product_id, idealoView(r));
  return m;
}
export function idealoView(r) {
  if (!r) return null;
  if (!r.found) return { found: false, checked_at: r.checked_at };
  // Vergleich mit dem eigenen idealo-Angebot (inkl. Versand), sonst mit dem Shop-Preis
  const own = r.own_total ?? r.own_price ?? null;
  const gap = own != null && r.min_total ? Math.round(((own - r.min_total) / r.min_total) * 1000) / 10 : null;
  const headroom = r.own_rank === 1 && r.next_total && r.own_total ? Math.round(((r.next_total - r.own_total) / r.own_total) * 1000) / 10 : null;
  return {
    found: true, checked_at: r.checked_at, offers: r.offers, min_total: r.min_total, min_shop: r.min_shop, url: r.url,
    own_rank: r.own_rank, own_total: r.own_total, listed: r.own_rank != null, compare: r.own_total != null ? 'idealo' : 'shop',
    gap_pct: gap, next_total: r.next_total, headroom_pct: headroom,
    kind: gap == null ? 'none' : gap > 0.5 ? 'dearer' : 'cheapest',
  };
}

export function productIdealo(db, productId) {
  const r = db.prepare('SELECT i.*, p.price AS own_price FROM idealo_products i JOIN products p ON p.id=i.product_id WHERE i.product_id=?').get(productId);
  if (!r) return null;
  const offers = db.prepare(`SELECT o.position, o.shop, o.price, o.shipping, o.total, o.delivery, o.marketplace, o.own, o.competitor_id, c.name AS competitor
    FROM idealo_offers o LEFT JOIN competitors c ON c.id=o.competitor_id WHERE o.product_id=? ORDER BY o.total`).all(productId);
  const history = db.prepare('SELECT day, min_total, own_total, offers FROM idealo_history WHERE product_id=? ORDER BY day DESC LIMIT 60').all(productId).reverse();
  return { ...idealoView(r), ean: r.ean, title: r.title, offers_list: offers, history };
}

/** Händler auf idealo, die noch nicht als Mitbewerber angelegt sind: wie oft dabei, wie oft günstiger als du. */
let remapKey = null;
/** Zuordnung Händler → Mitbewerber neu rechnen, wenn sich die Mitbewerber geändert haben (z. B. gerade angelegt). */
export function remapCompetitors(db) {
  const key = db.prepare("SELECT COUNT(*) || ':' || COALESCE(GROUP_CONCAT(name || base_url, '|'), '') AS k FROM competitors").get().k;
  if (key === remapKey) return;
  remapKey = key;
  const of = competitorMatcher(db);
  const up = db.prepare('UPDATE idealo_offers SET competitor_id=? WHERE shop=?');
  for (const { shop } of db.prepare('SELECT DISTINCT shop FROM idealo_offers').all()) up.run(of(shop), shop);
}
export function discoveredShops(db, { limit = 50 } = {}) {
  remapCompetitors(db);
  const rows = db.prepare(`SELECT o.shop, o.marketplace, COUNT(*) AS products, SUM(o.total < COALESCE(i.own_total, p.price) - 0.005) AS cheaper,
      SUM(o.position = 1 OR o.total = i.min_total) AS best, ROUND(AVG((o.total - COALESCE(i.own_total, p.price)) / COALESCE(i.own_total, p.price) * 100), 1) AS avg_gap
    FROM idealo_offers o JOIN idealo_products i ON i.product_id=o.product_id JOIN products p ON p.id=o.product_id
    WHERE o.own=0 AND o.competitor_id IS NULL AND p.price > 0 GROUP BY lower(o.shop) ORDER BY cheaper DESC, products DESC LIMIT ?`).all(limit);
  const dismissed = new Set(String(getSetting(db, 'idealo_dismissed') || '').split('\n').filter(Boolean).map((s) => s.toLowerCase()));
  return rows.filter((r) => !dismissed.has(r.shop.toLowerCase()));
}
export function dismissShop(db, shop) {
  const set = new Set(String(getSetting(db, 'idealo_dismissed') || '').split('\n').filter(Boolean));
  set.add(String(shop).trim());
  setSetting(db, 'idealo_dismissed', [...set].join('\n'));
}

export function idealoOverview(db) {
  const cfg = idealoConfig(db);
  const st = db.prepare(`SELECT COUNT(*) AS checked, COALESCE(SUM(found),0) AS found, COALESCE(SUM(own_rank IS NOT NULL),0) AS listed, COALESCE(SUM(own_rank=1),0) AS best, MAX(checked_at) AS last FROM idealo_products`).get();
  const withEan = db.prepare("SELECT COUNT(*) AS n FROM products WHERE active=1 AND tracked=1 AND offline_since IS NULL AND ean IS NOT NULL AND length(ean) >= 8").get().n;
  const m = idealoMap(db);
  let dearer = 0;
  for (const v of m.values()) if (v.kind === 'dearer') dearer++;
  const spend = spendMonth(db);
  const err = getSetting(db, 'idealo_error');
  return {
    configured: cfg.configured, enabled: cfg.enabled, actor: { id: cfg.actorId, label: cfg.actor.label, note: cfg.actor.note },
    per_day: cfg.perDay, days: cfg.days, days_a: cfg.daysA, budget: cfg.budget,
    spend: { usd: Math.round(spend.usd * 100) / 100, lookups: spend.units, today: spendToday(db) },
    with_ean: withEan, checked: st.checked, found: st.found, listed: st.listed, best: st.best, dearer, last: st.last,
    due: cfg.configured ? dueIdealo(db, 100000).length : null,
    error: err ? { at: err.split('|')[0], message: err.split('|').slice(1).join('|') } : null,
    job: { ...idealoJob },
    // grobe Hochrechnung der Monatskosten beim eingestellten Tageskontingent
    estimate: Math.round(cfg.actor.cost(Math.ceil(cfg.perDay / cfg.actor.batch) * 30, cfg.perDay * 30 * 0.8) * 100) / 100,
  };
}
