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

const state = { data: null, scope: null, tab: 'start', q: '', brand: '', filter: 'all', sort: 'name', comp: '', status: '', minP: '', maxP: '', gapMin: '', selected: null, runs: [], more: false };

// ---------- Auswertung pro Produkt ----------
function analyse(p, comps) {
  const cells = comps.map((c) => ({ c, m: p.matches[c.id] }));
  const ok = cells.filter(({ m }) => m && m.status === 'ok' && m.price != null);
  const review = cells.some(({ m }) => m && m.status === 'review');
  const min = ok.length ? Math.min(...ok.map(({ m }) => m.price)) : null;
  let kind = 'none';
  if (min != null && p.price != null) kind = p.price <= min ? 'cheapest' : 'undercut';
  const gap = min != null && p.price != null ? p.price - min : null;
  const moved = ok.some(({ m }) => m.previous != null && m.previous !== m.price);
  const problem = cells.some(({ m }) => m && ['error', 'blocked'].includes(m.status));
  const notFound = cells.some(({ m }) => m && m.status === 'not_found');
  const oos = ok.some(({ m }) => m.availability === 'out_of_stock');
  return { moved, problem, notFound, oos, cells, ok, min, kind, gap, gapPct: gap != null && min ? (gap / min) * 100 : null, review };
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
  if (m.status === 'ok' || (m.status === 'review' && m.price != null)) {
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
    blocked: ['gesperrt', 'err'], review: ['zu prüfen', ''], error: ['Fehler', 'err'],
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

  const chip = (key, label, n, cls = '') => h('button', { class: `chip ${cls}${state.filter === key ? ' on' : ''}`, 'aria-pressed': state.filter === key ? 'true' : 'false', onclick: () => { state.filter = key; render(); } }, h('b', {}, String(n)), label);
  const extra = ['comp', 'status', 'minP', 'maxP', 'gapMin'].filter((k) => state[k] !== '').length + (['moved', 'problem', 'notFound', 'oos', 'equal'].includes(state.filter) ? 1 : 0);
  const reset = () => { Object.assign(state, { q: '', brand: '', filter: 'all', comp: '', status: '', minP: '', maxP: '', gapMin: '' }); render(); };
  root.append(
    h('div', { class: 'pagehead' }, h('h2', {}, 'Preise'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Artikelauswahl' },
        h('button', { class: `chip${state.scope === 'tracked' ? ' on' : ''}`, onclick: () => { state.scope = 'tracked'; refresh(); } }, h('b', {}, String(d.counts.tracked)), 'beobachtet'),
        h('button', { class: `chip${state.scope === 'all' ? ' on' : ''}`, onclick: () => { state.scope = 'all'; refresh(); } }, h('b', {}, String(d.counts.all)), 'alle Artikel')),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: '/api/export.csv' }, 'CSV-Export')),
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Name, Artikelnummer oder EAN', value: state.q, 'aria-label': 'Suche',
        oninput: (e) => { state.q = e.target.value; renderTable(); } }),
      h('select', { 'aria-label': 'Hersteller', onchange: (e) => { state.brand = e.target.value; renderTable(); } },
        h('option', { value: '' }, 'Alle Hersteller'), brands.map((b) => h('option', { value: b, selected: b === state.brand }, b))),
      h('select', { 'aria-label': 'Sortierung', onchange: (e) => { state.sort = e.target.value; renderTable(); } },
        [['name', 'Nach Name'], ['gap', 'Größter Rückstand in €'], ['gappct', 'Größter Rückstand in %'], ['lead', 'Größter Vorsprung'], ['price', 'Preis absteigend'], ['priceAsc', 'Preis aufsteigend']]
          .filter(([v]) => !noComps || v === 'name' || v === 'price' || v === 'priceAsc').map(([v, l]) => h('option', { value: v, selected: v === state.sort }, l))),
      noComps ? null : h('button', { class: `btn${state.more ? ' on' : ''}`, 'aria-expanded': state.more ? 'true' : 'false', onclick: () => { state.more = !state.more; render(); } }, extra ? `Weitere Filter (${extra})` : 'Weitere Filter'),
      state.q || state.brand || state.filter !== 'all' || extra ? h('button', { class: 'linkbtn', onclick: reset }, 'Zurücksetzen') : null),
    noComps ? null : h('div', { class: 'toolbar' }, h('div', { class: 'seg' },
      chip('all', 'alle', rows.length),
      chip('undercut', 'teurer als ein Mitbewerber', count((r) => r.a.kind === 'undercut'), 'bad'),
      chip('cheapest', 'günstigster', count((r) => r.a.kind === 'cheapest'), 'good'),
      chip('review', 'zu prüfen', count((r) => r.a.review), 'warn'),
      chip('none', 'ohne Vergleichspreis', count((r) => r.a.kind === 'none')))),
    noComps || !state.more ? null : h('div', { class: 'morebox' },
      h('div', { class: 'seg' },
        chip('equal', 'gleichauf', count((r) => r.a.kind === 'cheapest' && r.a.gap != null && Math.abs(r.p.price - r.a.min) < 0.005)),
        chip('moved', 'Preis geändert', count((r) => r.a.moved)),
        chip('problem', 'Fehler oder gesperrt', count((r) => r.a.problem), 'bad'),
        chip('notFound', 'nicht gefunden', count((r) => r.a.notFound)),
        chip('oos', 'Mitbewerber ausverkauft', count((r) => r.a.oos))),
      h('div', { class: 'toolbar', style: 'margin:12px 0 0' },
        h('select', { 'aria-label': 'Günstiger bei', onchange: (e) => { state.comp = e.target.value; renderTable(); } },
          h('option', { value: '' }, 'Günstiger bei: jeder'), d.competitors.map((c) => h('option', { value: c.id, selected: String(c.id) === String(state.comp) }, `Günstiger bei ${c.name}`))),
        h('select', { 'aria-label': 'Status', onchange: (e) => { state.status = e.target.value; renderTable(); } },
          [['', 'Jeder Status'], ['ok', 'mit Preis'], ['review', 'zu prüfen'], ['not_found', 'nicht gefunden'], ['nourl', 'URL fehlt'], ['pending', 'ausstehend'], ['error', 'Fehler'], ['blocked', 'gesperrt']]
            .map(([v, l]) => h('option', { value: v, selected: v === state.status }, l))),
        h('input', { type: 'number', min: 0, step: 'any', placeholder: 'Preis ab €', value: state.minP, 'aria-label': 'Preis ab', class: 'num', oninput: (e) => { state.minP = e.target.value; renderTable(); } }),
        h('input', { type: 'number', min: 0, step: 'any', placeholder: 'Preis bis €', value: state.maxP, 'aria-label': 'Preis bis', class: 'num', oninput: (e) => { state.maxP = e.target.value; renderTable(); } }),
        h('input', { type: 'number', step: 'any', placeholder: 'Abstand ab %', value: state.gapMin, 'aria-label': 'Mindestabstand in Prozent', class: 'num', title: 'Nur Artikel, bei denen du mindestens so viel Prozent teurer bist', oninput: (e) => { state.gapMin = e.target.value; renderTable(); } })),
      h('div', { class: 'toolbar', style: 'margin:12px 0 0' },
        h('span', { class: 'pmeta' }, 'Nur beobachtete Artikel werden bei Mitbewerbern abgeglichen.'),
        h('button', { class: 'btn small', onclick: guard(() => track(state.visibleIds, true)) }, 'Gefilterte beobachten'),
        h('button', { class: 'btn small', onclick: guard(() => track(state.visibleIds, false)) }, 'Gefilterte nicht beobachten'))),
    h('div', { class: 'tablewrap', id: 'tablewrap' }));
  renderTable();
}

/** Beobachtung (Abgleich bei Mitbewerbern) für Artikel setzen. */
async function track(ids, tracked) {
  if (!ids?.length) return toast('Keine Artikel im Filter', true);
  if (ids.length > 500 && !confirm(`${ids.length} Artikel ${tracked ? 'beobachten' : 'nicht mehr beobachten'}?`)) return;
  const r = await api('/api/products/track', { body: { ids, tracked } });
  toast(`${r.changed} Artikel ${tracked ? 'werden beobachtet' : 'werden nicht mehr beobachtet'}`);
  await refresh();
}

function renderTable() {
  const d = state.data;
  const wrap = document.getElementById('tablewrap');
  if (!wrap) return;
  const q = state.q.trim().toLowerCase();
  let rows = d.products.map((p) => ({ p, a: analyse(p, d.competitors) }));
  rows = rows.filter(({ p, a }) => {
    if (state.brand && p.manufacturer !== state.brand) return false;
    const F = { all: () => true, review: () => a.review, equal: () => a.kind === 'cheapest' && Math.abs(p.price - a.min) < 0.005, moved: () => a.moved, problem: () => a.problem, notFound: () => a.notFound, oos: () => a.oos };
    if (!(F[state.filter] ?? (() => a.kind === state.filter))()) return false;
    if (state.comp && !(a.cells.find(({ c }) => String(c.id) === String(state.comp))?.m?.price < p.price && a.cells.find(({ c }) => String(c.id) === String(state.comp))?.m?.status === 'ok')) return false;
    if (state.status && !a.cells.some(({ m }) => m && m.status === state.status)) return false;
    if (state.minP !== '' && !(p.price >= Number(state.minP))) return false;
    if (state.maxP !== '' && !(p.price <= Number(state.maxP))) return false;
    if (state.gapMin !== '' && !(a.gapPct != null && a.gapPct >= Number(state.gapMin))) return false;
    if (q && ![p.name, p.number, p.ean, p.mpn, p.manufacturer].some((v) => String(v ?? '').toLowerCase().includes(q))) return false;
    return true;
  });
  const sorters = {
    name: (x, y) => (x.p.manufacturer ?? '').localeCompare(y.p.manufacturer ?? '', 'de') || x.p.name.localeCompare(y.p.name, 'de'),
    gap: (x, y) => (y.a.gap ?? -Infinity) - (x.a.gap ?? -Infinity),
    lead: (x, y) => (x.a.gap ?? Infinity) - (y.a.gap ?? Infinity),
    gappct: (x, y) => (y.a.gapPct ?? -Infinity) - (x.a.gapPct ?? -Infinity),
    price: (x, y) => (y.p.price ?? 0) - (x.p.price ?? 0),
    priceAsc: (x, y) => (x.p.price ?? Infinity) - (y.p.price ?? Infinity),
  };
  rows.sort(sorters[state.sort]);
  state.visibleIds = rows.map(({ p }) => p.id);

  const shown = rows.slice(0, 400);
  const table = h('table', { class: 'prices' },
    h('thead', {}, h('tr', {},
      h('th', { title: 'Beobachten: wird bei Mitbewerbern abgeglichen' }, '👁'),
      h('th', { class: 'prod' }, `Produkt (${rows.length}${rows.length !== d.products.length ? ' von ' + d.products.length : ''})`),
      h('th', { class: 'own' }, d.own.name),
      d.competitors.map((c) => h('th', { title: c.base_url }, c.name, c.enabled ? '' : ' (aus)')),
      d.competitors.length ? [h('th', {}, 'Position'), h('th', {}, 'Abstand zum günstigsten')] : null)),
    h('tbody', {}, shown.map(({ p, a }) => h('tr', { tabindex: 0, onclick: () => openDrawer(p.id), onkeydown: (e) => e.key === 'Enter' && openDrawer(p.id) },
      h('td', { onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: Boolean(p.tracked), 'aria-label': `${p.name} beobachten`, onchange: guard((e) => track([p.id], e.target.checked)) })),
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
    ...a.cells.map(({ c, m }) => {
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
      h('tbody', {}, state.runs.map((r) => h('tr', {}, h('td', {}, dt.format(new Date(r.started_at))), h('td', {}, r.trigger === 'schedule' ? 'Zeitplan' : r.trigger === 'rolling' ? 'verteilt' : 'manuell'), h('td', {}, `${r.checked}/${r.total}`), h('td', {}, r.found), h('td', {}, r.errors),
        h('td', {}, r.finished_at ? `${Math.max(1, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60000))} min${r.note ? ` (${r.note})` : ''}` : 'läuft …'))))) : h('p', { class: 'pmeta' }, 'Noch kein Lauf.'),
    h('p', { class: 'pmeta', style: 'margin-top:8px' }, (d.schedule.mode === 'rolling' ? `Automatischer Abruf verteilt über den Tag: Ein neuer Lauf beginnt erst ${d.schedule.interval} bis ${d.schedule.interval + d.schedule.jitter} Sekunden nach dem Ende des vorigen, mit bis zu ${d.schedule.batch} Artikeln je Mitbewerber, jeder Artikel höchstens alle ${d.schedule.refresh} Stunden.` : `Automatischer Abruf zu festen Zeiten (${d.schedule.hours.map((x) => String(x).padStart(2, '0') + ':00').join(' und ')} Uhr).`) + ' Einstellbar unter Einstellungen → Abrufplan.')));
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


// ---------- Lagebild (Start) ----------
const goPrices = (filter) => { Object.assign(state, { filter, comp: '', status: '', minP: '', maxP: '', gapMin: '' }); setTab('preise'); };
const goAnalysis = (action) => { aState.action = action; aState.brand = ''; aState.comp = ''; setTab('analyse'); };

function shortList(title, sub, items, empty, more) {
  return h('section', { class: 'list' },
    h('div', { class: 'list-h' }, h('h3', {}, title), more ? h('button', { class: 'linkbtn', onclick: more.fn }, more.label) : null),
    sub ? h('p', { class: 'pmeta' }, sub) : null,
    items.length ? h('ol', {}, items) : h('p', { class: 'list-empty' }, empty));
}

async function renderStart(root) {
  const d = state.data;
  if (!d.counts.all) {
    root.append(h('section', { class: 'hero' },
      h('p', { class: 'hero-k' }, 'Noch leer'),
      h('h1', {}, 'Hol zuerst deine Artikel ins Preisradar.'),
      h('p', { class: 'hero-sub' }, 'Aus der eigenen Sitemap, aus Shopware oder per CSV. Danach Mitbewerber anlegen, der Abruf läuft dann von selbst.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => setTab('einstellungen') }, 'Eigene Sitemap hinterlegen'), h('button', { class: 'btn', onclick: () => setTab('import') }, 'CSV oder Shopware'))));
    return;
  }
  const [a, imp] = await Promise.all([api('/api/analysis'), api('/api/import/sitemap/status').catch(() => null)]);
  lastAnalysis = a;
  const k = a.kpi;
  const real = a.rows.filter((r) => !r.warning);
  const tol = a.rules.tolerance;
  const seg = {
    cheaper: real.filter((r) => r.gap_percent <= 0).length,
    near: real.filter((r) => r.gap_percent > 0 && r.gap_percent <= tol).length,
    dearer: real.filter((r) => r.gap_percent > tol).length,
    check: a.rows.filter((r) => r.warning).length,
    none: Math.max(0, k.tracked - k.compared),
  };
  const dearerAny = seg.near + seg.dearer;

  // Kopf: eine Aussage, eine Zahl
  const hero = h('section', { class: 'hero' },
    h('p', { class: 'hero-k' }, `${k.tracked} beobachtete Artikel, ${d.competitors.filter((c) => c.enabled).length} Mitbewerber`),
    k.compared
      ? h('h1', {}, h('span', { class: 'hero-n' }, String(dearerAny)), ` von ${k.compared} verglichenen Artikeln gibt es bei einem Mitbewerber günstiger.`)
      : h('h1', {}, 'Noch keine bestätigten Vergleichspreise.'),
    h('p', { class: 'hero-sub' }, k.compared
      ? `${seg.dearer} davon mehr als ${tol} % teurer. Im Schnitt liegst du ${fmtPct(k.avg_gap)} über dem günstigsten lieferbaren Angebot (Median ${fmtPct(k.median_gap)}). ${k.erhoehen ? `${k.erhoehen} Artikel haben Spielraum nach oben.` : ''}`
      : d.competitors.length ? 'Der Abruf läuft in kleinen Paketen über den Tag. Die ersten Preise erscheinen hier, sobald Treffer bestätigt sind.' : 'Lege unter Mitbewerber den ersten Shop an, am einfachsten per Produktlink.'));

  // Preislage als ein Balken über alle beobachteten Artikel
  const parts = [
    ['cheaper', 'günstigster oder gleichauf', seg.cheaper, () => goPrices('cheapest')],
    ['near', `bis ${tol} % teurer`, seg.near, () => goPrices('undercut')],
    ['dearer', `mehr als ${tol} % teurer`, seg.dearer, () => goAnalysis('senken')],
    ['check', 'auffällige Abweichung', seg.check, () => goAnalysis('prüfen')],
    ['none', 'noch ohne Vergleichspreis', seg.none, () => goPrices('none')],
  ];
  const total = parts.reduce((s, p) => s + p[2], 0) || 1;
  const gauge = h('section', { class: 'gauge', 'aria-label': 'Preislage aller beobachteten Artikel' },
    h('div', { class: 'gauge-bar' }, parts.filter((p) => p[2]).map(([key, label, n, fn]) =>
      h('button', { class: `gseg ${key}`, style: `flex-grow:${n}`, title: `${n} ${label}`, 'aria-label': `${n} ${label}`, onclick: fn }))),
    h('ul', { class: 'gauge-legend' }, parts.map(([key, label, n, fn]) =>
      h('li', {}, h('button', { class: 'linkbtn', onclick: fn, disabled: !n }, h('i', { class: `sw ${key}` }), h('b', {}, String(n)), ` ${label}`, h('small', {}, ` ${Math.round((n / total) * 100)} %`))))));

  const item = (r, main, side) => h('li', { tabindex: 0, onclick: () => { state.tab = 'preise'; render(); openDrawer(r.id); }, onkeydown: (e) => e.key === 'Enter' && e.currentTarget.click() },
    h('div', { class: 'li-main' }, h('div', { class: 'pname' }, r.name), h('div', { class: 'pmeta' }, main)), h('div', { class: 'li-side' }, side));
  const down = a.rows.filter((r) => r.action === 'senken').sort((x, y) => y.diff - x.diff).slice(0, 6);
  const up = a.rows.filter((r) => r.action === 'erhöhen').sort((x, y) => (y.suggested_price - y.own_price) - (x.suggested_price - x.own_price)).slice(0, 6);
  const lists = h('div', { class: 'cols' },
    shortList('Zu teuer', 'Größte Differenz zum günstigsten lieferbaren Angebot', down.map((r) => item(r, `${r.cheapest_competitor}: ${eur.format(r.cheapest)}`, [h('div', { class: 'fig warm' }, `+${eur.format(r.diff)}`), h('div', { class: 'pmeta' }, fmtPct(r.gap_percent))])), 'Kein Artikel ist deutlich teurer.', { label: `alle ${k.senken}`, fn: () => goAnalysis('senken') }),
    shortList('Spielraum nach oben', 'Deutlich unter dem günstigsten Mitbewerber', up.map((r) => item(r, `${r.cheapest_competitor}: ${eur.format(r.cheapest)}`, [h('div', { class: 'fig cool' }, `+${eur.format(r.suggested_price - r.own_price)}`), h('div', { class: 'pmeta' }, `auf ${eur.format(r.suggested_price)}`)])), 'Kein Artikel mit deutlichem Spielraum.', { label: `alle ${k.erhoehen}`, fn: () => goAnalysis('erhöhen') }),
    shortList(`Bewegung bei Mitbewerbern`, `Preisänderungen der letzten ${a.rules.moveDays} Tage`, a.moves.slice(0, 6).map((m) => item(m, `${m.competitor}: ${eur.format(m.from)} → ${eur.format(m.to)}`, [h('div', { class: `fig ${m.pct < 0 ? 'warm' : 'cool'}` }, fmtPct(m.pct)), h('div', { class: 'pmeta' }, m.own_price != null ? `du: ${eur.format(m.own_price)}` : '')])), 'Keine Preisänderungen erfasst.', a.moves.length ? { label: 'alle', fn: () => setTab('analyse') } : null));

  // Mitbewerber und Betrieb
  const comps = h('section', { class: 'list' },
    h('div', { class: 'list-h' }, h('h3', {}, 'Mitbewerber'), h('button', { class: 'linkbtn', onclick: () => setTab('mitbewerber') }, 'verwalten')),
    a.competitors.length ? h('table', { class: 'comp' }, h('tbody', {}, a.competitors.map((c) => h('tr', {},
      h('th', {}, c.name),
      h('td', { class: 'w' }, h('div', { class: 'cov' }, h('div', { class: 'covbar', style: `width:${Math.min(100, c.coverage)}%` }))),
      h('td', {}, `${c.ok} Preise`, h('small', {}, ` ${String(c.coverage).replace('.', ',')} %`)),
      h('td', { class: 'pmeta' }, c.review ? `${c.review} zu prüfen` : ''),
      h('td', { class: c.error + c.blocked ? 'warmtxt' : 'pmeta' }, c.error + c.blocked ? `${c.error + c.blocked} Fehler` : ''),
      h('td', { class: 'pmeta' }, c.last_checked ? dt.format(new Date(c.last_checked)) : 'noch nicht geprüft'))))) : h('p', { class: 'list-empty' }, 'Noch kein Mitbewerber angelegt.'));
  const sch = d.schedule;
  const ops = h('section', { class: 'list' },
    h('div', { class: 'list-h' }, h('h3', {}, 'Betrieb'), h('button', { class: 'linkbtn', onclick: () => setTab('import') }, 'Läufe ansehen')),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Abruf'), h('dd', {}, d.scrape.running ? `läuft: ${d.scrape.done} von ${d.scrape.total}` : sch.mode === 'rolling' ? `verteilt, ${sch.batch} Artikel je Mitbewerber, Pause ${sch.interval}–${sch.interval + sch.jitter} s nach jedem Lauf` : `feste Zeiten ${sch.hours.join(', ')} Uhr`),
      h('dt', {}, 'Aktualität'), h('dd', {}, `jeder Artikel höchstens alle ${sch.refresh} Stunden`),
      h('dt', {}, 'Artikel'), h('dd', {}, `${d.counts.all} gesamt, ${d.counts.tracked} beobachtet`),
      imp?.running ? [h('dt', {}, 'Import'), h('dd', {}, `läuft: ${imp.done} von ${imp.total}`)] : imp?.finishedAt ? [h('dt', {}, 'Letzter Import'), h('dd', {}, `${dt.format(new Date(imp.finishedAt))}, ${imp.created} neu, ${imp.updated} aktualisiert${imp.errors ? `, ${imp.errors} Fehler` : ''}`)] : null,
      h('dt', {}, 'KI'), h('dd', {}, d.config.ai ? 'eingerichtet' : 'nicht eingerichtet (Regeln und Sitemaps arbeiten trotzdem)')));

  root.append(hero, gauge,
    a.hints.length ? h('ul', { class: 'hints' }, a.hints.slice(0, 4).map((x) => h('li', { class: x.level }, x.text))) : null,
    lists, h('div', { class: 'cols two' }, comps, ops));
}

// ---------- Analyse (Regelwerk) ----------
const ACTION_TAG = { senken: ['Preis senken', 'err'], halten: ['Preis halten', 'mute'], 'erhöhen': ['Preis erhöhen', 'good'], 'prüfen': ['Prüfen', 'warn'] };
const fmtPct = (v, d = 1) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(d).replace('.', ',')} %`);
const aState = { action: 'actionable', comp: '', brand: '', q: '', sort: 'gap' };

function kpiTile(label, value, sub, cls = '') {
  return h('div', { class: `kpi ${cls}` }, h('div', { class: 'kpi-v' }, value), h('div', { class: 'kpi-l' }, label), sub ? h('div', { class: 'kpi-s' }, sub) : null);
}

/** Verteilung des Abstands: Blau = wir sind günstiger, Rot = wir sind teurer, Grau = gleichauf. */
function histogramChart(hist) {
  const max = Math.max(1, ...hist.map((b) => b.count));
  const total = hist.reduce((s, b) => s + b.count, 0);
  const rowsEl = hist.map((b) => {
    const w = (b.count / max) * 100;
    return h('div', { class: 'hrow', title: `${b.label}: ${b.count} Artikel` },
      h('div', { class: 'hlabel' }, b.label),
      h('div', { class: 'htrack' }, h('div', { class: `hbar ${b.side}`, style: `width:${w}%` })),
      h('div', { class: 'hval' }, String(b.count), h('small', {}, total ? ` ${Math.round((b.count / total) * 100)} %` : '')));
  });
  return h('div', { class: 'panel' },
    h('h3', {}, 'Wo stehe ich gegenüber dem günstigsten Mitbewerber?'),
    h('p', { class: 'pmeta' }, 'Anzahl Artikel je Abstandsklasse. Blau: ich bin günstiger, Rot: ich bin teurer.'),
    h('div', { class: 'hist' }, rowsEl),
    h('details', { class: 'tview' }, h('summary', {}, 'Als Tabelle'),
      h('table', { class: 'mini' }, h('tbody', {}, hist.map((b) => h('tr', {}, h('td', {}, b.label), h('td', {}, String(b.count))))))));
}

function competitorTable(a) {
  if (!a.competitors.length) return null;
  const head = ['Mitbewerber', 'Abdeckung', 'bestätigt', 'zu prüfen', 'nicht gefunden', 'Fehler/gesperrt', 'Ø Abstand', 'billiger als ich', 'Günstigster bei', 'Preisbewegung 7 Tage', 'zuletzt geprüft'];
  return h('div', { class: 'panel flush' },
    h('div', { class: 'panelhead' }, h('h3', {}, 'Mitbewerber im Vergleich'), h('p', { class: 'pmeta' }, 'Ø Abstand: positiv bedeutet, ich bin im Schnitt teurer als dieser Mitbewerber.')),
    h('div', { class: 'tablewrap', style: 'max-height:none' }, h('table', { class: 'prices', style: 'min-width:0' },
      h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: i === 0 ? 'prod' : '' }, t)))),
      h('tbody', {}, a.competitors.map((c) => h('tr', {},
        h('td', { class: 'prod' }, h('div', { class: 'pname' }, c.name)),
        h('td', {}, h('div', { class: 'cov' }, h('div', { class: 'covbar', style: `width:${Math.min(100, c.coverage)}%` })), h('small', {}, `${String(c.coverage).replace('.', ',')} %`)),
        h('td', {}, String(c.ok)), h('td', {}, String(c.review)), h('td', {}, String(c.not_found)), h('td', {}, String(c.error + c.blocked)),
        h('td', { class: c.avg_gap_vs_us == null ? '' : c.avg_gap_vs_us > 2 ? 'gap bad' : c.avg_gap_vs_us < -2 ? 'gap cool' : 'gap' }, fmtPct(c.avg_gap_vs_us)),
        h('td', {}, String(c.cheaper_than_us)), h('td', {}, String(c.holds_lowest)),
        h('td', {}, c.drops || c.rises ? [h('span', { class: 'delta cheaper' }, `▼ ${c.drops}`), ' ', h('span', { class: 'delta dearer' }, `▲ ${c.rises}`)] : '–'),
        h('td', {}, c.last_checked ? dt.format(new Date(c.last_checked)) : '–')))))));
}

function brandTable(a) {
  if (!a.brands.length) return null;
  return h('div', { class: 'panel flush' },
    h('div', { class: 'panelhead' }, h('h3', {}, 'Marken'), h('p', { class: 'pmeta' }, 'Klick auf eine Marke filtert die Empfehlungen darunter.')),
    h('div', { class: 'tablewrap', style: 'max-height:360px' }, h('table', { class: 'prices', style: 'min-width:0' },
      h('thead', {}, h('tr', {}, ['Marke', 'verglichen', 'Ø Abstand', 'senken', 'erhöhen', 'günstigster'].map((t, i) => h('th', { class: i === 0 ? 'prod' : '' }, t)))),
      h('tbody', {}, a.brands.slice(0, 60).map((b) => h('tr', { onclick: () => { aState.brand = b.brand; aState.action = 'all'; render(); } },
        h('td', { class: 'prod' }, h('div', { class: 'pname' }, b.brand)), h('td', {}, String(b.compared)),
        h('td', { class: b.avg_gap > 2 ? 'gap bad' : b.avg_gap < -2 ? 'gap cool' : 'gap' }, fmtPct(b.avg_gap)),
        h('td', {}, String(b.senken)), h('td', {}, String(b.erhoehen)), h('td', {}, String(b.cheapest))))))));
}

function movesPanel(a) {
  if (!a.moves.length) return null;
  return h('div', { class: 'panel flush' },
    h('div', { class: 'panelhead' }, h('h3', {}, `Preisbewegungen der letzten ${a.rules.moveDays} Tage`), h('p', { class: 'pmeta' }, 'Änderungen bei bestätigten Mitbewerberpreisen, größte zuerst.')),
    h('div', { class: 'tablewrap', style: 'max-height:340px' }, h('table', { class: 'prices', style: 'min-width:0' },
      h('thead', {}, h('tr', {}, ['Artikel', 'Mitbewerber', 'vorher', 'jetzt', 'Änderung', 'Mein Preis'].map((t, i) => h('th', { class: i === 0 ? 'prod' : '' }, t)))),
      h('tbody', {}, a.moves.map((m) => h('tr', { onclick: () => { state.tab = 'preise'; render(); openDrawer(m.id); } },
        h('td', { class: 'prod' }, h('div', { class: 'pname' }, m.name), h('div', { class: 'pmeta' }, m.number)),
        h('td', {}, m.competitor), h('td', {}, eur.format(m.from)), h('td', {}, eur.format(m.to)),
        h('td', {}, h('span', { class: `delta ${m.pct < 0 ? 'cheaper' : 'dearer'}` }, fmtPct(m.pct))),
        h('td', {}, m.own_price != null ? eur.format(m.own_price) : '–')))))));
}

function recommendations(a) {
  const q = aState.q.trim().toLowerCase();
  const compOf = (r) => r.prices.some((p) => p.competitor === aState.comp);
  let rows = a.rows.filter((r) => {
    if (aState.action === 'actionable' ? r.action === 'halten' : aState.action !== 'all' && r.action !== aState.action) return false;
    if (aState.brand && (r.brand || 'ohne Marke') !== aState.brand) return false;
    if (aState.comp && r.cheapest_competitor !== aState.comp) return false;
    if (q && ![r.name, r.number, r.brand].some((v) => String(v ?? '').toLowerCase().includes(q))) return false;
    return true;
  });
  const sorters = {
    gap: (x, y) => Math.abs(y.gap_percent) - Math.abs(x.gap_percent),
    diff: (x, y) => Math.abs(y.diff) - Math.abs(x.diff),
    price: (x, y) => y.own_price - x.own_price,
    name: (x, y) => x.name.localeCompare(y.name, 'de'),
  };
  rows = [...rows].sort(sorters[aState.sort]);
  const cnt = (k) => a.rows.filter((r) => r.action === k).length;
  const chipA = (key, label, n, cls = '') => h('button', { class: `chip ${cls}${aState.action === key ? ' on' : ''}`, onclick: () => { aState.action = key; render(); } }, h('b', {}, String(n)), label);
  const brands = a.brands.map((b) => b.brand);
  const tableEl = rows.length
    ? h('div', { class: 'tablewrap', style: 'max-height:none' }, h('table', { class: 'prices', style: 'min-width:0' },
      h('thead', {}, h('tr', {}, ['Artikel', 'Aktion', 'Mein Preis', 'Günstigster', 'Abstand', 'Vorschlag', 'Begründung'].map((t, i) => h('th', { class: i === 0 ? 'prod' : '', style: i === 6 ? 'text-align:left' : '' }, t)))),
      h('tbody', {}, rows.slice(0, 300).map((x) => {
        const [label, cls] = ACTION_TAG[x.action] ?? [x.action, ''];
        return h('tr', { tabindex: 0, onclick: () => { state.tab = 'preise'; render(); openDrawer(x.id); } },
          h('td', { class: 'prod' }, h('div', { class: 'pname' }, x.name), h('div', { class: 'pmeta' }, [x.brand, x.number].filter(Boolean).join(' · '))),
          h('td', {}, h('span', { class: `tag ${cls}` }, label)),
          h('td', {}, eur.format(x.own_price)),
          h('td', {}, eur.format(x.cheapest), h('div', { class: 'pmeta' }, x.cheapest_competitor)),
          h('td', { class: x.gap_percent > aRules(a).tolerance ? 'gap bad' : x.gap_percent < 0 ? 'gap cool' : 'gap' }, fmtPct(x.gap_percent)),
          h('td', { style: 'font-weight:700' }, x.suggested_price != null ? eur.format(x.suggested_price) : '–'),
          h('td', { style: 'text-align:left;white-space:normal;min-width:260px;max-width:480px' }, x.reason));
      }))))
    : h('div', { class: 'empty' }, 'Keine Artikel für diesen Filter.');
  return h('div', { class: 'panel flush' },
    h('div', { class: 'panelhead' }, h('h3', {}, 'Empfehlungen'), h('p', { class: 'pmeta' }, `${rows.length} Artikel${rows.length > 300 ? ', die ersten 300 werden gezeigt' : ''}`)),
    h('div', { class: 'toolbar inpanel' },
      h('div', { class: 'seg' },
        chipA('actionable', 'mit Handlungsbedarf', cnt('senken') + cnt('erhöhen') + cnt('prüfen')),
        chipA('senken', 'senken', cnt('senken'), 'bad'), chipA('erhöhen', 'erhöhen', cnt('erhöhen'), 'good'),
        chipA('prüfen', 'prüfen', cnt('prüfen'), 'warn'), chipA('halten', 'halten', cnt('halten')), chipA('all', 'alle', a.rows.length)),
      h('span', { class: 'spacer' }),
      h('input', { type: 'search', placeholder: 'Suche', value: aState.q, 'aria-label': 'Suche', oninput: (e) => { aState.q = e.target.value; refreshRecs(); } }),
      h('select', { 'aria-label': 'Marke', onchange: (e) => { aState.brand = e.target.value; refreshRecs(); } }, h('option', { value: '' }, 'Alle Marken'), brands.map((b) => h('option', { value: b, selected: b === aState.brand }, b))),
      h('select', { 'aria-label': 'Günstigster Mitbewerber', onchange: (e) => { aState.comp = e.target.value; refreshRecs(); } }, h('option', { value: '' }, 'Jeder Mitbewerber'), a.competitors.map((c) => h('option', { value: c.name, selected: c.name === aState.comp }, `${c.name} günstigster`))),
      h('select', { 'aria-label': 'Sortierung', onchange: (e) => { aState.sort = e.target.value; refreshRecs(); } },
        [['gap', 'Größter Abstand in %'], ['diff', 'Größter Abstand in €'], ['price', 'Preis absteigend'], ['name', 'Name']].map(([v, l]) => h('option', { value: v, selected: v === aState.sort }, l)))),
    tableEl);
}
const aRules = (a) => a.rules;
let lastAnalysis = null;
function refreshRecs() {
  const old = document.getElementById('recs');
  if (!old || !lastAnalysis) return;
  const q = document.activeElement?.type === 'search' ? document.activeElement.selectionStart : null;
  const fresh = recommendations(lastAnalysis);
  fresh.id = 'recs';
  old.replaceWith(fresh);
  if (q != null) { const el = fresh.querySelector('input[type=search]'); el?.focus(); el?.setSelectionRange(q, q); }
}

async function renderAnalysis(root) {
  const a = await api('/api/analysis');
  lastAnalysis = a;
  const k = a.kpi;
  root.append(h('h2', {}, 'Analyse'),
    h('p', { class: 'sub' }, `Feste Regeln auf Basis bestätigter Mitbewerberpreise (lieferbar bevorzugt): bis ${a.rules.tolerance} % über dem Günstigsten gilt als konkurrenzfähig, mehr als ${a.rules.raiseAbove} % darunter ist Spielraum für eine Erhöhung, Abweichungen über ${a.rules.outlier} % gelten als mögliche Fehlzuordnung. Einkaufspreise und Margen kennt die App nicht, Senkungen bitte immer gegen die Marge prüfen.`),
    h('div', { class: 'panel' }, h('p', { style: 'max-width:80ch;margin:0' }, a.summary)));
  if (a.hints.length) root.append(h('ul', { class: 'hints' }, a.hints.map((x) => h('li', { class: x.level }, x.text))));
  if (!a.rows.length) return;
  root.append(
    h('div', { class: 'kpis' },
      kpiTile('Abdeckung', `${String(k.coverage).replace('.', ',')} %`, `${k.compared} von ${k.tracked} Artikeln verglichen`),
      kpiTile('Konkurrenzfähig', k.share_competitive == null ? '–' : `${String(k.share_competitive).replace('.', ',')} %`, 'höchstens 2 % über dem Günstigsten', 'cool'),
      kpiTile('Günstigster oder gleichauf', k.cheapest_share == null ? '–' : `${String(k.cheapest_share).replace('.', ',')} %`, 'der verglichenen Artikel'),
      kpiTile('Ø Abstand', fmtPct(k.avg_gap), `Median ${fmtPct(k.median_gap)}`, k.avg_gap > 2 ? 'warm' : ''),
      kpiTile('Zu teuer', String(k.senken), k.gap_sum_down ? `${eur.format(k.gap_sum_down)} Differenz je Stück gesamt` : '', k.senken ? 'warm' : ''),
      kpiTile('Spielraum nach oben', String(k.erhoehen), k.gap_sum_up ? `${eur.format(k.gap_sum_up)} je Stück gesamt` : '', 'cool')),
    h('div', { class: 'grid2' }, histogramChart(a.histogram), competitorTable(a)),
    movesPanel(a),
    brandTable(a));
  const recs = recommendations(a);
  recs.id = 'recs';
  root.append(recs);
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

  const sch = cur.schedule;
  const plan = h('form', { class: 'panel', onsubmit: (e) => e.preventDefault() },
    h('h3', {}, 'Abrufplan'),
    h('p', { class: 'sub' }, 'Verteilt: kleine Pakete über den ganzen Tag mit zufälligem Abstand, das schont die Server der Mitbewerber. Feste Zeiten: ein großer Lauf zu den Stunden aus der Server-Einstellung SCRAPE_HOURS. Abgeglichen werden nur beobachtete Artikel.'),
    h('div', { class: 'grid' },
      h('div', { class: 'field' }, h('label', {}, 'Modus'), h('select', { name: 'mode' }, [['rolling', 'Verteilt über den Tag'], ['slots', `Feste Zeiten (${sch.hours.map((x) => `${String(x).padStart(2, '0')}:00`).join(', ')})`]].map(([v, t]) => h('option', { value: v, selected: sch.mode === v }, t)))),
      f('Artikel je Mitbewerber und Paket', 'batch', sch.batch, { type: 'number' }),
      f('Abstand zwischen Paketen (Sekunden)', 'interval', sch.interval, { type: 'number' }),
      f('Zufälliger Aufschlag bis (Sekunden)', 'jitter', sch.jitter, { type: 'number' }),
      f('Mindestabstand je Artikel (Stunden)', 'refresh', sch.refresh, { type: 'number', hint: '12 = etwa zweimal täglich' })),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { await api('/api/settings', { method: 'PUT', body: { schedule: Object.fromEntries(new FormData(plan)) } }); toast('Abrufplan gespeichert'); await refresh(); }) }, 'Speichern')));

  const mcpOut = h('div', {});
  const mcpUrl = `${location.origin}/mcp`;
  const mcp = h('div', { class: 'panel' },
    h('h3', {}, 'Claude-Zugang (MCP)'),
    h('p', { class: 'sub' }, 'Damit kannst du Preisradar in Claude lesen und bedienen: Analyse und Empfehlungen abfragen, Artikel suchen, Importe starten, Einstellungen und Mitbewerber ändern, Abrufe starten, Treffer bestätigen. Preise im Shop werden nie geändert, Zugangsdaten (API-Keys, Passwörter) kann Claude nicht setzen. Der Token wird nur einmal angezeigt, gespeichert wird nur sein Hash. Ein neuer Token ersetzt den alten.'),
    h('p', { class: 'pmeta' }, cur.mcp_enabled ? 'Zugang ist aktiv.' : 'Zugang ist aus.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => {
        if (cur.mcp_enabled && !confirm('Der bisherige Token wird ungültig. Neuen Token erzeugen?')) return;
        const { token } = await api('/api/settings/mcp-token', { method: 'POST', body: {} });
        mcpOut.replaceChildren(
          h('p', {}, h('strong', {}, 'Token (jetzt kopieren, wird nicht mehr angezeigt):')), h('code', { class: 'secret' }, token),
          h('p', { class: 'pmeta' }, 'In Claude unter Einstellungen → Konnektoren → „Benutzerdefinierten Konnektor hinzufügen“ diese URL eintragen:'),
          h('code', { class: 'secret' }, `${mcpUrl}?token=${token}`),
          h('p', { class: 'pmeta' }, 'Für Claude Code (Token im Header):'),
          h('code', { class: 'secret' }, `claude mcp add --transport http preisradar ${mcpUrl} --header "Authorization: Bearer ${token}"`),
          h('p', { class: 'pmeta' }, 'Die URL mit Token ist ein Passwort: nicht weitergeben.'));
      }) }, cur.mcp_enabled ? 'Neuen Token erzeugen' : 'Zugang aktivieren'),
      cur.mcp_enabled ? h('button', { class: 'btn danger', type: 'button', onclick: guard(async () => { if (confirm('Claude-Zugang abschalten?')) { await api('/api/settings/mcp-token', { method: 'DELETE' }); toast('Zugang abgeschaltet'); await refresh(); } }) }, 'Abschalten') : null),
    mcpOut);

  const pw = h('form', { class: 'panel', onsubmit: (e) => e.preventDefault() },
    h('h3', {}, 'Passwort ändern'),
    h('div', { class: 'grid' }, f('Aktuelles Passwort', 'current', '', { type: 'password' }), f('Neues Passwort (mind. 10 Zeichen)', 'password', '', { type: 'password' })),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await api('/api/auth/password', { body: Object.fromEntries(new FormData(pw)) }); pw.reset(); toast('Passwort geändert'); }) }, 'Passwort ändern')));
  const up = h('div', { id: 'userpanel' }, await userPanel());
  root.append(h('div', { class: 'settings' }, h('h2', {}, 'Einstellungen'), form, plan, ki, mcp, up, pw));
}

// ---------- Laufleiste ----------
function renderRunbar() {
  const sc = state.data.scrape;
  const bar = document.getElementById('runbar');
  if (sc.running) {
    bar.replaceChildren(h('div', { class: 'rb-l' }, 'Abruf läuft'),
      h('progress', { max: Math.max(sc.total, 1), value: sc.done }),
      h('div', { class: 'rb-t', title: sc.current ?? '' }, `${sc.done} von ${sc.total} geprüft`),
      sc.current ? h('div', { class: 'rb-s', title: sc.current }, sc.current) : null,
      h('button', { class: 'btn small', onclick: guard(async () => { await api('/api/scrape/stop', { method: 'POST', body: {} }); }) }, 'Stoppen'));
  } else {
    const lr = state.data.lastRun;
    bar.replaceChildren(h('div', { class: 'rb-l' }, 'Letzter Abruf'),
      h('div', { class: 'rb-t' }, lr?.finished_at ? dt.format(new Date(lr.finished_at)) : 'noch keiner'),
      h('button', { class: 'btn primary small', onclick: guard(async () => { const r = await api('/api/scrape', { body: {} }); toast(r.total ? `Abruf gestartet (${r.total} Prüfungen)` : 'Alles aktuell, nichts zu prüfen'); await refresh(); }) }, 'Preise jetzt abrufen'));
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
  if (state.tab === 'start') renderStart(main).catch((e) => { if (!(e instanceof AuthError)) toast(e.message, true); });
  else if (state.tab === 'preise') renderPrices(main);
  else if (state.tab === 'analyse') renderAnalysis(main).catch((e) => { if (!(e instanceof AuthError)) toast(e.message, true); });
  else if (state.tab === 'mitbewerber') renderCompetitors(main);
  else if (state.tab === 'einstellungen') renderSettings(main).catch((e) => { if (!(e instanceof AuthError)) toast(e.message, true); });
  else renderImport(main);
  main.scrollTop = keep;
}

let pollTimer;
async function refresh() {
  const scrollY = window.scrollY;
  state.data = await api(`/api/overview${state.scope ? `?scope=${state.scope}` : ''}`);
  state.scope = state.data.scope;
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
