/**
 * Prüf-Stufen für große Sortimente: Die wichtigsten Artikel (Stufe A) werden täglich abgefragt, alle übrigen
 * (Stufe B) im Abstand von einigen Tagen. Stufe A ergibt sich automatisch aus den vorhandenen Daten; einzelne
 * Artikel lassen sich zusätzlich von Hand auf „täglich“ setzen.
 */
const keyOf = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase(); } catch { return null; } };
const setting = (db, k, d) => { const v = Number(db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value); return Number.isFinite(v) && v >= 0 ? v : d; };

export function tierConfig(db) {
  return {
    size: Math.min(100000, Math.round(setting(db, 'tier_a_size', 1000))),
    bDays: Math.min(60, Math.max(1, setting(db, 'tier_b_days', 4))),
  };
}

let last = 0;
/** Stufen neu berechnen (höchstens alle 10 Minuten, außer mit force). Gibt die Verteilung zurück. */
export function computeTiers(db, { force = false } = {}) {
  if (!force && Date.now() - last < 10 * 60 * 1000) return null;
  last = Date.now();
  const { size } = tierConfig(db);
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const prods = db.prepare('SELECT id, number, url, price, tier_pin FROM products WHERE active=1 AND tracked=1 AND offline_since IS NULL').all();
  const sales = new Map(db.prepare('SELECT product_id, units_90, revenue_90 FROM product_sales').all().map((r) => [r.product_id, r]));
  const seo = new Map(db.prepare('SELECT page, impressions FROM seo_pages').all().map((r) => [r.page, r.impressions]));
  const mc = new Map(db.prepare('SELECT offer_id, benchmark FROM mc_products WHERE benchmark IS NOT NULL').all().map((r) => [String(r.offer_id).toLowerCase(), r.benchmark]));
  // Mitbewerber hat in den letzten 7 Tagen den Preis geändert (mindestens zwei verschiedene Preise im Zeitraum)
  const moved = new Set(db.prepare(`
    SELECT m.product_id FROM price_history h JOIN matches m ON m.id=h.match_id
    WHERE h.at >= ? GROUP BY m.id HAVING COUNT(DISTINCT h.price) > 1`).all(since).map((r) => r.product_id));
  const scored = prods.map((p) => {
    const s = sales.get(p.id);
    const imp = p.url ? seo.get(keyOf(p.url)) ?? 0 : 0;
    const bench = mc.get(String(p.number).toLowerCase());
    const above = bench && p.price && p.price > bench * 1.02;
    const reasons = [];
    if (p.tier_pin) reasons.push('von Hand gesetzt');
    if (s?.units_90 > 0) reasons.push(`${s.units_90} verkauft (90 T)`);
    if (moved.has(p.id)) reasons.push('Mitbewerber hat den Preis geändert');
    if (imp >= 50) reasons.push(`${Math.round(imp)} Impressionen bei Google`);
    if (above) reasons.push('über dem Google-Vergleichspreis');
    // Rangfolge: von Hand > Umsatz > Preisbewegung > Google-Nachfrage > über Vergleichspreis
    const score = (p.tier_pin ? 1e15 : 0) + (s?.units_90 > 0 ? 1e12 + (s.revenue_90 ?? 0) : 0) + (moved.has(p.id) ? 1e9 : 0) + Math.min(imp, 9e5) * 1000 + (above ? 1e4 : 0);
    return { id: p.id, pin: Boolean(p.tier_pin), score, reasons };
  });
  scored.sort((a, b) => b.score - a.score);
  const upd = db.prepare('UPDATE products SET tier=?, tier_reason=? WHERE id=?');
  let a = 0;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE products SET tier=NULL, tier_reason=NULL WHERE NOT (active=1 AND tracked=1 AND offline_since IS NULL)").run();
    for (const x of scored) {
      const isA = x.pin || (x.reasons.length > 0 && a < size); // von Hand gesetzte zählen nicht gegen die Größe
      if (isA && !x.pin) a++;
      upd.run(isA ? 'A' : 'B', isA ? x.reasons.join(', ') : null, x.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const total = scored.filter((x) => x.pin).length + a;
  return { a: total, b: scored.length - total };
}

const HOUR = 3600 * 1000;
/**
 * Ist ein Treffer bei einem automatischen Abruf dran?
 *  - nie geprüft: ja (Stufe A zuerst, über die Reihenfolge)
 *  - Stufe A: nach dem Mindestabstand (≥ 8 h); Stufe B: alle bDays Tage
 *  - nicht gefunden / URL fehlt / gesperrt: wöchentlich, nach 4 erfolglosen Versuchen monatlich
 *  - Fehler: nach 6 Stunden
 */
export function dueByTier(m, tier, now, { refreshH, bDays }) {
  if (!m.last_checked || m.status === 'pending') return true;
  const age = now - Date.parse(m.last_checked);
  if (m.status === 'error') return age > 6 * HOUR;
  if (['not_found', 'nourl', 'blocked'].includes(m.status)) return age > ((m.miss_count ?? 0) >= 4 ? 30 : 7) * 24 * HOUR;
  return age > (tier === 'A' ? refreshH : bDays * 24) * HOUR;
}

/** Fortschritt der Erstzuordnung und Aktualität je Stufe (für das Lagebild). */
export function tierStatus(db) {
  const cfg = tierConfig(db);
  const now = Date.now();
  const rows = db.prepare(`SELECT p.tier, m.status, m.last_checked FROM matches m JOIN products p ON p.id=m.product_id JOIN competitors c ON c.id=m.competitor_id
    WHERE c.enabled=1 AND p.active=1 AND p.tracked=1 AND p.offline_since IS NULL`).all();
  const total = rows.length;
  const done = rows.filter((r) => r.last_checked && r.status !== 'pending').length;
  const fresh = (tier, h) => {
    const list = rows.filter((r) => r.tier === tier && ['ok', 'review'].includes(r.status));
    return list.length ? Math.round((list.filter((r) => now - Date.parse(r.last_checked) < h * HOUR).length / list.length) * 1000) / 10 : null;
  };
  const counts = db.prepare("SELECT SUM(tier='A') AS a, SUM(tier='B') AS b, SUM(tier_pin=1) AS pinned FROM products WHERE active=1 AND tracked=1 AND offline_since IS NULL").get();
  // Tempo der letzten 24 Stunden für die Restzeit der Erstzuordnung
  const pace = db.prepare('SELECT COALESCE(SUM(checked),0) AS n FROM runs WHERE started_at >= ?').get(new Date(now - 86400000).toISOString()).n;
  const open = total - done;
  return {
    ...cfg, a: counts.a ?? 0, b: counts.b ?? 0, pinned: counts.pinned ?? 0,
    matches: total, checked: done, open,
    days_left: open && pace ? Math.ceil((open / pace) * 10) / 10 : null,
    fresh_a: fresh('A', 26), fresh_b: fresh('B', cfg.bDays * 24 + 2),
  };
}
