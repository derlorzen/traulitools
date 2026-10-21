export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Alphanumerisch normalisieren (für EAN/Herstellernummern-Vergleiche). */
export function normId(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Preis aus Text oder Zahl lesen.
 * Deutsch ("1.234,56 €") ist der Standard, mit dotDecimal:true gilt "1234.56" (JSON-LD/Meta).
 */
export function parsePrice(v, { dotDecimal = false } = {}) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  let s = String(v).replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');
  } else if (lastDot > -1 && !dotDecimal && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

export function tokens(s) {
  return new Set(
    String(s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9äöüß]+/)
      .filter((t) => t.length >= 3),
  );
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Kleiner CSV-Parser (Trennzeichen ; , oder Tab, Anführungszeichen, BOM). */
export function parseCsv(text) {
  text = String(text ?? '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (c) => firstLine.split(c).length - 1;
  const delim = [';', '\t', ','].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function pick(row, names) {
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find((k) => k.toLowerCase().replace(/[\s_\-]/g, '') === n.toLowerCase().replace(/[\s_\-]/g, ''));
    if (k && row[k] !== '') return row[k];
  }
  return null;
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
