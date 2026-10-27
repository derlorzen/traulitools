/**
 * Regelbasierte Preisanalyse (ohne KI).
 * Grundlage: eigene Bruttopreise der beobachteten Artikel und bestätigte Mitbewerberpreise (Status "ok").
 * Mitbewerber, die einen Artikel nicht liefern können, bestimmen den Vergleichspreis nicht.
 */
export const RULES = {
  tolerance: 2, // % – bis hierhin gilt der Preis als konkurrenzfähig
  raiseAbove: 5, // % – so weit unter dem Günstigsten lohnt sich eine Erhöhung
  outlier: 40, // % – größere Abweichungen sind eher Fehlzuordnung als Marktpreis
  moveDays: 7, // Zeitraum für Preisbewegungen
};

const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;
const eur = (n) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Klassen für die Verteilung des Abstands zum günstigsten Mitbewerber (positiv = wir sind teurer). */
const BUCKETS = [
  { label: 'über 10 % günstiger', from: -Infinity, to: -10 },
  { label: '5–10 % günstiger', from: -10, to: -5 },
  { label: '2–5 % günstiger', from: -5, to: -2 },
  { label: 'gleichauf (±2 %)', from: -2, to: 2 },
  { label: '2–5 % teurer', from: 2, to: 5 },
  { label: '5–10 % teurer', from: 5, to: 10 },
  { label: 'über 10 % teurer', from: 10, to: Infinity },
];

const pageKeyOf = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase(); } catch { return null; } };
/** Einkaufspreis, aktuelle Marge und Preis-Untergrenze (Mindestmarge) sowie Verkäufe eines Artikels. */
function economics(p, s, minMargin) {
  const tax = 1 + (p.tax_rate ?? 19) / 100;
  const ek = p.purchase_price > 0 ? p.purchase_price : null;
  const net = p.price != null ? p.price / tax : null;
  return {
    purchase_price: ek,
    margin_percent: ek && net ? Math.round(((net - ek) / net) * 1000) / 10 : null,
    floor_price: ek ? Math.ceil((ek / (1 - minMargin / 100)) * tax * 100) / 100 : null,
    stock: p.stock ?? null,
    units_30: s?.units_30 ?? null, revenue_30: s?.revenue_30 ?? null, units_90: s?.units_90 ?? null, revenue_90: s?.revenue_90 ?? null,
  };
}
function demand(seo, url) {
  const r = url ? seo.get(pageKeyOf(url)) : null;
  return r ? { impressions: r.impressions, clicks: r.clicks, search_position: Math.round(r.position * 10) / 10 } : { impressions: null, clicks: null, search_position: null };
}

export function analyse(db, rules = RULES) {
  const now = Date.now();
  const tracked = db.prepare('SELECT id, number, name, manufacturer, price, url, purchase_price, tax_rate, stock FROM products WHERE active=1 AND tracked=1 AND offline_since IS NULL').all();
  // Nachfrage aus der Search Console (letzte 28 Tage) je Produktseite, falls angebunden
  const seo = new Map(db.prepare('SELECT page, clicks, impressions, position FROM seo_pages').all().map((r) => [r.page, r]));
  // Verkäufe aus Shopware und Mindestmarge (Einkaufspreis netto, Marge auf den Nettoverkaufspreis)
  const sales = new Map(db.prepare('SELECT product_id, units_30, revenue_30, units_90, revenue_90 FROM product_sales').all().map((r) => [r.product_id, r]));
  const mm = Number(db.prepare("SELECT value FROM settings WHERE key='min_margin'").get()?.value ?? 10);
  const minMargin = Number.isFinite(mm) && mm >= 0 && mm < 95 ? mm : 10;
  const comps = db.prepare('SELECT id, name FROM competitors WHERE enabled=1 ORDER BY position, id').all();
  const ms = db
    .prepare(
      `SELECT m.id, m.product_id, m.competitor_id, m.status, m.price, m.availability, m.last_checked, m.last_error
       FROM matches m JOIN competitors c ON c.id=m.competitor_id JOIN products p ON p.id=m.product_id
       WHERE c.enabled=1 AND p.active=1 AND p.tracked=1 AND p.offline_since IS NULL`,
    )
    .all();
  const compName = new Map(comps.map((c) => [c.id, c.name]));
  const by = new Map();
  for (const m of ms) {
    if (!by.has(m.product_id)) by.set(m.product_id, []);
    by.get(m.product_id).push({ ...m, competitor: compName.get(m.competitor_id) });
  }

  // --- Zeilen je Artikel ---
  const rows = [];
  const stats = { total: tracked.length, compared: 0, cheapest: 0, competitive: 0, expensive: 0, noPrice: 0, unconfirmedOnly: 0, noOffer: 0 };
  for (const p of tracked) {
    if (p.price == null) { stats.noPrice++; continue; }
    const all = by.get(p.id) ?? [];
    const ok = all.filter((m) => m.status === 'ok' && m.price != null);
    if (!ok.length) {
      if (all.some((m) => m.status === 'review' && m.price != null)) stats.unconfirmedOnly++;
      else stats.noOffer++;
      continue;
    }
    stats.compared++;
    const inStock = ok.filter((m) => m.availability !== 'out_of_stock');
    const pool = inStock.length ? inStock : ok;
    const low = pool.reduce((a, b) => (b.price < a.price ? b : a));
    const lowAny = ok.reduce((a, b) => (b.price < a.price ? b : a));
    const gap = r1(((p.price - low.price) / low.price) * 100);
    const base = {
      id: p.id, number: p.number, name: p.name, brand: p.manufacturer, own_price: p.price,
      ...demand(seo, p.url),
      ...economics(p, sales.get(p.id), minMargin),
      cheapest: low.price, cheapest_competitor: low.competitor, gap_percent: gap, diff: r2(p.price - low.price), offers: ok.length,
      cheapest_unavailable: lowAny.price < low.price - 0.004 ? { competitor: lowAny.competitor, price: lowAny.price } : null,
      prices: ok.map((m) => ({ competitor: m.competitor, price: m.price, out_of_stock: m.availability === 'out_of_stock' })),
    };
    const note = base.cheapest_unavailable ? ` ${base.cheapest_unavailable.competitor} (${eur(base.cheapest_unavailable.price)}) ist günstiger, aber nicht lieferbar und zählt nicht.` : '';

    if (Math.abs(gap) > rules.outlier) {
      rows.push({ ...base, action: 'prüfen', suggested_price: null, reason: `Abweichung von ${gap > 0 ? '+' : ''}${gap} % zu ${low.competitor} (${eur(low.price)}). Vermutlich andere Variante oder falsche Zuordnung, bitte Treffer prüfen.`, warning: true });
      continue;
    }
    if (gap > rules.tolerance) {
      stats.expensive++;
      if (base.floor_price != null && base.floor_price >= p.price - 0.004) {
        rows.push({ ...base, action: 'halten', margin_blocked: true, suggested_price: null, reason: `${low.competitor} ist mit ${eur(low.price)} um ${gap} % günstiger, aber eine Senkung würde deine Mindestmarge von ${minMargin} % unterschreiten (Untergrenze ${eur(base.floor_price)}).${note}` });
      } else if (base.floor_price != null && base.floor_price > low.price) {
        rows.push({ ...base, action: 'senken', margin_limited: true, suggested_price: r2(base.floor_price), reason: `${low.competitor} ist mit ${eur(low.price)} um ${gap} % günstiger. Wegen deiner Mindestmarge von ${minMargin} % höchstens auf ${eur(base.floor_price)} senken.${note}` });
      } else {
        rows.push({ ...base, action: 'senken', suggested_price: r2(low.price), reason: `${low.competitor} ist mit ${eur(low.price)} um ${gap} % günstiger.${base.margin_percent != null ? ` Marge danach ${Math.round(((low.price / (1 + (p.tax_rate ?? 19) / 100) - base.purchase_price) / (low.price / (1 + (p.tax_rate ?? 19) / 100))) * 1000) / 10} %.` : ' Vor einer Senkung die Marge prüfen.'}${note}` });
      }
    } else if (gap < -rules.raiseAbove) {
      stats.cheapest++;
      const target = r2(low.price - 0.1);
      rows.push({ ...base, action: target > p.price ? 'erhöhen' : 'halten', suggested_price: target > p.price ? target : null, reason: `Du liegst ${Math.abs(gap)} % unter dem günstigsten Mitbewerber (${low.competitor}, ${eur(low.price)}). Spielraum für eine Erhöhung.${note}` });
    } else {
      if (gap <= 0) stats.cheapest++;
      else stats.competitive++;
      rows.push({ ...base, action: 'halten', suggested_price: null, reason: gap <= 0 ? `Günstigster oder gleichauf, Preis passt.${note}` : `Innerhalb der Toleranz von ${rules.tolerance} % zum Günstigsten (${low.competitor}).${note}` });
    }
  }
  const order = { senken: 0, prüfen: 1, erhöhen: 2, halten: 3 };
  rows.sort((a, b) => order[a.action] - order[b.action] || Math.abs(b.gap_percent) - Math.abs(a.gap_percent));
  const n = (a) => rows.filter((r) => r.action === a).length;

  // --- Kennzahlen ---
  const real = rows.filter((r) => !r.warning); // Ausreißer verzerren Durchschnitte
  const gaps = real.map((r) => r.gap_percent);
  const down = rows.filter((r) => r.action === 'senken');
  const up = rows.filter((r) => r.action === 'erhöhen');
  const kpi = {
    tracked: tracked.length,
    compared: stats.compared,
    coverage: tracked.length ? r1((stats.compared / tracked.length) * 100) : 0,
    avg_gap: gaps.length ? r1(avg(gaps)) : null,
    median_gap: gaps.length ? r1(median(gaps)) : null,
    share_competitive: real.length ? r1((real.filter((r) => r.gap_percent <= rules.tolerance).length / real.length) * 100) : null,
    cheapest_share: real.length ? r1((real.filter((r) => r.gap_percent <= 0).length / real.length) * 100) : null,
    senken: down.length, erhoehen: up.length, pruefen: n('prüfen'),
    gap_sum_down: r2(down.reduce((s, r) => s + r.diff, 0)), // Summe der Preisdifferenz je Stück, wenn alle teureren Artikel angeglichen würden
    gap_sum_up: r2(up.reduce((s, r) => s + (r.suggested_price - r.own_price), 0)), // Spielraum je Stück bei Erhöhungen
  };

  // --- Verteilung ---
  const histogram = BUCKETS.map((b) => ({ label: b.label, count: real.filter((r) => r.gap_percent >= b.from && r.gap_percent < b.to).length, side: b.to <= -2 ? 'cheaper' : b.from >= 2 ? 'dearer' : 'even' }));

  // --- Mitbewerber ---
  const lowByProduct = new Map(rows.map((r) => [r.id, r]));
  const ownById = new Map(tracked.map((p) => [p.id, p]));
  const since = new Date(now - rules.moveDays * 86400000).toISOString();
  const hist = db
    .prepare('SELECT h.match_id, h.price, h.at FROM price_history h JOIN matches m ON m.id=h.match_id JOIN products p ON p.id=m.product_id WHERE p.tracked=1 AND p.active=1 AND p.offline_since IS NULL ORDER BY h.match_id, h.at')
    .all();
  const histBy = new Map();
  for (const h of hist) {
    if (!histBy.has(h.match_id)) histBy.set(h.match_id, []);
    histBy.get(h.match_id).push(h);
  }
  const moves = [];
  for (const m of ms) {
    const pts = histBy.get(m.id);
    if (!pts || pts.length < 2 || m.status !== 'ok') continue;
    const last = pts[pts.length - 1];
    if (last.at < since) continue;
    const before = [...pts].reverse().find((x) => x.at < since) ?? pts[0];
    if (before === last || before.price === last.price) continue;
    const p = ownById.get(m.product_id);
    moves.push({ id: m.product_id, number: p?.number, name: p?.name, competitor: compName.get(m.competitor_id), from: before.price, to: last.price, pct: r1(((last.price - before.price) / before.price) * 100), at: last.at, own_price: p?.price ?? null });
  }
  moves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  const competitors = comps.map((c) => {
    const mine = ms.filter((m) => m.competitor_id === c.id);
    const count = (s) => mine.filter((m) => m.status === s).length;
    const okm = mine.filter((m) => m.status === 'ok' && m.price != null);
    const gapsVs = [];
    let wins = 0, losses = 0, holdsLowest = 0;
    for (const m of okm) {
      const p = ownById.get(m.product_id);
      if (!p || p.price == null) continue;
      const g = ((p.price - m.price) / m.price) * 100;
      if (Math.abs(g) <= rules.outlier) gapsVs.push(g);
      if (p.price > m.price + 0.004) losses++; else wins++;
      if (lowByProduct.get(m.product_id)?.cheapest_competitor === c.name) holdsLowest++;
    }
    const mv = moves.filter((x) => x.competitor === c.name);
    const checked = mine.map((m) => m.last_checked).filter(Boolean).sort();
    return {
      name: c.name,
      tracked: tracked.length,
      ok: okm.length, review: count('review'), not_found: count('not_found'), error: count('error'), blocked: count('blocked'), nourl: count('nourl'), pending: count('pending') + (tracked.length - mine.length),
      coverage: tracked.length ? r1((okm.length / tracked.length) * 100) : 0,
      avg_gap_vs_us: gapsVs.length ? r1(avg(gapsVs)) : null, // positiv = wir sind im Schnitt teurer als dieser Mitbewerber
      cheaper_than_us: losses, not_cheaper_than_us: wins, holds_lowest: holdsLowest,
      drops: mv.filter((x) => x.pct < 0).length, rises: mv.filter((x) => x.pct > 0).length,
      out_of_stock: okm.filter((m) => m.availability === 'out_of_stock').length,
      last_checked: checked.length ? checked[checked.length - 1] : null,
    };
  });

  // --- Marken ---
  const brandMap = new Map();
  for (const r of real) {
    const b = r.brand || 'ohne Marke';
    if (!brandMap.has(b)) brandMap.set(b, []);
    brandMap.get(b).push(r);
  }
  const brands = [...brandMap.entries()].map(([brand, list]) => ({
    brand, compared: list.length, avg_gap: r1(avg(list.map((r) => r.gap_percent))),
    senken: list.filter((r) => r.action === 'senken').length, erhoehen: list.filter((r) => r.action === 'erhöhen').length,
    cheapest: list.filter((r) => r.gap_percent <= 0).length,
  })).sort((a, b) => b.compared - a.compared || a.brand.localeCompare(b.brand, 'de'));

  // --- Hinweise (Datenqualität und Auffälligkeiten) ---
  const hints = [];
  const offline = db.prepare('SELECT COUNT(*) AS n FROM products WHERE active=1 AND tracked=1 AND offline_since IS NOT NULL').get().n;
  if (offline) hints.push({ level: 'warn', text: `${offline} beobachtete Artikel sind bei dir offline (nicht mehr in deiner Sitemap). Sie bleiben gespeichert, zählen aber nicht in der Analyse und werden nicht mehr abgefragt.` });
  const pendingTotal = competitors.reduce((s, c) => s + c.pending, 0);
  if (!comps.length) hints.push({ level: 'info', text: 'Es ist noch kein aktiver Mitbewerber angelegt.' });
  if (tracked.length && !stats.compared) hints.push({ level: 'info', text: 'Noch kein Artikel hat bestätigte Vergleichspreise. Starte einen Abruf oder warte auf den nächsten Lauf.' });
  if (pendingTotal && stats.compared) hints.push({ level: 'info', text: `${pendingTotal} Prüfungen sind noch ausstehend, die Auswertung wird mit jedem Lauf genauer.` });
  const reviewTotal = competitors.reduce((s, c) => s + c.review, 0);
  if (reviewTotal) hints.push({ level: 'warn', text: `${reviewTotal} Treffer sind noch nicht bestätigt („zu prüfen“) und fließen nicht in die Analyse ein.` });
  for (const c of competitors) {
    if (c.blocked) hints.push({ level: 'warn', text: `${c.name}: ${c.blocked} Seiten durch die robots.txt gesperrt.` });
    if (c.error > Math.max(3, c.ok)) hints.push({ level: 'warn', text: `${c.name}: ${c.error} Abrufe mit Fehler, die Einrichtung (Selektor, Sitemap, KI) prüfen.` });
    if (c.tracked >= 10 && c.ok + c.review + c.not_found + c.error + c.blocked > 0 && c.ok === 0) hints.push({ level: 'warn', text: `${c.name}: bisher keine bestätigten Preise.` });
    if (c.drops >= 3) hints.push({ level: 'info', text: `${c.name} hat in ${rules.moveDays} Tagen bei ${c.drops} Artikeln den Preis gesenkt.` });
  }
  if (rows.some((r) => r.cheapest_unavailable)) hints.push({ level: 'info', text: `${rows.filter((r) => r.cheapest_unavailable).length} Artikel haben einen günstigeren, aber nicht lieferbaren Mitbewerber. Diese Preise zählen nicht.` });

  const summary = stats.compared
    ? `${stats.compared} von ${stats.total} beobachteten Artikeln haben bestätigte Vergleichspreise. ${n('senken')} sind mehr als ${rules.tolerance} % teurer als der günstigste lieferbare Mitbewerber, ${n('erhöhen')} liegen deutlich darunter, ${n('prüfen')} weichen auffällig ab.${stats.unconfirmedOnly ? ` Bei ${stats.unconfirmedOnly} Artikeln gibt es nur unbestätigte Treffer („zu prüfen“).` : ''}`
    : tracked.length ? 'Noch keine bestätigten Mitbewerberpreise. Lege Mitbewerber an und starte einen Abruf.' : 'Es sind noch keine Artikel zur Beobachtung ausgewählt (Tab Preise).';
  rules = { ...rules, minMargin };
  return { rules, stats, kpi, histogram, competitors, brands, moves: moves.slice(0, 25), hints, summary, rows };
}
