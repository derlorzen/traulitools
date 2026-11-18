import { performance } from 'node:perf_hooks';

/**
 * Messung langer synchroner Arbeit: Solange sie läuft, ist der Server für alle Anfragen blockiert. Alles über
 * LIMIT_MS landet mit Namen und Speicherverbrauch im Log, damit sich Blockaden einer Stelle zuordnen lassen.
 */
const LIMIT_MS = Number(process.env.SLOW_LOG_MS) || 800;
const mb = () => Math.round(process.memoryUsage().rss / 1048576);

export function noteSlow(name, ms) {
  if (ms >= LIMIT_MS) console.warn(`Langsam: ${name} ${Math.round(ms)} ms (Speicher ${mb()} MB)`);
}
/** fn ausführen und messen (nur der synchrone Teil). */
export function timed(name, fn) {
  const t = performance.now();
  try { return fn(); } finally { noteSlow(typeof name === 'function' ? name() : name, performance.now() - t); }
}
export const now = () => performance.now();

/** Einmal beim Start: Datenmengen der großen Tabellen ins Log (für die Einordnung von Laufzeit und Speicher). */
export function logDataSizes(db) {
  try {
    const n = (sql) => { try { return db.prepare(sql).get().n; } catch { return '–'; } };
    const sm = db.prepare('SELECT c.name, COUNT(s.url) AS n FROM competitors c LEFT JOIN sitemap_urls s ON s.competitor_id=c.id GROUP BY c.id ORDER BY n DESC LIMIT 8').all();
    console.log(`Daten: ${n('SELECT COUNT(*) AS n FROM products')} Artikel (${n('SELECT COUNT(*) AS n FROM products WHERE active=1 AND tracked=1')} beobachtet), `
      + `${n('SELECT COUNT(*) AS n FROM competitors')} Mitbewerber, ${n('SELECT COUNT(*) AS n FROM matches')} Treffer, ${n('SELECT COUNT(*) AS n FROM price_history')} Preisverlauf, `
      + `${n('SELECT COUNT(*) AS n FROM sitemap_urls')} Sitemap-Adressen (${sm.map((r) => `${r.name} ${r.n}`).join(', ')}), ${n('SELECT COUNT(*) AS n FROM own_sitemap_urls')} eigene, `
      + `${n('SELECT COUNT(*) AS n FROM seo_queries')} Suchanfragen, ${n('SELECT COUNT(*) AS n FROM market_offers')} Marktangebote, Speicher ${mb()} MB`);
  } catch (e) { console.error('Datenmengen:', e.message); }
}
