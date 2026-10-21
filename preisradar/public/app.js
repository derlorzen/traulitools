// Preisradar – Oberfläche (ohne Framework, ohne externe Ressourcen)
const NS = 'http://www.w3.org/2000/svg';
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const pct = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const dt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const dShort = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

class AuthError extends Error {}

async function api(path, opts = {}) {
  const method = opts.method || (opts.body ? 'POST' : 'GET');
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : method === 'GET' ? undefined : '{}',
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) { showAuth(); throw new AuthError('Nicht angemeldet'); }
  if (!res.ok) throw new Error(json.error || `Fehler ${res.status}`);
  return json;
}

let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (!(e instanceof AuthError)) toast(e.message, true); } };

const state = { data: null, tab: 'preise', q: '', brand: '', filter: 'all', sort: 'name', selected: null, runs: [] };

// ---------- Auswertung pro Produkt ----------
function analyse(p, comps) {
  const cells = comps.map((c) => ({ c, m: p.matches[c.id] }));
  const ok = cells.filter(({ m }) => m && m.status === 'ok' && m.price != null);
  const review = cells.some(({ m }) => m && m.status === 'review');
  const min = ok.length ? Math.min(...ok.map(({ m }) => m.price)) : null;
  let kind = 'none';
  if (min != null && p.price != null) kind = p.price <= min ? 'cheapest' : 'undercut';
  const gap = min != null && p.price != null ? p.price - min : null;
  return { cells, ok, min, kind, gap, gapPct: gap != null && min ? (gap / min) * 100 : null, review };
}

// ---------- Preisleiter ----------
function ladder(p, a) {
  const W = 150, H = 26, pad = 7;
  const vals = [p.price, ...a.ok.map(({ m }) => m.price)].filter((v) => v != null);
  const svg = s('svg', { class: 'ladder', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Preisposition' });
  if (a.ok.length === 0 || p.price == null) return svg;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const x = (v) => (hi === lo ? W / 2 : pad + ((v - lo) / (hi - lo)) * (W - pad * 2));
  const y = H / 2;
  svg.append(s('line', { x1: x(lo), x2: x(hi), y1: y, y2: y, stroke: 'var(--line)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
  if (a.kind === 'undercut') svg.append(s('line', { x1: x(a.min), x2: x(p.price), y1: y, y2: y, stroke: 'var(--bad)', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  if (a.kind === 'cheapest') {
    const second = Math.min(...a.ok.map(({ m }) => m.price));
    svg.append(s('line', { x1: x(p.price), x2: x(second), y1: y, y2: y, stroke: 'var(--good)', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  }
  for (const { m, c } of a.ok) svg.append(s('circle', { cx: x(m.price), cy: y, r: 3.5, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 1.5 }, s('title', {}, `${c.name}: ${eur.format(m.price)}`)));
  svg.append(s('circle', { cx: x(p.price), cy: y, r: 5.5, fill: a.kind === 'undercut' ? 'var(--bad)' : 'var(--petrol)', stroke: 'var(--surface)', 'stroke-width': 1.5 }, s('title', {}, `${state.data.own.name}: ${eur.format(p.price)}`)));
  return svg;
}

// ---------- Preise ----------
function matchCell(p, a, { c, m }) {
  if (!m) return h('td', {}, h('span', { class: 'tag mute' }, '–'));
  const tip = m.checked ? `Geprüft: ${dt.format(new Date(m.checked))}` : '';
  if (m.status === 'ok' || m.status === 'review') {
    const best = m.status === 'ok' && a.min != null && m.price === a.min;
    let delta = null;
    if (p.price) {
      const d = ((m.price - p.price) / p.price) * 100;
      const cls = Math.abs(d) < 0.05 ? 'same' : d < 0 ? 'cheaper' : 'dearer';
      delta = h('span', { class: `delta ${cls}` }, Math.abs(d) < 0.05 ? 'gleich' : `${pct.format(d)} %`);
    }
    const prev = m.previous != null && m.previous !== m.price ? ` · vorher ${eur.format(m.previous)}` : '';
    return h('td', { class: `cell ${m.status}${best ? ' best' : ''}`, title: `${m.title ?? ''}\n${tip}${prev}`.trim() },
      h('span', { class: 'price' }, eur.format(m.price)), delta, m.status === 'review' ? h('span', { class: 'tag' }, 'prüfen') : null);
  }
  const map = {
    not_found: ['nicht gefunden', 'mute'], nourl: ['URL fehlt', 'mute'], pending: ['ausstehend', 'mute'],
    blocked: ['gesperrt', 'err'], error: ['Fehler', 'err'],
  };
  const [label, cls] = map[m.status] ?? [m.status, 'mute'];
  return h('td', { title: [m.error, tip].filter(Boolean).join('\n') }, h('span', { class: `tag ${cls}` }, label));
}

function renderPrices(root) {
  const d = state.data;
  if (!d.products.length) {
    root.append(h('div', { class: 'panel empty' },
      h('h3', {}, 'Noch keine Produkte'),
      h('p', {}, 'Hol die Produkte aus Shopware oder lade eine CSV-Datei hoch.'),
      h('button', { class: 'btn primary', onclick: () => setTab('import') }, 'Zum Import')));
    return;
  }
  const noComps = !d.competitors.length;
  if (noComps) {
    root.append(h('div', { class: 'panel head' },
      h('div', {}, h('strong', {}, `${d.products.length} Produkte in deiner Artikelbasis. `), 'Für den Preisvergleich fehlen noch Mitbewerber.'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => setTab('mitbewerber') }, 'Mitbewerber anlegen')));
  }
  const rows = d.products.map((p) => ({ p, a: analyse(p, d.competitors) }));
  const count = (f) => rows.filter(f).length;
  const brands = [...new Set(d.products.map((p) => p.manufacturer).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));

  const chip = (key, label, n, cls = '') => h('button', { class: `chip ${cls}${state.filter === key ? ' on' : ''}`, onclick: () => { state.filter = key; render(); } }, h('b', {}, String(n)), label);
  root.append(
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Suche: Name, Artikelnummer, EAN', value: state.q, 'aria-label': 'Suche',
        oninput: (e) => { state.q = e.target.value; renderTable(); } }),
      h('select', { 'aria-label': 'Hersteller', onchange: (e) => { state.brand = e.target.value; renderTable(); } },
        h('option', { value: '' }, 'Alle Hersteller'), brands.map((b) => h('option', { value: b, selected: b === state.brand }, b))),
      h('select', { 'aria-label': 'Sortierung', onchange: (e) => { state.sort = e.target.value; renderTable(); } },
        [['name', 'Sortiert nach Name'], ['gap', 'Größter Rückstand zuerst'], ['lead', 'Größter Vorsprung zuerst'], ['price', 'Preis absteigend']]
          .filter(([v]) => !noComps || v === 'name' || v === 'price').map(([v, l]) => h('option', { value: v, selected: v === state.sort }, l))),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: '/api/export.csv' }, 'CSV-Export')),
    noComps ? null : h('div', { class: 'toolbar' }, h('div', { class: 'seg' },
      chip('all', 'Produkte', rows.length),
      chip('undercut', 'teurer als ein Mitbewerber', count((r) => r.a.kind === 'undercut'), 'bad'),
      chip('cheapest', 'günstigster Preis', count((r) => r.a.kind === 'cheapest'), 'good'),
      chip('none', 'ohne Vergleichspreis', count((r) => r.a.kind === 'none')),
      chip('review', 'zu prüfen', count((r) => r.a.review), 'warn'))),
    h('div', { class: 'tablewrap', id: 'tablewrap' }));
  renderTable();
}

function renderTable() {
  const d = state.data;
  const wrap = document.getElementById('tablewrap');
  if (!wrap) return;
  const q = state.q.trim().toLowerCase();
  let rows = d.products.map((p) => ({ p, a: analyse(p, d.competitors) }));
  rows = rows.filter(({ p, a }) => {
    if (state.brand && p.manufacturer !== state.brand) return false;
    if (state.filter !== 'all' && !(state.filter === 'review' ? a.review : a.kind === state.filter)) return false;
    if (q && ![p.name, p.number, p.ean, p.mpn, p.manufacturer].some((v) => String(v ?? '').toLowerCase().includes(q))) return false;
    return true;
  });
  const sorters = {
    name: (x, y) => (x.p.manufacturer ?? '').localeCompare(y.p.manufacturer ?? '', 'de') || x.p.name.localeCompare(y.p.name, 'de'),
    gap: (x, y) => (y.a.gap ?? -Infinity) - (x.a.gap ?? -Infinity),
    lead: (x, y) => (x.a.gap ?? Infinity) - (y.a.gap ?? Infinity),
    price: (x, y) => (y.p.price ?? 0) - (x.p.price ?? 0),
  };
  rows.sort(sorters[state.sort]);

  const shown = rows.slice(0, 400);
  const table = h('table', { class: 'prices' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'prod' }, `Produkt (${rows.length}${rows.length !== d.products.length ? ' von ' + d.products.length : ''})`),
      h('th', { class: 'own' }, d.own.name),
      d.competitors.map((c) => h('th', { title: c.base_url }, c.name, c.enabled ? '' : ' (aus)')),
      d.competitors.length ? [h('th', {}, 'Position'), h('th', {}, 'Abstand zum günstigsten')] : null)),
    h('tbody', {}, shown.map(({ p, a }) => h('tr', { tabindex: 0, onclick: () => openDrawer(p.id), onkeydown: (e) => e.key === 'Enter' && openDrawer(p.id) },
      h('td', { class: 'prod' }, h('div', { class: 'pname' }, p.name), h('div', { class: 'pmeta' }, [p.manufacturer, p.number, p.ean].filter(Boolean).join(' · '))),
      h('td', { class: 'own' }, p.price != null ? eur.format(p.price) : '–'),
      a.cells.map((cell) => matchCell(p, a, cell)),
      d.competitors.length ? h('td', {}, ladder(p, a)) : null,
      d.competitors.length ? h('td', { class: a.kind === 'undercut' ? 'gap bad' : a.kind === 'cheapest' ? 'gap good' : 'gap' },
        a.kind === 'undercut' ? [`+${eur.format(a.gap)}`, h('small', {}, `${pct.format(a.gapPct)} % über dem günstigsten`)]
          : a.kind === 'cheapest' ? ['günstigster', h('small', {}, a.min - p.price > 0.004 ? `${eur.format(a.min - p.price)} Vorsprung` : 'gleichauf')]
            : h('span', { class: 'tag mute' }, '–')) : null))));
  wrap.replaceChildren(table);
  if (rows.length > shown.length) wrap.append(h('p', { class: 'pmeta', style: 'padding:10px 14px' }, `Es werden die ersten ${shown.length} von ${rows.length} Produkten gezeigt – Suche oder Filter verwenden.`));
  if (!rows.length) wrap.replaceChildren(h('div', { class: 'empty' }, 'Keine Produkte für diesen Filter.'));
}

// ---------- Detailansicht ----------
const COLORS = ['#c2410c', '#7c3aed', '#0891b2', '#a16207', '#be185d', '#4d7c0f', '#475569'];

function chart(hist) {
  const own = { name: state.data.own.name, color: 'var(--petrol)', pts: hist.own, w: 3 };
  const others = hist.series.map((x, i) => ({ name: x.name, color: COLORS[i % COLORS.length], pts: x.points, w: 2 }));
  const all = [own, ...others].filter((x) => x.pts.length);
  const pts = all.flatMap((x) => x.pts.map((p) => ({ t: Date.parse(p.at), v: p.price })));
  if (!pts.length) return h('p', { class: 'pmeta' }, 'Noch kein Preisverlauf vorhanden.');
  const W = 516, H = 190, L = 52, R = 10, T = 10, B = 24;
  let t0 = Math.min(...pts.map((p) => p.t)), t1 = Math.max(...pts.map((p) => p.t), Date.now());
  if (t1 - t0 < 86400000) t0 = t1 - 86400000 * 3;
  let v0 = Math.min(...pts.map((p) => p.v)), v1 = Math.max(...pts.map((p) => p.v));
  const padV = (v1 - v0) * 0.12 || v1 * 0.05 || 1;
  v0 -= padV; v1 += padV;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - v0) / (v1 - v0)) * (H - T - B);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Preisverlauf' });
  for (let i = 0; i <= 3; i++) {
    const v = v0 + ((v1 - v0) * i) / 3;
    svg.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: 'var(--line)' }),
      s('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, eur.format(v).replace(/,00/, '')));
  }
  for (let i = 0; i <= 3; i++) {
    const t = t0 + ((t1 - t0) * i) / 3;
    svg.append(s('text', { x: X(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === 3 ? 'end' : 'middle', 'font-size': 11, fill: 'var(--muted)' }, dShort.format(new Date(t))));
  }
  for (const ser of all) {
    const pts2 = ser.pts.map((p) => [X(Date.parse(p.at)), Y(p.price)]);
    let d = `M${pts2[0][0]},${pts2[0][1]}`;
    for (let i = 1; i < pts2.length; i++) d += `H${pts2[i][0]}V${pts2[i][1]}`;
    d += `H${X(t1)}`;
    svg.append(s('path', { d, fill: 'none', stroke: ser.color, 'stroke-width': ser.w, 'stroke-linejoin': 'round' }));
    const last = pts2[pts2.length - 1];
    svg.append(s('circle', { cx: last[0], cy: last[1], r: 3, fill: ser.color }));
  }
  const legend = h('div', { class: 'legend' }, all.map((x) => h('span', {}, h('i', { style: `background:${x.color}` }), x.name)));
  return h('div', {}, svg, legend);
}

async function openDrawer(id) {
  state.selected = id;
  const d = state.data;
  const p = d.products.find((x) => x.id === id);
  if (!p) return;
  const el = document.getElementById('drawer');
  el.hidden = false;
  const a = analyse(p, d.competitors);
  const statusText = { ok: 'bestätigt', review: 'bitte prüfen', not_found: 'nicht gefunden', nourl: 'URL fehlt', pending: 'ausstehend', blocked: 'durch robots.txt gesperrt', error: 'Fehler' };
  const histBox = h('div', {}, h('p', { class: 'pmeta' }, 'Verlauf wird geladen …'));

  el.replaceChildren(
    h('button', { class: 'btn small close', onclick: closeDrawer, 'aria-label': 'Schließen' }, 'Schließen'),
    h('h2', {}, p.name),
    h('p', { class: 'pmeta' }, [p.manufacturer, `Art.-Nr. ${p.number}`, p.ean && `EAN ${p.ean}`].filter(Boolean).join(' · ')),
    h('div', { class: 'row', style: 'margin:10px 0 4px' },
      h('strong', {}, `${d.own.name}: ${p.price != null ? eur.format(p.price) : '–'}`),
      p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, 'im Shop öffnen') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: guard(async () => { await api('/api/scrape', { body: { product_id: p.id } }); toast('Abruf gestartet'); await refresh(); }) }, 'Jetzt prüfen')),
    h('h3', { style: 'margin-top:18px' }, 'Preisverlauf'), histBox,
    h('h3', { style: 'margin-top:22px' }, 'Mitbewerber'),
    a.cells.map(({ c, m }) => {
      const input = h('input', { type: 'url', placeholder: 'Produkt-URL beim Mitbewerber (optional, überschreibt die Suche)', value: m?.url ?? '', 'aria-label': `URL bei ${c.name}` });
      return h('div', { class: 'mrow' },
        h('div', { class: 'line' }, h('strong', {}, c.name),
          h('span', { class: `tag ${m?.status === 'ok' ? 'mute' : m?.status === 'error' || m?.status === 'blocked' ? 'err' : m?.status === 'review' ? '' : 'mute'}` }, statusText[m?.status] ?? 'ausstehend'),
          m?.source === 'manual' ? h('span', { class: 'tag mute' }, 'manuell') : null,
          h('span', { class: 'p' }, m?.price != null && (m.status === 'ok' || m.status === 'review') ? eur.format(m.price) : '')),
        m?.title ? h('div', { class: 'pmeta' }, m.title) : null,
        m?.error ? h('div', { class: 'pmeta' }, m.error) : null,
        m?.ai_note ? h('div', { class: 'pmeta' }, m.ai_note) : null,
        m?.checked ? h('div', { class: 'pmeta' }, `Geprüft ${dt.format(new Date(m.checked))}`) : null,
        input,
        h('div', { class: 'row', style: 'margin-top:8px' },
          m?.url ? h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, 'Seite öffnen') : null,
          h('span', { class: 'spacer' }),
          m?.status === 'review' ? [
            h('button', { class: 'btn small', onclick: guard(async () => { await api(`/api/matches/${m.id}/confirm`, { method: 'POST', body: {} }); await refresh(); }) }, 'Passt'),
            h('button', { class: 'btn small danger', onclick: guard(async () => { await api(`/api/matches/${m.id}/reject`, { method: 'POST', body: {} }); await refresh(); }) }, 'Passt nicht'),
          ] : null,
          h('button', { class: 'btn small', onclick: guard(async () => { await api('/api/matches', { method: 'PUT', body: { product_id: p.id, competitor_id: c.id, url: input.value } }); toast(input.value ? 'URL gespeichert, Preis wird abgerufen' : 'Zuordnung zurückgesetzt'); setTimeout(refresh, 2500); await refresh(); }) }, 'URL speichern')));
    }));
  try {
    histBox.replaceChildren(chart(await api(`/api/products/${id}/history`)));
  } catch (e) {
    histBox.replaceChildren(h('p', { class: 'pmeta' }, e.message));
  }
}
function closeDrawer() { state.selected = null; document.getElementById('drawer').hidden = true; }
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

// ---------- Mitbewerber ----------
/** Sitemaps eines Shops automatisch finden (robots.txt und übliche Pfade) und ins Textfeld übernehmen. */
function discoverBtn(getBase, getField) {
  const msg = h('span', { class: 'hint' });
  const btn = h('button', { class: 'btn small', type: 'button', onclick: guard(async () => {
    msg.textContent = 'Suche …';
    const r = await api('/api/sitemaps/discover', { body: { base_url: getBase() } });
    const field = getField();
    if (!r.sitemaps.length) { msg.textContent = 'Keine Sitemap gefunden. Trage die URL manuell ein.'; return; }
    const have = new Set(field.value.split(/\s+/).filter(Boolean));
    for (const s of r.sitemaps) have.add(s.url);
    field.value = [...have].join('\n');
    msg.textContent = `${r.sitemaps.length} gefunden (${r.sitemaps.map((s) => (s.kind === 'index' ? 'Index' : `${s.entries.toLocaleString('de-DE')} URLs`)).join(', ')}). Zum Übernehmen speichern.`;
  }) }, 'Sitemaps automatisch finden');
  return h('span', { class: 'row' }, btn, msg);
}

/** Artikelbasis aus der eigenen Sitemap importieren (Hintergrundjob mit Fortschrittsanzeige). */
function ownImportControls() {
  const msg = h('span', { class: 'hint' });
  const limit = h('input', { type: 'number', min: 1, placeholder: 'alle', style: 'width:90px' });
  const show = (s) => {
    const base = `${s.done.toLocaleString('de-DE')} von ${s.total.toLocaleString('de-DE')} Seiten · ${s.created} neu, ${s.updated} aktualisiert, ${s.skipped} übersprungen${s.errors ? `, ${s.errors} Fehler` : ''}`;
    msg.textContent = s.running ? `Läuft: ${base}` : s.startedAt ? `Fertig: ${base}${s.lastError ? ` · letzter Fehler: ${s.lastError}` : ''}` : '';
  };
  let timer = null;
  const poll = () => {
    clearInterval(timer);
    timer = setInterval(async () => {
      if (!document.contains(msg)) return clearInterval(timer);
      try {
        const s = await api('/api/import/sitemap/status');
        show(s);
        start.disabled = s.running;
        if (!s.running) { clearInterval(timer); await refresh(); }
      } catch { clearInterval(timer); }
    }, 2000);
  };
  const start = h('button', { class: 'btn small primary', type: 'button', onclick: guard(async () => {
    await api('/api/import/sitemap', { method: 'POST', body: { limit: Number(limit.value) || 0 } });
    start.disabled = true;
    toast('Import gestartet, läuft im Hintergrund');
    poll();
  }) }, 'Produkte importieren');
  const stop = h('button', { class: 'btn small', type: 'button', onclick: guard(async () => { await api('/api/import/sitemap/stop', { method: 'POST', body: {} }); }) }, 'Stoppen');
  api('/api/import/sitemap/status').then((s) => { show(s); start.disabled = s.running; if (s.running) poll(); }).catch(() => {});
  return { limit, start, stop, msg };
}

function competitorPanel(c) {
  const f = (label, name, value, { hint, type = 'text', ph } = {}) => h('div', { class: 'field' }, h('label', {}, label), h('input', { name, type, value: value ?? '', placeholder: ph ?? '' }), hint ? h('span', { class: 'hint' }, hint) : null);
  const form = h('form', { class: 'panel', onsubmit: (e) => e.preventDefault() });
  const out = h('div', { class: 'result', hidden: true });
  const val = () => {
    const fd = Object.fromEntries(new FormData(form));
    return { ...fd, delay_ms: Number(fd.delay_ms) || 3000, enabled: form.elements.enabled.checked };
  };
  const sm = h('span', { class: 'hint' }, c?.sitemap_count ? `${c.sitemap_count.toLocaleString('de-DE')} URLs eingelesen` : '');
  const show = (nodes) => { out.hidden = false; out.replaceChildren(...[].concat(nodes)); };
  const test = guard(async (kind) => {
    const v = val();
    const body = kind !== 'search' ? { product_url: form.elements.t_url.value, price_selector: v.price_selector, use_ai: kind === 'ai' } : { search_url: v.search_url, query: form.elements.t_q.value, result_selector: v.result_selector };
    show('Wird abgerufen …');
    const r = await api('/api/competitors/test', { body });
    if (r.blocked) return show(`⚠ ${r.message}`);
    const nodes = [];
    if (r.product) nodes.push(h('div', {}, r.product.found ? `Preis ${eur.format(r.product.price)} gefunden (Quelle: ${r.product.source}).` : `Kein Preis gefunden (HTTP ${r.product.http}). Ein Preis-Selektor kann helfen.`, h('br'), `Titel: ${r.product.title ?? '–'}`, h('br'), `Kennungen: ${r.product.ids.join(', ') || 'keine'}`));
    if (r.search) nodes.push(h('div', {}, `Suche (HTTP ${r.search.http}): ${r.search.candidates.length} Treffer-Links`, h('ul', {}, r.search.candidates.map((u) => h('li', {}, h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u))))));
    if (r.ai) nodes.push(h('div', { style: 'margin-top:8px' }, h('strong', {}, 'KI: '), r.ai.price != null ? `Preis ${eur.format(r.ai.price)}` : r.ai.priceUngrounded ? 'Preis nicht auf der Seite belegt, verworfen' : 'kein Preis erkannt', ` · ${r.ai.isProductPage ? 'Produktseite' : 'keine Produktseite'} · Titel: ${r.ai.title ?? '–'}`));
    show(nodes.length ? nodes : 'Bitte eine Test-URL oder einen Suchbegriff eingeben.');
  });
  form.append(
    h('div', { class: 'grid' },
      f('Name', 'name', c?.name, { ph: 'z. B. Bad-Direkt' }),
      f('Shop-URL', 'base_url', c?.base_url, { type: 'url', ph: 'https://www.beispiel-shop.de' }),
      f('Such-URL', 'search_url', c?.search_url, { ph: 'https://…/search?search={q}', hint: '{q} wird durch EAN bzw. Herstellernummer ersetzt. Shopware-Shops: …/search?search={q}' }),
      f('Ergebnis-Selektor (optional)', 'result_selector', c?.result_selector, { ph: 'a.product-name', hint: 'CSS-Selektor der Produktlinks auf der Suchseite' }),
      f('Preis-Selektor (optional)', 'price_selector', c?.price_selector, { ph: '.product-detail-price', hint: 'Nur nötig, wenn der Preis nicht automatisch erkannt wird' }),
      f('Pause zwischen Abrufen (ms)', 'delay_ms', c?.delay_ms ?? 3000, { type: 'number' }),
      h('div', { class: 'field', style: 'grid-column:1/-1' }, h('label', {}, 'Sitemap-URLs (optional, eine pro Zeile)'),
        h('textarea', { name: 'sitemap_url', rows: 2, placeholder: 'https://www.beispiel-shop.de/sitemap/Sitemap_item.xml' }, c?.sitemap_url ?? ''),
        h('span', { class: 'hint' }, 'Für Shops, deren Suche gesperrt oder nicht auslesbar ist: Produkte werden über die URLs der Sitemap (Marke und Name) gefunden. Die Sitemap wird wöchentlich neu eingelesen.'),
        c ? h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: guard(async () => {
          const r = await api(`/api/competitors/${c.id}/sitemap/refresh`, { method: 'POST', body: {} });
          const bad = r.report.filter((x) => x.error);
          sm.textContent = `${r.count.toLocaleString('de-DE')} URLs eingelesen${bad.length ? ` · Fehler: ${bad.map((x) => `${x.url.split('/').pop()} (${x.error})`).join(', ')}` : ''}`;
          toast(r.count ? 'Sitemap eingelesen' : 'Keine URLs gefunden', !r.count);
        }) }, 'Sitemap jetzt einlesen'), sm) : null,
        h('div', { class: 'row' }, discoverBtn(() => form.elements.base_url.value, form.elements.sitemap_url ? () => form.elements.sitemap_url : () => null))),
      h('div', { class: 'field' }, h('label', {}, 'KI beim Auslesen'),
        h('select', { name: 'ai_mode' },
          [['fallback', 'Bei Bedarf'], ['always', 'Immer prüfen'], ['off', 'Aus']].map(([v, t]) => h('option', { value: v, selected: (c?.ai_mode ?? 'fallback') === v }, t))),
        h('div', { class: 'hint' }, 'Bei Bedarf: Regeln zuerst, KI nur wenn nichts gefunden wird. Immer prüfen: KI beurteilt auch unsichere Treffer. Benötigt den OpenAI-Zugang unter Einstellungen. Die KI findet Produkte und liest Preise ohne CSS-Selektoren aus.'))),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'enabled', checked: c ? Boolean(c.enabled) : true }), 'Aktiv'),
      h('span', { class: 'spacer' }),
      c ? h('button', { class: 'btn small danger', type: 'button', onclick: guard(async () => { if (confirm(`„${c.name}“ samt Preisverlauf löschen?`)) { await api(`/api/competitors/${c.id}`, { method: 'DELETE' }); await refresh(); } }) }, 'Löschen') : null,
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { const v = val(); if (c) await api(`/api/competitors/${c.id}`, { method: 'PUT', body: v }); else await api('/api/competitors', { body: v }); toast('Gespeichert'); await refresh(); }) }, c ? 'Speichern' : 'Mitbewerber anlegen')),
    h('details', { style: 'margin-top:12px' }, h('summary', {}, 'Einrichtung testen'),
      h('div', { class: 'grid', style: 'margin-top:10px' },
        h('div', { class: 'field' }, h('label', {}, 'Produktseite testen'), h('input', { name: 't_url', type: 'url', placeholder: 'https://…/produkt' }), h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => test('product') }, 'Preis auslesen'), h('button', { class: 'btn small', type: 'button', onclick: () => test('ai') }, 'Mit KI auslesen'))),
        h('div', { class: 'field' }, h('label', {}, 'Suche testen'), h('input', { name: 't_q', placeholder: 'EAN oder Herstellernummer' }), h('button', { class: 'btn small', type: 'button', onclick: () => test('search') }, 'Suche ausführen'))),
      out));
  return form;
}

/** Mitbewerber per Produktlink einrichten: App analysiert den Shop und legt ihn an. */
function quickSetupPanel() {
  const url = h('input', { type: 'url', placeholder: 'https://www.mitbewerber.de/produkt-xyz', style: 'flex:1;min-width:260px', 'aria-label': 'Produktlink eines Mitbewerbers' });
  const name = h('input', { placeholder: 'Name (optional)', style: 'width:180px' });
  const out = h('div', { class: 'result', hidden: true });
  const row = (k, v) => h('div', {}, h('strong', {}, `${k}: `), v);
  const analyse = h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => {
    out.hidden = false; out.textContent = 'Analysiere Shop … (kann bis zu einer Minute dauern)';
    analyse.disabled = true;
    try {
      const r = await api('/api/competitors/autosetup', { body: { product_url: url.value } });
      const ok = r.product || r.search_url || r.sitemaps.length;
      out.replaceChildren(
        row('Shop', `${r.name} (${r.base_url})`),
        row('Preis', r.product ? `${eur.format(r.product.price)} erkannt über ${r.price_method}` : 'nicht erkannt'),
        row('Suche', r.search_url ?? 'keine nutzbare Such-URL'),
        row('Sitemaps', r.sitemaps.length ? r.sitemaps.map((s) => s.url).join(', ') : 'keine gefunden'),
        ...r.notes.map((n) => h('div', { class: 'pmeta' }, n)),
        ok ? h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => {
          await api('/api/competitors/autosetup', { body: { product_url: url.value, name: name.value, create: true } });
          toast('Mitbewerber angelegt'); await refresh();
        }) }, 'Mitbewerber so anlegen')) : null);
    } finally { analyse.disabled = false; }
  }) }, 'Shop analysieren');
  return h('div', { class: 'panel' }, h('h3', {}, 'Per Produktlink einrichten'),
    h('p', { class: 'sub' }, 'Füge den Link zu einem beliebigen Produkt des Mitbewerbers ein. Preisradar erkennt, wie der Preis ausgelesen wird, probiert gängige Such-URLs (nur wenn die robots.txt sie erlaubt) und sucht die Sitemaps. Danach legst du den Mitbewerber mit einem Klick an.'),
    h('div', { class: 'row' }, url, name, analyse), out);
}

function renderCompetitors(root) {
  root.append(h('h2', {}, 'Mitbewerber'),
    h('p', { class: 'sub' }, 'Jeder Mitbewerber braucht eine Such-URL (Suche per EAN oder Herstellernummer) und/oder Sitemap-URLs (Zuordnung über Marke und Name). Alternativ trägst du Produkt-URLs direkt im Import oder in der Detailansicht ein. Die robots.txt der Shops wird immer beachtet.'),
    quickSetupPanel(),
    ...state.data.competitors.map((c) => competitorPanel(c)),
    h('h3', {}, 'Neuen Mitbewerber hinzufügen'), competitorPanel(null));
}

// ---------- Import & Läufe ----------
function fileButton(label, endpoint, doneMsg) {
  const inp = h('input', { type: 'file', accept: '.csv,.txt', hidden: true, onchange: guard(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = await api(endpoint, { body: { text: await file.text() } });
    toast(doneMsg(r));
    e.target.value = '';
    await refresh();
  }) });
  return h('span', {}, inp, h('button', { class: 'btn', onclick: () => inp.click() }, label));
}

async function renderImport(root) {
  const d = state.data;
  root.append(h('h2', {}, 'Import & Läufe'),
    h('div', { class: 'panel' }, h('h3', {}, 'Eigene Produkte'),
      h('p', { class: 'sub' }, d.config.shopware
        ? 'Der Shopware-Zugang ist eingerichtet. Der Import liest aktive Produkte mit Artikelnummer, EAN, Herstellernummer und Bruttopreis.'
        : 'Der Shopware-Zugang ist noch nicht eingerichtet: SHOPWARE_URL, SHOPWARE_CLIENT_ID und SHOPWARE_CLIENT_SECRET als Umgebungsvariablen setzen (Integration unter Einstellungen → System → Integrationen). Bis dahin geht der Import per CSV.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', disabled: !d.config.shopware, onclick: guard(async (e) => { e.target.disabled = true; try { const r = await api('/api/import/shopware', { method: 'POST', body: {} }); toast(`${r.created} neu, ${r.updated} aktualisiert`); await refresh(); } finally { e.target.disabled = false; } }) }, 'Aus Shopware importieren'),
        fileButton('Produkt-CSV hochladen', '/api/import/csv', (r) => `${r.created} neu, ${r.updated} aktualisiert`)),
      h('p', { class: 'pmeta', style: 'margin-top:8px' }, 'CSV-Spalten: Artikelnummer, Name, EAN, Herstellernummer, Hersteller, Preis (brutto), URL.')),
    h('div', { class: 'panel' }, h('h3', {}, 'Bekannte Mitbewerber-URLs'),
      h('p', { class: 'sub' }, 'Wenn du die Produktseiten schon kennst: CSV mit den Spalten Artikelnummer, Mitbewerber (Name wie angelegt) und URL. Diese Zuordnungen werden nicht per Suche überschrieben.'),
      fileButton('URL-CSV hochladen', '/api/import/urls', (r) => `${r.set} URLs gesetzt${r.skipped ? `, ${r.skipped} übersprungen` : ''}`)));
  try {
    state.runs = await api('/api/runs');
  } catch { /* ignorieren */ }
  root.append(h('div', { class: 'panel' }, h('h3', {}, 'Letzte Läufe'),
    state.runs.length ? h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, ['Start', 'Auslöser', 'Geprüft', 'Preise gefunden', 'Fehler', 'Dauer'].map((x) => h('th', {}, x)))),
      h('tbody', {}, state.runs.map((r) => h('tr', {}, h('td', {}, dt.format(new Date(r.started_at))), h('td', {}, r.trigger === 'schedule' ? 'Zeitplan' : 'manuell'), h('td', {}, `${r.checked}/${r.total}`), h('td', {}, r.found), h('td', {}, r.errors),
        h('td', {}, r.finished_at ? `${Math.max(1, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60000))} min${r.note ? ` (${r.note})` : ''}` : 'läuft …'))))) : h('p', { class: 'pmeta' }, 'Noch kein Lauf.'),
    h('p', { class: 'pmeta', style: 'margin-top:8px' }, `Automatischer Abruf zweimal täglich (${d.config.scrapeHours.map((x) => String(x).padStart(2, '0') + ':00').join(' und ')} Uhr).`)));
}

// ---------- Anmeldung ----------
async function showAuth(info) {
  clearInterval(pollTimer);
  closeDrawer();
  document.body.classList.add('noauth');
  info ??= await fetch('/api/auth/state').then((r) => r.json());
  const setup = info.setup;
  const err = h('p', { class: 'err', role: 'alert' });
  const f = (label, name, type = 'text', extra = {}) => h('div', { class: 'field' }, h('label', { for: name }, label), h('input', { id: name, name, type, required: true, ...extra }));
  const form = h('form', { class: 'panel authbox', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    const v = Object.fromEntries(new FormData(form));
    if (setup && v.password !== v.password2) { err.textContent = 'Die Passwörter stimmen nicht überein.'; return; }
    try {
      await api(setup ? '/api/auth/setup' : '/api/auth/login', { body: v });
      await boot();
    } catch (x) { err.textContent = x.message; }
  } },
    h('h2', {}, setup ? 'Preisradar einrichten' : 'Anmelden'),
    h('p', { class: 'sub' }, setup ? 'Lege deinen Zugang an. Das Konto gilt für diese Installation; Shopware-Zugangsdaten folgen danach unter Einstellungen.' : 'Bitte mit deinem Konto anmelden.'),
    f('Benutzername', 'username', 'text', { autocomplete: 'username', autofocus: true }),
    f(setup ? 'Passwort (mindestens 10 Zeichen)' : 'Passwort', 'password', 'password', { autocomplete: setup ? 'new-password' : 'current-password', minlength: setup ? 10 : 1 }),
    setup ? f('Passwort wiederholen', 'password2', 'password', { autocomplete: 'new-password' }) : null,
    setup && info.setupTokenRequired ? f('Einrichtungscode', 'setup_token', 'password', { autocomplete: 'off' }) : null,
    err,
    h('button', { class: 'btn primary', type: 'submit' }, setup ? 'Konto anlegen' : 'Anmelden'));
  document.getElementById('main').replaceChildren(form);
}


// ---------- Analyse (Regelwerk) ----------
const ACTION_TAG = { senken: ['Preis senken', 'err'], halten: ['Preis halten', 'mute'], 'erhöhen': ['Preis erhöhen', ''], 'prüfen': ['Prüfen', ''] };

async function renderAnalysis(root) {
  const d = state.data;
  const a = await api('/api/analysis');
  const byNumber = new Map(d.products.map((p) => [p.number, p]));
  root.append(h('h2', {}, 'Analyse'),
    h('p', { class: 'sub' }, `Feste Regeln auf Basis der bestätigten Mitbewerberpreise: bis ${a.rules.tolerance} % über dem Günstigsten gilt als konkurrenzfähig, mehr als ${a.rules.raiseAbove} % darunter ist Spielraum für eine Erhöhung, Abweichungen über ${a.rules.outlier} % werden als mögliche Fehlzuordnung markiert. Einkaufspreise und Margen kennt die App nicht, Senkungen bitte immer gegen die Marge prüfen.`));
  root.append(h('div', { class: 'panel' }, h('p', { style: 'max-width:80ch;margin:0' }, a.summary)));
  if (!a.rows.length) return;
  root.append(h('div', { class: 'tablewrap', style: 'max-height:none;margin-bottom:16px' }, h('table', { class: 'prices', style: 'min-width:0' },
    h('thead', {}, h('tr', {}, h('th', { class: 'prod' }, 'Artikel'), h('th', {}, 'Aktion'), h('th', {}, 'Mein Preis'), h('th', {}, 'Günstigster'), h('th', {}, 'Abstand'), h('th', {}, 'Vorschlag'), h('th', { style: 'text-align:left' }, 'Begründung'))),
    h('tbody', {}, a.rows.map((x) => {
      const [label, cls] = ACTION_TAG[x.action] ?? [x.action, ''];
      return h('tr', { onclick: () => byNumber.get(x.number) && (state.tab = 'preise', render(), openDrawer(x.id)) },
        h('td', { class: 'prod' }, h('div', { class: 'pname' }, x.name), h('div', { class: 'pmeta' }, x.number)),
        h('td', {}, h('span', { class: `tag ${cls}` }, label)),
        h('td', {}, eur.format(x.own_price)),
        h('td', {}, eur.format(x.cheapest), h('div', { class: 'pmeta' }, x.cheapest_competitor)),
        h('td', {}, `${x.gap_percent > 0 ? '+' : ''}${x.gap_percent.toString().replace('.', ',')} %`),
        h('td', { style: 'font-weight:700' }, x.suggested_price != null ? eur.format(x.suggested_price) : '–'),
        h('td', { style: 'text-align:left;white-space:normal;min-width:260px' }, x.reason));
    })))));
}

// ---------- Benutzer ----------
async function userPanel() {
  const users = await api('/api/users');
  const box = h('div', { class: 'panel' }, h('h3', {}, 'Benutzer'),
    h('p', { class: 'sub' }, 'Alle Benutzer haben die gleichen Rechte. Neue Benutzer melden sich mit Benutzername und Passwort an.'));
  box.append(h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, ['Benutzer', 'Angelegt', 'Neues Passwort', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, users.map((u) => {
      const pw = h('input', { type: 'password', placeholder: 'mind. 10 Zeichen', autocomplete: 'new-password', 'aria-label': `Neues Passwort für ${u.username}` });
      return h('tr', {},
        h('td', {}, u.username, u.me ? h('span', { class: 'tag mute' }, ' (du)') : null),
        h('td', {}, dt.format(new Date(u.created_at))),
        h('td', {}, h('div', { class: 'row' }, pw, h('button', { class: 'btn small', type: 'button', onclick: guard(async () => { await api(`/api/users/${u.id}/password`, { method: 'PUT', body: { password: pw.value } }); pw.value = ''; toast(`Passwort für ${u.username} gesetzt`); }) }, 'Setzen'))),
        h('td', {}, u.me ? null : h('button', { class: 'btn small danger', type: 'button', onclick: guard(async () => { if (confirm(`Benutzer „${u.username}“ löschen?`)) { await api(`/api/users/${u.id}`, { method: 'DELETE' }); await refreshUsers(); } }) }, 'Löschen')));
    }))));
  const nu = h('form', { class: 'row', style: 'margin-top:14px', onsubmit: (e) => e.preventDefault() },
    h('input', { name: 'username', placeholder: 'Neuer Benutzername', autocomplete: 'off', 'aria-label': 'Neuer Benutzername' }),
    h('input', { name: 'password', type: 'password', placeholder: 'Passwort (mind. 10 Zeichen)', autocomplete: 'new-password', 'aria-label': 'Passwort für neuen Benutzer' }),
    h('button', { class: 'btn primary', type: 'submit', onclick: guard(async () => { await api('/api/users', { body: Object.fromEntries(new FormData(nu)) }); nu.reset(); toast('Benutzer angelegt'); await refreshUsers(); }) }, 'Benutzer anlegen'));
  box.append(nu);
  return box;
}
async function refreshUsers() {
  const old = document.getElementById('userpanel');
  if (old) old.replaceChildren(await userPanel());
}

// ---------- Einstellungen ----------
async function renderSettings(root) {
  const cur = await api('/api/settings');
  const f = (label, name, value, { type = 'text', hint, ph } = {}) => h('div', { class: 'field' }, h('label', {}, label), h('input', { name, type, value: value ?? '', placeholder: ph ?? '', autocomplete: 'off' }), hint ? h('span', { class: 'hint' }, hint) : null);
  const out = h('div', { class: 'result', hidden: true });
  const form = h('form', { class: 'panel', onsubmit: (e) => e.preventDefault() });
  const vals = () => Object.fromEntries(new FormData(form));
  const owm = h('span', { class: 'hint' });
  const imp = ownImportControls();
  form.append(
    h('h3', {}, 'Dein Shop'),
    h('div', { class: 'grid' }, f('Anzeigename', 'own_name', cur.own_name, { hint: 'Spaltenüberschrift im Dashboard' }), f('Shop-URL', 'own_url', cur.own_url, { type: 'url', ph: 'https://www.belkai.de', hint: 'Für Links zu deinen Produkten' })),
    h('div', { class: 'field', style: 'margin-top:12px' }, h('label', {}, 'Eigene Sitemap-URLs (optional, eine pro Zeile)'),
      h('textarea', { name: 'own_sitemap_url', rows: 2, placeholder: 'https://www.belkai.de/sitemap.xml' }, cur.own_sitemap_url ?? ''),
      h('span', { class: 'hint' }, 'Auch .xml.gz und Index-Sitemaps. Die URLs werden deinen Artikeln zugeordnet (Artikelnummer im Pfad oder sehr ähnlicher Name), damit „im Shop öffnen“ auf die richtige Seite führt.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: guard(async () => {
          await api('/api/settings', { method: 'PUT', body: { own_sitemap_url: form.elements.own_sitemap_url.value } });
          const r = await api('/api/settings/own-sitemap/refresh', { method: 'POST', body: {} });
          const bad = r.report.filter((x) => x.error);
          owm.textContent = `${r.count.toLocaleString('de-DE')} URLs eingelesen, ${r.assigned} Artikeln zugeordnet${bad.length ? ` · Fehler: ${bad.map((x) => `${x.url.split('/').pop().slice(-40)} (${x.error})`).join(', ')}` : ''}`;
          await refresh();
        }) }, 'Einlesen & zuordnen'), owm),
      discoverBtn(() => form.elements.own_url.value, () => form.elements.own_sitemap_url),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('label', { class: 'pmeta' }, 'Anzahl begrenzen (leer = alle)'),
        imp.limit,
        imp.start, imp.stop, imp.msg)),
    h('h3', { style: 'margin-top:20px' }, 'Shopware-Zugang'),
    h('p', { class: 'sub' }, 'In Shopware unter Einstellungen → System → Integrationen eine Integration anlegen (Lesezugriff auf Produkte genügt). Das Secret wird verschlüsselt gespeichert und nie wieder angezeigt.'),
    cur.shopware_from_env ? h('p', { class: 'pmeta' }, 'Aktuell werden die Zugangsdaten aus der Server-Umgebung verwendet. Wenn du hier speicherst, gelten deine Eingaben.') : null,
    h('div', { class: 'grid' },
      f('Shopware-URL', 'shopware_url', cur.shopware_url, { type: 'url', ph: 'https://www.belkai.de' }),
      f('Client-ID', 'shopware_client_id', cur.shopware_client_id),
      f('Client-Secret', 'shopware_client_secret', '', { type: 'password', ph: cur.shopware_secret_set ? '•••••••• (gespeichert)' : '', hint: cur.shopware_secret_set ? 'Leer lassen, um das gespeicherte Secret zu behalten' : '' })),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => {
        out.hidden = false; out.textContent = 'Verbindung wird geprüft …';
        try { const r = await api('/api/settings/shopware/test', { body: vals() }); out.textContent = `Verbunden: ${r.products} aktive Produkte gefunden.`; }
        catch (e) { out.textContent = `Fehlgeschlagen: ${e.message}`; }
      }) }, 'Verbindung testen'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { await api('/api/settings', { method: 'PUT', body: vals() }); toast('Einstellungen gespeichert'); await refresh(); }) }, 'Speichern')),
    out);

  const kout = h('div', { class: 'result', hidden: true });
  const ki = h('form', { class: 'panel', onsubmit: (e) => e.preventDefault() },
    h('h3', {}, 'KI (OpenAI / ChatGPT API)'),
    h('p', { class: 'sub' }, 'API-Schlüssel aus dem OpenAI-Dashboard (platform.openai.com → API keys). Der Schlüssel wird verschlüsselt gespeichert und nie wieder angezeigt. Die KI liest die Seiten der Mitbewerber aus und wählt Treffer in den Suchergebnissen (pro Mitbewerber einstellbar, begrenzt auf ca. 400 Anfragen pro Lauf). Die Nutzung wird von OpenAI nach Verbrauch abgerechnet, nicht über ein ChatGPT-Abo.'),
    cur.openai_from_env ? h('p', { class: 'pmeta' }, 'Aktuell wird der Schlüssel aus der Server-Umgebung verwendet.') : null,
    h('div', { class: 'grid' },
      f('API-Schlüssel', 'openai_api_key', '', { type: 'password', ph: cur.openai_key_set ? '•••••••• (gespeichert)' : 'sk-…', hint: cur.openai_key_set ? 'Leer lassen, um den gespeicherten Schlüssel zu behalten' : '' }),
      f('Modell', 'openai_model', cur.openai_model, { hint: `Name wie in der OpenAI-Modellliste, Standard: ${cur.openai_default_model}` })),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => {
        kout.hidden = false; kout.textContent = 'Verbindung wird geprüft …';
        try { const r = await api('/api/settings/openai/test', { body: Object.fromEntries(new FormData(ki)) }); kout.textContent = `Verbunden, Modell ${r.model} antwortet.`; }
        catch (e) { kout.textContent = `Fehlgeschlagen: ${e.message}`; }
      }) }, 'Verbindung testen'),
      cur.openai_key_set && !cur.openai_from_env ? h('button', { class: 'btn danger', type: 'button', onclick: guard(async () => { if (confirm('Gespeicherten OpenAI-Schlüssel entfernen?')) { await api('/api/settings', { method: 'PUT', body: { openai_remove_key: true } }); toast('Schlüssel entfernt'); await refresh(); } }) }, 'Schlüssel entfernen') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(ki)) }); toast('KI-Einstellungen gespeichert'); await refresh(); }) }, 'Speichern')),
    kout);

  const pw = h('form', { class: 'panel', onsubmit: (e) => e.preventDefault() },
    h('h3', {}, 'Passwort ändern'),
    h('div', { class: 'grid' }, f('Aktuelles Passwort', 'current', '', { type: 'password' }), f('Neues Passwort (mind. 10 Zeichen)', 'password', '', { type: 'password' })),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await api('/api/auth/password', { body: Object.fromEntries(new FormData(pw)) }); pw.reset(); toast('Passwort geändert'); }) }, 'Passwort ändern')));
  const up = h('div', { id: 'userpanel' }, await userPanel());
  root.append(h('div', { class: 'settings' }, h('h2', {}, 'Einstellungen'), form, ki, up, pw));
}

// ---------- Laufleiste ----------
function renderRunbar() {
  const sc = state.data.scrape;
  const bar = document.getElementById('runbar');
  if (sc.running) {
    bar.replaceChildren(h('progress', { max: Math.max(sc.total, 1), value: sc.done }), h('span', { class: 'txt', title: sc.current ?? '' }, `${sc.done}/${sc.total} geprüft${sc.current ? ' · ' + sc.current : ''}`),
      h('button', { class: 'btn small', onclick: guard(async () => { await api('/api/scrape/stop', { method: 'POST', body: {} }); }) }, 'Stoppen'));
  } else {
    const lr = state.data.lastRun;
    bar.replaceChildren(h('span', { class: 'txt' }, lr?.finished_at ? `Letzter Abruf: ${dt.format(new Date(lr.finished_at))}` : 'Noch kein Abruf'),
      h('button', { class: 'btn primary small', onclick: guard(async () => { const r = await api('/api/scrape', { body: {} }); toast(r.total ? `Abruf gestartet (${r.total} Prüfungen)` : 'Alles aktuell – nichts zu prüfen'); await refresh(); }) }, 'Preise jetzt abrufen'));
  }
}

// ---------- Rahmen ----------
function setTab(t) { state.tab = t; closeDrawer(); render(); }
document.getElementById('tabs').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.tab; if (t) setTab(t); });

function render() {
  if (!state.data) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  renderRunbar();
  const main = document.getElementById('main');
  const keep = main.scrollTop;
  main.replaceChildren();
  if (state.tab === 'preise') renderPrices(main);
  else if (state.tab === 'analyse') renderAnalysis(main).catch((e) => { if (!(e instanceof AuthError)) toast(e.message, true); });
  else if (state.tab === 'mitbewerber') renderCompetitors(main);
  else if (state.tab === 'einstellungen') renderSettings(main).catch((e) => { if (!(e instanceof AuthError)) toast(e.message, true); });
  else renderImport(main);
  main.scrollTop = keep;
}

let pollTimer;
async function refresh() {
  const scrollY = window.scrollY;
  state.data = await api('/api/overview');
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.getElementById('main').contains(document.activeElement);
  if (typing && state.tab === 'preise') { renderRunbar(); renderTable(); } // Eingabefeld nicht neu aufbauen
  else if (typing) renderRunbar();
  else render();
  window.scrollTo(0, scrollY);
  clearInterval(pollTimer);
  if (state.data.scrape.running) {
    let ticks = 0;
    pollTimer = setInterval(guard(async () => {
      const st = await api('/api/scrape/status');
      state.data.scrape = st;
      renderRunbar();
      // Tabelle nur gelegentlich oder am Ende neu laden
      if (!st.running || ++ticks % 7 === 0) { clearInterval(pollTimer); await refresh(); }
    }), 3000);
  }
}

document.getElementById('logout').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); await boot(); });

async function boot() {
  const info = await fetch('/api/auth/state').then((r) => r.json());
  if (!info.authenticated) return showAuth(info);
  document.body.classList.remove('noauth');
  document.getElementById('logout').hidden = false;
  await refresh();
}
boot().catch((e) => toast(e.message, true));
