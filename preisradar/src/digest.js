import nodemailer from 'nodemailer';
import { getSetting, setSetting } from './settings.js';
import { analyse } from './analysis.js';
import { aiUsage } from './aiscrape.js';
import { seoOverview } from './seo.js';
import { gscConfig } from './gsc.js';

/**
 * Tägliche Zusammenfassung per E-Mail: was sich seit gestern bewegt hat und wo Handlungsbedarf besteht.
 */
const eur = (n) => (n == null ? '–' : n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const pct = (n) => (n == null ? '–' : `${n > 0 ? '+' : ''}${n.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`);
const nf = (n) => (n == null ? '–' : Math.round(n).toLocaleString('de-DE'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const berlinDay = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const berlinHour = (t = Date.now()) => Number(new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }));

export function mailConfig(db) {
  const port = Number(getSetting(db, 'mail_port') || 587);
  return {
    enabled: getSetting(db, 'mail_enabled') === '1',
    host: getSetting(db, 'mail_host') || '',
    port,
    secure: getSetting(db, 'mail_secure') ? getSetting(db, 'mail_secure') === '1' : port === 465,
    user: getSetting(db, 'mail_user') || '',
    pass: getSetting(db, 'mail_pass') || '',
    from: getSetting(db, 'mail_from') || getSetting(db, 'mail_user') || '',
    to: String(getSetting(db, 'mail_to') || '').split(/[\s,;]+/).filter((x) => /@/.test(x)),
    hour: Number(getSetting(db, 'mail_hour') ?? 7),
    get configured() { return Boolean(this.host && this.from && this.to.length); },
  };
}

/** Inhalt der Zusammenfassung (Daten). */
export function digestData(db, now = Date.now()) {
  const since = new Date(now - 24 * 3600 * 1000).toISOString();
  const a = analyse(db);
  const own = new Map(db.prepare('SELECT id, name, number, price FROM products').all().map((p) => [p.id, p]));
  // Preisänderungen der Mitbewerber in den letzten 24 Stunden (bestätigte Treffer beobachteter Artikel)
  const changes = db.prepare(`
    SELECT m.id, m.product_id, c.name AS competitor, h.price AS now_price, h.at,
      (SELECT h2.price FROM price_history h2 WHERE h2.match_id=h.match_id AND h2.at < h.at ORDER BY h2.at DESC LIMIT 1) AS before_price
    FROM price_history h JOIN matches m ON m.id=h.match_id JOIN competitors c ON c.id=m.competitor_id JOIN products p ON p.id=m.product_id
    WHERE h.at >= ? AND m.status='ok' AND p.tracked=1 AND p.active=1 AND p.offline_since IS NULL`).all(since)
    .filter((x) => x.before_price != null && Math.abs(x.before_price - x.now_price) >= 0.01)
    .map((x) => {
      const p = own.get(x.product_id);
      return { ...x, name: p?.name, number: p?.number, own_price: p?.price, pct: ((x.now_price - x.before_price) / x.before_price) * 100, undercut: p?.price != null && x.now_price < p.price && x.before_price >= p.price };
    });
  const drops = changes.filter((x) => x.pct < 0).sort((x, y) => Number(y.undercut) - Number(x.undercut) || x.pct - y.pct);
  const rises = changes.filter((x) => x.pct > 0).sort((x, y) => y.pct - x.pct);
  const weight = (r) => (r.revenue_90 ?? 0) * 1000 + (r.impressions ?? 0);
  const down = a.rows.filter((r) => r.action === 'senken').sort((x, y) => weight(y) - weight(x) || y.gap_percent - x.gap_percent).slice(0, 10);
  const up = a.rows.filter((r) => r.action === 'erhöhen').sort((x, y) => weight(y) - weight(x)).slice(0, 5);
  const offline = db.prepare('SELECT name, number, offline_since FROM products WHERE offline_since >= ? ORDER BY offline_since DESC LIMIT 20').all(since);
  const runs = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(checked),0) AS checked, COALESCE(SUM(found),0) AS found, COALESCE(SUM(errors),0) AS errors FROM runs WHERE started_at >= ?').get(since);
  let google = null;
  if (gscConfig(db).configured) {
    const o = seoOverview(db);
    if (o.daily.length) google = { clicks: o.kpi.clicks, clicks_prev: o.kpi.clicks_prev, impressions: o.kpi.impressions, position: o.kpi.position, top: o.opportunities.groups.find((g) => g.key === 'demand_price')?.items.slice(0, 5) ?? [] };
  }
  return { date: berlinDay(now), summary: a.summary, kpi: a.kpi, stats: a.stats, drops: drops.slice(0, 15), drops_total: drops.length, undercuts: drops.filter((x) => x.undercut).length, rises: rises.slice(0, 5), rises_total: rises.length, down, up, offline, runs, ai: aiUsage(), google };
}

/** HTML-Mail (Tabellen-Layout mit Inline-Styles, damit sie in allen Mailprogrammen gleich aussieht). */
export function digestHtml(d, appUrl = '') {
  const cell = 'padding:6px 8px;border-bottom:1px solid #e3e8e8;font-size:14px;';
  const num = `${cell}text-align:right;white-space:nowrap;`;
  const h2 = (t) => `<h2 style="font:600 17px/1.3 Arial,sans-serif;color:#12242b;margin:26px 0 8px">${esc(t)}</h2>`;
  const table = (head, rows) => rows.length ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;color:#12242b"><tr>${head.map((x, i) => `<th style="${i ? num : `${cell}text-align:left;`}color:#586a6f;font-size:12px;font-weight:600">${esc(x)}</th>`).join('')}</tr>${rows.join('')}</table>` : '<p style="font:14px Arial,sans-serif;color:#586a6f">Nichts.</p>';
  const k = d.kpi;
  const tile = (v, l, c = '#12242b') => `<td style="padding:10px 12px;background:#f3f6f6;border-radius:8px;font-family:Arial,sans-serif"><div style="font-size:22px;font-weight:700;color:${c}">${v}</div><div style="font-size:12px;color:#586a6f">${esc(l)}</div></td><td style="width:8px"></td>`;
  return `<!doctype html><html lang="de"><body style="margin:0;padding:0;background:#e9f0f0">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#e9f0f0"><tr><td align="center" style="padding:24px 12px">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px"><tr><td style="padding:24px 26px;font-family:Arial,sans-serif;color:#12242b">
<div style="font-size:13px;color:#0d5466;font-weight:700">Preisradar · ${esc(new Date(d.date).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
<h1 style="font:600 24px/1.25 Arial,sans-serif;margin:6px 0 10px">${d.undercuts ? `${d.undercuts} Mitbewerber ${d.undercuts === 1 ? 'ist' : 'sind'} seit gestern unter deinen Preis gegangen` : d.drops_total ? `${d.drops_total} Preissenkungen bei Mitbewerbern seit gestern` : 'Keine Preissenkungen bei Mitbewerbern seit gestern'}</h1>
<p style="font-size:14px;line-height:1.5;color:#3d4f54;margin:0 0 14px">${esc(d.summary)}</p>
<table cellpadding="0" cellspacing="0"><tr>${tile(nf(k.senken), 'zu teuer', '#b4402d')}${tile(nf(k.erhoehen), 'Spielraum nach oben', '#1f5fa8')}${tile(pct(k.avg_gap), 'Ø Abstand')}${tile(`${(k.coverage ?? 0).toLocaleString('de-DE')} %`, 'Abdeckung')}</tr></table>
${h2('Preisänderungen der Mitbewerber (24 Stunden)')}
${table(['Artikel', 'Mitbewerber', 'vorher', 'jetzt', 'Änderung', 'Dein Preis'], d.drops.concat(d.rises).map((x) => `<tr><td style="${cell}">${esc(x.name)}${x.undercut ? ' <b style="color:#b4402d">· jetzt günstiger als du</b>' : ''}</td><td style="${cell}">${esc(x.competitor)}</td><td style="${num}">${eur(x.before_price)}</td><td style="${num}">${eur(x.now_price)}</td><td style="${num}color:${x.pct < 0 ? '#b4402d' : '#1b7a4b'}">${pct(x.pct)}</td><td style="${num}">${eur(x.own_price)}</td></tr>`))}
${d.drops_total > d.drops.length ? `<p style="font:12px Arial,sans-serif;color:#586a6f">und ${d.drops_total - d.drops.length} weitere Senkungen.</p>` : ''}
${h2('Wichtigste Preissenkungs-Kandidaten')}
${table(['Artikel', 'Dein Preis', 'Günstigster', 'Abstand', 'Vorschlag'], d.down.map((r) => `<tr><td style="${cell}">${esc(r.name)}<div style="font-size:12px;color:#586a6f">${[r.units_30 != null ? `${nf(r.units_30)} verkauft (30 T)` : '', r.impressions != null ? `${nf(r.impressions)} Impr. bei Google` : '', r.margin_limited ? 'durch Mindestmarge begrenzt' : ''].filter(Boolean).join(' · ')}</div></td><td style="${num}">${eur(r.own_price)}</td><td style="${num}">${eur(r.cheapest)}<div style="font-size:12px;color:#586a6f">${esc(r.cheapest_competitor)}</div></td><td style="${num}color:#b4402d">${pct(r.gap_percent)}</td><td style="${num}font-weight:700">${eur(r.suggested_price)}</td></tr>`))}
${d.up.length ? h2('Spielraum nach oben') + table(['Artikel', 'Dein Preis', 'Günstigster', 'Vorschlag'], d.up.map((r) => `<tr><td style="${cell}">${esc(r.name)}</td><td style="${num}">${eur(r.own_price)}</td><td style="${num}">${eur(r.cheapest)}</td><td style="${num}font-weight:700">${eur(r.suggested_price)}</td></tr>`)) : ''}
${d.google ? h2('Google (letzte 28 Tage)') + `<p style="font:14px Arial,sans-serif;margin:0">${nf(d.google.clicks)} Klicks${d.google.clicks_prev ? ` (${pct(((d.google.clicks - d.google.clicks_prev) / d.google.clicks_prev) * 100)} zur Vorperiode)` : ''}, ${nf(d.google.impressions)} Impressionen, Ø Position ${(d.google.position ?? 0).toLocaleString('de-DE')}.</p>${d.google.top.length ? `<p style="font:13px Arial,sans-serif;color:#586a6f;margin:8px 0 4px">Viel gesucht, aber teurer:</p><ul style="font:14px Arial,sans-serif;margin:0;padding-left:18px">${d.google.top.map((x) => `<li>${esc(x.name)} (${esc(x.why)})</li>`).join('')}</ul>` : ''}` : ''}
${d.offline.length ? h2('Bei dir neu offline') + `<ul style="font:14px Arial,sans-serif;margin:0;padding-left:18px">${d.offline.map((x) => `<li>${esc(x.name)} (${esc(x.number)})</li>`).join('')}</ul>` : ''}
<p style="font:12px/1.5 Arial,sans-serif;color:#586a6f;margin:26px 0 0">Abrufe der letzten 24 Stunden: ${nf(d.runs.checked)} Prüfungen in ${nf(d.runs.n)} Läufen, ${nf(d.runs.found)} Preise gefunden, ${nf(d.runs.errors)} Fehler. KI-Anfragen heute: ${nf(d.ai.today)} von ${nf(d.ai.limit)}.</p>
${appUrl ? `<p style="margin:18px 0 0"><a href="${esc(appUrl)}" style="display:inline-block;background:#0d5466;color:#ffffff;text-decoration:none;font:600 14px Arial,sans-serif;padding:10px 16px;border-radius:8px">Preisradar öffnen</a></p>` : ''}
</td></tr></table>
<p style="font:11px Arial,sans-serif;color:#586a6f">Tägliche Zusammenfassung von Preisradar. Abbestellen unter Einstellungen → E-Mail.</p>
</td></tr></table></body></html>`;
}

export function digestText(d) {
  const lines = [`Preisradar – ${d.date}`, '', d.summary, '', `Preisänderungen der Mitbewerber (24 h): ${d.drops_total} Senkungen, ${d.rises_total} Erhöhungen, davon ${d.undercuts} jetzt günstiger als du.`];
  for (const x of d.drops) lines.push(`- ${x.name}: ${x.competitor} ${eur(x.before_price)} → ${eur(x.now_price)} (${pct(x.pct)}), du: ${eur(x.own_price)}`);
  lines.push('', 'Preissenkungs-Kandidaten:');
  for (const r of d.down) lines.push(`- ${r.name}: ${eur(r.own_price)}, günstigster ${eur(r.cheapest)} (${r.cheapest_competitor}), Vorschlag ${eur(r.suggested_price)}`);
  return lines.join('\n');
}

export async function sendDigest(db, { appUrl = getSetting(db, 'app_url') || '', to = null } = {}) {
  const cfg = mailConfig(db);
  if (!cfg.host || !cfg.from) throw new Error('E-Mail-Versand ist nicht eingerichtet (Server und Absender fehlen)');
  const rcpt = to ?? cfg.to;
  if (!rcpt.length) throw new Error('Keine Empfänger eingetragen');
  const d = digestData(db);
  const transport = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined, connectionTimeout: 20000 });
  const subject = d.undercuts ? `Preisradar: ${d.undercuts} Mitbewerber jetzt günstiger als du` : `Preisradar: ${d.kpi.senken} Artikel zu teuer, ${d.drops_total} Preissenkungen bei Mitbewerbern`;
  const info = await transport.sendMail({ from: cfg.from, to: rcpt.join(', '), subject, text: digestText(d), html: digestHtml(d, appUrl) });
  setSetting(db, 'mail_last_sent', new Date().toISOString());
  return { messageId: info.messageId, to: rcpt, subject };
}

/** Vom Zeitplan aufgerufen: einmal täglich zur eingestellten Stunde. */
export async function maybeSendDigest(db, now = Date.now()) {
  const cfg = mailConfig(db);
  if (!cfg.enabled || !cfg.configured) return null;
  const day = berlinDay(now);
  if (getSetting(db, 'mail_sent_day') === day || berlinHour(now) < cfg.hour) return null;
  setSetting(db, 'mail_sent_day', day); // auch bei Fehler nur ein Versuch pro Tag, damit nicht wiederholt gesendet wird
  return sendDigest(db);
}
