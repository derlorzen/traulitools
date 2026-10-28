import { analyse } from './analysis.js';
import { channel, profit, margin, floorPrice, channelView } from './channels.js';
import { pageKey } from './gsc.js';
import { ISSUES } from './seoaudit.js';
import { expectedCtr } from './pricelist.js';

/**
 * Chancenfinder (Regeln aus dem Marktschreier, angepasst an Shopware/JTL): Wo Marco mehr verkaufen oder mehr
 * verdienen kann. Jede Chance hat einen geschätzten Wert in Euro (für die Sortierung) und eine konkrete Handlung.
 */
const r2 = (v) => Math.round(v * 100) / 100;
const eur = (v) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(v);

export const TYPES = {
  comp_oos: { label: 'Mitbewerber ausverkauft', tone: 'good', hint: 'Der günstigere Mitbewerber kann nicht liefern. Preis halten oder bis knapp unter den nächsten lieferbaren anheben.' },
  ebay_missing: { label: 'Fehlt auf eBay', tone: 'good', hint: 'Verkauft sich im Shop, ist auf eBay nicht im Angebot und bringt dort nach Gebühren Gewinn.' },
  ebay_cheaper: { label: 'eBay-Angebot zu teuer', tone: 'warn', hint: 'Auf eBay gibt es dasselbe Produkt günstiger, und ein niedrigerer Preis bringt noch Gewinn. Preis in JTL anpassen.' },
  stockout: { label: 'Bald ausverkauft', tone: 'warn', hint: 'Beim aktuellen Absatz reicht der Bestand keine zwei Wochen. Nachbestellen und nicht billiger werden.' },
  low_profit: { label: 'Zu wenig Gewinn', tone: 'bad', hint: 'Nach Gebühren und Versand bleibt weniger als der Mindestgewinn. Preis prüfen oder Einkauf verhandeln.' },
  search_dear: { label: 'Gefragt, aber teurer', tone: 'bad', hint: 'Viele sehen die Seite bei Google, aber ein Mitbewerber ist günstiger. Hier kostet der Preis am meisten Umsatz.' },
  search_near: { label: 'Knapp vor den Top 3', tone: 'warn', hint: 'Die Seite steht bei Google auf Platz 4 bis 20 und wird gesucht. Wenige Plätze mehr bringen deutlich mehr Klicks: Titel, Beschreibung, Text und interne Links verbessern.' },
  seo_error: { label: 'SEO-Fehler bei wichtigem Artikel', tone: 'bad', hint: 'Der Seiten-Check hat auf der Seite eines Artikels, der sich verkauft oder gesucht wird, Fehler gefunden (z. B. Preis in den Produktdaten falsch, noindex, keine Produktdaten).' },
  keyword_drop: { label: 'Keyword verloren', tone: 'bad', hint: 'Ein beobachtetes Keyword ist in den letzten 7 Tagen deutlich abgerutscht. Seite und Preis prüfen, oft hat ein Mitbewerber nachgelegt.' },
  slow_mover: { label: 'Ladenhüter', tone: 'bad', hint: 'Bestand ohne Verkauf in 90 Tagen. Geld liegt im Lager: auf eBay anbieten, Preis senken oder als Aktion bewerben.' },
};

export function findOpportunities(db) {
  const prods = db.prepare(`SELECT p.*, s.units_30, s.units_90, s.revenue_90 FROM products p LEFT JOIN product_sales s ON s.product_id=p.id
    WHERE p.active=1 AND p.offline_since IS NULL`).all();
  const hasSales = Boolean(db.prepare('SELECT 1 FROM product_sales LIMIT 1').get());
  const listings = new Map();
  for (const l of db.prepare("SELECT * FROM ebay_listings WHERE status='active' AND product_id IS NOT NULL").all()) listings.set(l.product_id, l);
  const market = new Map(db.prepare('SELECT * FROM ebay_market').all().map((m) => [m.product_id, m]));
  const shopCh = channel(db, 'shop'), ebayCh = channel(db, 'ebay');
  const ebayActive = Boolean(ebayCh?.active);
  const out = [];
  const add = (type, p, o) => out.push({ type, ...TYPES[type], product_id: p.id, number: p.number, name: p.name, price: p.price, stock: p.stock ?? null, units_90: p.units_90 ?? null, ...o });

  for (const p of prods) {
    const vat = p.tax_rate ?? 19;
    const cost = p.purchase_price > 0 ? p.purchase_price : null;
    const perDay = (p.units_30 ?? 0) / 30;
    // Bald ausverkauft
    if (p.stock > 0 && perDay > 0) {
      const days = p.stock / perDay;
      if (days < 14) add('stockout', p, { detail: `${p.stock} Stück, reicht etwa ${Math.max(1, Math.round(days))} Tage (${p.units_30} in 30 Tagen verkauft)`, value: r2((p.price ?? 0) * perDay * Math.max(0, 14 - days)), action: 'Nachbestellen, Preis nicht senken' });
    }
    // Ladenhüter
    if (hasSales && p.stock > 0 && !(p.units_90 > 0) && cost) {
      const tied = r2(p.stock * cost);
      if (tied >= 50) add('slow_mover', p, { detail: `${p.stock} Stück, ${eur(tied)} Einkaufswert, 90 Tage kein Verkauf`, value: r2(tied * 0.1), action: listings.has(p.id) ? 'Preis senken oder Aktion' : 'Auf eBay anbieten oder Preis senken' });
    }
    // Zu wenig Gewinn im Shop
    if (cost && p.price && shopCh) {
      const pr = profit(p.price, cost, shopCh, vat);
      if (pr != null && pr < shopCh.min_profit) add('low_profit', p, { detail: `Shop: ${eur(pr)} Gewinn je Verkauf (Marge ${String(margin(p.price, cost, shopCh, vat)).replace('.', ',')} %), Mindestgewinn ${eur(shopCh.min_profit)}`, value: r2((shopCh.min_profit - pr) * Math.max(1, p.units_90 ?? 0)), action: `Preis mindestens ${eur(floorPrice(cost, shopCh, vat))}`, channel: 'shop', suggested_price: floorPrice(cost, shopCh, vat) });
    }
    const l = listings.get(p.id);
    const m = market.get(p.id);
    if (ebayActive && ebayCh) {
      // eBay-Angebot zu wenig Gewinn / zu teuer
      if (l && cost) {
        const pr = profit(l.price, cost, ebayCh, vat);
        if (pr != null && pr < ebayCh.min_profit) add('low_profit', p, { detail: `eBay: ${eur(pr)} Gewinn je Verkauf bei ${eur(l.price)}`, value: r2((ebayCh.min_profit - pr) * Math.max(1, l.sold ?? 0)), action: `eBay-Preis mindestens ${eur(floorPrice(cost, ebayCh, vat))} (in JTL)`, channel: 'ebay', suggested_price: floorPrice(cost, ebayCh, vat) });
        else if (m?.min_total != null && l.price > m.min_total + 0.01) {
          const floor = floorPrice(cost, ebayCh, vat);
          if (floor != null && floor < m.min_total) add('ebay_cheaper', p, { detail: `Dein eBay-Preis ${eur(l.price)}, günstigster ${eur(m.min_total)} inkl. Versand (${m.min_seller}), Untergrenze ${eur(floor)}`, value: r2((l.price - m.min_total) * Math.max(1, p.units_90 ?? 1)), action: `In JTL auf ${eur(Math.max(floor, m.min_total - 0.01))} setzen`, channel: 'ebay', suggested_price: r2(Math.max(floor, m.min_total - 0.01)) });
        }
      }
      // Fehlt auf eBay
      if (!l && p.tracked && (p.units_90 > 0 || p.tier === 'A') && (p.stock ?? 1) > 0) {
        const v = channelView(db, p, { market: { ebay: m?.min_total ?? null } }).find((c) => c.key === 'ebay');
        // ohne eBay-Markt: Shop-Preis, sofern er über der eBay-Untergrenze liegt
        const price = v?.suggestion ?? (v?.floor != null && p.price != null ? Math.max(v.floor, p.price) : p.price ?? null);
        const pr = price != null && cost ? profit(price, cost, ebayCh, vat) : null;
        if (!cost || (pr != null && pr >= ebayCh.min_profit)) {
          add('ebay_missing', p, {
            detail: [p.units_90 ? `${p.units_90} im Shop verkauft (90 T)` : 'wichtiger Artikel', m?.offers != null ? (m.offers ? `${m.offers} Angebote auf eBay, günstigstes ${eur(m.min_total)}` : 'auf eBay kein Angebot gefunden') : null, price != null ? `Vorschlag ${eur(price)}${pr != null ? `, ${eur(pr)} Gewinn je Verkauf` : ''}` : null].filter(Boolean).join(' · '),
            value: r2((pr ?? (p.price ?? 0) * 0.1) * Math.max(1, (p.units_90 ?? 0) / 3)), action: 'Auf eBay einstellen', channel: 'ebay', suggested_price: price,
          });
        }
      }
    }
  }
  // Google: gefragt aber teurer, knapp vor den Top 3; Seiten-Check; Keywords
  const gsc = new Map(db.prepare('SELECT page, clicks, impressions, position FROM seo_pages').all().map((r) => [r.page, r]));
  const audits = new Map(db.prepare('SELECT product_id, issues FROM seo_audit').all().map((a) => [a.product_id, JSON.parse(a.issues || '[]')]));
  const a = analyse(db);
  const rowBy = new Map(a.rows.map((r) => [r.id, r]));
  for (const p of prods) {
    const g = p.url ? gsc.get(pageKey(p.url)) : null;
    const row = rowBy.get(p.id);
    const important = p.units_90 > 0 || p.tier === 'A' || (g?.impressions ?? 0) >= 100;
    if (g && row && row.gap_percent > a.rules.tolerance && g.impressions >= 100) {
      add('search_dear', p, { detail: `${Math.round(g.impressions).toLocaleString('de-DE')} Impressionen bei Google, ${String(row.gap_percent).replace('.', ',')} % teurer als ${row.cheapest_competitor} (${eur(row.cheapest)})`, value: r2(g.impressions * 0.02 * 0.03 * (p.price ?? 0)), action: row.suggested_price ? `Preis auf ${eur(row.suggested_price)} prüfen` : 'Preis prüfen', channel: 'shop', suggested_price: row.action === 'senken' ? row.suggested_price : null });
    }
    if (g && g.position > 3 && g.position <= 20 && g.impressions >= 100) {
      const extra = Math.max(0, Math.round(g.impressions * expectedCtr(3) - g.clicks));
      if (extra >= 5) add('search_near', p, { detail: `Platz ${String(Math.round(g.position * 10) / 10).replace('.', ',')}, ${Math.round(g.impressions).toLocaleString('de-DE')} Impressionen, etwa ${extra} Klicks mehr in 28 Tagen unter den ersten drei`, value: r2(extra * 0.03 * (p.price ?? 0) * 0.2), action: 'Seite verbessern (Seiten-Check, KI-Titel)' });
    }
    const issues = audits.get(p.id);
    const errs = issues?.filter((i) => ISSUES[i.code]?.sev === 'error') ?? [];
    if (errs.length && important) {
      add('seo_error', p, { detail: errs.map((i) => `${ISSUES[i.code].label}${i.detail ? ` (${i.detail})` : ''}`).join(', '), value: r2(Math.max(20, (p.revenue_90 ?? 0) * 0.05)), action: 'Im Seiten-Check ansehen und im Shop beheben' });
    }
  }
  const since = new Date(Date.now() - 8 * 86400e3).toISOString().slice(0, 10);
  const prodByPage = new Map(prods.filter((p) => p.url).map((p) => [pageKey(p.url), p]));
  for (const k of db.prepare('SELECT id, keyword, position, url, volume FROM keywords WHERE last_checked IS NOT NULL').all()) {
    const old = db.prepare('SELECT position, url FROM keyword_ranks WHERE keyword_id=? AND date <= ? ORDER BY date DESC LIMIT 1').get(k.id, since);
    if (!old || old.position == null) continue;
    const now = k.position ?? 51;
    if (now - old.position >= 3 && old.position <= 20) {
      const p = prodByPage.get(pageKey(k.url || old.url || ''));
      if (!p) continue;
      add('keyword_drop', p, { detail: `„${k.keyword}“ von Platz ${old.position} auf ${k.position ?? 'über 50'}${k.volume ? ` (${k.volume.toLocaleString('de-DE')} Suchen/Monat)` : ''}`, value: r2((k.volume ?? 100) * (expectedCtr(old.position) - expectedCtr(Math.min(now, 30))) * 0.03 * (p.price ?? 0)), action: 'Seite und Preis prüfen, Mitbewerber vergleichen' });
    }
  }
  // Mitbewerber ausverkauft (aus der Preisanalyse)
  const okBy = new Map();
  for (const r of db.prepare(`SELECT m.product_id, m.price, m.availability, c.name FROM matches m JOIN competitors c ON c.id=m.competitor_id WHERE c.enabled=1 AND m.status='ok' AND m.price IS NOT NULL`).all()) {
    if (!okBy.has(r.product_id)) okBy.set(r.product_id, []);
    okBy.get(r.product_id).push(r);
  }
  const byId = new Map(prods.map((p) => [p.id, p]));
  for (const row of a.rows) {
    const p = byId.get(row.id);
    const list = okBy.get(row.id) ?? [];
    if (!p || !(p.stock > 0 || p.stock == null)) continue;
    const cheaperOos = list.filter((x) => x.price < p.price && x.availability === 'out_of_stock');
    const cheaperIn = list.filter((x) => x.price < p.price && x.availability !== 'out_of_stock');
    if (cheaperOos.length && !cheaperIn.length) {
      const nextIn = list.filter((x) => x.availability !== 'out_of_stock' && x.price >= p.price).sort((x, y) => x.price - y.price)[0];
      add('comp_oos', p, {
        detail: `${cheaperOos.map((x) => `${x.name} (${eur(x.price)})`).join(', ')} ausverkauft${nextIn ? `; nächster lieferbarer: ${nextIn.name} ${eur(nextIn.price)}` : '; sonst niemand günstiger lieferbar'}`,
        value: r2((nextIn ? nextIn.price - 0.01 - p.price : p.price * 0.03) * Math.max(1, (p.units_90 ?? 0) / 3)),
        action: nextIn && nextIn.price - 0.01 > p.price ? `Preis halten oder bis ${eur(nextIn.price - 0.01)} anheben` : 'Preis halten', channel: 'shop',
        suggested_price: nextIn && nextIn.price - 0.01 > p.price ? r2(nextIn.price - 0.01) : null,
      });
    }
  }
  out.sort((x, y) => (y.value ?? 0) - (x.value ?? 0));
  const counts = Object.fromEntries(Object.keys(TYPES).map((k) => [k, out.filter((o) => o.type === k).length]));
  return { types: TYPES, counts, has_sales: hasSales, items: out };
}

/**
 * Preisvorschläge als CSV für die JTL-Ameise (Semikolon, UTF-8 mit BOM, Komma als Dezimalzeichen).
 * Shop-Vorschläge aus der Preisanalyse (senken/erhöhen), eBay- und Shop-Vorschläge aus dem Chancenfinder.
 * Spalten werden in der Ameise frei zugeordnet (z. B. Brutto-VK bzw. Plattformpreis eBay).
 */
let cache = null; // { at, data }
/** Chancen eines Artikels (für die Detailansicht), Ergebnis 60 Sekunden zwischengespeichert. */
export function productOpportunities(db, productId) {
  if (!cache || Date.now() - cache.at > 60000) cache = { at: Date.now(), data: findOpportunities(db) };
  return cache.data.items.filter((i) => i.product_id === productId);
}
export const invalidateOpportunities = () => { cache = null; };

export function jtlExport(db, { channel: only = null } = {}) {
  const a = analyse(db);
  const rows = [];
  const seen = new Set();
  const push = (number, name, ch, current, suggested, reason) => {
    const k = `${number}|${ch}`;
    if (seen.has(k) || suggested == null || current == null || Math.abs(suggested - current) < 0.005) return;
    if (only && only !== ch) return;
    seen.add(k);
    rows.push({ number, name, ch, current, suggested, reason });
  };
  for (const r of a.rows) if ((r.action === 'senken' || r.action === 'erhöhen') && r.suggested_price) push(r.number, r.name, 'shop', r.own_price, r.suggested_price, r.reason);
  const o = findOpportunities(db);
  const ebayPrice = new Map(db.prepare("SELECT product_id, price FROM ebay_listings WHERE status='active' AND product_id IS NOT NULL").all().map((l) => [l.product_id, l.price]));
  for (const x of o.items) {
    if (!x.suggested_price || !x.channel || x.type === 'ebay_missing') continue;
    push(x.number, x.name, x.channel, x.channel === 'ebay' ? ebayPrice.get(x.product_id) ?? null : x.price, x.suggested_price, `${x.label}: ${x.detail}`);
  }
  const f = (v) => Number(v).toFixed(2).replace('.', ',');
  const esc = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['Artikelnummer', 'Artikelname', 'Kanal', 'Preis aktuell (brutto)', 'Preis neu (brutto)', 'Grund'].join(';'),
    ...rows.map((r) => [r.number, r.name, r.ch === 'shop' ? 'Shop' : r.ch === 'ebay' ? 'eBay' : r.ch, f(r.current), f(r.suggested), r.reason].map(esc).join(';'))];
  return { count: rows.length, csv: `﻿${lines.join('\r\n')}` };
}
