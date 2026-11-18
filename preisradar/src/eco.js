/**
 * Sparmodus: senkt die Rechenlast des Servers deutlich, auf Kosten der Aktualität.
 *   - Abruf: längere Pausen zwischen den Läufen, kürzere Läufe, kein automatisches Beschleunigen, 1,5-facher Abstand
 *   - Preisliste: nur neu berechnen, wenn sie gerade benutzt wird, und höchstens alle 3 Minuten
 *   - Sitemap-Index: Aufbau langsamer gestreckt
 *   - Seiten-Check: halbes Tempo
 * Einstellung eco_mode ('1' an, '0' aus). Der Stand wird hier gehalten, damit auch Stellen ohne Datenbank-Zugriff
 * (z. B. das Tempo im Fetcher) ihn kennen; der Planer frischt ihn regelmäßig auf.
 */
export const eco = { on: false };
export function refreshEco(db) {
  try { eco.on = db.prepare("SELECT value FROM settings WHERE key='eco_mode'").get()?.value === '1'; } catch { /* Tabelle noch nicht da */ }
  return eco.on;
}
