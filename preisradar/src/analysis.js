/**
 * Regelbasierte Preisanalyse (ohne KI).
 * Grundlage: eigene Bruttopreise und bestätigte Mitbewerberpreise (Status "ok").
 */
export const RULES = {
  tolerance: 2, // % – bis hierhin gilt der Preis als konkurrenzfähig
  raiseAbove: 5, // % – so weit unter dem Günstigsten lohnt sich eine Erhöhung
  outlier: 40, // % – größere Abweichungen sind eher Fehlzuordnung als Marktpreis
};

const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;
const eur = (n) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

export function analyse(db, rules = RULES) {
  const products = db.prepare('SELECT id, number, name, manufacturer, price FROM products WHERE active=1').all();
  const ms = db
    .prepare(
      `SELECT m.product_id, m.status, m.price, c.name AS competitor
       FROM matches m JOIN competitors c ON c.id=m.competitor_id
       WHERE c.enabled=1 AND m.price IS NOT NULL AND m.status IN ('ok','review')`,
    )
    .all();
  const by = new Map();
  for (const m of ms) {
    if (!by.has(m.product_id)) by.set(m.product_id, []);
    by.get(m.product_id).push(m);
  }

  const rows = [];
  const stats = { total: products.length, compared: 0, cheapest: 0, competitive: 0, expensive: 0, noPrice: 0, unconfirmedOnly: 0 };
  for (const p of products) {
    if (p.price == null) { stats.noPrice++; continue; }
    const all = by.get(p.id) ?? [];
    const ok = all.filter((m) => m.status === 'ok');
    if (!ok.length) {
      if (all.length) stats.unconfirmedOnly++;
      continue;
    }
    stats.compared++;
    const low = ok.reduce((a, b) => (b.price < a.price ? b : a));
    const gap = r1(((p.price - low.price) / low.price) * 100);
    const base = { id: p.id, number: p.number, name: p.name, own_price: p.price, cheapest: low.price, cheapest_competitor: low.competitor, gap_percent: gap, offers: ok.length };

    if (Math.abs(gap) > rules.outlier) {
      rows.push({ ...base, action: 'prüfen', suggested_price: null, reason: `Abweichung von ${gap > 0 ? '+' : ''}${gap} % zu ${low.competitor} (${eur(low.price)}). Vermutlich andere Variante oder falsche Zuordnung, bitte Treffer prüfen.`, warning: true });
      continue;
    }
    if (gap > rules.tolerance) {
      stats.expensive++;
      rows.push({ ...base, action: 'senken', suggested_price: r2(low.price), reason: `${low.competitor} ist mit ${eur(low.price)} um ${gap} % günstiger. Vor einer Senkung die Marge prüfen.` });
    } else if (gap < -rules.raiseAbove) {
      stats.cheapest++;
      const target = r2(low.price - 0.1);
      rows.push({ ...base, action: target > p.price ? 'erhöhen' : 'halten', suggested_price: target > p.price ? target : null, reason: `Du liegst ${Math.abs(gap)} % unter dem günstigsten Mitbewerber (${low.competitor}, ${eur(low.price)}). Spielraum für eine Erhöhung.` });
    } else {
      if (gap <= 0) stats.cheapest++;
      else stats.competitive++;
      rows.push({ ...base, action: 'halten', suggested_price: null, reason: gap <= 0 ? 'Günstigster oder gleichauf, Preis passt.' : `Innerhalb der Toleranz von ${rules.tolerance} % zum Günstigsten (${low.competitor}).` });
    }
  }
  const order = { senken: 0, prüfen: 1, erhöhen: 2, halten: 3 };
  rows.sort((a, b) => order[a.action] - order[b.action] || Math.abs(b.gap_percent) - Math.abs(a.gap_percent));

  const n = (a) => rows.filter((r) => r.action === a).length;
  const summary = stats.compared
    ? `${stats.compared} von ${stats.total} Artikeln haben bestätigte Vergleichspreise. ${n('senken')} sind mehr als ${rules.tolerance} % teurer als der günstigste Mitbewerber, ${n('erhöhen')} liegen deutlich darunter, ${n('prüfen')} weichen auffällig ab.${stats.unconfirmedOnly ? ` Bei ${stats.unconfirmedOnly} Artikeln gibt es nur unbestätigte Treffer („zu prüfen“).` : ''}`
    : 'Noch keine bestätigten Mitbewerberpreise. Lege Mitbewerber an und starte einen Abruf.';
  return { rules, stats, summary, rows };
}
