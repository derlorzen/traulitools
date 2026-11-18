import idealo from './idealo.js';

/**
 * Register der Marktquellen. Eine neue Quelle ist eine Datei mit Actor-Tarifen und einer Übersetzung des
 * Actor-Ergebnisses (normProduct); Planung, Kosten, Ablage, Auswertung und Oberfläche sind für alle gleich.
 *   kind: 'offers' = aktuelle Angebote (fließen in den günstigsten Marktpreis ein)
 */
export const SOURCES = { [idealo.key]: idealo };
export const sourceList = () => Object.values(SOURCES);
export const source = (key) => SOURCES[key] ?? null;
