// Preisradar – Oberfläche (ohne Framework, ohne externe Ressourcen)
const NS = 'http://www.w3.org/2000/svg';
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const pct = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const dt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const dShort = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });

// append/replaceChildren ohne null/false (bedingte Elemente), Arrays werden aufgelöst
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const name of ['append', 'replaceChildren']) {
    const orig = proto[name];
    proto[name] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
  }
}

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

const state = { data: null, scope: null, tab: 'start', q: '', brand: '', filter: 'all', sort: 'name', dir: 'asc', comp: '', status: '', minP: '', maxP: '', gapMin: '', selected: null, runs: [], more: false, impMin: '', posMax: '', view: (() => { try { return localStorage.getItem('pr_view') === 'google' ? 'google' : 'preise'; } catch { return 'preise'; } })() };

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

// ---------- Position: Platz und Abstand zum günstigsten Angebot ----------
const TOL = 2; // % wie in der Analyse
function position(p, a) {
  if (p.price == null || a.min == null) return null;
  const prices = a.ok.map(({ m }) => m.price);
  const rank = 1 + prices.filter((x) => x < p.price - 0.004).length;
  const pctv = ((p.price - a.min) / a.min) * 100; // 0 = günstigster, >0 = teurer als das günstigste Angebot
  const second = prices.length ? Math.min(...prices) : null;
  const lead = rank === 1 && second != null ? ((second - p.price) / p.price) * 100 : null; // Vorsprung als Günstigster
  const tone = rank === 1 ? 'cool' : pctv <= TOL ? 'near' : 'warm';
  return { rank, n: prices.length + 1, pct: pctv, lead, tone };
}
function positionCell(p, a) {
  const pos = position(p, a);
  if (!pos) return h('td', { class: 'poscell', 'data-label': 'Position' }, h('span', { class: 'tag mute' }, 'kein Vergleich'));
  // Balken um die Mitte: rechts = teurer als der Günstigste, links = Vorsprung als Günstigster (bis ±25 %)
  const val = pos.rank === 1 ? -(pos.lead ?? 0) : pos.pct;
  const w = Math.min(Math.abs(val), 25) / 25 * 50;
  const label = pos.rank === 1 ? (pos.lead > 0.05 ? `${pct.format(pos.lead)} % Vorsprung` : 'gleichauf') : `${pct.format(pos.pct)} % teurer`;
  return h('td', { class: `poscell ${pos.tone}`, 'data-label': 'Position', title: `Platz ${pos.rank} von ${pos.n} Anbietern. ${label}.` },
    h('div', { class: 'pos' },
      h('span', { class: `rank ${pos.tone}` }, h('b', {}, String(pos.rank)), h('small', {}, ` von ${pos.n}`)),
      h('span', { class: 'posbar', 'aria-hidden': 'true' }, h('span', { class: 'mid' }), h('i', { class: `${val < 0 ? 'l' : 'r'} ${pos.tone}`, style: `width:${Math.max(w, val ? 2 : 0)}%` })),
      h('span', { class: `poslabel ${pos.tone}` }, label)));
}


// ---------- Preise ----------
function matchCell(p, a, { c, m }) {
  if (!m) return h('td', { 'data-label': c.name, class: 'mcell' }, h('span', { class: 'tag mute' }, '–'));
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
    return h('td', { 'data-label': c.name, class: `mcell cell ${m.status}${best ? ' best' : ''}`, title: `${m.title ?? ''}\n${tip}${prev}`.trim() },
      h('span', { class: 'price' }, eur.format(m.price)), delta, m.status === 'review' ? h('span', { class: 'tag' }, 'prüfen') : null);
  }
  const map = {
    not_found: ['nicht gefunden', 'mute'], nourl: ['URL fehlt', 'mute'], pending: ['ausstehend', 'mute'],
    blocked: ['gesperrt', 'err'], review: ['zu prüfen', ''], error: ['Fehler', 'err'],
  };
  const [label, cls] = map[m.status] ?? [m.status, 'mute'];
  const term = searchTerms(p)[0];
  return h('td', { 'data-label': c.name, class: 'mcell', title: [m.error, tip].filter(Boolean).join('\n') }, h('span', { class: `tag ${cls}` }, label),
    ['not_found', 'nourl', 'error'].includes(m.status) ? h('a', { class: 'searchlink', href: shopSearchUrl(c, term[1]), target: '_blank', rel: 'noopener noreferrer', title: `Im Shop von ${c.name} nach ${term[0]} „${term[1]}“ suchen`, onclick: (e) => e.stopPropagation() }, 'suchen') : null);
}

// Preisliste: wird seitenweise vom Server geladen (Filter und Sortierung dort), weitere Seiten beim Scrollen
const PAGE = 100;
const list = { rows: [], total: 0, inScope: 0, chips: {}, brands: [], loading: false, seq: 0, observer: null };
const FILTER_KEYS = ['q', 'brand', 'filter', 'comp', 'status', 'minP', 'maxP', 'gapMin', 'impMin', 'posMax', 'sort', 'dir'];
function listQuery() {
  const q = { scope: state.scope ?? '' };
  for (const k of FILTER_KEYS) if (state[k] !== '' && state[k] != null) q[k] = state[k];
  return q;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

/** Suchlink in den Shop des Mitbewerbers (öffnet der Nutzer selbst im Browser). */
function shopSearchUrl(c, term) {
  let host = '';
  try { host = new URL(c.base_url).hostname; } catch { /* leer */ }
  const tpl = c.manual_search_url || c.search_url || `https://www.google.com/search?q=site:${host}+{q}`;
  return tpl.replaceAll('{q}', encodeURIComponent(term));
}
const searchTerms = (p) => [
  p.mpn ? ['Herstellernr.', p.mpn] : null,
  p.ean ? ['EAN', p.ean] : null,
  ['Name', `${p.name}`.replace(/\s+-\s+.*$/, '').slice(0, 80)],
].filter(Boolean);

function renderPrices(root) {
  const d = state.data;
  if (!d.counts.all) {
    root.append(h('div', { class: 'panel empty' },
      h('h3', {}, 'Noch keine Produkte'),
      h('p', {}, 'Hol die Produkte aus deiner Sitemap, aus Shopware oder per CSV.'),
      h('button', { class: 'btn primary', onclick: () => setTab('import') }, 'Zum Import')));
    return;
  }
  const noComps = !d.competitors.length;
  if (noComps) {
    root.append(h('div', { class: 'panel head' },
      h('div', {}, h('strong', {}, `${d.counts.all} Produkte in deiner Artikelbasis. `), 'Für den Preisvergleich fehlen noch Mitbewerber.'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => setTab('mitbewerber') }, 'Mitbewerber anlegen')));
  }
  const reload = () => loadRows(true);
  let typingTimer;
  const typed = (key) => (e) => { state[key] = e.target.value; clearTimeout(typingTimer); typingTimer = setTimeout(reload, 250); };
  const hasGoogle = Boolean(d.config.gsc || d.config.merchant || d.config.seoAudit);
  const gview = hasGoogle && state.view === 'google';
  const extra = ['comp', 'status', 'minP', 'maxP', 'gapMin', 'impMin', 'posMax'].filter((k) => state[k] !== '').length + (['moved', 'problem', 'notFound', 'oos', 'equal', 'offline', 'tierA'].includes(state.filter) ? 1 : 0);
  const reset = () => { Object.assign(state, { q: '', brand: '', filter: 'all', comp: '', status: '', minP: '', maxP: '', gapMin: '', impMin: '', posMax: '' }); render(); };
  const setView = (v) => {
    state.view = v;
    try { localStorage.setItem('pr_view', v); } catch { /* egal */ }
    if (v === 'google' && ['name', 'number', 'gap', 'gappct', 'cheapest', 'price'].includes(state.sort)) Object.assign(state, { sort: 'potential', dir: 'desc' });
    if (v === 'preise' && ['potential', 'position', 'ctr', 'query'].includes(state.sort)) Object.assign(state, { sort: 'name', dir: 'asc' });
    render();
  };
  const sorts = [['name:asc', 'Name A–Z'], ['name:desc', 'Name Z–A'], ['number:asc', 'Artikelnummer'], ['gap:desc', 'Größter Rückstand in €'], ['gappct:desc', 'Größter Rückstand in %'], ['gap:asc', 'Größter Vorsprung'], ['price:desc', 'Preis absteigend'], ['price:asc', 'Preis aufsteigend'], ['cheapest:asc', 'Günstigster Mitbewerberpreis'], ['units:desc', 'Meistverkauft (30 Tage)'], ['revenue:desc', 'Meister Umsatz (90 Tage)'], ['margin:asc', 'Geringste Marge'], ['benchmark:desc', 'Am weitesten über Google-Vergleichspreis'], ['impressions:desc', 'Meiste Impressionen (Google)'], ['clicks:desc', 'Meiste Klicks (Google)'], ['potential:desc', 'Größtes Klickpotenzial (Google)'], ['position:asc', 'Beste Google-Position'], ['position:desc', 'Schlechteste Google-Position'], ['ctr:asc', 'Niedrigste Klickrate (Google)'], ['updated:desc', 'Zuletzt aktualisiert']];
  if (gview) sorts.unshift(...sorts.splice(sorts.findIndex(([v]) => v === 'potential:desc'), 4), ...sorts.splice(sorts.findIndex(([v]) => v === 'benchmark:desc'), 1));

  root.append(
    h('div', { class: 'pagehead' }, h('h2', {}, 'Preise'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Artikelauswahl' },
        h('button', { class: `chip${state.scope === 'tracked' ? ' on' : ''}`, onclick: () => { state.scope = 'tracked'; render(); } }, h('b', {}, String(d.counts.tracked)), 'beobachtet'),
        h('button', { class: `chip${state.scope === 'all' ? ' on' : ''}`, onclick: () => { state.scope = 'all'; render(); } }, h('b', {}, String(d.counts.all)), 'alle Artikel')),
      d.counts.tracked < d.counts.all ? h('button', { class: 'btn small', title: 'Alle Artikel bei den Mitbewerbern abgleichen. Die wichtigsten werden täglich geprüft, die übrigen im Wechsel.', onclick: guard(trackAll) }, 'Alle beobachten') : null,
      h('span', { class: 'spacer' }),
      hasGoogle ? h('div', { class: 'seg viewseg', role: 'group', 'aria-label': 'Ansicht' },
        h('button', { class: `chip${!gview ? ' on' : ''}`, 'aria-pressed': String(!gview), onclick: () => setView('preise') }, 'Preisvergleich'),
        h('button', { class: `chip${gview ? ' on' : ''}`, 'aria-pressed': String(gview), onclick: () => setView('google') }, 'Google-Sichtbarkeit')) : null,
      h('a', { class: 'btn', href: '/api/export.csv' }, 'CSV-Export')),
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: hasGoogle ? 'Name, Nummer, EAN, Suchbegriff' : 'Name, Artikelnummer oder EAN', title: hasGoogle ? 'Findet auch Artikel, deren Seite bei Google über diesen Suchbegriff gefunden wird' : null, value: state.q, 'aria-label': 'Suche', oninput: typed('q') }),
      h('select', { id: 'brandsel', 'aria-label': 'Hersteller', onchange: (e) => { state.brand = e.target.value; reload(); } },
        h('option', { value: '' }, 'Alle Hersteller'), list.brands.map((b) => h('option', { value: b, selected: b === state.brand }, b))),
      h('select', { 'aria-label': 'Sortierung', onchange: (e) => { const [s, dir] = e.target.value.split(':'); state.sort = s; state.dir = dir; render(); } },
        sorts.map(([v, l]) => h('option', { value: v, selected: v === `${state.sort}:${state.dir}` }, l))),
      noComps ? null : h('button', { class: `btn${state.more ? ' on' : ''}`, 'aria-expanded': state.more ? 'true' : 'false', onclick: () => { state.more = !state.more; render(); } }, extra ? `Weitere Filter (${extra})` : 'Weitere Filter'),
      state.q || state.brand || state.filter !== 'all' || extra ? h('button', { class: 'linkbtn', onclick: reset }, 'Zurücksetzen') : null),
    gview ? h('div', { class: 'toolbar gchips' }, h('div', { class: 'seg', id: 'chips-google' })) : null,
    noComps ? null : h('div', { class: 'toolbar' }, h('div', { class: 'seg', id: 'chips-main' })),
    hasGoogle && !gview ? h('div', { class: 'toolbar gchips' }, h('span', { class: 'seglabel' }, 'Google'), h('div', { class: 'seg', id: 'chips-google' })) : null,
    gview ? h('p', { class: 'pmeta gexplain' }, d.config.gsc ? 'Klickpotenzial: so viele Klicks mehr in 28 Tagen, wenn die Seite unter die ersten drei bei Google käme (oder dort so oft geklickt würde wie üblich). Daten der Search Console, 2–3 Tage verzögert.' : 'Search Console noch nicht verbunden: Positionen, Klicks und Klickpotenzial fehlen, Vergleichspreise kommen aus dem Merchant Center.') : null,
    noComps || !state.more ? null : h('div', { class: 'morebox' },
      h('div', { class: 'seg', id: 'chips-more' }),
      h('div', { class: 'toolbar', style: 'margin:12px 0 0' },
        h('select', { 'aria-label': 'Günstiger bei', onchange: (e) => { state.comp = e.target.value; reload(); } },
          h('option', { value: '' }, 'Günstiger bei: jeder'), d.competitors.map((c) => h('option', { value: c.id, selected: String(c.id) === String(state.comp) }, `Günstiger bei ${c.name}`))),
        h('select', { 'aria-label': 'Status', onchange: (e) => { state.status = e.target.value; reload(); } },
          [['', 'Jeder Status'], ['ok', 'mit Preis'], ['review', 'zu prüfen'], ['not_found', 'nicht gefunden'], ['nourl', 'URL fehlt'], ['pending', 'ausstehend'], ['error', 'Fehler'], ['blocked', 'gesperrt']]
            .map(([v, l]) => h('option', { value: v, selected: v === state.status }, l))),
        h('input', { type: 'number', min: 0, step: 'any', placeholder: 'Preis ab €', value: state.minP, 'aria-label': 'Preis ab', class: 'numin', oninput: typed('minP') }),
        h('input', { type: 'number', min: 0, step: 'any', placeholder: 'Preis bis €', value: state.maxP, 'aria-label': 'Preis bis', class: 'numin', oninput: typed('maxP') }),
        h('input', { type: 'number', step: 'any', placeholder: 'Abstand ab %', value: state.gapMin, 'aria-label': 'Mindestabstand in Prozent', class: 'numin', title: 'Nur Artikel, bei denen du mindestens so viel Prozent teurer bist', oninput: typed('gapMin') }),
        d.config.gsc ? h('input', { type: 'number', min: 0, step: 1, placeholder: 'Impressionen ab', value: state.impMin, 'aria-label': 'Google-Impressionen ab', class: 'numin', title: 'Nur Artikel, deren Seite in den letzten 28 Tagen mindestens so oft bei Google angezeigt wurde', oninput: typed('impMin') }) : null,
        d.config.gsc ? h('input', { type: 'number', min: 1, step: 'any', placeholder: 'Google-Platz bis', value: state.posMax, 'aria-label': 'Google-Position bis', class: 'numin', title: 'Nur Artikel, deren Seite bei Google im Schnitt mindestens so weit oben steht', oninput: typed('posMax') }) : null),
      h('div', { class: 'toolbar', style: 'margin:12px 0 0' },
        h('span', { class: 'pmeta' }, 'Nur beobachtete Artikel werden bei Mitbewerbern abgeglichen.'),
        h('button', { class: 'btn small', onclick: guard(() => track(null, true)) }, 'Gefilterte beobachten'),
        h('button', { class: 'btn small', onclick: guard(() => track(null, false)) }, 'Gefilterte nicht beobachten')),
      h('div', { class: 'toolbar', style: 'margin:12px 0 0' },
        h('span', { class: 'pmeta' }, 'Zusätzlich zu den automatisch gewählten Artikeln täglich prüfen:'),
        h('button', { class: 'btn small', onclick: guard(() => pinFiltered(true)) }, 'Gefilterte täglich prüfen'),
        h('button', { class: 'btn small', onclick: guard(() => pinFiltered(false)) }, 'Gefilterte nicht mehr von Hand'))),
    h('div', { class: 'tablewrap', id: 'tablewrap' }));
  buildTable();
  loadRows(true);
}

function renderChips() {
  const c = list.chips;
  const chip = (key, label, cls = '') => h('button', { class: `chip ${cls}${state.filter === key ? ' on' : ''}`, 'aria-pressed': state.filter === key ? 'true' : 'false', onclick: () => { state.filter = key; render(); } }, h('b', {}, String(c[key] ?? 0)), label);
  document.getElementById('chips-main')?.replaceChildren(
    chip('all', 'alle'), chip('undercut', 'teurer als ein Mitbewerber', 'bad'), chip('cheapest', 'günstigster', 'good'),
    chip('review', 'zu prüfen', 'warn'), chip('none', 'ohne Vergleichspreis'));
  document.getElementById('chips-more')?.replaceChildren(
    chip('equal', 'gleichauf'), chip('moved', 'Preis geändert'), chip('problem', 'Fehler oder gesperrt', 'bad'),
    chip('notFound', 'nicht gefunden'), chip('oos', 'Mitbewerber ausverkauft'), chip('offline', 'bei mir offline', 'warn'), chip('tierA', 'täglich geprüft'));
  const gc = state.data.config;
  const gchip = (key, label, cls, title) => { const b = chip(key, label, cls); b.title = title; return b; };
  document.getElementById('chips-google')?.replaceChildren(
    gchip('gAdvice', 'mit Handlungsbedarf', 'warn', 'Artikel mit mindestens einem Hinweis (Preis, Klickrate, Position, Sichtbarkeit)'),
    gc.gsc ? gchip('gDemandDear', 'gefragt, aber teurer', 'bad', `Mindestens 100 Impressionen bei Google und teurer als ein Mitbewerber`) : null,
    gc.merchant ? gchip('gAboveBench', 'über Google-Vergleichspreis', 'bad', 'Mehr als 2 % teurer als der Preis, zu dem andere Händler das Produkt bei Google anbieten') : null,
    gc.gsc ? gchip('gStriking', 'Platz 4–20', '', 'Seite steht bei Google knapp unter den Top 3 oder auf Seite 2 und hat Impressionen: hier bringt eine Verbesserung am meisten') : null,
    gc.gsc ? gchip('gLowCtr', 'wenig geklickt', 'warn', 'Viel gesehen, aber weniger als halb so oft geklickt wie für diese Position üblich') : null,
    gc.gsc ? gchip('gDemand', 'gefragt bei Google', 'good', 'Mindestens 100 Impressionen in den letzten 28 Tagen') : null,
    gc.merchant ? gchip('gSuggest', 'Google-Preisvorschlag', '', 'Google empfiehlt einen anderen Preis (Merchant Center)') : null,
    gchip('gSeo', 'SEO-Fehler', 'bad', 'Der Seiten-Check hat auf der Produktseite Fehler gefunden (z. B. noindex, fehlende Produktdaten, Preis in den Produktdaten weicht ab)'),
    gc.gsc ? gchip('gSoldHidden', 'verkauft, kaum sichtbar', '', 'In den letzten 90 Tagen verkauft, aber unter 20 Impressionen bei Google') : null,
    gc.gsc ? gchip('gInvisible', 'nicht bei Google', '', 'Keine Impressionen in den letzten 28 Tagen') : null);
  const sel = document.getElementById('brandsel');
  if (sel && sel.options.length <= 1 && list.brands.length) sel.append(...list.brands.map((b) => h('option', { value: b, selected: b === state.brand }, b)));
}

/** Gefilterte Artikel (Serverabfrage) beobachten bzw. nicht mehr beobachten. */
/** Alle aktiven Artikel beobachten, unabhängig vom Filter. */
async function trackAll() {
  const d = state.data;
  const n = d.counts.all - d.counts.tracked;
  if (n > 500 && !confirm(`Alle ${d.counts.all.toLocaleString('de-DE')} Artikel beobachten (${n.toLocaleString('de-DE')} kommen dazu)? Die wichtigsten werden täglich geprüft, die übrigen im Abstand von einigen Tagen.`)) return;
  const r = await api('/api/products/track', { body: { query: { scope: 'all' }, tracked: true } });
  toast(`Alle ${r.counts.tracked.toLocaleString('de-DE')} Artikel werden beobachtet`);
  state.scope = 'tracked';
  await refresh();
  render();
}

async function track(ids, tracked) {
  const body = ids ? { ids, tracked } : { query: listQuery(), tracked };
  const n = ids ? ids.length : list.total;
  if (!n) return toast('Keine Artikel im Filter', true);
  if (n > 500 && !confirm(`${n} Artikel ${tracked ? 'beobachten' : 'nicht mehr beobachten'}?`)) return;
  const r = await api('/api/products/track', { body });
  toast(`${r.changed} Artikel ${tracked ? 'werden beobachtet' : 'werden nicht mehr beobachtet'}`);
  await refresh();
  if (!ids) render(); // Zähler oben aktualisieren
}

function sortHead(label, key, cls = '', firstDir = 'asc') {
  const on = state.sort === key;
  const arrow = on ? (state.dir === 'desc' ? ' ▼' : ' ▲') : '';
  return h('th', { class: `${cls} sortable${on ? ' sorted' : ''}`, 'aria-sort': on ? (state.dir === 'desc' ? 'descending' : 'ascending') : 'none' },
    h('button', { class: 'thbtn', onclick: () => { state.dir = on ? (state.dir === 'asc' ? 'desc' : 'asc') : firstDir; state.sort = key; render(); } }, label, arrow));
}

/** Kleines Radar als Ladeanzeige für einen einzelnen Bereich (nicht die ganze Seite). */
function miniRadar(text = 'Wird geladen', { small = false } = {}) {
  return h('div', { class: `mr${small ? ' small' : ''}`, role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'mr-scope', 'aria-hidden': 'true' },
      h('div', { class: 'mr-sweep' }),
      [['32deg', '62%', 'c'], ['148deg', '38%', 'w'], ['250deg', '74%', 'c'], ['305deg', '48%', 'w']].map(([a, d, t], i) => h('i', { class: `mr-blip ${t}`, style: `--a:${a};--d:${d};animation-delay:${(parseInt(a, 10) / 360) * 1.6}s` })),
      h('b', { class: 'mr-core' })),
    h('div', { class: 'mr-text' }, text, h('span', { class: 'mr-dots' }, h('i'), h('i'), h('i'))));
}
const TAB_LOADING = { start: 'Lagebild wird gezeichnet', analyse: 'Analyse wird gerechnet', chancen: 'Chancen werden bewertet', sichtbarkeit: 'Google-Daten werden geladen', keywords: 'Keywords werden geladen', seitencheck: 'Seiten-Check wird geladen', ebay: 'eBay-Daten werden geladen', import: 'Läufe werden geladen', einstellungen: 'Einstellungen werden geladen' };

function buildTable() {
  const d = state.data;
  const wrap = document.getElementById('tablewrap');
  if (!wrap) return;
  const has = d.competitors.length > 0;
  const gview = state.view === 'google' && Boolean(d.config.gsc || d.config.merchant || d.config.seoAudit);
  const table = gview ? h('table', { class: 'prices gview' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'trackhead', title: 'Alle Artikel im aktuellen Filter beobachten bzw. nicht mehr beobachten' }, h('input', { type: 'checkbox', id: 'trackall', 'aria-label': 'Alle Artikel im Filter beobachten', onchange: guard(async (e) => { const on = e.target.checked; e.target.checked = !on; await track(null, on); }) })),
      sortHead(h('span', { id: 'prodcount' }, 'Produkt'), 'name', 'prod'),
      d.config.gsc ? [sortHead('Google-Position', 'position', 'gposh'), sortHead('Impressionen', 'impressions', '', 'desc'), sortHead('Klicks', 'clicks', '', 'desc'), sortHead('Klickrate', 'ctr'), sortHead('Klickpotenzial', 'potential', '', 'desc')] : null,
      h('th', { class: 'gtodo' }, 'Was tun'),
      sortHead(d.own.name, 'price', 'own', 'desc'),
      has ? sortHead('Preis-Platz', 'gappct', '', 'desc') : null,
      h('th', {}, ''))),
    h('tbody', { id: 'rows' })) : h('table', { class: 'prices' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'trackhead', title: 'Alle Artikel im aktuellen Filter beobachten bzw. nicht mehr beobachten' }, h('input', { type: 'checkbox', id: 'trackall', 'aria-label': 'Alle Artikel im Filter beobachten', onchange: guard(async (e) => { const on = e.target.checked; e.target.checked = !on; await track(null, on); }) })),
      sortHead(h('span', { id: 'prodcount' }, 'Produkt'), 'name', 'prod'),
      sortHead(d.own.name, 'price', 'own', 'desc'),
      d.competitors.map((c) => sortHead(`${c.name}${c.enabled ? '' : ' (aus)'}`, `comp:${c.id}`)),
      has ? [sortHead('Position (Platz)', 'gappct', 'posh', 'desc'), sortHead('Abstand zum günstigsten', 'gap', '', 'desc'), h('th', {}, '')] : null)),
    h('tbody', { id: 'rows' }));
  const status = h('div', { id: 'liststatus', class: 'liststatus' }, miniRadar('Preise werden geladen'));
  wrap.replaceChildren(table, status);
  list.observer?.disconnect();
  const narrow = window.matchMedia('(max-width: 700px)').matches; // mobil scrollt die Seite, nicht die Tabelle
  list.observer = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadRows(false); }, { root: narrow ? null : wrap, rootMargin: '600px' });
  list.observer.observe(status);
}

async function loadRows(reset, { keep = false } = {}) {
  if (!document.getElementById('rows')) return;
  if (!reset && (list.loading || list.rows.length >= list.total)) return;
  const seq = ++list.seq;
  list.loading = true;
  // Neu filtern/sortieren: dauert es länger, das Radar über der Tabelle zeigen (nur dort, nicht auf der ganzen Seite)
  const wrapEl = document.getElementById('tablewrap');
  if (!reset) document.getElementById('liststatus')?.replaceChildren(miniRadar('Weitere Artikel werden geladen', { small: true }));
  const busyTimer = reset && document.getElementById('rows')?.children.length ? setTimeout(() => { if (seq === list.seq && list.loading && wrapEl && !wrapEl.querySelector('.mr-overlay')) wrapEl.append(h('div', { class: 'mr-overlay' }, miniRadar('Wird aktualisiert', { small: true }))); }, 220) : null;
  const offset = reset ? 0 : list.rows.length;
  const limit = keep ? Math.min(500, Math.max(PAGE, list.rows.length)) : PAGE;
  try {
    const r = await api(`/api/products?${qs({ ...listQuery(), offset, limit })}`);
    if (seq !== list.seq) return; // inzwischen neue Abfrage
    Object.assign(list, { total: r.total, inScope: r.inScope, chips: r.chips, brands: r.brands });
    if (r.scope !== state.scope) state.scope = r.scope;
    const tbody = document.getElementById('rows');
    if (!tbody) return;
    const els = r.rows.map((p) => (state.view === 'google' && (state.data.config.gsc || state.data.config.merchant || state.data.config.seoAudit) ? googleRowEl(p) : rowEl(p)));
    tbody.classList.toggle('still', Boolean(keep)); // beim Aktualisieren nicht erneut animieren
    if (reset) { list.rows = r.rows; tbody.replaceChildren(...els); if (!keep) document.getElementById('tablewrap').scrollTop = 0; }
    else { list.rows.push(...r.rows); tbody.append(...els); }
    renderChips();
    const ta = document.getElementById('trackall');
    if (ta) { ta.checked = list.rows.length > 0 && list.rows.every((x) => x.tracked); ta.indeterminate = !ta.checked && list.rows.some((x) => x.tracked); }
    const pc = document.getElementById('prodcount');
    if (pc) pc.textContent = `Produkt (${list.total.toLocaleString('de-DE')}${list.total !== list.inScope ? ' von ' + list.inScope.toLocaleString('de-DE') : ''})`;
    const st = document.getElementById('liststatus');
    if (st) st.textContent = !list.total ? 'Keine Produkte für diesen Filter.' : list.rows.length < list.total ? `${list.rows.length.toLocaleString('de-DE')} von ${list.total.toLocaleString('de-DE')} geladen, weitere beim Scrollen …` : `Alle ${list.total.toLocaleString('de-DE')} geladen.`;
  } finally {
    if (seq === list.seq) { list.loading = false; clearTimeout(busyTimer); wrapEl?.querySelector('.mr-overlay')?.remove(); }
  }
  // Passt die erste Seite ganz auf den Bildschirm, gleich weiterladen
  const st = document.getElementById('liststatus');
  const wrap = document.getElementById('tablewrap');
  if (st && wrap && list.rows.length < list.total && st.getBoundingClientRect().top < Math.min(window.innerHeight, wrap.getBoundingClientRect().bottom) + 400) loadRows(false);
}

function rowEl(p) {
  const d = state.data;
  const a = analyse(p, d.competitors);
  const tr = h('tr', { tabindex: 0, 'data-id': p.id, class: p.offline_since ? 'offline' : null, onclick: () => openDrawer(p.id), onkeydown: (e) => e.key === 'Enter' && e.target === tr && openDrawer(p.id) },
    h('td', { class: 'trackcell', onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: Boolean(p.tracked), 'aria-label': `${p.name} beobachten`, onchange: guard((e) => track([p.id], e.target.checked)) })),
    h('td', { class: 'prod' }, h('div', { class: 'pname' }, p.name),
      h('div', { class: 'pmeta' }, [p.manufacturer, p.number, p.mpn && p.mpn !== p.number ? `HAN ${p.mpn}` : null].filter(Boolean).join(' · ')),
      econLine(p),
      hitLine(p),
      sigChips(p.id, p.sig, { omit: ['price', 'sales', 'gsc'] }),
      p.seo ? h('div', { class: 'seoline', title: `Google, letzte 28 Tage: ${p.seo.clicks} Klicks, ${p.seo.impressions} Impressionen, Ø Position ${p.seo.position}` }, `${nf.format(p.seo.impressions)} Impr. · ${nf.format(p.seo.clicks)} Klicks · Pos. ${nf1.format(p.seo.position)}`) : null,
      tierTag(p),
      p.offline_since ? h('span', { class: 'tag warn', title: `Seit ${dt.format(new Date(p.offline_since))} nicht mehr in deiner Sitemap bzw. nicht erreichbar` }, 'bei dir offline') : null),
    h('td', { class: `own ${position(p, a)?.tone ?? ''}`, 'data-label': d.own.name }, p.price != null ? eur.format(p.price) : '–'),
    a.cells.map((cell) => matchCell(p, a, cell)),
    d.competitors.length ? positionCell(p, a) : null,
    d.competitors.length ? h('td', { 'data-label': 'Abstand zum günstigsten', class: a.kind === 'undercut' ? 'gapcell gap bad' : a.kind === 'cheapest' ? 'gapcell gap good' : 'gapcell gap' },
      a.kind === 'undercut' ? [`+${eur.format(a.gap)}`, h('small', {}, `günstigster: ${a.ok.find(({ m }) => m.price === a.min)?.c.name ?? ''}`)]
        : a.kind === 'cheapest' ? ['günstigster', h('small', {}, a.min - p.price > 0.004 ? `${eur.format(a.min - p.price)} Vorsprung` : 'gleichauf')]
          : h('span', { class: 'tag mute' }, '–')) : null,
    d.competitors.length ? h('td', { class: 'actcell', onclick: (e) => e.stopPropagation() }, h('div', { class: 'acts' }, checkButton(p.id), pinButton(p))) : null);
  return tr;
}

/** Treffer über einen Google-Suchbegriff (die Produktseite wird mit dieser Suchanfrage gefunden). */
function hitLine(p) {
  return p.hit ? h('div', { class: 'hitline', title: 'Gefunden, weil die Produktseite bei Google über diese Suchanfrage angezeigt wird' }, 'Google-Suche: „', h('b', {}, p.hit), '“') : null;
}

/** Ton einer Google-Position: Top 3, Seite 1, Seite 2, dahinter. */
const gTone = (pos) => (pos == null ? '' : pos <= 3 ? 'good' : pos <= 10 ? 'cool' : pos <= 20 ? 'warn' : 'bad');

/** Zeile der Ansicht „Google-Sichtbarkeit“. */
function googleRowEl(p) {
  const d = state.data;
  const a = analyse(p, d.competitors);
  const g = p.g ?? { potential: 0, advice: [], flags: [] };
  const sx = p.seo;
  const pos = d.competitors.length ? position(p, a) : null;
  const maxPot = Math.max(50, ...list.rows.map((r) => r.g?.potential ?? 0));
  const tr = h('tr', { tabindex: 0, 'data-id': p.id, class: p.offline_since ? 'offline' : null, onclick: () => openDrawer(p.id), onkeydown: (e) => e.key === 'Enter' && e.target === tr && openDrawer(p.id) },
    h('td', { class: 'trackcell', onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: Boolean(p.tracked), 'aria-label': `${p.name} beobachten`, onchange: guard((e) => track([p.id], e.target.checked)) })),
    h('td', { class: 'prod' }, h('div', { class: 'pname' }, p.name),
      h('div', { class: 'pmeta' }, [p.manufacturer, p.number].filter(Boolean).join(' · ')),
      hitLine(p),
      sx?.top ? h('div', { class: 'topq', title: 'Suchanfrage mit den meisten Klicks auf diese Seite' }, 'Top-Suche „', h('b', {}, sx.top.query), `“ · Platz ${nf1.format(sx.top.position)}`) : null,
      p.sales?.units_90 ? h('div', { class: 'pmeta' }, `${nf.format(p.sales.units_90)} verkauft (90 T)`) : null,
      sigChips(p.id, p.sig, { omit: ['price', 'sales', 'gsc'] }),
      tierTag(p)),
    d.config.gsc ? [
      h('td', { class: 'mcell gpos', 'data-label': 'Google-Position' }, sx ? h('div', { class: 'gposbox', title: `Ø Position ${nf1.format(sx.position)} in den letzten 28 Tagen` },
        h('span', { class: `gpill ${gTone(sx.position)}` }, nf1.format(sx.position)),
        h('span', { class: 'gscale', 'aria-hidden': 'true' }, h('i', { class: gTone(sx.position), style: `left:${Math.min(100, ((Math.min(sx.position, 30) - 1) / 29) * 100)}%` }))) : h('span', { class: 'tag mute' }, 'nicht gefunden')),
      h('td', { class: 'mcell', 'data-label': 'Impressionen' }, sx ? nf.format(sx.impressions) : '–'),
      h('td', { class: 'mcell', 'data-label': 'Klicks' }, sx ? nf.format(sx.clicks) : '–'),
      h('td', { class: `mcell ${g.flags.includes('lowCtr') ? 'warmtxt' : ''}`, 'data-label': 'Klickrate' }, sx ? [`${nf1.format(sx.ctr * 100)} %`, g.expected != null ? h('small', { class: 'pmeta gexp' }, `üblich ${nf1.format(g.expected * 100)} %`) : null] : '–'),
      h('td', { class: 'mcell gpot', 'data-label': 'Klickpotenzial' }, sx && g.potential > 0 ? h('div', { class: 'potbox', title: `Etwa ${g.potential} Klicks mehr in 28 Tagen möglich` },
        h('b', {}, `+${nf.format(g.potential)}`), h('span', { class: 'potbar' }, h('i', { style: `width:${Math.max(3, Math.min(100, (g.potential / maxPot) * 100))}%` }))) : h('span', { class: 'tag mute' }, '–')),
    ] : null,
    h('td', { class: 'gapcell gtodo', 'data-label': 'Was tun' }, g.advice.length
      ? h('ul', { class: 'todo' }, g.advice.slice(0, 2).map((x) => h('li', { class: x.kind }, x.text)))
      : h('span', { class: 'tag mute' }, sx || p.google ? 'nichts Dringendes' : '–')),
    h('td', { class: 'own', 'data-label': d.own.name },
      p.price != null ? eur.format(p.price) : '–',
      g.bench != null ? h('small', { class: `gbench ${g.bench > 2 ? 'warmtxt' : g.bench < -2 ? 'cooltxt' : ''}`, title: `Google-Vergleichspreis ${eur.format(p.google.benchmark)}` }, `Google ${eur.format(p.google.benchmark)} (${g.bench > 0 ? '+' : ''}${nf1.format(g.bench)} %)`) : null),
    d.competitors.length ? h('td', { class: 'mcell', 'data-label': 'Preis-Position' }, pos
      ? h('span', { class: `gprank ${pos.tone}`, title: `Platz ${pos.rank} von ${pos.n} Anbietern` }, h('b', {}, `${pos.rank} von ${pos.n}`), h('small', {}, pos.rank > 1 ? `${pct.format(pos.pct)} % teurer` : 'günstigster'))
      : h('span', { class: 'tag mute' }, 'kein Vergleich')) : null,
    h('td', { class: 'actcell', onclick: (e) => e.stopPropagation() }, h('div', { class: 'acts' }, d.competitors.length ? checkButton(p.id) : null, pinButton(p))));
  return tr;
}

/** Lagebild: wie oft geprüft wird, Fortschritt der Erstzuordnung und Aktualität je Stufe. */
function tiersFacts(t, sch) {
  if (!t) return [h('dt', {}, 'Aktualität'), h('dd', {}, `jeder Artikel höchstens alle ${sch.refresh} Stunden`)];
  const pct = (v) => (v == null ? '–' : `${String(v).replace('.', ',')} %`);
  const prog = t.matches ? Math.round((t.checked / t.matches) * 1000) / 10 : 100;
  return [
    h('dt', {}, 'Prüf-Rhythmus'), h('dd', {}, h('button', { class: 'linkbtn', title: 'Täglich geprüfte Artikel in der Preisliste zeigen', onclick: () => { state.filter = 'tierA'; state.more = true; setTab('preise'); } }, `${t.a.toLocaleString('de-DE')} täglich`),
      `${t.pinned ? ` (davon ${t.pinned.toLocaleString('de-DE')} von Hand)` : ''}, ${t.b.toLocaleString('de-DE')} alle ${t.bDays} Tage`),
    t.open ? [h('dt', {}, 'Erstzuordnung'), h('dd', {},
      h('div', { class: 'aimeter', title: `${t.checked} von ${t.matches} Zuordnungen mindestens einmal geprüft` }, h('div', { style: `width:${Math.min(100, prog)}%` })),
      `${pct(prog)} erledigt, ${t.open.toLocaleString('de-DE')} offen${t.days_left ? `, noch etwa ${t.days_left < 1 ? 'einen Tag' : `${String(Math.ceil(t.days_left)).replace('.', ',')} Tage`}` : ''}`)] : null,
    h('dt', {}, 'Aktualität'), h('dd', {}, `täglich geprüfte: ${pct(t.fresh_a)} von heute, übrige: ${pct(t.fresh_b)} im Rhythmus`),
  ];
}

/** Verkäufe, Bestand und Marge eines Artikels in einer Zeile. */
function econLine(p) {
  const parts = [];
  if (p.sales) parts.push(`${nf.format(p.sales.units_30)} verkauft (30 T)`);
  if (p.stock != null) parts.push(`Bestand ${nf.format(p.stock)}`);
  if (p.google?.benchmark && p.price) parts.push(`Google-Vergleich ${eur.format(p.google.benchmark)}`);
  if (p.purchase_price > 0 && p.price) { const net = p.price / (1 + (p.tax_rate ?? 19) / 100); parts.push(`Marge ${nf1.format(((net - p.purchase_price) / net) * 100)} %`); }
  return parts.length ? h('div', { class: 'econline' }, parts.join(' · ')) : null;
}

/** Sofortprüfung eines Artikels bei allen Mitbewerbern; ersetzt danach Zeile und Detailansicht. */
function checkButton(id, label = 'Prüfen') {
  const b = h('button', { class: 'btn small', title: 'Jetzt bei allen Mitbewerbern prüfen', onclick: guard(async () => {
    b.disabled = true;
    b.textContent = 'prüft …';
    try {
      const r = await api(`/api/products/${id}/check`, { method: 'POST', body: {} });
      const found = r.results.filter((x) => x.found).length;
      toast(`${found} von ${r.results.length} Mitbewerbern mit Preis`);
      replaceRow(r.product);
      if (state.selected === id) openDrawer(id, r.product);
    } finally { b.disabled = false; b.textContent = label; }
  }) }, label);
  return b;
}
/** Prüf-Stufe eines Artikels als kleines Etikett (nur bei täglicher Prüfung). */
function tierTag(p) {
  if (p.tier !== 'A') return null;
  return h('span', { class: `tag tier${p.tier_pin ? ' pinned' : ''}`, title: `Wird täglich bei den Mitbewerbern abgefragt: ${p.tier_reason || 'von Hand gesetzt'}` }, p.tier_pin ? 'täglich (von Hand)' : 'täglich');
}

/** Artikel von Hand auf tägliche Prüfung setzen bzw. zurücknehmen. */
function pinButton(p, long = false) {
  const on = Boolean(p.tier_pin);
  const label = on ? (long ? 'Nicht mehr täglich prüfen' : 'täglich ✓') : (long ? 'Täglich prüfen' : 'täglich');
  const b = h('button', { class: `btn small pin${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false',
    title: on ? 'Von Hand auf tägliche Prüfung gesetzt. Klicken, um das zurückzunehmen; danach entscheiden wieder Verkäufe, Preisbewegung und Google-Daten.' : 'Diesen Artikel immer täglich bei den Mitbewerbern prüfen, unabhängig von Verkäufen und Google-Daten',
    onclick: guard(async () => {
      b.disabled = true;
      try {
        const r = await api('/api/products/pin', { body: { ids: [p.id], pin: !on } });
        toast(on ? 'Wird wieder automatisch eingestuft' : 'Wird ab jetzt täglich geprüft');
        replaceRow(r.product);
        if (state.selected === p.id) openDrawer(p.id, r.product);
      } finally { b.disabled = false; }
    }) }, label);
  return b;
}

/** Gefilterte Artikel von Hand auf täglich setzen bzw. zurücknehmen. */
async function pinFiltered(pin) {
  const n = list.total;
  if (!n) return toast('Keine Artikel im Filter', true);
  if (pin && n > 200 && !confirm(`${n.toLocaleString('de-DE')} Artikel täglich prüfen? Das erhöht die Zahl der Abfragen bei den Mitbewerbern deutlich.`)) return;
  const r = await api('/api/products/pin', { body: { query: listQuery(), pin } });
  toast(pin ? `${r.changed} Artikel werden täglich geprüft` : `${r.changed} Artikel wieder automatisch eingestuft`);
  await refresh();
}

function replaceRow(p) {
  const i = list.rows.findIndex((x) => x.id === p.id);
  if (i >= 0) list.rows[i] = p;
  const nr = state.view === 'google' && (state.data.config.gsc || state.data.config.merchant || state.data.config.seoAudit) ? googleRowEl(p) : rowEl(p);
  nr.classList.add('flash');
  document.querySelector(`#rows tr[data-id="${p.id}"]`)?.replaceWith(nr);
}

// ---------- Detailansicht ----------
const COLORS = ['#c2410c', '#7c3aed', '#0891b2', '#a16207', '#be185d', '#4d7c0f', '#475569'];

function chart(hist) {
  const own = { name: state.data.own.name, color: 'var(--petrol)', pts: hist.own, w: 3 };
  const others = hist.series.map((x, i) => ({ name: x.name, color: COLORS[i % COLORS.length], pts: x.points, w: 2 }));
  const all = [own, ...others].filter((x) => x.pts.length);
  const pts = all.flatMap((x) => x.pts.map((p) => ({ t: Date.parse(p.at), v: p.price })));
  if (!pts.length) return h('p', { class: 'pmeta' }, 'Noch kein Preisverlauf vorhanden.');
  const maxLabel = Math.max(...pts.map((p) => eur.format(p.v).length));
  const W = 516, H = 190, L = Math.max(52, maxLabel * 6.6 + 8), R = 10, T = 10, B = 24;
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

async function openDrawer(id, given = null, section = null) {
  state.selected = id;
  const d = state.data;
  const el = document.getElementById('drawer');
  el.hidden = false;
  if (!given) el.replaceChildren(h('div', { class: 'drawer-top' }, h('button', { class: 'btn small close', onclick: closeDrawer, 'aria-label': 'Detailansicht schließen' }, 'Schließen')), miniRadar('Artikel wird geladen', { small: true }));
  document.body.classList.add('drawer-open');
  const p = given ?? await api(`/api/products/${id}`).catch((e) => { toast(e.message, true); return null; });
  if (!p || state.selected !== id) return;
  const a = analyse(p, d.competitors);
  const statusText = { ok: 'bestätigt', review: 'bitte prüfen', not_found: 'nicht gefunden', nourl: 'URL fehlt', pending: 'ausstehend', blocked: 'durch robots.txt gesperrt', error: 'Fehler' };
  const histBox = h('div', {}, h('p', { class: 'pmeta' }, 'Verlauf wird geladen …'));
  const reloadDrawer = async () => { const np = await api(`/api/products/${id}`); replaceRow(np); openDrawer(id, np); };

  el.replaceChildren(
    h('div', { class: 'drawer-top' }, h('button', { class: 'btn small close', onclick: closeDrawer, 'aria-label': 'Detailansicht schließen' }, 'Schließen')),
    h('h2', {}, p.name),
    h('p', { class: 'pmeta' }, [p.manufacturer, `Art.-Nr. ${p.number}`, p.mpn && `HAN ${p.mpn}`, p.ean && `EAN ${p.ean}`].filter(Boolean).join(' · ')),
    p.offline_since ? h('p', { class: 'note warn' }, `Bei dir offline: seit ${dt.format(new Date(p.offline_since))} nicht mehr in deiner Sitemap bzw. nicht erreichbar. Der Artikel bleibt mit seinen Daten erhalten und wird bei Mitbewerbern nicht mehr automatisch abgefragt.`) : null,
    h('div', { class: 'row', style: 'margin:10px 0 4px' },
      h('strong', {}, `${d.own.name}: ${p.price != null ? eur.format(p.price) : '–'}`),
      p.purchase_price > 0 ? h('span', { class: 'pmeta' }, `EK ${eur.format(p.purchase_price)} netto`) : null,
      p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, 'im Shop öffnen') : null,
      h('span', { class: 'spacer' }),
      pinButton(p, true),
      checkButton(p.id, 'Jetzt alle Mitbewerber prüfen')),
    econLine(p),
    p.tracked && !p.offline_since && p.tier ? h('p', { class: 'pmeta tierline' }, p.tier === 'A'
      ? `Abfrage bei Mitbewerbern: täglich, weil ${p.tier_reason || 'von Hand gesetzt'}.`
      : `Abfrage bei Mitbewerbern: alle ${state.data.tiers?.bDays ?? 4} Tage (keine Verkäufe, Preisbewegung oder Google-Nachfrage erfasst).`) : null,
    p.g?.advice.length ? h('div', { class: 'note gnote' }, h('strong', {}, 'Bei Google: '), h('ul', { class: 'todo' }, p.g.advice.map((x) => h('li', { class: x.kind }, x.text)))) : null,
    contextBox(p.id),
    p.google?.suggested && Math.abs(p.google.suggested - p.price) >= 0.01 ? h('p', { class: 'note' }, `Google-Preisvorschlag: ${eur.format(p.google.suggested)}${p.google.conversions_change != null ? `, erwartet ${p.google.conversions_change > 0 ? '+' : ''}${Math.round(p.google.conversions_change * 100)} % Verkäufe in Shopping` : ''}.`) : null,
    secHead('preise', 'Preisverlauf'), histBox,
    secHead('kanal', 'Preise je Kanal', d.config.ebay ? ['eBay', 'ebay'] : null), channelBox(p),
    secHead('google', 'Bei Google (letzte 28 Tage)', d.config.gsc ? ['Sichtbarkeit', 'sichtbarkeit'] : null), seoDrawerBox(p.id),
    secHead('keywords', 'Keywords', ['Keyword-Monitoring', 'keywords']), keywordBox(p),
    p.url ? [secHead('seo', 'Seiten-Check (SEO)', ['Seiten-Check', 'seitencheck']), seoAuditBox(p.id)] : null,
    secHead('mitbewerber', 'Mitbewerber'),
    ...a.cells.map(({ c, m }) => {
      const input = h('input', { type: 'url', placeholder: 'https://… (Produktseite beim Mitbewerber)', value: m?.url ?? '', 'aria-label': `Produkt-URL bei ${c.name}` });
      const missing = !m || !['ok', 'review'].includes(m.status);
      return h('div', { class: `mrow${missing ? ' missing' : ''}` },
        h('div', { class: 'line' }, h('strong', {}, c.name),
          h('span', { class: `tag ${m?.status === 'ok' ? 'mute' : m?.status === 'error' || m?.status === 'blocked' ? 'err' : m?.status === 'review' ? '' : 'mute'}` }, statusText[m?.status] ?? 'ausstehend'),
          m?.source === 'manual' ? h('span', { class: 'tag mute' }, 'manuell hinterlegt') : null,
          h('span', { class: 'p' }, m?.price != null && (m.status === 'ok' || m.status === 'review') ? eur.format(m.price) : '')),
        m?.title ? h('div', { class: 'pmeta' }, m.title) : null,
        m?.error ? h('div', { class: 'pmeta' }, m.error) : null,
        m?.ai_note ? h('div', { class: 'pmeta' }, m.ai_note) : null,
        m?.checked ? h('div', { class: 'pmeta' }, `Geprüft ${dt.format(new Date(m.checked))}`) : null,
        h('div', { class: 'searchrow' }, h('span', { class: 'pmeta' }, 'Im Shop suchen:'),
          searchTerms(p).map(([label, term]) => h('a', { class: 'btn small', href: shopSearchUrl(c, term), target: '_blank', rel: 'noopener noreferrer', title: term }, label))),
        h('label', { class: 'pmeta', style: 'display:block;margin-top:8px' }, missing ? 'Gefunden? Link zur Produktseite hier einfügen:' : 'Produktseite (bei Bedarf korrigieren):'),
        input,
        h('div', { class: 'row', style: 'margin-top:8px' },
          m?.url ? h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, 'Seite öffnen') : null,
          h('span', { class: 'spacer' }),
          m?.status === 'review' ? [
            h('button', { class: 'btn small', onclick: guard(async () => { await api(`/api/matches/${m.id}/confirm`, { method: 'POST', body: {} }); await reloadDrawer(); }) }, 'Passt'),
            h('button', { class: 'btn small danger', onclick: guard(async () => { await api(`/api/matches/${m.id}/reject`, { method: 'POST', body: {} }); await reloadDrawer(); }) }, 'Passt nicht'),
          ] : null,
          h('button', { class: 'btn small primary', onclick: guard(async () => {
            await api('/api/matches', { method: 'PUT', body: { product_id: p.id, competitor_id: c.id, url: input.value } });
            toast(input.value ? 'Link gespeichert, Preis wird abgerufen' : 'Zuordnung zurückgesetzt');
            setTimeout(guard(reloadDrawer), 4000);
            await reloadDrawer();
          }) }, input.value ? 'Link speichern' : 'Link speichern')));
    }));
  if (section) setTimeout(() => document.getElementById(`sec-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 350);
  try {
    histBox.replaceChildren(chart(await api(`/api/products/${id}/history`)));
  } catch (e) {
    histBox.replaceChildren(h('p', { class: 'pmeta' }, e.message));
  }
}
/** Überschrift eines Abschnitts in der Detailansicht, mit Sprung in den passenden Bereich. */
function secHead(key, title, link = null) {
  return h('div', { class: 'sechd', id: `sec-${key}` }, h('h3', {}, title),
    link ? h('button', { class: 'linkbtn', onclick: () => setTab(link[1]) }, `${link[0]} öffnen`) : null);
}

const fmtPos = (v) => nf1.format(v);
/**
 * Signale eines Artikels aus allen Bereichen als kleine Chips. Ein Klick öffnet die Detailansicht direkt beim
 * passenden Abschnitt. omit: Signale, die in der jeweiligen Liste schon als Spalte stehen.
 */
function sigChips(id, sig, { omit = [] } = {}) {
  if (!sig) return null;
  const go = (sec) => (e) => { e.stopPropagation(); openDrawer(id, null, sec); };
  const chip = (cls, text, sec, title = '') => h('button', { class: `sig ${cls}`, title, onclick: go(sec) }, text);
  const out = [];
  const pr = sig.price;
  if (!omit.includes('price') && pr) {
    if (pr.kind === 'cheapest') out.push(chip('good', 'günstigster', 'mitbewerber', pr.competitor ? `Günstigster vor ${pr.competitor}` : ''));
    else if (pr.kind === 'undercut') out.push(chip('bad', `+${nf1.format(pr.gap_pct)} % Preis`, 'mitbewerber', `${pr.competitor} ist günstiger (${eur.format(pr.min)})`));
    if (pr.oos) out.push(chip('good', `${pr.oos}× Mitbewerber ausverkauft`, 'mitbewerber'));
  }
  if (!omit.includes('sales') && sig.sales) out.push(chip('', `${nf.format(sig.sales.units_90)} verkauft`, 'kanal', 'Verkäufe der letzten 90 Tage (Shopware)'));
  if (!omit.includes('gsc') && sig.gsc) out.push(chip(sig.gsc.position <= 3 ? 'good' : sig.gsc.position <= 10 ? 'cool' : 'warn', `Google ${fmtPos(sig.gsc.position)} · ${nf.format(sig.gsc.impressions)} Impr.`, 'google', 'Ø Position und Impressionen der letzten 28 Tage'));
  if (!omit.includes('keywords') && sig.keywords) out.push(chip(sig.keywords.best <= 3 ? 'good' : sig.keywords.best <= 10 ? 'cool' : 'warn', `${sig.keywords.count} Keyword${sig.keywords.count > 1 ? 's' : ''} · bester Platz ${sig.keywords.best}`, 'keywords', `Bestes Keyword: ${sig.keywords.best_keyword}`));
  if (!omit.includes('audit') && sig.audit) out.push(sig.audit.errors ? chip('bad', `${sig.audit.errors} SEO-Fehler`, 'seo', sig.audit.top ?? '') : sig.audit.warns ? chip('warn', `${sig.audit.warns} SEO-Warnung${sig.audit.warns > 1 ? 'en' : ''}`, 'seo', sig.audit.top ?? '') : chip('good', 'SEO ok', 'seo'));
  if (!omit.includes('ebay') && sig.ebay) {
    const e = sig.ebay;
    if (e.listed) out.push(chip(e.market_min != null && e.price > e.market_min + 0.01 ? 'warn' : 'good', `eBay ${eur.format(e.price)}${e.market_min != null && e.price > e.market_min + 0.01 ? ` (ab ${eur.format(e.market_min)})` : ''}`, 'kanal'));
    else if (e.market_min != null) out.push(chip('', `eBay ab ${eur.format(e.market_min)}`, 'kanal', `${e.offers} Angebote auf eBay, du bist dort nicht`));
    if (e.pending_jtl) out.push(chip('warn', 'JTL-Übernahme offen', 'kanal'));
  }
  return out.length ? h('div', { class: 'sigs' }, out) : null;
}

/** Auf einen Blick und Chancen eines Artikels (aus allen Bereichen). */
function contextBox(id) {
  const box = h('div', { class: 'ctxbox' });
  api(`/api/products/${id}/context`).then((r) => {
    box.replaceChildren(
      sigChips(id, r.signals),
      r.opportunities.length ? h('div', { class: 'note chancen', id: 'sec-chancen' }, h('strong', {}, 'Chancen: '),
        h('ul', { class: 'todo' }, r.opportunities.map((o) => h('li', { class: o.tone === 'bad' ? 'price' : o.tone === 'warn' ? 'snippet' : 'content' }, h('b', {}, o.label), `: ${o.detail}. `, h('span', { class: 'pmeta' }, o.action),
          o.type === 'ebay_missing' && state.data.config.ebayConnected ? [' ', h('button', { class: 'linkbtn', onclick: () => openListingEditor(id) }, 'einstellen')] : null)))) : null);
  }).catch(() => box.replaceChildren());
  return box;
}

/** Keywords, mit denen die Seite rankt, und Suchanfragen aus der Search Console zum Übernehmen. */
function keywordBox(p) {
  const box = h('div', { class: 'kwbox' }, h('p', { class: 'pmeta' }, 'Wird geladen …'));
  Promise.all([api(`/api/products/${p.id}/context`), p.url ? api(`/api/products/${p.id}/seo`) : Promise.resolve({ queries: [] })]).then(([ctx, seo]) => {
    const tracked = new Set(ctx.keywords.map((k) => k.keyword.toLowerCase()));
    const cand = (seo.queries ?? []).filter((q) => !tracked.has(q.query.toLowerCase())).slice(0, 5);
    box.replaceChildren(
      ctx.keywords.length ? h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, ['Keyword', 'Platz', 'Suchvolumen'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ctx.keywords.map((k) => h('tr', {}, h('td', {}, k.keyword), h('td', {}, h('span', { class: `gpill ${gTone(k.position)}` }, String(k.position))), h('td', {}, k.volume != null ? nf.format(k.volume) : '–')))))
        : h('p', { class: 'pmeta' }, 'Kein beobachtetes Keyword rankt mit dieser Seite.'),
      cand.length ? h('div', { style: 'margin-top:8px' }, h('span', { class: 'pmeta' }, 'Aus der Search Console beobachten: '),
        cand.map((q) => h('button', { class: 'chip', title: `${nf.format(q.impressions)} Impressionen, Ø Platz ${nf1.format(q.position)}`, onclick: guard(async (e) => {
          const r = await api('/api/keywords', { body: { keywords: q.query, source: 'suggestion' } });
          toast(r.added ? `„${q.query}“ wird beobachtet` : 'Schon beobachtet');
          e.target.closest('button').disabled = true;
        }) }, `+ ${q.query}`))) : null);
  }).catch((e) => box.replaceChildren(h('p', { class: 'pmeta' }, e.message)));
  return box;
}

function closeDrawer() { state.selected = null; document.getElementById('drawer').hidden = true; document.body.classList.remove('drawer-open'); }
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

/** Tempo eines Mitbewerbers: Prüfungen in 24 Stunden, Bremse durch robots.txt oder Überlastung, Schätzung pro Stunde. */
function tempoHint(c) {
  if (!c) return 'Wartezeit zwischen zwei Seitenaufrufen beim selben Shop. Kürzer = schneller, aber mehr Last für den Shop. Mindestens 1000.';
  const pace = c.pace ?? {};
  const eff = Math.max(c.delay_ms, (pace.crawl_delay_s ?? 0) * 1000) * (pace.factor ?? 1);
  const perHour = Math.round(3600 / (eff * 1.25 / 1000 + 1.2)); // Pause mit Streuung plus typische Ladezeit
  return [
    `Etwa ${nf.format(perHour)} Seitenaufrufe pro Stunde${c.checked_24h != null ? `, in den letzten 24 Stunden ${nf.format(c.checked_24h)} Artikel geprüft` : ''}.`,
    pace.crawl_delay_s ? `Der Shop verlangt in seiner robots.txt mindestens ${nf1.format(pace.crawl_delay_s)} s Abstand, daran hält sich Preisradar.` : null,
    pace.factor > 1 ? `Gerade gebremst (${nf1.format(pace.factor)}-facher Abstand), weil der Shop überlastet war oder abgelehnt hat.` : null,
  ].filter(Boolean).join(' ');
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
      h('div', { class: 'field' }, h('label', {}, 'Suchlink für dich'),
        h('input', { name: 'manual_search_url', value: c?.manual_search_url ?? '', placeholder: 'https://…/search?search={q}' }),
        h('span', { class: 'hint' }, 'Öffnest du selbst im Browser („suchen“ bei nicht gefundenen Artikeln). {q} = Suchbegriff. Leer: Such-URL oder Google-Suche auf dieser Seite.'),
        c ? h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: guard(async () => {
          const r = await api(`/api/competitors/${c.id}/search-link/detect`, { method: 'POST', body: {} });
          if (r.link) { form.elements.manual_search_url.value = r.link; toast('Suchlink erkannt und gespeichert'); } else toast('Kein Suchlink auf der Startseite gefunden', true);
        }) }, 'Suchlink erkennen')) : null),
      f('Ergebnis-Selektor (optional)', 'result_selector', c?.result_selector, { ph: 'a.product-name', hint: 'CSS-Selektor der Produktlinks auf der Suchseite' }),
      f('Preis-Selektor (optional)', 'price_selector', c?.price_selector, { ph: '.product-detail-price', hint: 'Nur nötig, wenn der Preis nicht automatisch erkannt wird' }),
      f('Pause zwischen Abrufen (ms)', 'delay_ms', c?.delay_ms ?? 3000, { type: 'number', hint: tempoHint(c) }),
      h('div', { class: 'field', style: 'grid-column:1/-1' }, h('label', {}, 'Sitemap-URLs (optional, eine pro Zeile)'),
        h('textarea', { name: 'sitemap_url', rows: 2, placeholder: 'https://www.beispiel-shop.de/sitemap/Sitemap_item.xml' }, c?.sitemap_url ?? ''),
        h('span', { class: 'hint' }, 'Für Shops, deren Suche gesperrt oder nicht auslesbar ist: Produkte werden über die URLs der Sitemap (Marke und Name) gefunden. Die Sitemap wird wöchentlich neu eingelesen.'),
        c ? h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: guard(async () => {
          const r = await api(`/api/competitors/${c.id}/sitemap/refresh`, { method: 'POST', body: {} });
          const bad = r.report.filter((x) => x.error);
          sm.textContent = `${r.count.toLocaleString('de-DE')} URLs eingelesen${bad.length ? ` · Fehler: ${bad.map((x) => `${x.url.split('/').pop()} (${x.error})`).join(', ')}` : ''}`;
          toast(r.count ? 'Sitemap eingelesen' : 'Keine URLs gefunden', !r.count);
        }) }, 'Sitemap jetzt einlesen'), sm) : null,
        h('div', { class: 'row' }, discoverBtn(() => form.elements.base_url.value, form.elements.sitemap_url ? () => form.elements.sitemap_url : () => null)),
        c?.sitemap_count ? categoryPicker(c) : null),
      c ? templateList(c) : null,
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

/** Von der KI gelernte Abruf-Vorlagen (Preis-Selektoren) eines Mitbewerbers. */
function templateList(c) {
  let list = [];
  try { list = JSON.parse(c.templates || '[]'); } catch { /* leer */ }
  const box = h('div', { class: 'field', style: 'grid-column:1/-1' }, h('label', {}, 'Abruf-Vorlagen'));
  const draw = () => box.replaceChildren(h('label', {}, 'Abruf-Vorlagen'),
    list.length
      ? h('ul', { class: 'tpls' }, list.map((t) => h('li', {},
        h('code', { translate: 'no' }, t.selector),
        h('span', { class: 'pmeta' }, `${t.hits} Treffer${t.fails ? `, ${t.fails} ohne Preis` : ''}${t.source === 'ki' ? ', von der KI gelernt' : ''}`),
        h('button', { class: 'linkbtn', type: 'button', onclick: guard(async () => { const r = await api(`/api/competitors/${c.id}/templates`, { method: 'DELETE', body: { selector: t.selector } }); list = r.templates; draw(); toast('Vorlage entfernt'); }) }, 'entfernen'))))
      : h('span', { class: 'hint' }, 'Noch keine. Findet die KI auf einer Seite den Preis, merkt sich Preisradar, wo er steht, und liest alle weiteren Seiten dieses Shops ohne KI.'));
  draw();
  return box;
}

/** Kategorien der Sitemap als Mehrfachauswahl: gesucht wird nur in den gewählten Kategorien. */
function categoryPicker(c) {
  const sel0 = (() => { try { return JSON.parse(c.sitemap_categories || '[]'); } catch { return []; } })();
  const box = h('div', { class: 'catbox' });
  const det = h('details', { class: 'cats' }, h('summary', {}, sel0.length ? `Kategorien: ${sel0.length} ausgewählt` : 'Kategorien eingrenzen (derzeit alle)'), box);
  let loaded = false;
  det.addEventListener('toggle', guard(async () => {
    if (!det.open || loaded) return;
    loaded = true;
    box.replaceChildren(h('p', { class: 'pmeta' }, 'Kategorien werden ermittelt …'));
    const r = await api(`/api/competitors/${c.id}/categories`);
    const chosen = new Set(r.selected);
    if (!r.categories.length) { box.replaceChildren(h('p', { class: 'pmeta' }, 'In den URLs dieser Sitemap stehen keine Kategorien.')); return; }
    const info = h('p', { class: 'pmeta' });
    const count = () => {
      const inSel = (path) => [...chosen].some((x) => (x === '' ? path === '' : path === x || path.startsWith(x + '/')));
      const n = r.categories.filter((k) => k.level === 1 && inSel(k.path)).reduce((s, k) => s + k.count, 0) + (chosen.has('') ? r.root : 0);
      const sub = r.categories.filter((k) => k.level === 2 && chosen.has(k.path) && !chosen.has(k.path.split('/')[0])).reduce((s, k) => s + k.count, 0);
      info.textContent = chosen.size ? `${chosen.size} ausgewählt, rund ${(n + sub).toLocaleString('de-DE')} von ${r.total.toLocaleString('de-DE')} URLs werden durchsucht.` : `Nichts ausgewählt: alle ${r.total.toLocaleString('de-DE')} URLs werden durchsucht.`;
    };
    const q = h('input', { type: 'search', placeholder: 'Kategorie suchen', 'aria-label': 'Kategorie suchen' });
    const items = [...r.categories, ...(r.root ? [{ path: '', count: r.root, level: 1 }] : [])].map((k) => {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(k.path), onchange: (e) => { if (e.target.checked) chosen.add(k.path); else chosen.delete(k.path); count(); } });
      const label = k.path === '' ? 'ohne Kategorie (direkt unter der Domain)' : k.path.split('/').pop().replace(/-/g, ' ');
      return { k, el: h('label', { class: `catitem l${k.level}`, title: '/' + k.path }, cb, h('span', {}, label), h('small', {}, k.count.toLocaleString('de-DE'))) };
    });
    const listEl = h('div', { class: 'catlist' }, items.map((x) => x.el));
    q.addEventListener('input', () => { const t = q.value.toLowerCase(); for (const x of items) x.el.hidden = Boolean(t) && !x.k.path.includes(t); });
    count();
    box.replaceChildren(
      r.flat ? h('p', { class: 'note warn' }, 'Bei diesem Shop liegen die meisten Produkt-URLs ohne Kategorie direkt unter der Domain. Eine Auswahl bringt hier wenig, gefiltert wird ohnehin über die Marke deiner Artikel.') : null,
      h('div', { class: 'row' }, q, h('button', { class: 'linkbtn', type: 'button', onclick: () => { chosen.clear(); for (const x of items) x.el.querySelector('input').checked = false; count(); } }, 'Auswahl leeren')),
      listEl, info,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn small primary', type: 'button', onclick: guard(async () => {
        const res = await api(`/api/competitors/${c.id}/categories`, { method: 'PUT', body: { categories: [...chosen] } });
        det.querySelector('summary').textContent = res.selected.length ? `Kategorien: ${res.selected.length} ausgewählt` : 'Kategorien eingrenzen (derzeit alle)';
        toast('Kategorien gespeichert');
      }) }, 'Kategorien speichern')));
  }));
  return det;
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

function googleCompetitorsPanel() {
  const box = h('div', { class: 'panel', hidden: true });
  if (!state.data.config.merchant) return box;
  api('/api/merchant').then((mc) => {
    const list = mc.competitors.filter((c) => !c.known);
    if (!mc.competitors.length) return;
    box.hidden = false;
    box.replaceChildren(h('h3', {}, 'Weitere Mitbewerber laut Google'),
      h('p', { class: 'sub' }, 'Shops, die in deinen Kategorien bei Google Shopping sichtbar sind (Merchant Center, Wettbewerbsübersicht). Überschneidung: Anteil der Suchen, bei denen ihr beide erscheint. Öfter vor dir: Anteil, bei dem dieser Shop höher steht.'),
      list.length ? h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, ['Shop', 'Überschneidung', 'Öfter vor dir', 'Sichtbarkeit', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, list.slice(0, 20).map((c) => h('tr', {},
          h('td', {}, h('a', { href: `https://${c.domain}`, target: '_blank', rel: 'noopener noreferrer' }, c.domain)),
          h('td', {}, c.overlap != null ? `${nf.format(Math.round(c.overlap * 100))} %` : '–'),
          h('td', {}, c.higher != null ? `${nf.format(Math.round(c.higher * 100))} %` : '–'),
          h('td', {}, c.visibility != null ? nf1.format(c.visibility) : '–'),
          h('td', {}, h('button', { class: 'btn small', onclick: guard(async (e) => {
            e.target.disabled = true; e.target.textContent = 'wird eingerichtet …';
            try { const r = await api('/api/competitors/from-domain', { body: { domain: c.domain } }); toast(`${r.name} angelegt${r.sitemaps.length ? `, ${r.sitemaps.length} Sitemap(s) gefunden` : ', keine Sitemap gefunden'}`); await refresh(); }
            finally { e.target.disabled = false; e.target.textContent = 'Anlegen'; }
          }) }, 'Anlegen')))))) : h('p', { class: 'pmeta' }, 'Alle von Google genannten Shops sind bereits angelegt.'));
  }).catch(() => {});
  return box;
}

function renderCompetitors(root) {
  root.append(h('h2', {}, 'Mitbewerber'),
    h('p', { class: 'sub' }, 'Jeder Mitbewerber braucht eine Such-URL (Suche per EAN oder Herstellernummer) und/oder Sitemap-URLs (Zuordnung über Marke und Name). Alternativ trägst du Produkt-URLs direkt im Import oder in der Detailansicht ein. Die robots.txt der Shops wird immer beachtet.'),
    googleCompetitorsPanel(),
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
        fileButton('Produkt-CSV hochladen', '/api/import/csv', (r) => `${r.created} neu, ${r.updated} aktualisiert${r.purchase_prices ? `, ${r.purchase_prices} Einkaufspreise` : ''}`)),
      h('p', { class: 'pmeta', style: 'margin-top:8px' }, 'CSV-Spalten: Artikelnummer, Name, EAN, Herstellernummer, Hersteller, Preis (brutto), Einkaufspreis (netto), URL. Nur Einkaufspreise nachtragen (z. B. Export aus JTL-Wawi): Artikelnummer und Einkaufspreis genügen.')),
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
    h('p', { class: 'pmeta', style: 'margin-top:8px' }, (d.schedule.mode === 'rolling' ? `Automatischer Abruf verteilt über den Tag: alle Mitbewerber gleichzeitig, jeder Shop mit seinem eigenen Abstand zwischen den Seitenaufrufen. Solange Artikel fällig sind, läuft der Abruf durch; sonst Pause von ${d.schedule.interval} bis ${d.schedule.interval + d.schedule.jitter} Sekunden. Jeder Artikel höchstens alle ${d.schedule.refresh} Stunden.` : `Automatischer Abruf zu festen Zeiten (${d.schedule.hours.map((x) => String(x).padStart(2, '0') + ':00').join(' und ')} Uhr).`) + ' Einstellbar unter Einstellungen → Abrufplan.')));
}

// ---------- Anmeldung ----------
async function showAuth(info) {
  window.__preloaderDone?.();
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
  const [a, imp, opps] = await Promise.all([api('/api/analysis'), api('/api/import/sitemap/status').catch(() => null), api('/api/opportunities').catch(() => null)]);
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
      ? h('h1', {}, h('span', { class: 'hero-n', 'data-count': dearerAny }, dearerAny.toLocaleString('de-DE')), ` von ${k.compared.toLocaleString('de-DE')} verglichenen Artikeln gibt es bei einem Mitbewerber günstiger.`)
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

  const item = (r, main, side) => h('li', { tabindex: 0, onclick: () => openDrawer(r.id), onkeydown: (e) => e.key === 'Enter' && e.currentTarget.click() },
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
      h('td', { class: 'pmeta', title: 'In den letzten 24 Stunden geprüft' }, (() => { const oc = d.competitors.find((x) => x.name === c.name); return oc?.checked_24h != null ? `${nf.format(oc.checked_24h)} in 24 h${oc.pace?.factor > 1 ? ' (gebremst)' : ''}` : ''; })()),
      h('td', { class: 'pmeta' }, c.last_checked ? dt.format(new Date(c.last_checked)) : 'noch nicht geprüft'))))) : h('p', { class: 'list-empty' }, 'Noch kein Mitbewerber angelegt.'));
  const sch = d.schedule;
  const ops = h('section', { class: 'list' },
    h('div', { class: 'list-h' }, h('h3', {}, 'Betrieb'), h('button', { class: 'linkbtn', onclick: () => setTab('import') }, 'Läufe ansehen')),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Abruf'), h('dd', {}, d.scrape.running ? `läuft: ${d.scrape.done} von ${d.scrape.total}` : sch.mode === 'rolling' ? `verteilt, alle Mitbewerber gleichzeitig; solange etwas fällig ist ohne lange Pause, sonst ${sch.interval}–${sch.interval + sch.jitter} s Pause` : `feste Zeiten ${sch.hours.join(', ')} Uhr`),
      tiersFacts(d.tiers, sch),
      h('dt', {}, 'Artikel'), h('dd', {}, `${d.counts.all} gesamt, ${d.counts.tracked} beobachtet`),
      imp?.running ? [h('dt', {}, 'Import'), h('dd', {}, `läuft: ${imp.done} von ${imp.total}`)] : imp?.finishedAt ? [h('dt', {}, 'Letzter Import'), h('dd', {}, `${dt.format(new Date(imp.finishedAt))}, ${imp.created} neu, ${imp.updated} aktualisiert${imp.errors ? `, ${imp.errors} Fehler` : ''}`)] : null,
      h('dt', {}, 'Shopware'), h('dd', {}, d.config.shopware ? (d.config.swSynced ? `Abgleich ${dt.format(new Date(d.config.swSynced))}` : 'verbunden, Abgleich steht aus') : h('button', { class: 'linkbtn', onclick: () => setTab('einstellungen') }, 'noch nicht verbunden (Verkäufe, Einkaufspreise)')),
      h('dt', {}, 'Google'), h('dd', {}, d.config.gsc ? h('button', { class: 'linkbtn', onclick: () => setTab('sichtbarkeit') }, 'Search Console verbunden, zur Sichtbarkeit') : h('button', { class: 'linkbtn', onclick: () => setTab('einstellungen') }, 'Search Console noch nicht verbunden')),
      h('dt', {}, 'E-Mail'), h('dd', {}, h('button', { class: 'linkbtn', onclick: () => { setTab('einstellungen'); setTimeout(() => document.getElementById('mail-settings')?.scrollIntoView({ behavior: 'smooth' }), 500); } }, 'Tägliche Zusammenfassung einstellen')),
      h('dt', {}, 'KI'), h('dd', {}, d.config.ai
        ? [h('div', { class: 'aimeter', title: `${d.config.aiUsage.today} von ${d.config.aiUsage.limit} KI-Anfragen heute` }, h('div', { style: `width:${Math.min(100, (d.config.aiUsage.today / Math.max(1, d.config.aiUsage.limit)) * 100)}%` })),
          `${d.config.aiUsage.today.toLocaleString('de-DE')} von ${d.config.aiUsage.limit.toLocaleString('de-DE')} Anfragen heute${d.config.aiUsage.today >= d.config.aiUsage.limit ? ' (Grenze erreicht, weiter ohne KI)' : ''}`]
        : 'nicht eingerichtet (Regeln und Sitemaps arbeiten trotzdem)')));

  // Wichtigste Chancen aus allen Bereichen (Preis, Google, Seiten-Check, Keywords, eBay, Lager)
  const items = opps?.items ?? [];
  const firstOfType = items.filter((i, n) => items.findIndex((x) => x.type === i.type) === n); // je Art die wertvollste
  const top = [...firstOfType, ...items.filter((i) => !firstOfType.includes(i))].slice(0, 6).sort((x, y) => (y.value ?? 0) - (x.value ?? 0));
  const chancen = opps?.items?.length ? h('section', { class: 'list wide' },
    h('div', { class: 'list-h' }, h('h3', {}, 'Wichtigste Chancen'), h('button', { class: 'linkbtn', onclick: () => setTab('chancen') }, `alle ${nf.format(opps.total ?? opps.items.length)}`)),
    h('p', { class: 'pmeta' }, 'Aus Preisen, Google, Seiten-Check, Keywords, eBay und Lager, nach geschätztem Wert.'),
    h('ol', {}, top.map((i) => h('li', { tabindex: 0, onclick: () => openDrawer(i.product_id, null, 'chancen'), onkeydown: (e) => e.key === 'Enter' && e.currentTarget.click() },
      h('div', { class: 'li-main' }, h('div', { class: 'pname' }, i.name), h('div', { class: 'pmeta' }, i.detail)),
      h('div', { class: 'li-side' }, h('span', { class: `ichip ${i.tone === 'bad' ? 'error' : i.tone === 'warn' ? 'warn' : 'ok'}` }, i.label)))))) : null;

  root.append(hero, gauge,
    a.hints.length ? h('ul', { class: 'hints' }, a.hints.slice(0, 4).map((x) => h('li', { class: x.level }, x.text))) : null,
    chancen, lists, h('div', { class: 'cols two' }, comps, ops));
}

// ---------- Sichtbarkeit (Google Search Console) ----------
const nf = new Intl.NumberFormat('de-DE');
const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const dDay = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });

function delta(cur, prev, { lowerIsBetter = false, unit = '%' } = {}) {
  if (cur == null || prev == null || !prev) return null;
  const ch = unit === '%' ? ((cur - prev) / prev) * 100 : cur - prev;
  if (Math.abs(ch) < 0.05) return h('span', { class: 'kpi-d' }, '± 0');
  const good = lowerIsBetter ? ch < 0 : ch > 0;
  return h('span', { class: `kpi-d ${good ? 'up' : 'down'}` }, `${ch > 0 ? '▲' : '▼'} ${nf1.format(Math.abs(ch))}${unit === '%' ? ' %' : ''} zur Vorperiode`);
}

/** Linien-Diagramm mit Achse, Raster und Tooltip je Punkt (eine Achse, mehrere Reihen). */
function lineChart(series, { height = 220, fmtY = (v) => nf.format(Math.round(v)), fmtX = (t) => dDay.format(new Date(t)), area = false } = {}) {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return h('p', { class: 'pmeta' }, 'Noch keine Daten.');
  const W = 900, H = height, L = 52, R = 12, T = 12, B = 26;
  const xs = all.map((p) => Date.parse(p.date)), ys = all.map((p) => p.value);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  let y0 = Math.min(0, ...ys), y1 = Math.max(...ys);
  if (y1 === y0) y1 = y0 + 1;
  y1 += (y1 - y0) * 0.08;
  const X = (t) => L + ((t - x0) / Math.max(1, x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', class: 'lchart', role: 'img', 'aria-label': series.map((x) => x.name).join(', ') });
  for (let i = 0; i <= 3; i++) {
    const v = y0 + ((y1 - y0) * i) / 3;
    svg.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: 'var(--line)', 'stroke-dasharray': i ? '2 4' : '' }),
      s('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, fmtY(v)));
  }
  const ticks = 5;
  for (let i = 0; i < ticks; i++) {
    const t = x0 + ((x1 - x0) * i) / (ticks - 1);
    svg.append(s('text', { x: X(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle', 'font-size': 11, fill: 'var(--muted)' }, fmtX(t)));
  }
  for (const se of series) {
    const pts = se.points.map((p) => [X(Date.parse(p.date)), Y(p.value)]);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    if (area && pts.length > 1) svg.append(s('path', { d: `${d} L${pts[pts.length - 1][0]},${Y(y0)} L${pts[0][0]},${Y(y0)} Z`, fill: se.color, opacity: 0.12 }));
    svg.append(s('path', { d, fill: 'none', stroke: se.color, 'stroke-width': se.width ?? 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'lpath' }));
    se.points.forEach((p, i) => svg.append(s('circle', { cx: pts[i][0], cy: pts[i][1], r: 8, fill: 'transparent', class: 'hit' },
      s('title', {}, `${se.name} · ${new Date(p.date).toLocaleDateString('de-DE')}: ${fmtY(p.value)}`))));
    const [lx, ly] = pts[pts.length - 1];
    svg.append(s('circle', { cx: lx, cy: ly, r: 3.5, fill: se.color, stroke: 'var(--surface-solid)', 'stroke-width': 1.5 }));
  }
  return h('div', {}, svg, series.length > 1 ? h('div', { class: 'legend' }, series.map((x) => h('span', {}, h('i', { style: `background:${x.color}` }), x.name))) : null);
}

function seoSetupHint() {
  return h('div', { class: 'panel empty' },
    h('h3', {}, 'Google verbinden'),
    h('p', { style: 'max-width:62ch;margin:0 auto 12px' }, 'Mit der Search Console siehst du, wie oft deine Produktseiten bei Google erscheinen und angeklickt werden und wo Preis und Auffindbarkeit nicht zusammenpassen. Mit dem Merchant Center kommen Googles Vergleichspreise, Preisvorschläge und weitere Mitbewerber dazu.'),
    h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn primary', onclick: () => { setTab('einstellungen'); setTimeout(() => document.getElementById('seo-settings')?.scrollIntoView({ behavior: 'smooth' }), 500); } }, 'Zugang einrichten')));
}

function seoSyncBar(o) {
  const st = o.status.gsc, job = o.job;
  return h('div', { class: 'syncbar' },
    h('div', {}, h('b', {}, 'Search Console '), h('span', { class: 'pmeta' }, st.synced_at ? `Stand ${dt.format(new Date(st.synced_at))}, Daten vom ${String(st.range || '').split('|').map((x) => x && new Date(x).toLocaleDateString('de-DE')).join(' bis ')} (${st.site})` : `${st.site}, noch nicht abgeglichen`),
      h('button', { class: 'btn small', disabled: job.running, onclick: guard(async () => { await api('/api/seo/gsc/sync', { method: 'POST', body: {} }); toast('Abgleich gestartet, das dauert einen Moment'); render(); pollSeo(); }) }, job.running ? 'Abgleich läuft …' : 'Jetzt abgleichen')),
    job.error ? h('div', { class: 'warmtxt' }, `Letzter Abgleich fehlgeschlagen: ${job.error}`) : null);
}
let seoPoll;
function pollSeo() {
  clearInterval(seoPoll);
  seoPoll = setInterval(guard(async () => {
    const o = await api('/api/seo');
    if (!o.job.running) { clearInterval(seoPoll); if (state.tab === 'sichtbarkeit') render(); toast(o.job.error ? `Abgleich fehlgeschlagen: ${o.job.error}` : 'Abgleich fertig', Boolean(o.job.error)); }
  }), 4000);
}

async function renderSeo(root) {
  const [o, mc] = await Promise.all([api('/api/seo'), api('/api/merchant')]);
  root.append(h('div', { class: 'pagehead' }, h('h2', {}, 'Sichtbarkeit')),
    h('p', { class: 'sub' }, 'Wie gut deine Artikel bei Google gefunden werden und wie deine Preise im Google-Shopping-Vergleich stehen.'));
  if (!o.status.gsc.configured && !mc.configured) { root.append(seoSetupHint()); return; }
  root.append(h('div', { class: 'panel head' },
    h('div', {}, h('strong', {}, 'Je Artikel ansehen: '), 'Die Preisliste hat eine eigene Ansicht mit Google-Platz, Klickpotenzial und Hinweisen, was zu tun ist.'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn primary', onclick: () => { state.view = 'google'; try { localStorage.setItem('pr_view', 'google'); } catch { /* egal */ } Object.assign(state, { sort: 'potential', dir: 'desc', filter: 'gAdvice' }); setTab('preise'); } }, 'Artikel mit Handlungsbedarf')));
  if (o.status.gsc.configured) renderGsc(root, o);
  if (mc.configured) renderMerchant(root, mc);
}

function renderMerchant(root, mc) {
  const pctTxt = (f) => (f == null ? '' : `${f > 0 ? '+' : ''}${nf.format(Math.round(f * 100))} %`);
  root.append(h('h3', { class: 'sechead' }, 'Google Shopping (Merchant Center)'),
    h('div', { class: 'syncbar' }, h('div', {}, h('b', {}, 'Merchant Center '), h('span', { class: 'pmeta' }, mc.synced_at ? `Konto ${mc.account}, Stand ${dt.format(new Date(mc.synced_at))}, ${nf.format(mc.offers)} Angebote, davon ${nf.format(mc.matched)} deinen Artikeln zugeordnet` : `Konto ${mc.account}, noch nicht abgeglichen`),
      h('button', { class: 'btn small', disabled: mc.job.running, onclick: guard(async () => { await api('/api/merchant/sync', { method: 'POST', body: {} }); toast('Abgleich gestartet'); render(); const t = setInterval(guard(async () => { const x = await api('/api/merchant'); if (!x.job.running) { clearInterval(t); toast(x.job.error ? `Fehlgeschlagen: ${x.job.error}` : 'Merchant Center abgeglichen', Boolean(x.job.error)); if (state.tab === 'sichtbarkeit') render(); } }), 4000); }) }, mc.job.running ? 'Abgleich läuft …' : 'Jetzt abgleichen')),
      mc.job.error ? h('div', { class: 'warmtxt' }, `Letzter Abgleich: ${mc.job.error}`) : null,
      mc.job.result?.warnings?.length ? h('div', { class: 'pmeta' }, `Hinweise: ${mc.job.result.warnings.join(' · ')}`) : null));
  if (!mc.offers) { root.append(h('p', { class: 'pmeta' }, 'Noch keine Daten aus dem Merchant Center.')); return; }
  const b = mc.benchmark;
  root.append(h('div', { class: 'kpis' },
    kpiTile('Mit Google-Vergleichspreis', h('span', { 'data-count': b.total }, nf.format(b.total)), 'Artikel, für die Google einen Marktpreis kennt'),
    kpiTile('Über dem Vergleichspreis', h('span', { 'data-count': b.above }, nf.format(b.above)), 'mehr als 2 % teurer', b.above ? 'warm' : ''),
    kpiTile('Unter dem Vergleichspreis', h('span', { 'data-count': b.below }, nf.format(b.below)), 'mehr als 2 % günstiger', 'cool')));
  const open = (id) => () => openDrawer(id);
  root.append(h('div', { class: 'grid2 eq' },
    h('div', { class: 'panel flush' },
      h('div', { class: 'panelhead' }, h('h3', {}, 'Über dem Google-Vergleichspreis'), h('p', { class: 'pmeta' }, 'Google vergleicht mit allen Händlern, die dasselbe Produkt in Shopping anbieten, auch mit solchen, die du noch nicht beobachtest.')),
      mc.above_benchmark.length ? h('div', { class: 'tablewrap', style: 'max-height:460px' }, h('table', { class: 'prices', style: 'min-width:0' },
        h('thead', {}, h('tr', {}, ['Artikel', 'Dein Preis', 'Vergleichspreis', 'Abstand'].map((t, i) => h('th', { class: i === 0 ? 'prod' : '' }, t)))),
        h('tbody', {}, mc.above_benchmark.map((r) => h('tr', { onclick: open(r.id) },
          h('td', { class: 'prod' }, h('div', { class: 'pname' }, r.name), h('div', { class: 'pmeta' }, r.number)),
          h('td', {}, eur.format(r.own_price)), h('td', {}, eur.format(r.benchmark)), h('td', { class: 'gap bad' }, fmtPct(r.gap_percent))))))) : h('p', { class: 'list-empty', style: 'padding:0 16px 14px' }, 'Kein Artikel deutlich über dem Vergleichspreis.')),
    h('div', { class: 'panel flush' },
      h('div', { class: 'panelhead' }, h('h3', {}, 'Preisvorschläge von Google'), h('p', { class: 'pmeta' }, 'Googles Schätzung, wie sich ein anderer Preis auf Klicks und Verkäufe in Shopping auswirkt. Marge vorher prüfen.')),
      mc.suggestions.length ? h('div', { class: 'tablewrap', style: 'max-height:460px' }, h('table', { class: 'prices', style: 'min-width:0' },
        h('thead', {}, h('tr', {}, ['Artikel', 'Dein Preis', 'Vorschlag', 'Klicks', 'Verkäufe'].map((t, i) => h('th', { class: i === 0 ? 'prod' : '' }, t)))),
        h('tbody', {}, mc.suggestions.map((r) => h('tr', { onclick: open(r.id) },
          h('td', { class: 'prod' }, h('div', { class: 'pname' }, r.name), h('div', { class: 'pmeta' }, [r.number, r.effectiveness ? `Wirkung: ${{ HIGH: 'hoch', MEDIUM: 'mittel', LOW: 'gering' }[r.effectiveness] ?? r.effectiveness}` : null].filter(Boolean).join(' · '))),
          h('td', {}, eur.format(r.own_price)), h('td', { style: 'font-weight:700' }, eur.format(r.suggested)),
          h('td', { class: r.clicks_change > 0 ? 'cooltxt' : '' }, pctTxt(r.clicks_change)), h('td', { class: r.conversions_change > 0 ? 'cooltxt' : '' }, pctTxt(r.conversions_change))))))) : h('p', { class: 'list-empty', style: 'padding:0 16px 14px' }, 'Derzeit keine Vorschläge.'))));
  if (mc.competitors.length) root.append(h('p', { class: 'pmeta', style: 'margin-top:12px' }, `${mc.competitors.filter((c) => !c.known).length} weitere Shops sind in deinen Kategorien bei Google sichtbar. `, h('button', { class: 'linkbtn', onclick: () => setTab('mitbewerber') }, 'Unter Mitbewerber ansehen')));
}

function renderGsc(root, o) {
  root.append(seoSyncBar(o));
  if (o.job.running && !o.daily.length) pollSeo();
  if (!o.daily.length) { root.append(h('p', { class: 'pmeta' }, 'Noch keine Daten aus der Search Console. Der erste Abgleich läuft automatisch nach dem Einrichten oder über „Jetzt abgleichen“.')); return; }
  const k = o.kpi;
  root.append(h('div', { class: 'kpis' },
    kpiTile('Klicks', h('span', { 'data-count': Math.round(k.clicks) }, nf.format(k.clicks)), delta(k.clicks, k.clicks_prev), 'cool'),
    kpiTile('Impressionen', h('span', { 'data-count': Math.round(k.impressions) }, nf.format(k.impressions)), delta(k.impressions, k.impressions_prev)),
    kpiTile('Klickrate', k.ctr == null ? '–' : `${nf1.format(k.ctr)} %`, 'Klicks je Impression'),
    kpiTile('Ø Position', k.position == null ? '–' : nf1.format(k.position), delta(k.position, k.position_prev, { lowerIsBetter: true, unit: '' })),
    kpiTile('Produktseiten mit Daten', h('span', { 'data-count': o.coverage.with_data }, nf.format(o.coverage.with_data)), `von ${nf.format(o.coverage.product_pages)} Artikeln mit Shop-URL`)));
  root.append(h('div', { class: 'panel' }, h('h3', {}, 'Klicks pro Tag'), h('p', { class: 'pmeta' }, 'Letzte 90 Tage (Google liefert die Daten mit 2 bis 3 Tagen Verzögerung)'),
    lineChart([{ name: 'Klicks', color: 'var(--petrol)', points: o.daily.map((d) => ({ date: d.date, value: d.clicks })), width: 2.5 }], { area: true })));

  // Chancen aus Preis und Suche
  const op = o.opportunities;
  if (op.available) {
    root.append(h('h3', { class: 'sechead' }, 'Chancen aus Preis und Suche'),
      h('div', { class: 'cols four' }, op.groups.map((g) => h('section', { class: `list opp ${g.tone}` },
        h('div', { class: 'list-h' }, h('h3', {}, g.title), h('span', { class: 'pmeta' }, String(g.items.length))),
        h('p', { class: 'pmeta' }, g.hint),
        g.items.length ? h('ol', {}, g.items.slice(0, 8).map((r) => h('li', { tabindex: 0, onclick: () => openDrawer(r.id), onkeydown: (e) => e.key === 'Enter' && e.currentTarget.click() },
          h('div', { class: 'li-main' }, h('div', { class: 'pname' }, r.name), h('div', { class: 'pmeta' }, r.why), sigChips(r.id, r.sig, { omit: ['gsc', 'price'] })),
          h('div', { class: 'li-side' }, h('div', { class: `fig ${r.gap_percent > 2 ? 'warm' : r.gap_percent <= 0 ? 'cool' : ''}` }, fmtPct(r.gap_percent)), h('div', { class: 'pmeta' }, eur.format(r.own_price))))))
          : h('p', { class: 'list-empty' }, 'Derzeit nichts.')))));
  } else root.append(h('p', { class: 'pmeta' }, 'Chancen erscheinen, sobald Suchdaten zu beobachteten Artikeln mit Vergleichspreisen vorliegen. Dafür brauchen deine Artikel eine Shop-URL (eigene Sitemap unter Einstellungen).'));

  const posBadge = (p) => h('span', { class: `posbadge ${p <= 3 ? 'cool' : p <= 10 ? 'near' : 'warm'}` }, nf1.format(p));
  root.append(h('div', { class: 'grid2 eq' },
    h('div', { class: 'panel flush' },
      h('div', { class: 'panelhead' }, h('h3', {}, 'Produktseiten'), h('p', { class: 'pmeta' }, 'Nach Klicks. Klick öffnet den Artikel.')),
      h('div', { class: 'tablewrap', style: 'max-height:560px' }, h('table', { class: 'prices', style: 'min-width:0' },
        h('thead', {}, h('tr', {}, ['Artikel', 'Klicks', 'Impr.', 'CTR', 'Pos.'].map((t, i) => h('th', { class: i === 0 ? 'prod' : '' }, t)))),
        h('tbody', {}, o.pages.map((p) => h('tr', { onclick: () => openDrawer(p.product.id) },
          h('td', { class: 'prod' }, h('div', { class: 'pname' }, p.product.name), h('div', { class: 'pmeta' }, [p.product.price != null ? eur.format(p.product.price) : null, p.product.offline ? 'bei dir offline' : null].filter(Boolean).join(' · ')), sigChips(p.product.id, p.product.sig, { omit: ['gsc'] })),
          h('td', {}, nf.format(p.clicks)), h('td', {}, nf.format(p.impressions)), h('td', {}, `${nf1.format(p.ctr * 100)} %`), h('td', {}, posBadge(p.position)))))))),
    h('div', { class: 'panel flush' },
      h('div', { class: 'panelhead' }, h('h3', {}, 'Suchanfragen'), h('p', { class: 'pmeta' }, 'Womit deine Produktseiten gefunden werden, nach Klicks.')),
      h('div', { class: 'tablewrap', style: 'max-height:560px' }, h('table', { class: 'prices', style: 'min-width:0' },
        h('thead', {}, h('tr', {}, ['Suchanfrage', 'Klicks', 'Impr.', 'Pos.'].map((t, i) => h('th', { class: i === 0 ? 'prod' : '' }, t)))),
        h('tbody', {}, o.queries.map((q) => h('tr', { class: 'nolink' },
          h('td', { class: 'prod' }, h('div', { class: 'pname' }, q.query), h('div', { class: 'sigs' },
            h('button', { class: 'sig', title: 'Artikel zeigen, deren Seite mit dieser Suchanfrage gefunden wird', onclick: () => { Object.assign(state, { q: q.query, filter: 'all', view: 'google' }); setTab('preise'); } }, 'Artikel zeigen'),
            h('button', { class: 'sig cool', title: 'Im Keyword-Monitoring täglich beobachten', onclick: guard(async (e) => { const r = await api('/api/keywords', { body: { keywords: q.query, source: 'suggestion' } }); toast(r.added ? `„${q.query}“ wird beobachtet` : 'Schon beobachtet'); e.target.disabled = true; }) }, '+ Keyword'))),
          h('td', {}, nf.format(q.clicks)), h('td', {}, nf.format(q.impressions)), h('td', {}, q.position != null ? posBadge(q.position) : '–')))))))));
}

/** Suchdaten in der Detailansicht eines Artikels. */
function seoDrawerBox(id) {
  const box = h('div', { class: 'seobox' }, h('p', { class: 'pmeta' }, 'Suchdaten werden geladen …'));
  api(`/api/products/${id}/seo`).then((r) => {
    if (!r.page) { box.replaceChildren(h('p', { class: 'pmeta' }, state.data.config.gsc ? 'Für diese Seite liegen keine Suchdaten vor (keine Impressionen in den letzten 28 Tagen oder keine Shop-URL zugeordnet).' : 'Die Google Search Console unter Einstellungen verbinden, dann siehst du hier, wie diese Seite bei Google gefunden wird.')); return; }
    box.replaceChildren(
      r.page ? h('div', { class: 'seokpis' },
        h('div', {}, h('b', {}, nf.format(r.page.clicks)), h('small', {}, 'Klicks')),
        h('div', {}, h('b', {}, nf.format(r.page.impressions)), h('small', {}, 'Impressionen')),
        h('div', {}, h('b', {}, `${nf1.format(r.page.ctr * 100)} %`), h('small', {}, 'Klickrate')),
        h('div', {}, h('b', {}, nf1.format(r.page.position)), h('small', {}, 'Ø Position'))) : null,
      r.queries.length ? h('table', { class: 'plain', style: 'margin-top:8px' }, h('thead', {}, h('tr', {}, ['Suchanfrage', 'Klicks', 'Impr.', 'Pos.'].map((t) => h('th', {}, t)))),
        h('tbody', {}, r.queries.map((q) => h('tr', {}, h('td', {}, q.query), h('td', {}, nf.format(q.clicks)), h('td', {}, nf.format(q.impressions)), h('td', {}, nf1.format(q.position)))))) : null);
  }).catch((e) => box.replaceChildren(h('p', { class: 'pmeta' }, e.message)));
  return box;
}

// ---------- Verkaufskanäle, eBay, Chancen ----------
const r2c = (v) => Math.round(v * 100) / 100;
const chProfit = (gross, cost, ch, vat = 19) => (gross == null || !(cost > 0) || !ch ? null : r2c(gross / (1 + vat / 100) - gross * (ch.fee_percent / 100) - ch.fee_fixed - ch.shipping_cost - cost));
const chMargin = (gross, cost, ch, vat = 19) => { const p = chProfit(gross, cost, ch, vat); const net = gross / (1 + vat / 100); return p == null || !(net > 0) ? null : Math.round((p / net) * 1000) / 10; };
const money = (v) => (v == null ? '–' : eur.format(v));
const pctTxt = (v) => (v == null ? '–' : `${nf1.format(v)} %`);

/** „Preise je Kanal“ in der Detailansicht eines Artikels. */
function channelBox(p) {
  const box = h('div', { class: 'chbox' }, h('p', { class: 'pmeta' }, 'Wird berechnet …'));
  api(`/api/products/${p.id}/channels`).then((r) => {
    if (!r.purchase_price) { box.replaceChildren(h('p', { class: 'pmeta' }, 'Ohne Einkaufspreis keine Gewinnrechnung. Einkaufspreise kommen aus Shopware oder per CSV unter Import.')); return; }
    const l = r.ebay.listing;
    box.replaceChildren(
      h('table', { class: 'plain chtable' },
        h('thead', {}, h('tr', {}, ['Kanal', 'Preis', 'Gewinn', 'Marge', 'Untergrenze', 'Günstigster am Markt', 'Vorschlag'].map((t) => h('th', {}, t)))),
        h('tbody', {}, r.channels.map((c) => h('tr', {},
          h('td', {}, c.name),
          h('td', {}, c.price != null ? money(c.price) : h('span', { class: 'pmeta' }, c.key === 'ebay' ? 'nicht auf eBay' : '–')),
          h('td', { class: c.profit == null ? '' : c.profit < 0 ? 'warmtxt' : 'cooltxt' }, money(c.profit)),
          h('td', {}, pctTxt(c.margin)),
          h('td', { title: 'Preis mit genau dem Mindestgewinn nach Einkauf, Gebühren und Versand' }, money(c.floor)),
          h('td', {}, c.market != null ? [money(c.market), c.key === 'ebay' && r.ebay.market?.min_seller ? h('small', { class: 'pmeta' }, ` ${r.ebay.market.min_seller}`) : null] : '–'),
          h('td', {}, c.suggestion != null ? [money(c.suggestion), c.market_reachable === false ? h('small', { class: 'warmtxt' }, ' Markt unter Untergrenze') : null] : c.target != null ? h('span', { title: 'Zielpreis nach Zielmarge' }, money(c.target)) : '–'))))),
      h('div', { class: 'row', style: 'margin-top:8px' },
        l ? h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, `eBay-Angebot ${l.item_id}`) : null,
        l?.created_by_us && l.jtl_state === 'pending' ? h('span', { class: 'tag warn' }, 'Übernahme in JTL ausstehend') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => { calcState.product = { ...p, units_30: p.sales?.units_30 ?? 0 }; setTab('chancen'); } }, 'Im Rechner öffnen'),
        !l && state.data.config.ebayConnected ? h('button', { class: 'btn small', onclick: () => openListingEditor(p.id) }, 'Auf eBay einstellen') : null,
        state.data.config.ebay && p.ean ? h('button', { class: 'btn small', onclick: guard(async () => { await api('/api/ebay/market', { body: { ids: [p.id] } }); toast('eBay-Preise geprüft'); box.replaceWith(channelBox(p)); }) }, 'eBay-Preise prüfen') : null));
  }).catch((e) => box.replaceChildren(h('p', { class: 'pmeta' }, e.message)));
  return box;
}

// ---------- eBay-Bereich ----------
const JTL_STEPS = [
  'In JTL-Wawi „Plattformen → eBay → Angebotsimport“ öffnen und „eBay-Angebote laden“ klicken.',
  'Prüfen, dass in der Spalte „Art.Nr. (zugeordnet)“ die Artikelnummer steht (gelbe oder grüne Zeile). Die Zuordnung läuft über die eBay-SKU, die Preisradar immer auf die Artikelnummer setzt.',
  'Unter „Einstellungen → Bestände“ die Option „Bestand beibehalten“ wählen, damit der JTL-Bestand nicht von der Angebotsmenge überschrieben wird.',
  'Nicht „Artikel aus Angebot neu erstellen“ klicken: Das legt neue Artikel an (Dubletten). Ist eine Zeile rot, das Angebot dem vorhandenen Artikel von Hand zuordnen.',
  '„Speichern“: JTL übernimmt die Angebote und kümmert sich ab jetzt um Bestand, Preis und Aufträge.',
];

async function renderEbay(root) {
  const o = await api('/api/ebay');
  const c = o.config;
  const conn = new URLSearchParams(location.search).get('ebay');
  if (conn) { history.replaceState(null, '', '/'); toast(conn === 'connected' ? 'eBay verbunden' : `eBay: ${new URLSearchParams(location.search).get('msg') || 'Verbindung fehlgeschlagen'}`, conn !== 'connected'); }
  root.append(h('div', { class: 'pagehead' }, h('h2', {}, 'eBay'),
    c.connected ? h('span', { class: 'pmeta' }, `verbunden als ${c.username ?? 'eBay-Konto'}`) : null,
    h('span', { class: 'spacer' }),
    c.connected ? h('button', { class: 'btn', onclick: guard(async () => { const r = await api('/api/ebay/sync', { body: {} }); toast(`${r.listings} Angebote gelesen, ${r.matched} zugeordnet`); render(); }) }, 'Angebote abgleichen') : null,
    c.app ? h('button', { class: 'btn', disabled: o.market.job.running, onclick: guard(async () => { const r = await api('/api/ebay/market', { body: {} }); toast(`${r.job.total} Artikel werden auf eBay gesucht`); render(); }) }, o.market.job.running ? `prüft ${o.market.job.done} von ${o.market.job.total} …` : 'Mitbewerberpreise prüfen') : null));

  if (!c.app || !c.connected) {
    root.append(h('div', { class: 'panel head' },
      h('div', {},
        h('strong', {}, !c.app ? 'eBay ist noch nicht eingerichtet. ' : 'Noch nicht mit Marcos eBay-Konto verbunden. '),
        !c.app ? 'Mit einem kostenlosen eBay-Entwicklerkonto sieht Preisradar die Preise der Mitbewerber auf eBay. Mit der Verbindung zum Verkäuferkonto kommen die eigenen Angebote und das Einstellen dazu.'
          : c.can_connect ? 'Mitbewerberpreise laufen schon. Für eigene Angebote und das Einstellen einmal bei eBay anmelden und zustimmen.' : 'Für die Verbindung fehlt noch der RuName unter Einstellungen → eBay.'),
      h('span', { class: 'spacer' }),
      c.can_connect && !c.connected ? h('a', { class: 'btn primary', href: '/api/ebay/connect' }, 'Mit eBay verbinden') : h('button', { class: 'btn primary', onclick: () => { setTab('einstellungen'); setTimeout(() => document.getElementById('ebay-settings')?.scrollIntoView({ behavior: 'smooth' }), 500); } }, 'eBay einrichten')));
  }
  if (c.app) root.append(h('div', { class: 'kpis' },
    kpiTile('Eigene Angebote', h('span', { 'data-count': o.listings.length }, nf.format(o.listings.length)), o.listings_at ? `abgeglichen ${dt.format(new Date(o.listings_at))}` : 'noch nicht abgeglichen'),
    kpiTile('Mitbewerber geprüft', nf.format(o.market.checked), `${nf.format(o.market.with_offers)} mit Angeboten auf eBay`),
    kpiTile('Übernahme in JTL', nf.format(o.pending_jtl), 'eingestellt, noch nicht übernommen', o.pending_jtl ? 'warm' : ''),
    kpiTile('eBay-Gebühr', `${nf1.format(o.fees.fee_percent)} %`, `+ ${eur.format(o.fees.fee_fixed)} je Verkauf, anpassbar unter Einstellungen`)));

  // Übernahme in JTL
  const pending = o.listings.filter((l) => l.created_by_us && l.jtl_state === 'pending');
  if (pending.length) {
    root.append(h('section', { class: 'panel jtlpanel' }, h('h3', {}, `${pending.length} Angebote in JTL übernehmen`),
      h('p', { class: 'pmeta' }, 'Bis zur Übernahme kennt JTL diese Angebote nicht: Der Bestand wird nicht abgeglichen. Am besten gleich nach dem Einstellen übernehmen.'),
      h('ol', { class: 'plainlist jtlsteps' }, JTL_STEPS.map((t) => h('li', {}, t))),
      h('table', { class: 'plain' }, h('tbody', {}, pending.map((l) => h('tr', {},
        h('td', {}, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.item_id)),
        h('td', {}, l.title), h('td', {}, `SKU ${l.sku}`), h('td', {}, money(l.price)),
        h('td', {}, h('button', { class: 'btn small', onclick: guard(async () => { await api(`/api/ebay/listings/${l.item_id}/jtl`, { body: { state: 'imported' } }); toast('Als übernommen markiert'); render(); }) }, 'In JTL übernommen'))))))));
  }

  // Chancen für eBay
  if (c.connected) root.append(h('div', { class: 'panel head' }, h('div', {}, h('strong', {}, 'Was auf eBay fehlt: '), 'Artikel, die sich im Shop verkaufen und auf eBay nach Gebühren Gewinn bringen, stehen unter Chancen.'),
    h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => { opp.type = 'ebay_missing'; setTab('chancen'); } }, 'Fehlt auf eBay ansehen')));

  // Eigene Angebote
  if (o.listings.length) {
    root.append(h('h3', { class: 'sechead' }, 'Eigene Angebote'),
      h('div', { class: 'tablewrap kwwrap' }, h('table', { class: 'prices kwtable ebtable' },
        h('thead', {}, h('tr', {}, h('th', { class: 'prod' }, 'Angebot'), ...['Preis', 'Menge', 'Verkauft', 'Günstigster auf eBay', 'Gewinn', 'Marge', 'Hinweis'].map((t) => h('th', {}, t)))),
        h('tbody', {}, o.listings.map((l) => h('tr', { tabindex: 0, onclick: () => l.product_id && openDrawer(l.product_id) },
          h('td', { class: 'prod' }, h('div', { class: 'pname' }, l.title), h('div', { class: 'pmeta' }, [`SKU ${l.sku ?? '–'}`, l.name && l.name !== l.title ? l.name : null].filter(Boolean).join(' · ')), l.created_by_us ? h('span', { class: `tag ${l.jtl_state === 'pending' ? 'warn' : 'tier'}` }, l.jtl_state === 'pending' ? 'JTL-Übernahme offen' : 'über Preisradar eingestellt') : null, l.product_id ? sigChips(l.product_id, l.sig, { omit: ['ebay'] }) : null),
          h('td', { class: 'mcell', 'data-label': 'Preis' }, money(l.price)),
          h('td', { class: 'mcell', 'data-label': 'Menge' }, String(l.quantity ?? '–')),
          h('td', { class: 'mcell', 'data-label': 'Verkauft' }, String(l.sold ?? 0)),
          h('td', { class: 'mcell', 'data-label': 'Günstigster auf eBay' }, l.market?.min_total != null ? [money(l.market.min_total), h('small', { class: 'pmeta kbest' }, `${l.market.min_seller} · ${l.market.offers} Angebote`)] : l.market?.error ? h('small', { class: 'pmeta' }, l.market.error) : '–'),
          h('td', { class: `mcell ${l.calc?.profit < 0 ? 'warmtxt' : ''}`, 'data-label': 'Gewinn' }, money(l.calc?.profit)),
          h('td', { class: 'mcell', 'data-label': 'Marge' }, pctTxt(l.calc?.margin)),
          h('td', { class: 'mcell kurl', 'data-label': 'Hinweis' }, !l.product_id ? h('span', { class: 'warmtxt' }, 'SKU passt zu keinem Artikel') : l.calc?.profit != null && l.calc.profit < 0 ? h('span', { class: 'warmtxt' }, 'Verlust je Verkauf') : l.market?.min_total != null && l.price > l.market.min_total + 0.01 ? `${money(l.price - l.market.min_total)} über dem Günstigsten` : l.market?.min_total != null ? h('span', { class: 'goodtxt' }, 'günstigster') : '')))))));
  } else if (c.connected) root.append(h('div', { class: 'panel empty' }, h('h3', {}, 'Keine eigenen Angebote gefunden'), h('p', {}, '„Angebote abgleichen“ liest die aktiven Angebote aus dem eBay-Konto.')));
}

// ---------- Angebot einstellen ----------
async function openListingEditor(productId) {
  const el = document.getElementById('drawer');
  el.hidden = false;
  document.body.classList.add('drawer-open');
  const top = h('div', { class: 'drawer-top' }, h('button', { class: 'btn small close', onclick: closeDrawer, 'aria-label': 'Schließen' }, 'Schließen'));
  el.replaceChildren(top, h('p', { class: 'pmeta' }, 'Angebot wird vorbereitet (Shopware-Daten, eBay-Kategorie) …'));
  const d = await api(`/api/ebay/draft/${productId}`).catch((e) => { toast(e.message, true); return null; });
  if (!d) return;
  const df = d.defaults;
  const ch = d.channel;
  const vat = d.product.tax_rate ?? 19;
  const cost = d.product.purchase_price;
  const title = h('input', { type: 'text', value: df.title, maxlength: 80, class: 'kwtag wide', 'aria-label': 'Titel' });
  const titleCount = h('small', { class: 'pmeta' });
  const upCount = () => { titleCount.textContent = `${title.value.length} von 80 Zeichen`; };
  title.oninput = upCount; upCount();
  const price = h('input', { type: 'number', step: '0.01', min: 0, value: df.price ?? '', class: 'kwtag', 'aria-label': 'Preis' });
  const qty = h('input', { type: 'number', min: 1, step: 1, value: df.quantity || 1, class: 'kwtag', 'aria-label': 'Menge' });
  const ean = h('input', { type: 'text', value: df.ean, class: 'kwtag', 'aria-label': 'EAN' });
  const cond = h('select', { class: 'kwtag', 'aria-label': 'Zustand' }, [[1000, 'Neu'], [1500, 'Neu: Sonstige']].map(([v, t]) => h('option', { value: v, selected: Number(df.condition) === v }, t)));
  const calcOut = h('div', { class: 'pmeta calcout' });
  const upCalc = () => {
    const pv = Number(price.value);
    const pr = chProfit(pv, cost, ch, vat);
    calcOut.replaceChildren(cost > 0 ? h('span', { class: pr < 0 ? 'warmtxt' : '' }, `Gewinn je Verkauf ${money(pr)} · Marge ${pctTxt(chMargin(pv, cost, ch, vat))} · eBay-Gebühr ${money(r2c(pv * ch.fee_percent / 100 + ch.fee_fixed))}`) : 'Ohne Einkaufspreis keine Gewinnrechnung.',
      d.calc?.floor != null ? h('span', {}, ` · Untergrenze ${money(d.calc.floor)}`) : null,
      d.market?.min_total != null ? h('span', {}, ` · günstigstes eBay-Angebot ${money(d.market.min_total)} (${d.market.min_seller})`) : d.market?.offers === 0 ? h('span', {}, ' · auf eBay kein anderes Angebot') : null);
  };
  price.oninput = upCalc; upCalc();
  const imgs = new Set(df.images);
  const imgBox = h('div', { class: 'imgpick' }, df.images.length ? df.images.map((u) => { const cb = h('input', { type: 'checkbox', checked: true, onchange: (e) => (e.target.checked ? imgs.add(u) : imgs.delete(u)) }); return h('label', {}, cb, h('img', { src: u, alt: '', loading: 'lazy' })); }) : h('p', { class: 'pmeta' }, 'Keine Bilder (Shopware nicht verbunden oder Artikel ohne Bilder). Ohne Bild lehnt eBay das Angebot meist ab.'));
  const desc = h('textarea', { rows: 6, class: 'desc', 'aria-label': 'Beschreibung (HTML)' }, df.description);
  const descPrev = h('iframe', { class: 'descprev', sandbox: '', title: 'Vorschau der Beschreibung' });
  const upDesc = () => { descPrev.srcdoc = `<style>body{font:14px/1.45 system-ui,sans-serif;margin:8px;color:#222}</style>${desc.value}`; };
  desc.oninput = upDesc; upDesc();
  // Kategorie und Merkmale
  let catId = '';
  const spec = { ...df.specifics };
  const specBox = h('div', { class: 'specbox' }, h('p', { class: 'pmeta' }, 'Zuerst eine Kategorie wählen.'));
  const loadAspects = async (id) => {
    catId = id;
    specBox.replaceChildren(h('p', { class: 'pmeta' }, 'Merkmale werden geladen …'));
    const asp = await api(`/api/ebay/aspects?category=${encodeURIComponent(id)}`);
    const known = new Set(asp.map((a) => a.name));
    specBox.replaceChildren(h('div', { class: 'grid' }, asp.map((a) => {
      const listId = `asp-${a.name.replace(/\W/g, '')}`;
      return h('div', { class: 'field' }, h('label', {}, a.name, a.required ? h('b', { class: 'warmtxt' }, ' *') : null),
        h('input', { type: 'text', value: spec[a.name] ?? '', list: a.values.length ? listId : null, oninput: (e) => { spec[a.name] = e.target.value; } }),
        a.values.length ? h('datalist', { id: listId }, a.values.map((v) => h('option', { value: v }))) : null);
    })), Object.keys(spec).filter((k) => !known.has(k) && spec[k]).length ? h('p', { class: 'pmeta' }, `Zusätzlich aus Shopware: ${Object.keys(spec).filter((k) => !known.has(k) && spec[k]).map((k) => `${k}: ${spec[k]}`).join(' · ')}`) : null);
  };
  const catList = h('div', { class: 'catlist' });
  const catQ = h('input', { type: 'search', class: 'kwtag wide', value: d.product.name, 'aria-label': 'Kategorie suchen' });
  const searchCats = guard(async () => {
    catList.replaceChildren(h('p', { class: 'pmeta' }, 'Suche …'));
    const cats = await api(`/api/ebay/categories?q=${encodeURIComponent(catQ.value)}`);
    catList.replaceChildren(...cats.map((c, i) => h('label', { class: 'catopt' }, h('input', { type: 'radio', name: 'ebcat', value: c.id, checked: i === 0, onchange: () => loadAspects(c.id) }), h('span', {}, c.path, h('small', { class: 'pmeta' }, ` (${c.id})`)))));
    if (cats[0]) loadAspects(cats[0].id);
  });
  catQ.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); searchCats(); } };
  const result = h('div', {});
  const body = () => ({ title: title.value, category_id: catId, price: price.value, quantity: qty.value, condition: cond.value, ean: ean.value, specifics: spec, images: [...imgs], description: desc.value });
  el.replaceChildren(top,
    h('h2', {}, 'Auf eBay einstellen'),
    h('p', { class: 'pmeta' }, `${d.product.name} · Art.-Nr. ${d.product.number} · Bestand ${d.product.stock ?? '–'}`),
    d.existing ? h('p', { class: 'note warn' }, `Für diese Artikelnummer läuft schon ein eBay-Angebot (${d.existing.item_id}). Ein zweites Angebot wird nicht angelegt.`) : null,
    d.shopware_error ? h('p', { class: 'note' }, d.shopware_error) : null,
    !d.policies_ok ? h('p', { class: 'note warn' }, 'Unter Einstellungen → eBay fehlen Versand-, Zahlungs- oder Rücknahmerichtlinie bzw. Artikelstandort.') : null,
    h('p', { class: 'note' }, `SKU des Angebots: ${df.sku} (= Artikelnummer). Darüber ordnet JTL das Angebot beim Angebotsimport dem vorhandenen Artikel zu, es entsteht keine Dublette.`),
    h('div', { class: 'field' }, h('label', {}, 'Titel'), h('div', { class: 'row' }, title, state.data.config.ai ? h('button', { class: 'btn small', onclick: guard(async (e) => { const b = e.currentTarget; b.disabled = true; try { const r = await api(`/api/ebay/texts/${productId}`, { body: { title: title.value, specifics: spec, only: 'title' } }); title.value = r.title; upCount(); } finally { b.disabled = false; } }) }, 'KI-Vorschlag') : null), titleCount),
    h('div', { class: 'field' }, h('label', {}, 'eBay-Kategorie'), h('div', { class: 'row' }, catQ, h('button', { class: 'btn small', onclick: searchCats }, 'Suchen')), catList),
    h('h3', { style: 'margin-top:14px' }, 'Artikelmerkmale'), specBox,
    h('div', { class: 'grid', style: 'margin-top:10px' },
      h('div', { class: 'field' }, h('label', {}, 'Preis (brutto)'), price),
      h('div', { class: 'field' }, h('label', {}, 'Menge'), qty, h('span', { class: 'hint' }, 'Nach der Übernahme in JTL gleicht JTL den Bestand ab.')),
      h('div', { class: 'field' }, h('label', {}, 'EAN'), ean),
      h('div', { class: 'field' }, h('label', {}, 'Zustand'), cond)),
    calcOut,
    h('h3', { style: 'margin-top:14px' }, 'Bilder'), imgBox,
    h('div', { class: 'row', style: 'margin-top:14px' }, h('h3', { style: 'margin:0' }, 'Beschreibung'), h('span', { class: 'spacer' }),
      state.data.config.ai ? h('button', { class: 'btn small', onclick: guard(async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'KI schreibt …';
        try { const r = await api(`/api/ebay/texts/${productId}`, { body: { title: title.value, specifics: spec } }); title.value = r.title; upCount(); if (r.description_html) { desc.value = r.description_html; upDesc(); } toast('Titel und Beschreibung übernommen, bitte prüfen'); }
        finally { b.disabled = false; b.textContent = 'Titel und Beschreibung von der KI'; }
      }) }, 'Titel und Beschreibung von der KI') : null),
    desc, descPrev,
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'btn', disabled: Boolean(d.existing), onclick: guard(async () => {
        result.replaceChildren(h('p', { class: 'pmeta' }, 'eBay prüft das Angebot …'));
        const r = await api(`/api/ebay/verify/${productId}`, { body: body() });
        result.replaceChildren(h('div', { class: 'note' }, h('strong', {}, 'eBay würde das Angebot annehmen. '), `Einstellgebühren laut eBay: ${money(r.fees)}.`, r.warnings.length ? h('ul', {}, r.warnings.map((w) => h('li', {}, w))) : null));
      }) }, 'Bei eBay prüfen'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', disabled: Boolean(d.existing) || !d.policies_ok, onclick: guard(async () => {
        if (!confirm(`„${title.value}“ für ${money(Number(price.value))} auf eBay einstellen?`)) return;
        const r = await api(`/api/ebay/list/${productId}`, { body: body() });
        result.replaceChildren(h('div', { class: 'note good' }, h('strong', {}, `Eingestellt: Angebot ${r.item_id}. `), h('a', { href: `https://www.ebay.de/itm/${r.item_id}`, target: '_blank', rel: 'noopener noreferrer' }, 'bei eBay ansehen'),
          h('p', {}, 'Jetzt in JTL übernehmen:'), h('ol', { class: 'plainlist jtlsteps' }, JTL_STEPS.map((t) => h('li', {}, t)))));
        toast('Auf eBay eingestellt');
      }) }, 'Auf eBay einstellen')),
    result);
  searchCats();
}

// ---------- Was-wäre-wenn-Rechner (aus dem Marktschreier) ----------
const calcState = { product: null };
async function whatIfPanel(prefill = null) {
  const chans = (await api('/api/channels')).filter((c) => c.active);
  const p = prefill ?? calcState.product;
  const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
  const mk = (val) => h('input', { type: 'text', inputmode: 'decimal', value: val, class: 'kwtag calcin' });
  const now = { price: mk(p?.price ?? 99), cost: mk(p?.purchase_price ?? 50), units: mk(p?.units_30 ?? 10), ads: mk(0) };
  const plan = { price: mk(p?.price ?? 99), cost: mk(p?.purchase_price ?? 50), units: mk(p?.units_30 ?? 10), ads: mk(0) };
  const chSel = h('select', { class: 'kwtag', 'aria-label': 'Kanal' }, chans.map((c) => h('option', { value: c.key }, c.name)));
  const vat = h('input', { type: 'text', inputmode: 'decimal', value: p?.tax_rate ?? 19, class: 'kwtag calcin', 'aria-label': 'MwSt' });
  const target = h('input', { type: 'text', inputmode: 'decimal', value: 20, class: 'kwtag calcin', 'aria-label': 'Zielmarge' });
  const out = h('div', { class: 'whatif-out' });
  const calc = () => {
    const ch = chans.find((c) => c.key === chSel.value);
    const v = num(vat.value);
    const col = (o) => {
      const price = num(o.price.value), cost = num(o.cost.value), units = num(o.units.value), ads = num(o.ads.value);
      const per = chProfit(price, cost, ch, v);
      const month = per == null ? null : r2c(per * units - ads);
      return { per, month, margin: chMargin(price, cost, ch, v), revenue: r2c(price * units), fees: r2c((price * ch.fee_percent / 100 + ch.fee_fixed) * units), breakeven: per > 0 ? Math.ceil(ads / per) : null };
    };
    const a = col(now), b = col(plan);
    const tm = num(target.value);
    const den = (1 - tm / 100) / (1 + num(vat.value) / 100) - ch.fee_percent / 100;
    const tgt = den > 0.01 ? r2c((num(plan.cost.value) + ch.fee_fixed + ch.shipping_cost) / den) : null;
    const diff = a.month != null && b.month != null ? r2c(b.month - a.month) : null;
    const row = (label, x, y, fmt = money) => h('tr', {}, h('th', {}, label), h('td', {}, fmt(x)), h('td', {}, fmt(y)));
    out.replaceChildren(h('table', { class: 'plain whatif' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Heute'), h('th', {}, 'Plan'))),
      h('tbody', {}, row('Gewinn je Verkauf', a.per, b.per), row('Marge', a.margin, b.margin, pctTxt), row('Umsatz im Monat', a.revenue, b.revenue), row('Gebühren im Monat', a.fees, b.fees), row('Gewinn im Monat', a.month, b.month),
        row('Verkäufe bis Werbung bezahlt', a.breakeven, b.breakeven, (v2) => (v2 == null ? '–' : nf.format(v2))))),
      h('p', { class: diff > 0 ? 'goodtxt' : diff < 0 ? 'warmtxt' : 'pmeta' }, diff == null ? 'Einkaufspreis fehlt.' : diff === 0 ? 'Plan und heute gleich.' : `Der Plan bringt ${diff > 0 ? '' : 'minus '}${money(Math.abs(diff))} ${diff > 0 ? 'mehr' : 'weniger'} Gewinn im Monat.`),
      h('p', { class: 'pmeta' }, `Für ${nf1.format(tm)} % Marge auf ${ch.name} bräuchte der Plan einen Preis von ${money(tgt)}.`));
  };
  for (const x of [...Object.values(now), ...Object.values(plan), vat, target]) x.oninput = calc;
  chSel.onchange = calc;
  const line = (label, k, hint) => h('tr', {}, h('th', {}, label, hint ? h('small', { class: 'pmeta' }, ` ${hint}`) : null), h('td', {}, now[k]), h('td', {}, plan[k]));
  const panel = h('section', { class: 'panel', id: 'whatif' },
    h('h3', {}, 'Was-wäre-wenn-Rechner'),
    h('p', { class: 'pmeta' }, p ? `Mit den Werten von ${p.name}. Stückzahl = Verkäufe der letzten 30 Tage.` : 'Preis, Einkauf, Stückzahl und Werbebudget durchspielen. Aus einem Artikel heraus („im Rechner öffnen“) mit dessen Werten.'),
    h('div', { class: 'row' }, h('label', {}, 'Kanal ', chSel), h('label', {}, 'MwSt % ', vat), h('label', {}, 'Zielmarge % ', target)),
    h('div', { class: 'whatif-grid' },
      h('table', { class: 'plain whatif-in' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Heute'), h('th', {}, 'Plan'))),
        h('tbody', {}, line('Preis brutto €', 'price'), line('Einkauf netto €', 'cost'), line('Stück im Monat', 'units'), line('Werbung im Monat €', 'ads'))),
      out));
  calc();
  return panel;
}

// ---------- Chancen ----------
const opp = { type: '', data: null };
async function renderChancen(root) {
  const [o, calcPanel] = await Promise.all([api('/api/opportunities'), whatIfPanel()]);
  opp.data = o;
  const list = o.items.filter((i) => !opp.type || i.type === opp.type);
  root.append(h('div', { class: 'pagehead' }, h('h2', {}, 'Chancen'), h('span', { class: 'spacer' }),
    h('a', { class: 'btn', href: '/api/export/jtl.csv?channel=shop' }, 'Shop-Preise für JTL'),
    h('a', { class: 'btn', href: '/api/export/jtl.csv?channel=ebay' }, 'eBay-Preise für JTL'),
    h('a', { class: 'btn primary', href: '/api/export/jtl.csv' }, 'Alle Preisvorschläge für JTL')),
    h('p', { class: 'sub' }, 'Wo du mehr verkaufen oder mehr verdienen kannst, nach geschätztem Wert sortiert. Die Preisvorschläge gibt es als Datei für die JTL-Ameise (Semikolon getrennt); in der Ameise die Spalte „Preis neu“ dem Brutto-VK bzw. dem eBay-Preis zuordnen. Preisradar ändert selbst keine Preise.'),
    !o.has_sales ? h('p', { class: 'note' }, 'Ohne Verkaufsdaten aus Shopware fehlen die Chancen „Bald ausverkauft“, „Ladenhüter“ und „Fehlt auf eBay“ zum großen Teil.') : null,
    h('div', { class: 'toolbar' }, h('div', { class: 'seg' },
      h('button', { class: `chip${!opp.type ? ' on' : ''}`, onclick: () => { opp.type = ''; render(); } }, h('b', {}, String(o.total ?? o.items.length)), 'alle'),
      Object.entries(o.types).map(([k, t]) => (o.counts[k] ? h('button', { class: `chip ${t.tone}${opp.type === k ? ' on' : ''}`, title: t.hint, onclick: () => { opp.type = k; render(); } }, h('b', {}, String(o.counts[k])), t.label) : null)))),
    opp.type ? h('p', { class: 'pmeta' }, o.types[opp.type].hint) : null,
    list.length ? h('div', { class: 'tablewrap kwwrap' }, h('table', { class: 'prices kwtable opptable' },
      h('thead', {}, h('tr', {}, h('th', { class: 'prod' }, 'Artikel'), h('th', {}, 'Chance'), h('th', { class: 'kurl' }, 'Warum'), h('th', {}, 'Wert'), h('th', {}, 'Was tun'))),
      h('tbody', {}, list.slice(0, 300).map((i) => h('tr', { tabindex: 0, onclick: () => openDrawer(i.product_id) },
        h('td', { class: 'prod' }, h('div', { class: 'pname' }, i.name), h('div', { class: 'pmeta' }, [i.number, i.price != null ? money(i.price) : null, i.stock != null ? `Bestand ${i.stock}` : null].filter(Boolean).join(' · ')), sigChips(i.product_id, i.sig)),
        h('td', { class: 'mcell', 'data-label': 'Chance' }, h('span', { class: `ichip ${i.tone === 'bad' ? 'error' : i.tone === 'warn' ? 'warn' : 'ok'}` }, i.label)),
        h('td', { class: 'mcell kurl', 'data-label': 'Warum' }, i.detail),
        h('td', { class: 'mcell', 'data-label': 'Wert', title: 'Grobe Schätzung in Euro, nur zum Sortieren' }, i.value ? money(i.value) : '–'),
        h('td', { class: 'mcell kurl', 'data-label': 'Was tun', onclick: (e) => i.type === 'ebay_missing' && e.stopPropagation() },
          i.type === 'ebay_missing' && state.data.config.ebayConnected ? h('button', { class: 'btn small', onclick: () => openListingEditor(i.product_id) }, 'Auf eBay einstellen') : i.action)))))) : h('div', { class: 'panel empty' }, h('h3', {}, 'Keine Chancen in dieser Gruppe'), h('p', {}, 'Mit mehr Daten (Shopware-Verkäufe, Einkaufspreise, eBay) findet Preisradar mehr.')),
    list.length > 300 ? h('p', { class: 'pmeta' }, `Die ersten 300 von ${list.length}.`) : null,
    calcPanel);
  if (calcState.product) { calcState.product = null; setTimeout(() => document.getElementById('whatif')?.scrollIntoView({ behavior: 'smooth' }), 300); }
}

// ---------- Einstellungen: Kanäle und eBay ----------
async function channelSettingsPanel() {
  const chans = await api('/api/channels');
  const rows = chans.map((c) => {
    const inp = (k, step = '0.01') => h('input', { type: 'number', step, min: 0, value: c[k], 'aria-label': `${c.name} ${k}`, 'data-k': k, class: 'chnum' });
    return h('tr', { 'data-key': c.key },
      h('td', {}, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: Boolean(c.active), 'data-k': 'active' }), c.name)),
      h('td', {}, inp('fee_percent', '0.1')), h('td', {}, inp('fee_fixed')), h('td', {}, inp('shipping_cost')), h('td', {}, inp('target_margin', '0.5')), h('td', {}, inp('min_profit')),
      h('td', {}, h('select', { 'data-k': 'ending', 'aria-label': `${c.name} Preisendung` }, [['', 'keine'], ['99', ',99'], ['95', ',95'], ['90', ',90'], ['9', 'x,x9'], ['00', 'glatt']].map(([v, t]) => h('option', { value: v, selected: c.ending === v }, t)))));
  });
  const panel = h('div', { class: 'panel', id: 'channel-settings' },
    h('h3', {}, 'Verkaufskanäle'),
    h('p', { class: 'sub' }, 'Gebühren und Versand je Kanal für die Gewinnrechnung, Preisuntergrenzen und Vorschläge. Die Gebühr in Prozent gilt auf den Bruttopreis. Die eBay-Werte sind Standardwerte, bitte an Marcos Konditionen anpassen (Kategorie-Provision und Gebühr je Bestellung). Versand: was dich der Versand kostet, abzüglich dem, was der Kunde zahlt.'),
    h('div', { class: 'tablewrap', style: 'max-height:none' }, h('table', { class: 'plain chset' },
      h('thead', {}, h('tr', {}, ['Kanal', 'Gebühr %', 'Gebühr fest €', 'Versand €', 'Zielmarge %', 'Mindestgewinn €', 'Preisendung'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows))),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => {
        for (const tr of rows) {
          const b = {};
          tr.querySelectorAll('[data-k]').forEach((e) => { b[e.dataset.k] = e.type === 'checkbox' ? e.checked : e.value; });
          await api(`/api/channels/${tr.dataset.key}`, { method: 'PUT', body: b });
        }
        toast('Verkaufskanäle gespeichert');
      }) }, 'Speichern')));
  return panel;
}

function ebaySettingsPanel(cur, f) {
  const e = cur.ebay;
  const out = h('div', { class: 'result', hidden: true });
  const polBox = h('div', {});
  const sel = (label, name, opts, value) => h('div', { class: 'field' }, h('label', {}, label), h('select', { name }, h('option', { value: '' }, '– wählen –'), opts.map((o) => h('option', { value: o.id, selected: o.id === value }, o.name))));
  const form = h('form', { class: 'panel', id: 'ebay-settings', onsubmit: (ev) => ev.preventDefault() },
    h('h3', {}, 'eBay'),
    h('p', { class: 'sub' }, 'Mitbewerberpreise auf eBay (Suche über die EAN), eigene Angebote und das Einstellen neuer Angebote. Bestehende Angebote ändert Preisradar nie; neue Angebote übernimmt JTL über den Angebotsimport.'),
    h('details', { class: 'howto' }, h('summary', {}, 'So richtest du den Zugang ein'),
      h('ol', { class: 'plainlist' },
        h('li', {}, 'Auf developer.ebay.com ein kostenloses Entwicklerkonto anlegen und unter „Application Keys“ ein Schlüsselpaar für „Production“ erzeugen: App ID (Client ID) und Cert ID (Client Secret).'),
        h('li', {}, 'Damit laufen schon die Mitbewerberpreise. Für eigene Angebote und das Einstellen unter „User Tokens → Get a Token from eBay via Your Application“ eine Weiterleitung (RuName) anlegen. Als „Auth accepted URL“ diese Adresse eintragen: ', h('code', {}, e.callback || '/api/ebay/callback')),
        h('li', {}, 'Den RuName (sieht aus wie „Firma-App-PRD-…“) hier eintragen, speichern und „Mit eBay verbinden“ klicken. Marco meldet sich bei eBay an und stimmt zu.'),
        h('li', {}, 'Im eBay-Konto müssen Rahmenbedingungen (Versand, Zahlung, Rücknahme) eingerichtet sein. Nach dem Verbinden hier auswählen.'))),
    h('div', { class: 'grid' },
      f('App ID (Client ID)', 'ebay_client_id', e.client_id),
      f('Cert ID (Client Secret)', 'ebay_client_secret', '', { type: 'password', ph: e.secret_set ? 'gespeichert (leer lassen = behalten)' : '' }),
      f('RuName', 'ebay_runame', e.runame),
      f('Mitbewerber-Prüfungen pro Tag', 'ebay_browse_per_day', e.browse_per_day, { type: 'number', hint: 'eBay erlaubt standardmäßig 5000 Suchen am Tag. Wichtige Artikel täglich, übrige wöchentlich.' }),
      f('Höchstmenge je neuem Angebot', 'ebay_max_qty', e.max_qty, { type: 'number', hint: 'Startmenge beim Einstellen, höchstens der Shopware-Bestand. Danach gleicht JTL ab.' }),
      f('Artikelstandort', 'ebay_location', e.location, { ph: 'Ort' }),
      f('Postleitzahl', 'ebay_postal_code', e.postal_code)),
    polBox,
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => {
        await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(form)) });
        out.hidden = false; out.textContent = 'Verbindung wird geprüft …';
        try { const r = await api('/api/ebay/test', { method: 'POST', body: {} }); out.textContent = `App-Schlüssel funktionieren.${r.connected ? ` Verbunden als ${r.username}.` : ' Verkäuferkonto noch nicht verbunden.'}`; await refresh(); } catch (er) { out.textContent = er.message; }
      }) }, 'Speichern und testen'),
      e.runame && e.client_id ? h('a', { class: 'btn', href: '/api/ebay/connect' }, e.connected ? 'Neu verbinden' : 'Mit eBay verbinden') : null,
      e.connected ? h('button', { class: 'btn danger', type: 'button', onclick: guard(async () => { if (confirm('Verbindung zum eBay-Konto trennen?')) { await api('/api/ebay/disconnect', { body: {} }); toast('Getrennt'); render(); } }) }, 'Trennen') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(form)) }); toast('eBay gespeichert'); await refresh(); }) }, 'Speichern')),
    out,
    e.connected ? h('p', { class: 'pmeta' }, `Verbunden als ${e.username ?? 'eBay-Konto'}.`) : null);
  if (e.connected) {
    polBox.replaceChildren(h('p', { class: 'pmeta' }, 'Rahmenbedingungen werden geladen …'));
    api('/api/ebay/policies').then((pol) => polBox.replaceChildren(h('div', { class: 'grid' },
      sel('Versand', 'ebay_fulfillment_policy', pol.fulfillment, e.fulfillment_policy), sel('Zahlung', 'ebay_payment_policy', pol.payment, e.payment_policy), sel('Rücknahme', 'ebay_return_policy', pol.return, e.return_policy))))
      .catch((er) => polBox.replaceChildren(h('p', { class: 'note warn' }, er.message)));
  }
  return form;
}

// ---------- Seiten-Check (SEO der eigenen Produktseiten) ----------
const sc = { issue: '', sev: '', q: '', important: false, rows: [], filtered: 0, poll: null };
const SEV_LABEL = { error: 'Fehler', warn: 'Warnung', info: 'Hinweis' };

/** Vorschau, wie die Seite im Google-Suchergebnis erscheint. */
function snippetPreview(title, url, desc, { price, availability } = {}) {
  const cut = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')} …` : s);
  let crumb = '';
  try { const u = new URL(url); crumb = [u.hostname.replace(/^www\./, ''), ...decodeURIComponent(u.pathname).split('/').filter(Boolean).slice(0, 2)].join(' › '); } catch { crumb = url ?? ''; }
  return h('div', { class: 'snippet' },
    h('div', { class: 'sn-url' }, crumb),
    h('div', { class: `sn-title${title ? '' : ' none'}` }, title ? cut(title, 62) : 'kein Seitentitel'),
    price != null || availability ? h('div', { class: 'sn-rich' }, [price != null ? eur.format(price) : null, availability ? (/InStock/i.test(availability) ? 'Auf Lager' : /OutOfStock/i.test(availability) ? 'Nicht auf Lager' : availability) : null].filter(Boolean).join(' · ')) : null,
    h('div', { class: `sn-desc${desc ? '' : ' none'}` }, desc ? cut(desc, 158) : 'keine Meta-Beschreibung, Google wählt selbst einen Textausschnitt'));
}
const issueChip = (i) => h('span', { class: `ichip ${i.sev}`, title: i.detail ?? '' }, i.label, i.detail && i.detail.length < 24 ? h('small', {}, ` ${i.detail}`) : null);

async function renderSeoCheck(root) {
  const qs2 = () => new URLSearchParams(Object.entries({ issue: sc.issue, sev: sc.sev, q: sc.q, important: sc.important ? '1' : '', limit: 100 }).filter(([, v]) => v !== '')).toString();
  const o = await api(`/api/seo-audit?${qs2()}`);
  sc.rows = o.pages; sc.filtered = o.filtered;
  if (o.job.running && o.job.manual && !sc.poll) {
    sc.poll = setInterval(guard(async () => {
      const x = await api('/api/seo-audit?limit=1');
      const bar = document.getElementById('scprog');
      if (bar) bar.textContent = `Prüfung läuft: ${x.job.done} von ${x.job.total}`;
      if (!x.job.running) { clearInterval(sc.poll); sc.poll = null; if (state.tab === 'seitencheck') render(); toast(`Seiten-Check fertig: ${x.job.done} Seiten geprüft`); }
    }), 4000);
  }
  const pct = o.total ? Math.round((o.checked / o.total) * 100) : 0;
  root.append(h('div', { class: 'pagehead' }, h('h2', {}, 'Seiten-Check'),
    h('span', { class: 'pmeta' }, `${nf.format(o.checked)} von ${nf.format(o.total)} Produktseiten geprüft`),
    h('span', { class: 'spacer' }),
    o.job.running
      ? [h('span', { class: 'pmeta', id: 'scprog' }, o.job.manual ? `Prüfung läuft: ${o.job.done} von ${o.job.total}` : 'prüft im Hintergrund …'),
        o.job.manual ? h('button', { class: 'btn', onclick: guard(async () => { await api('/api/seo-audit/stop', { method: 'POST', body: {} }); toast('Wird angehalten'); }) }, 'Anhalten') : null]
      : h('button', { class: 'btn primary', onclick: guard(async () => { const r = await api('/api/seo-audit/start', { body: {} }); toast(`${r.job.total} Seiten werden geprüft`); render(); }) }, 'Fällige Seiten jetzt prüfen')),
    h('p', { class: 'sub' }, `Prüft Titel, Beschreibung, Überschrift, Indexierung, die Produktdaten für Google (Preis, Lieferbarkeit, EAN, Marke), Textumfang, doppelte Inhalte und Ladezeit. ${o.config.perDay ? `Läuft im Hintergrund mit ${nf.format(o.config.perDay)} Seiten am Tag` : 'Die Hintergrundprüfung ist ausgeschaltet (Einstellungen → Abrufplan)'}; wichtige Artikel (täglich geprüft, verkauft, gefragt) kommen zuerst und werden wöchentlich erneut geprüft, alle anderen monatlich.`));

  if (!o.checked) {
    root.append(h('div', { class: 'panel empty' }, h('h3', {}, 'Noch keine Seite geprüft'),
      h('p', {}, o.total ? 'Die Prüfung startet automatisch im Hintergrund. Mit „Fällige Seiten jetzt prüfen“ geht es sofort los, die wichtigsten Artikel zuerst.' : 'Für die Prüfung braucht Preisradar die Shop-URLs der Artikel, zum Beispiel aus dem Sitemap-Import.')));
    return;
  }
  root.append(h('div', { class: 'kpis' },
    kpiTile('SEO-Wert', o.score == null ? '–' : `${o.score} %`, 'Seiten ohne Fehler und Warnungen', o.score >= 80 ? 'cool' : 'warm'),
    kpiTile('Mit Fehlern', h('span', { 'data-count': o.counts.error }, nf.format(o.counts.error)), 'kosten Sichtbarkeit', o.counts.error ? 'warm' : ''),
    kpiTile('Mit Warnungen', h('span', { 'data-count': o.counts.warn }, nf.format(o.counts.warn)), 'sollten behoben werden'),
    kpiTile('Produktdaten für Google', o.schema_share == null ? '–' : `${o.schema_share} %`, 'der Seiten haben strukturierte Daten'),
    kpiTile('Geprüft', `${pct} %`, o.last ? `zuletzt ${dt.format(new Date(o.last))}` : 'der Produktseiten')));

  // Befunde nach Art
  root.append(h('section', { class: 'panel' }, h('h3', {}, 'Befunde'), h('p', { class: 'pmeta' }, '„wichtig“ = Artikel, die sich verkaufen oder täglich geprüft werden. Klick zeigt die betroffenen Seiten.'),
    h('div', { class: 'issuelist' }, o.issues.map((i) => h('button', { class: `issuerow${sc.issue === i.code ? ' on' : ''}`, onclick: () => { sc.issue = sc.issue === i.code ? '' : i.code; render(); } },
      h('span', { class: `sevdot ${i.sev}`, title: SEV_LABEL[i.sev] }),
      h('span', { class: 'ilabel' }, h('b', {}, i.label), h('small', {}, i.hint)),
      h('span', { class: 'icount' }, h('b', {}, nf.format(i.count)), i.important ? h('small', {}, `${nf.format(i.important)} wichtig`) : null))))));

  // Seitenliste
  let tmr;
  const active = sc.issue ? o.issues.find((i) => i.code === sc.issue) : null;
  const tbody = h('tbody', {}, sc.rows.map(scRow));
  const more = h('button', { class: 'btn', hidden: sc.rows.length >= sc.filtered, onclick: guard(async () => {
    const x = await api(`/api/seo-audit?${qs2()}&offset=${sc.rows.length}`);
    sc.rows.push(...x.pages); tbody.append(...x.pages.map(scRow)); more.hidden = sc.rows.length >= sc.filtered;
  }) }, 'Weitere laden');
  root.append(h('h3', { class: 'sechead' }, 'Seiten, wichtigste zuerst'),
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Artikel oder Titel suchen', value: sc.q, 'aria-label': 'Suchen', oninput: (e) => { sc.q = e.target.value; clearTimeout(tmr); tmr = setTimeout(render, 300); } }),
      h('div', { class: 'seg' }, [['', 'alle'], ['error', 'mit Fehlern'], ['warn', 'mit Warnungen'], ['info', 'nur Hinweise'], ['ok', 'ohne Befund']].map(([v, l]) => h('button', { class: `chip${sc.sev === v ? ' on' : ''}`, onclick: () => { sc.sev = v; render(); } }, l))),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: sc.important, onchange: (e) => { sc.important = e.target.checked; render(); } }), 'nur wichtige Artikel'),
      active ? h('button', { class: 'chip on', onclick: () => { sc.issue = ''; render(); } }, `${active.label} ✕`) : null,
      h('span', { class: 'pmeta' }, `${nf.format(o.filtered)} Seiten`)),
    h('div', { class: 'tablewrap kwwrap' }, h('table', { class: 'prices kwtable sctable' },
      h('thead', {}, h('tr', {}, h('th', { class: 'prod' }, 'Artikel'), h('th', { class: 'snh' }, 'So sieht Google die Seite'), h('th', { class: 'kurl' }, 'Befunde'), h('th', {}, ''))),
      tbody)),
    h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' }, more));
}

function scRow(p) {
  return h('tr', { tabindex: 0, onclick: () => openDrawer(p.product_id), onkeydown: (e) => e.key === 'Enter' && openDrawer(p.product_id) },
    h('td', { class: 'prod' }, h('div', { class: 'pname' }, p.name),
      h('div', { class: 'pmeta' }, [p.number, p.units_90 ? `${p.units_90} verkauft (90 T)` : null, p.gsc ? `${nf.format(p.gsc.impressions)} Impr. · Pos. ${nf1.format(p.gsc.position)}` : null].filter(Boolean).join(' · ')),
      p.tier === 'A' ? h('span', { class: 'tag tier' }, 'wichtig') : null,
      sigChips(p.product_id, p.sig, { omit: ['audit', 'sales', 'gsc'] })),
    h('td', { class: 'mcell sncell', 'data-label': 'Google-Vorschau' }, snippetPreview(p.title, p.url, p.description, { price: p.schema?.price, availability: p.schema?.availability })),
    h('td', { class: 'mcell kurl', 'data-label': 'Befunde' }, p.error && !p.issues.length ? h('span', { class: 'pmeta' }, p.error) : p.issues.length ? h('div', { class: 'ichips' }, p.issues.slice(0, 6).map(issueChip), p.issues.length > 6 ? h('small', { class: 'pmeta' }, ` +${p.issues.length - 6}`) : null) : h('span', { class: 'ichip ok' }, 'alles in Ordnung')),
    h('td', { class: 'actcell', onclick: (e) => e.stopPropagation() }, h('button', { class: 'btn small', onclick: guard(async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'prüft …';
      try { const r = await api(`/api/products/${p.product_id}/seo-audit`, { body: {} }); if (r.audit) e.target.closest('tr').replaceWith(Object.assign(scRow(r.audit), { className: 'flash' })); toast('Neu geprüft'); }
      finally { b.disabled = false; b.textContent = 'Neu prüfen'; }
    }) }, 'Neu prüfen')));
}

/** SEO-Abschnitt in der Detailansicht eines Artikels. */
function seoAuditBox(id) {
  const box = h('div', { class: 'seoaudit' }, h('p', { class: 'pmeta' }, 'Wird geladen …'));
  const show = (r) => {
    const a = r.audit;
    if (!a) {
      box.replaceChildren(h('p', { class: 'pmeta' }, 'Diese Seite wurde noch nicht geprüft.'),
        h('button', { class: 'btn small', onclick: guard(async () => { box.replaceChildren(h('p', { class: 'pmeta' }, 'Seite wird geprüft …')); show(await api(`/api/products/${id}/seo-audit`, { body: {} })); }) }, 'Jetzt prüfen'));
      return;
    }
    const sug = h('div', {});
    const aiShow = (x) => sug.replaceChildren(h('div', { class: 'aisug' },
      h('div', { class: 'pmeta' }, 'KI-Vorschlag (zum Übernehmen in Shopware bzw. JTL):'),
      snippetPreview(x.title, a.url, x.description),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(x.title).then(() => toast('Titel kopiert')) }, `Titel kopieren (${x.title.length} Zeichen)`),
        h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(x.description).then(() => toast('Beschreibung kopiert')) }, `Beschreibung kopieren (${x.description.length} Zeichen)`)),
      x.notes ? h('p', { class: 'pmeta' }, x.notes) : null));
    if (r.ai) aiShow(r.ai);
    box.replaceChildren(
      snippetPreview(a.title, a.url, a.description, { price: a.schema?.price, availability: a.schema?.availability }),
      a.issues.length ? h('ul', { class: 'auditlist' }, a.issues.map((i) => h('li', { class: i.sev },
        h('b', {}, i.label), i.detail ? h('span', { class: 'pmeta' }, ` (${i.detail})`) : null, h('div', { class: 'pmeta' }, r.issues[i.code]?.hint ?? ''))))
        : h('p', { class: 'goodtxt' }, a.error ?? 'Keine Befunde.'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Produktdaten'), h('dd', {}, a.schema ? [a.schema.price != null ? eur.format(a.schema.price) : 'ohne Preis', a.schema.availability, a.schema.gtin ? `EAN ${a.schema.gtin}` : 'ohne EAN', a.schema.brand].filter(Boolean).join(' · ') : 'keine'),
        h('dt', {}, 'Text'), h('dd', {}, `${a.words ?? 0} Wörter Beschreibung`),
        h('dt', {}, 'Antwortzeit'), h('dd', {}, a.ms == null ? '–' : a.ms < 1000 ? `${nf.format(a.ms)} ms` : `${nf1.format(a.ms / 1000)} s`),
        h('dt', {}, 'Geprüft'), h('dd', {}, dt.format(new Date(a.checked_at)))),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: guard(async () => { box.replaceChildren(h('p', { class: 'pmeta' }, 'Seite wird geprüft …')); show(await api(`/api/products/${id}/seo-audit`, { body: {} })); }) }, 'Neu prüfen'),
        state.data.config.ai ? h('button', { class: 'btn small', onclick: guard(async (e) => {
          const b = e.currentTarget; b.disabled = true; b.textContent = 'KI schreibt …';
          try { aiShow(await api(`/api/products/${id}/seo-suggest`, { body: {} })); } finally { b.disabled = false; b.textContent = 'Titel und Beschreibung von der KI'; }
        }) }, r.ai ? 'Neuen KI-Vorschlag' : 'Titel und Beschreibung von der KI') : null),
      sug);
  };
  api(`/api/products/${id}/seo-audit`).then(show).catch((e) => box.replaceChildren(h('p', { class: 'pmeta' }, e.message)));
  return box;
}

// ---------- Keywords ----------
const kw = { data: null, filter: 'all', q: '', tag: '', sort: 'position', dir: 'asc', view: 'list', sug: null, sugSrc: 'all', picked: new Set(), poll: null };
const KW_OUT = 51; // „nicht in den Top 50“ im Diagramm

/** Platzierungsverlauf: Platz 1 oben, „nicht gefunden“ unten. */
function rankChart(series, { height = 220, depth = 50 } = {}) {
  const all = series.flatMap((x) => x.points);
  if (!all.length) return h('p', { class: 'pmeta' }, 'Noch kein Verlauf.');
  const W = 900, H = height, L = 40, R = 12, T = 10, B = 24;
  const out = depth + 1;
  const xs = all.map((p) => Date.parse(p.date));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ys = all.map((p) => p.value ?? out);
  const yMax = Math.min(out, Math.max(10, ...ys));
  const X = (t) => L + (x1 === x0 ? 0.5 : (t - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + ((Math.min(v ?? out, yMax) - 1) / Math.max(1, yMax - 1)) * (H - T - B);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', class: 'lchart', role: 'img', 'aria-label': 'Platzierungsverlauf' });
  for (const v of [1, 3, 10, 20, 30, 50].filter((v) => v <= yMax)) {
    svg.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: 'var(--line)', 'stroke-dasharray': v === 1 ? '' : '2 4' }),
      s('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, String(v)));
  }
  if (yMax === out) svg.append(s('text', { x: L - 6, y: Y(out) + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted)' }, '>' + depth));
  for (let i = 0; i < 4 && x1 > x0; i++) {
    const t = x0 + ((x1 - x0) * i) / 3;
    svg.append(s('text', { x: X(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === 3 ? 'end' : 'middle', 'font-size': 11, fill: 'var(--muted)' }, dDay.format(new Date(t))));
  }
  for (const se of series) {
    const pts = se.points.map((p) => [X(Date.parse(p.date)), Y(p.value), p]);
    svg.append(s('path', { d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' '), fill: 'none', stroke: se.color, 'stroke-width': se.width ?? 2, 'stroke-linejoin': 'round', 'stroke-dasharray': se.dash ?? '', class: 'lpath' }));
    for (const [x, y, p] of pts) svg.append(s('circle', { cx: x, cy: y, r: se.width > 2 ? 3 : 2.2, fill: se.color }, s('title', {}, `${se.name} · ${new Date(p.date).toLocaleDateString('de-DE')}: ${p.value == null ? `nicht in den Top ${depth}` : `Platz ${p.value}`}`)));
  }
  return h('div', {}, svg, series.length > 1 ? h('div', { class: 'legend' }, series.map((x) => h('span', {}, h('i', { style: `background:${x.color}` }), x.name))) : null);
}

/** Kleiner Verlauf in der Tabelle (30 Tage). */
function rankSpark(hist, depth) {
  if (!hist?.length) return h('span', { class: 'tag mute' }, '–');
  const W = 96, H = 26, out = depth + 1;
  const vals = hist.map((x) => x.p ?? out);
  const max = Math.min(out, Math.max(10, ...vals));
  const X = (i) => (hist.length === 1 ? W / 2 : 2 + (i / (hist.length - 1)) * (W - 4));
  const Y = (v) => 3 + ((Math.min(v, max) - 1) / Math.max(1, max - 1)) * (H - 6);
  const last = vals[vals.length - 1];
  return s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'kspark', 'aria-hidden': 'true' },
    s('line', { x1: 0, x2: W, y1: Y(Math.min(10, max)), y2: Y(Math.min(10, max)), stroke: 'var(--line)', 'stroke-dasharray': '2 3' }),
    s('path', { d: vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--petrol)', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }),
    s('circle', { cx: X(vals.length - 1), cy: Y(last), r: 2.4, fill: last === out ? 'var(--muted)' : 'var(--petrol)' }));
}

const kwPill = (p, depth) => (p === undefined ? h('span', { class: 'tag mute' }, 'ausstehend') : p == null ? h('span', { class: 'gpill out', title: `nicht unter den ersten ${depth}` }, `>${depth}`) : h('span', { class: `gpill ${gTone(p)}` }, String(p)));
const kwDelta = (d) => (d == null || d === 0 ? h('span', { class: 'kdelta' }, d === 0 ? '±0' : '') : h('span', { class: `kdelta ${d > 0 ? 'up' : 'down'}`, title: d > 0 ? `${d} Plätze besser` : `${-d} Plätze schlechter` }, `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}`));
const shortUrl = (u) => { try { const x = new URL(u); return decodeURIComponent(x.pathname).replace(/\/$/, '') || '/'; } catch { return u ?? ''; } };

const KW_FILTERS = {
  all: ['alle', () => true],
  top3: ['Top 3', (k) => k.position != null && k.position <= 3, 'good'],
  top10: ['Top 10', (k) => k.position != null && k.position <= 10, 'good'],
  p11: ['Platz 11–20', (k) => k.position > 10 && k.position <= 20],
  p21: ['Platz 21–50', (k) => k.position > 20],
  out: ['nicht gefunden', (k) => k.position === null, 'bad'],
  up: ['verbessert', (k) => k.change1 > 0, 'good'],
  down: ['verschlechtert', (k) => k.change1 < 0, 'bad'],
  comp: ['Mitbewerber vorn', (k) => k.better > 0, 'warn'],
  pending: ['ausstehend', (k) => k.position === undefined || k.pending],
};

async function renderKeywords(root) {
  const [o, sg] = await Promise.all([api('/api/keywords'), api('/api/keywords/suggestions')]);
  kw.data = o; kw.sug = sg.suggestions;
  if ((o.pending || o.sug.running) && !kw.poll) {
    kw.poll = setInterval(guard(async () => {
      const x = await api('/api/keywords');
      if (!x.pending && !x.sug.running) { clearInterval(kw.poll); kw.poll = null; if (state.tab === 'keywords') render(); toast(x.sug.error ? `Vorschläge: ${x.sug.error}` : 'Keyword-Platzierungen aktualisiert', Boolean(x.sug.error)); }
    }), 15000);
  }
  const sm = o.summary;
  const left = o.limit - sm.count;
  root.append(h('div', { class: 'pagehead' }, h('h2', {}, 'Keywords'),
    h('span', { class: 'pmeta' }, `${sm.count} von ${o.limit}`),
    h('span', { class: 'spacer' }),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Ansicht' },
      h('button', { class: `chip${kw.view === 'list' ? ' on' : ''}`, onclick: () => { kw.view = 'list'; render(); } }, 'Beobachtet'),
      h('button', { class: `chip${kw.view === 'sug' ? ' on' : ''}`, onclick: () => { kw.view = 'sug'; render(); } }, h('b', {}, String(kw.sug.length)), 'Vorschläge'))));

  // Abrufstatus
  root.append(h('div', { class: 'panel head kwstatus' },
    o.configured
      ? h('div', {}, o.pending ? h('strong', {}, `${o.pending} Abfragen laufen bei DataForSEO, Ergebnisse kommen in einigen Minuten. `) : null,
        `Geprüft werden die ersten ${o.depth} Google-Ergebnisse (${o.device === 'mobile' ? 'Smartphone' : 'Desktop'}, Deutschland) ${o.every_days === 1 ? 'täglich' : o.every_days === 7 ? 'wöchentlich' : `alle ${o.every_days} Tage`} ab ${o.hour} Uhr. `,
        `Kosten diesen Monat: ${o.cost_month.toFixed(2).replace('.', ',')} US-$, erwartet etwa ${o.est_month.toFixed(2).replace('.', ',')} US-$ im Monat.`,
        o.error ? h('div', { class: 'warmtxt' }, o.error) : null)
      : h('div', {}, h('strong', {}, 'Noch nicht verbunden. '), 'Keywords kannst du schon anlegen; geprüft wird, sobald unter Einstellungen der DataForSEO-Zugang eingetragen ist.'),
    h('span', { class: 'spacer' }),
    o.configured ? h('button', { class: 'btn', disabled: o.pending > 0 || !sm.count, onclick: guard(async () => { const r = await api('/api/keywords/check', { method: 'POST', body: {} }); toast(r.posted ? `${r.posted} Abfragen abgegeben, Ergebnisse in einigen Minuten` : 'Alle Keywords sind bereits in Arbeit'); render(); }) }, 'Jetzt alle prüfen')
      : h('button', { class: 'btn primary', onclick: () => { setTab('einstellungen'); setTimeout(() => document.getElementById('kw-settings')?.scrollIntoView({ behavior: 'smooth' }), 500); } }, 'Zugang einrichten')));

  if (kw.view === 'sug') { root.append(kwSuggestionsPanel(o)); return; }

  // Kennzahlen und Verlauf
  if (sm.checked) {
    root.append(h('div', { class: 'kpis' },
      kpiTile('Ø Position', sm.avg == null ? '–' : nf1.format(sm.avg), `${sm.top50} von ${sm.checked} in den Top ${o.depth}`, 'cool'),
      kpiTile('Top 3', h('span', { 'data-count': sm.top3 }, String(sm.top3)), sm.out ? `${sm.out} nicht in den Top ${o.depth}` : `von ${sm.checked} geprüften`),
      kpiTile('Top 10', h('span', { 'data-count': sm.top10 }, String(sm.top10)), 'erste Seite'),
      kpiTile('Seit der letzten Prüfung', h('span', {}, h('span', { class: 'kdelta up' }, `▲ ${sm.up}`), ' ', h('span', { class: 'kdelta down' }, `▼ ${sm.down}`)), 'verbessert / verschlechtert'),
      sm.clicks_est ? kpiTile('Geschätzte Klicks', nf.format(sm.clicks_est), 'pro Monat, aus Suchvolumen und Platz') : null));
    if (o.trend.length > 1) {
      root.append(h('div', { class: 'panel' }, h('h3', {}, 'Keywords auf Seite 1'), h('p', { class: 'pmeta' }, 'Anzahl der Keywords in den Top 10 und Top 3 je Prüftag'),
        lineChart([
          { name: 'Top 10', color: 'var(--petrol)', points: o.trend.map((t) => ({ date: t.date, value: t.top10 })), width: 2.5 },
          { name: 'Top 3', color: 'var(--good)', points: o.trend.map((t) => ({ date: t.date, value: t.top3 })) },
        ], { height: 180 })));
    }
  }

  // Hinzufügen
  const ta = h('textarea', { rows: 3, placeholder: 'Ein Keyword pro Zeile, z. B.\nhansgrohe talis e\nwaschtischarmatur schwarz', 'aria-label': 'Neue Keywords' });
  const tagIn = h('input', { type: 'text', class: 'kwtag', placeholder: 'Gruppe (optional)', list: 'kwtags', 'aria-label': 'Gruppe' });
  root.append(h('div', { class: 'panel kwadd' },
    h('div', { class: 'kwaddrow' }, ta,
      h('div', { class: 'kwaddside' }, tagIn, h('datalist', { id: 'kwtags' }, o.tags.map((t) => h('option', { value: t }))),
        h('button', { class: 'btn primary', disabled: left <= 0, onclick: guard(async () => {
          const r = await api('/api/keywords', { body: { keywords: ta.value, tag: tagIn.value } });
          toast(`${r.added} hinzugefügt${r.duplicate ? `, ${r.duplicate} schon vorhanden` : ''}${r.over_limit ? `, ${r.over_limit} über der Grenze von ${r.limit}` : ''}`, !r.added);
          render();
        }) }, 'Hinzufügen'),
        h('span', { class: 'pmeta' }, left > 0 ? `noch ${left} frei` : 'Grenze erreicht'))),
    kw.sug.length ? h('p', { class: 'pmeta', style: 'margin:8px 0 0' }, `${kw.sug.length} Vorschläge aus Search Console, Bestsellern${o.sug.fetched_at ? ' und DataForSEO' : ''}: `, h('button', { class: 'linkbtn', onclick: () => { kw.view = 'sug'; render(); } }, 'ansehen')) : null));

  if (!sm.count) { root.append(h('div', { class: 'panel empty' }, h('h3', {}, 'Noch keine Keywords'), h('p', {}, 'Trage oben Suchbegriffe ein oder übernimm Vorschläge.'))); return; }

  // Filter
  const rows = o.keywords;
  const base = rows.filter((k) => (!kw.q || k.keyword.includes(kw.q.toLowerCase())) && (!kw.tag || k.tag === kw.tag));
  const chips = h('div', { class: 'seg' }, Object.entries(KW_FILTERS).map(([key, [label, fn, cls]]) => {
    const n = base.filter(fn).length;
    if (!n && key !== 'all' && kw.filter !== key) return null;
    return h('button', { class: `chip ${cls ?? ''}${kw.filter === key ? ' on' : ''}`, onclick: () => { kw.filter = key; render(); } }, h('b', {}, String(n)), label);
  }));
  const tbody = h('tbody', {});
  const fill = () => {
    const f = (KW_FILTERS[kw.filter] ?? KW_FILTERS.all)[1];
    const d = kw.dir === 'desc' ? -1 : 1;
    const val = { keyword: (k) => k.keyword, position: (k) => (k.position === undefined ? 999 : k.position ?? 500), change: (k) => k.change1 ?? 0, change7: (k) => k.change7 ?? 0, volume: (k) => k.volume ?? -1, better: (k) => k.better, gsc: (k) => k.gsc?.position ?? 999 }[kw.sort] ?? ((k) => k.keyword);
    const list = base.filter(f).sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : a.keyword.localeCompare(b.keyword, 'de')) * d; });
    tbody.replaceChildren(...list.map((k) => kwRow(k, o)));
  };
  const th = (label, key, firstDir = 'asc', cls = '') => {
    const on = kw.sort === key;
    return h('th', { class: `${cls} sortable${on ? ' sorted' : ''}` }, h('button', { class: 'thbtn', onclick: () => { kw.dir = on ? (kw.dir === 'asc' ? 'desc' : 'asc') : firstDir; kw.sort = key; render(); } }, label, on ? (kw.dir === 'desc' ? ' ▼' : ' ▲') : ''));
  };
  let tmr;
  root.append(
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Keyword suchen', value: kw.q, 'aria-label': 'Keyword suchen', oninput: (e) => { kw.q = e.target.value; clearTimeout(tmr); tmr = setTimeout(render, 200); } }),
      o.tags.length ? h('select', { 'aria-label': 'Gruppe', onchange: (e) => { kw.tag = e.target.value; render(); } }, h('option', { value: '' }, 'Alle Gruppen'), o.tags.map((t) => h('option', { value: t, selected: t === kw.tag }, t))) : null),
    h('div', { class: 'toolbar' }, chips),
    h('div', { class: 'tablewrap kwwrap' }, h('table', { class: 'prices kwtable' },
      h('thead', {}, h('tr', {},
        th('Keyword', 'keyword', 'asc', 'prod'), th('Platz', 'position'), th('seit letzter', 'change', 'desc'), th('7 Tage', 'change7', 'desc'),
        h('th', {}, 'Verlauf'), th('Suchvolumen', 'volume', 'desc'), th('Search Console', 'gsc'), th('Mitbewerber', 'better', 'desc', 'kcomp'), h('th', { class: 'kurl' }, 'Rankende Seite'), h('th', {}, ''))),
      tbody)));
  fill();
}

function kwRow(k, o) {
  const comps = k.comps.filter((c) => c.position != null).slice(0, 3);
  return h('tr', { tabindex: 0, onclick: () => openKwDrawer(k.id), onkeydown: (e) => e.key === 'Enter' && openKwDrawer(k.id) },
    h('td', { class: 'prod' }, h('div', { class: 'pname' }, k.keyword),
      h('div', { class: 'pmeta' }, [k.tag, k.pending ? 'wird geprüft …' : k.last_checked ? `geprüft ${dt.format(new Date(k.last_checked))}` : 'noch nicht geprüft'].filter(Boolean).join(' · '))),
    h('td', { class: 'mcell', 'data-label': 'Platz' }, kwPill(k.position, o.depth), k.best != null && k.best !== k.position ? h('small', { class: 'pmeta kbest' }, `beste ${k.best}`) : null),
    h('td', { class: 'mcell', 'data-label': 'seit letzter Prüfung' }, kwDelta(k.change1)),
    h('td', { class: 'mcell', 'data-label': '7 Tage' }, kwDelta(k.change7)),
    h('td', { class: 'mcell', 'data-label': 'Verlauf' }, rankSpark(k.history, o.depth)),
    h('td', { class: 'mcell', 'data-label': 'Suchvolumen' }, k.volume != null ? nf.format(k.volume) : '–'),
    h('td', { class: 'mcell', 'data-label': 'Search Console', title: k.gsc ? `Ø Platz ${k.gsc.position} in den letzten 28 Tagen, ${k.gsc.impressions} Impressionen, ${k.gsc.clicks} Klicks` : 'keine Daten aus der Search Console' }, k.gsc ? [`Ø ${nf1.format(k.gsc.position)}`, h('small', { class: 'pmeta kbest' }, `${nf.format(k.gsc.impressions)} Impr.`)] : '–'),
    h('td', { class: 'mcell kcomp', 'data-label': 'Mitbewerber' }, comps.length ? h('div', { class: 'kcomps' }, comps.map((c) => h('span', { class: `kc${k.position == null || c.position < k.position ? ' ahead' : ''}`, title: `${c.domain} auf Platz ${c.position}` }, c.domain.replace(/\.(de|com|at|ch|eu|net)$/, ''), h('b', {}, String(c.position))))) : h('span', { class: 'tag mute' }, k.comps.length ? 'nicht in den Top ' + o.depth : '–')),
    h('td', { class: 'mcell kurl', 'data-label': 'Rankende Seite', onclick: (e) => k.product && e.stopPropagation() }, k.product ? [h('button', { class: 'linkbtn', title: k.url, onclick: () => openDrawer(k.product.id, null, 'keywords') }, k.product.name), sigChips(k.product.id, k.product.sig, { omit: ['keywords', 'sales'] })] : k.url ? h('span', { title: k.url }, shortUrl(k.url)) : '–'),
    h('td', { class: 'actcell', onclick: (e) => e.stopPropagation() }, h('button', { class: 'btn small', title: 'Keyword entfernen', 'aria-label': `${k.keyword} entfernen`, onclick: guard(async () => { if (!confirm(`„${k.keyword}“ mit Verlauf entfernen?`)) return; await api(`/api/keywords/${k.id}`, { method: 'DELETE' }); toast('Entfernt'); render(); }) }, 'Entfernen')));
}

async function openKwDrawer(id) {
  const el = document.getElementById('drawer');
  el.hidden = false;
  document.body.classList.add('drawer-open');
  state.selected = null;
  const top = h('div', { class: 'drawer-top' }, h('button', { class: 'btn small close', onclick: closeDrawer, 'aria-label': 'Detailansicht schließen' }, 'Schließen'));
  el.replaceChildren(top, h('p', { class: 'pmeta' }, 'Wird geladen …'));
  const d = await api(`/api/keywords/${id}`).catch((e) => { toast(e.message, true); return null; });
  if (!d) return;
  const o = kw.data;
  const k = d.keyword;
  const row = o.keywords.find((x) => x.id === id);
  const COLS = ['#c2410c', '#7c3aed', '#0891b2', '#a16207', '#be185d', '#4d7c0f'];
  const doms = [...new Set(d.comp_history.map((c) => c.domain))];
  const series = [{ name: 'du', color: 'var(--petrol)', width: 3, points: d.history.map((x) => ({ date: x.date, value: x.position })) },
    ...doms.map((dm, i) => ({ name: dm, color: COLS[i % COLS.length], dash: '4 3', points: d.comp_history.filter((c) => c.domain === dm).map((c) => ({ date: c.date, value: c.position })) }))];
  const tagIn = h('input', { type: 'text', class: 'kwtag', value: k.tag ?? '', list: 'kwtags', placeholder: 'Gruppe', 'aria-label': 'Gruppe' });
  el.replaceChildren(top,
    h('h2', {}, k.keyword),
    h('p', { class: 'pmeta' }, [k.volume != null ? `${nf.format(k.volume)} Suchen im Monat` : null, k.cpc ? `Klickpreis ca. ${eur.format(k.cpc)}` : null, k.last_checked ? `zuletzt geprüft ${dt.format(new Date(k.last_checked))}` : 'noch nicht geprüft'].filter(Boolean).join(' · ')),
    h('div', { class: 'row', style: 'margin:10px 0' },
      h('strong', {}, k.last_checked ? (k.position ? `Platz ${k.position}` : `nicht in den Top ${o.depth}`) : 'ausstehend'),
      row?.gsc ? h('span', { class: 'pmeta' }, `Search Console: Ø Platz ${nf1.format(row.gsc.position)}, ${nf.format(row.gsc.impressions)} Impressionen, ${nf.format(row.gsc.clicks)} Klicks (28 Tage)`) : null,
      h('span', { class: 'spacer' }),
      o.configured ? h('button', { class: 'btn small', disabled: row?.pending, onclick: guard(async () => { await api('/api/keywords/check', { body: { ids: [id] } }); toast('Abfrage abgegeben, Ergebnis in einigen Minuten'); render(); }) }, row?.pending ? 'wird geprüft …' : 'Jetzt prüfen') : null),
    k.url ? h('p', {}, 'Rankende Seite: ', h('a', { href: k.url, target: '_blank', rel: 'noopener noreferrer' }, row?.product?.name ?? shortUrl(k.url))) : null,
    h('div', { class: 'row' }, tagIn, h('button', { class: 'btn small', onclick: guard(async () => { await api(`/api/keywords/${id}`, { method: 'PUT', body: { tag: tagIn.value } }); toast('Gruppe gespeichert'); render(); }) }, 'Gruppe speichern')),
    h('h3', { style: 'margin-top:18px' }, 'Verlauf'),
    rankChart(series, { depth: o.depth }),
    h('h3', { style: 'margin-top:22px' }, `Google-Ergebnisse (Top ${o.depth})`),
    d.serp.length ? h('ol', { class: 'serp' }, d.serp.map((r) => h('li', { class: r.own ? 'own' : r.competitor ? 'comp' : '' },
      h('span', { class: 'srank' }, String(r.rank)),
      h('div', {}, h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title || r.url), h('div', { class: 'pmeta' }, r.domain, r.own ? h('span', { class: 'tag good' }, 'du') : r.competitor ? h('span', { class: 'tag warn' }, 'Mitbewerber') : null)))))
      : h('p', { class: 'pmeta' }, 'Noch keine Ergebnisse.'));
}

function kwSuggestionsPanel(o) {
  const src = { all: 'alle', gsc: 'Search Console', labs_comp: 'Mitbewerber', labs_own: 'eigener Shop', sales: 'Bestseller' };
  const label = { gsc: 'Search Console', labs_comp: 'Mitbewerber', labs_own: 'eigener Shop', sales: 'Bestseller' };
  const list = kw.sug.filter((x) => kw.sugSrc === 'all' || x.sources.includes(kw.sugSrc));
  const left = o.limit - o.summary.count;
  const pickedN = () => [...kw.picked].filter((k) => kw.sug.some((x) => x.keyword === k)).length;
  const addBtn = h('button', { class: 'btn primary' }, 'Markierte hinzufügen');
  const upd = () => { const n = pickedN(); addBtn.disabled = !n || n > left; addBtn.textContent = n ? `${n} markierte hinzufügen` : 'Markierte hinzufügen'; };
  addBtn.onclick = guard(async () => {
    const r = await api('/api/keywords', { body: { keywords: [...kw.picked].join('\n'), source: 'suggestion' } });
    kw.picked.clear();
    toast(`${r.added} Keywords hinzugefügt${o.configured ? ', werden jetzt geprüft' : ''}`);
    render();
  });
  upd();
  const box = h('div', {},
    h('div', { class: 'panel head' },
      h('div', {}, 'Vorschläge aus deinen Daten: Suchanfragen aus der Search Console, Bestseller aus Shopware und, wenn abgerufen, Begriffe, für die du oder deine Mitbewerber bei Google gut stehen (DataForSEO, kostet je Shop etwa 2 Cent).',
        o.sug.fetched_at ? h('div', { class: 'pmeta' }, `DataForSEO-Vorschläge vom ${dt.format(new Date(o.sug.fetched_at))}`) : null,
        o.sug.result?.warnings?.length ? h('div', { class: 'warmtxt' }, o.sug.result.warnings.join(' · ')) : null),
      h('span', { class: 'spacer' }),
      o.configured ? h('button', { class: 'btn', disabled: o.sug.running, onclick: guard(async () => { await api('/api/keywords/suggestions/refresh', { method: 'POST', body: {} }); toast('Vorschläge werden geholt'); render(); }) }, o.sug.running ? 'wird geholt …' : 'Von DataForSEO holen') : null),
    h('div', { class: 'toolbar' }, h('div', { class: 'seg' }, Object.entries(src).map(([k, l]) => {
      const n = k === 'all' ? kw.sug.length : kw.sug.filter((x) => x.sources.includes(k)).length;
      return n || k === 'all' ? h('button', { class: `chip${kw.sugSrc === k ? ' on' : ''}`, onclick: () => { kw.sugSrc = k; render(); } }, h('b', {}, String(n)), l) : null;
    })),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn small', onclick: () => { list.slice(0, Math.max(0, left)).forEach((x) => kw.picked.add(x.keyword)); render(); } }, `Erste ${Math.min(list.length, Math.max(0, left))} markieren`),
    h('button', { class: 'btn small', disabled: !pickedN(), onclick: guard(async () => { await api('/api/keywords/suggestions/dismiss', { body: { keywords: [...kw.picked] } }); kw.picked.clear(); toast('Ausgeblendet'); render(); }) }, 'Markierte ausblenden'),
    addBtn),
    list.length ? h('div', { class: 'tablewrap kwwrap' }, h('table', { class: 'prices kwtable sugtable' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'prod' }, 'Vorschlag'), h('th', {}, 'Suchvolumen'), h('th', {}, 'Dein Platz (geschätzt)'), h('th', { class: 'kurl' }, 'Warum'), h('th', {}, ''))),
      h('tbody', {}, list.map((x) => {
        const cb = h('input', { type: 'checkbox', checked: kw.picked.has(x.keyword), 'aria-label': `${x.keyword} markieren`, onchange: (e) => { e.target.checked ? kw.picked.add(x.keyword) : kw.picked.delete(x.keyword); upd(); } });
        return h('tr', { onclick: (e) => { if (e.target !== cb) { cb.checked = !cb.checked; cb.onchange({ target: cb }); } } },
          h('td', { class: 'trackcell' }, cb),
          h('td', { class: 'prod' }, h('div', { class: 'pname' }, x.keyword), h('div', { class: 'ksrc' }, x.sources.map((s2) => h('span', { class: `tag src-${s2}` }, label[s2])))),
          h('td', { class: 'mcell', 'data-label': 'Suchvolumen' }, x.volume != null ? nf.format(x.volume) : '–'),
          h('td', { class: 'mcell', 'data-label': 'Dein Platz' }, x.own_position != null ? h('span', { class: `gpill ${gTone(x.own_position)}` }, String(x.own_position)) : '–'),
          h('td', { class: 'mcell kurl', 'data-label': 'Warum' }, x.reasons.slice(0, 2).join(' · ')),
          h('td', { class: 'actcell', onclick: (e) => e.stopPropagation() }, h('div', { class: 'acts' },
            h('button', { class: 'btn small', disabled: left <= 0, onclick: guard(async () => { await api('/api/keywords', { body: { keywords: x.keyword, source: 'suggestion' } }); toast(`„${x.keyword}“ hinzugefügt`); render(); }) }, 'Hinzufügen'),
            h('button', { class: 'btn small', title: 'Nicht mehr vorschlagen', onclick: guard(async () => { await api('/api/keywords/suggestions/dismiss', { body: { keyword: x.keyword } }); render(); }) }, 'Ausblenden'))));
      }))))
      : h('div', { class: 'panel empty' }, h('h3', {}, 'Keine Vorschläge'), h('p', {}, o.configured ? 'Verbinde die Search Console oder hol Vorschläge von DataForSEO.' : 'Vorschläge kommen aus der Search Console, den Shopware-Verkäufen und DataForSEO.')));
  return box;
}

// ---------- So funktioniert's ----------
function renderHelp(root) {
  const d = state.data;
  const r = d.config.rules;
  const sch = d.schedule;
  const ai = d.config.aiUsage;
  const go = (tab, text) => h('button', { class: 'linkbtn', onclick: () => setTab(tab) }, text);
  const sec = (id, title, ...body) => h('section', { class: 'help-sec', id }, h('h2', {}, title), ...body);
  const p = (...k) => h('p', {}, ...k);
  const toc = [
    ['h-ablauf', 'Der Ablauf in vier Schritten'],
    ['h-finden', 'Wie Preisradar deinen Artikel beim Mitbewerber findet'],
    ['h-status', 'Was die Angaben in der Preisliste bedeuten'],
    ['h-abruf', 'Wann und wie oft abgefragt wird'],
    ['h-zusammen', 'Wie alles zusammenhängt'],
    ['h-ebay', 'Verkaufskanäle, eBay und Chancen'],
    ['h-seitencheck', 'Seiten-Check: SEO der eigenen Produktseiten'],
    ['h-keywords', 'Keyword-Monitoring'],
    ['h-ki', 'Was die KI macht und was sie kostet'],
    ['h-google', 'Google-Daten und tägliche E-Mail'],
    ['h-analyse', 'Wie die Empfehlungen entstehen'],
    ['h-selbst', 'Was du selbst tun kannst'],
    ['h-daten', 'Deine Daten und faires Verhalten'],
  ];
  root.append(h('article', { class: 'help' },
    h('header', { class: 'help-head' },
      h('h1', {}, 'So funktioniert Preisradar'),
      h('p', { class: 'hero-sub' }, 'Preisradar vergleicht regelmäßig die Preise deiner Artikel mit denen deiner Mitbewerber und zeigt dir, wo du teurer oder günstiger bist. Es liest nur öffentliche Shopseiten und ändert nie etwas in deinem Shop. Über deine Preise entscheidest immer du.')),
    h('nav', { class: 'help-toc', 'aria-label': 'Inhalt' }, h('ol', {}, toc.map(([id, t]) => h('li', {}, h('a', { href: `#${id}`, onclick: (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); } }, t))))),

    sec('h-ablauf', 'Der Ablauf in vier Schritten',
      h('ol', { class: 'steps' },
        h('li', {}, h('h3', {}, 'Deine Artikel kommen rein'), p('Am einfachsten über die Sitemap deines Shops (', go('einstellungen', 'Einstellungen'), '), alternativ über Shopware oder eine CSV-Datei. Preisradar merkt sich Name, Hersteller, Artikelnummer, Herstellernummer, EAN und deinen Preis.')),
        h('li', {}, h('h3', {}, 'Du wählst aus, was beobachtet wird'), p('Nur beobachtete Artikel werden bei Mitbewerbern gesucht. So entscheidest du, wie viel abgefragt wird. Auswahl in der ', go('preise', 'Preisliste'), ' über das Häkchen oder „Weitere Filter“.')),
        h('li', {}, h('h3', {}, 'Du legst deine Mitbewerber an'), p('Unter ', go('mitbewerber', 'Mitbewerber'), ' reicht der Link zu irgendeinem Produkt des Shops. Preisradar erkennt, wie der Shop aufgebaut ist und wo sein Produktverzeichnis (die Sitemap) liegt.')),
        h('li', {}, h('h3', {}, 'Preisradar fragt über den Tag verteilt ab'), p('In kleinen Paketen mit Pausen. Die Ergebnisse siehst du im ', go('start', 'Lagebild'), ', in der Preisliste und in der ', go('analyse', 'Analyse'), '.')))),

    sec('h-finden', 'Wie Preisradar deinen Artikel beim Mitbewerber findet',
      p('Das Schwierigste ist nicht der Preis, sondern das richtige Produkt. Preisradar geht dabei von sicher nach unsicher vor und hört auf, sobald es einen sicheren Treffer hat:'),
      h('ol', { class: 'plainlist' },
        h('li', {}, h('b', {}, 'Von dir hinterlegter Link. '), 'Hast du die Produktseite selbst eingetragen, wird nur diese abgefragt.'),
        h('li', {}, h('b', {}, 'Kennnummern in den Adressen. '), 'Viele Shops schreiben die Herstellernummer oder EAN in die Produktadresse. Passt sie genau zu deinem Artikel, ist das fast immer der richtige.'),
        h('li', {}, h('b', {}, 'Ähnlicher Name. '), 'Sonst vergleicht Preisradar Marke und Name mit den Adressen im Produktverzeichnis des Mitbewerbers, auf Wunsch nur in ausgewählten Kategorien.'),
        h('li', {}, h('b', {}, 'Shopsuche. '), 'Wenn der Mitbewerber es erlaubt, wird zusätzlich seine Suche nach EAN oder Herstellernummer befragt.'),
        h('li', {}, h('b', {}, 'KI als Helfer. '), 'Kommen die Regeln nicht weiter, kann die KI unter den ähnlichsten Seiten die passende auswählen (siehe unten).')),
      p('Auf der gefundenen Seite wird nachgeprüft: Steht dort deine EAN oder Herstellernummer, gilt der Treffer als ', h('b', {}, 'bestätigt'), '. Passt nur der Name, landet er bei ', h('b', {}, '„zu prüfen“'), ' und zählt erst, wenn du ihn bestätigst. In Preise, Lagebild und Analyse fließen nur bestätigte Preise ein.')),

    sec('h-status', 'Was die Angaben in der Preisliste bedeuten',
      h('table', { class: 'plain legend-table' }, h('tbody', {},
        [
          ['Preis mit Prozentwert', 'Bestätigter Preis beim Mitbewerber und der Abstand zu deinem Preis. Rot: der Mitbewerber ist günstiger. Unterstrichen: der günstigste.'],
          ['zu prüfen', 'Wahrscheinlich das richtige Produkt, aber nicht sicher. In der Detailansicht mit „Passt“ oder „Passt nicht“ entscheiden.'],
          ['nicht gefunden', 'Kein passendes Produkt gefunden. Mit „suchen“ öffnest du die Shopsuche des Mitbewerbers und kannst den Link selbst eintragen.'],
          ['ausstehend', 'Noch nicht abgefragt, kommt mit einem der nächsten Pakete.'],
          ['Fehler / gesperrt', 'Die Seite war nicht erreichbar, oder der Mitbewerber erlaubt den Abruf dieser Seite nicht (robots.txt).'],
          ['bei dir offline', 'Der Artikel steht nicht mehr in deiner eigenen Sitemap. Er bleibt mit allen Daten erhalten, wird aber nicht mehr abgefragt und zählt nicht in der Analyse.'],
          ['Position', 'Dein Platz unter allen Anbietern mit bestätigtem Preis (1 = günstigster). Der Balken zeigt, wie weit du über dem günstigsten Angebot liegst (rot, nach rechts) oder wie viel Vorsprung du als Günstigster hast (blau, nach links). Grau: bis 2 % teurer, praktisch gleichauf. Dein Preis ist in derselben Farbe hinterlegt.'],
        ].map(([a, b]) => h('tr', {}, h('th', {}, a), h('td', {}, b)))))),

    sec('h-abruf', 'Wann und wie oft abgefragt wird',
      sch.mode === 'rolling'
        ? p(`Preisradar fragt alle Mitbewerber gleichzeitig ab, jeden Shop aber nur mit einem Seitenaufruf nach dem anderen und einigen Sekunden Abstand (je Mitbewerber einstellbar). Ein schneller Shop wartet nicht auf einen langsamen: Jeder arbeitet weiter, solange bei ihm Artikel fällig sind, bis zu 25 Minuten am Stück, dann folgt eine kurze Pause. Ist nichts mehr fällig, pausiert der Abruf ${sch.interval} bis ${sch.interval + sch.jitter} Sekunden. Verlangt ein Shop in seiner robots.txt einen Mindestabstand (Crawl-delay), hält sich Preisradar daran; antwortet ein Shop mit „zu viele Anfragen“ oder gar nicht, verdoppelt Preisradar den Abstand und wird erst nach und nach wieder schneller. Jeder Artikel wird höchstens zweimal am Tag automatisch abgefragt, mit mindestens ${sch.refresh} Stunden Abstand. So verteilt sich die Last über den Tag, ohne dass ein Shop ständig dieselben Seiten sieht.`)
        : p(`Preisradar fragt zu festen Zeiten ab (${sch.hours.map((x) => String(x).padStart(2, '0') + ':00').join(', ')} Uhr), jeder Artikel höchstens alle ${sch.refresh} Stunden.`),
      p(h('b', {}, 'Wichtige Artikel täglich, der Rest im Wechsel: '), `Bei großen Sortimenten werden nicht alle Artikel jeden Tag abgefragt. Täglich geprüft werden die ${(d.tiers?.size ?? sch.tier_a_size ?? 1000).toLocaleString('de-DE')} wichtigsten: zuerst Artikel, die sich in den letzten 90 Tagen verkauft haben (aus Shopware, nach Umsatz), dann solche, bei denen ein Mitbewerber in der letzten Woche den Preis geändert hat, dann Artikel mit viel Google-Nachfrage und solche über dem Google-Vergleichspreis. Alle übrigen werden alle ${d.tiers?.bDays ?? sch.tier_b_days ?? 4} Tage abgefragt. Die Einstufung wird laufend neu berechnet. Mit „täglich“ in der Preisliste oder in der Detailansicht setzt du einzelne Artikel zusätzlich von Hand auf tägliche Prüfung.`),
      p('Neue Artikel werden zuerst einmal bei allen Mitbewerbern gesucht, die täglich geprüften vorneweg. Den Fortschritt siehst du im Lagebild unter „Betrieb“. Der Preisverlauf speichert einen Preis nur, wenn er sich ändert, und sonst einmal pro Woche; so bleibt die Datenbank auch bei vielen Artikeln schlank.'),
      p('Artikel, die bei einem Mitbewerber nicht gefunden wurden, werden dort einmal pro Woche erneut gesucht, nach vier erfolglosen Versuchen nur noch monatlich. Mit „Prüfen“ in der Preisliste fragst du einen Artikel jederzeit sofort bei allen Mitbewerbern ab. Einstellbar unter ', go('einstellungen', 'Einstellungen → Abrufplan'), '.'),
      p('Preisradar gibt sich offen als „PreisradarBot“ zu erkennen und hält sich an die Regeln, die jeder Shop in seiner robots.txt festlegt. Seiten, die ein Shop für Programme sperrt, werden nicht abgerufen.')),

    sec('h-zusammen', 'Wie alles zusammenhängt',
      p('Jeder Artikel hat eine Detailansicht, egal von wo du ihn öffnest: Preise und Mitbewerber, Preise je Kanal, Google, Keywords, Seiten-Check und die Chancen für genau diesen Artikel. Oben stehen alle Signale als kleine Marken, etwa „+9 % Preis“, „Google 8,2“, „2 SEO-Fehler“, „1 Keyword · bester Platz 4“ oder „eBay ab 85 €“. Dieselben Marken erscheinen in allen Listen (Preise, Sichtbarkeit, Keywords, Seiten-Check, eBay, Chancen); ein Klick öffnet die Detailansicht direkt beim passenden Abschnitt.'),
      p('Die Bereiche speisen sich gegenseitig: Verkäufe und Google-Nachfrage bestimmen, welche Artikel täglich geprüft werden und welche Seiten der Seiten-Check zuerst ansieht. Suchanfragen aus der Search Console werden zu Keyword-Vorschlägen und machen Artikel in der Preisliste auffindbar. Die Chancen sammeln alles an einer Stelle: Preis, Google, Seiten-Check, Keywords, eBay und Lager, und das Lagebild zeigt die wichtigsten davon.')),

    sec('h-ebay', 'Verkaufskanäle, eBay und Chancen',
      p(h('b', {}, 'Gewinn je Kanal: '), 'Unter ', go('einstellungen', 'Einstellungen → Verkaufskanäle'), ' stehen Gebühren und Versand für Shop, eBay und Amazon. Daraus rechnet Preisradar je Artikel den Gewinn, die Marge und die Preisuntergrenze (genau der Mindestgewinn nach Einkauf, Gebühren und Versand). Ein Preis, der im Shop gut ist, kann auf eBay Verlust bringen. Die Rechnung steht in der Detailansicht jedes Artikels unter „Preise je Kanal“.'),
      p(h('b', {}, 'eBay: '), 'Mit einem kostenlosen eBay-Entwicklerschlüssel sucht Preisradar jeden Artikel über die EAN auf eBay und merkt sich das günstigste Angebot inklusive Versand (wichtige Artikel täglich, übrige wöchentlich). Mit der Verbindung zu deinem eBay-Konto kommen deine eigenen Angebote dazu, und du kannst neue Angebote einstellen: Titel und Beschreibung auf Wunsch von der KI, Bilder und Merkmale aus Shopware, Kategorie und Pflichtmerkmale von eBay, Preis aus dem Kanal-Rechner.'),
      p(h('b', {}, 'Zusammenspiel mit JTL: '), 'Preisradar setzt die eBay-SKU immer auf die Artikelnummer. Im Angebotsimport von JTL („Plattformen → eBay → Angebotsimport“) ordnet JTL das Angebot darüber automatisch dem vorhandenen Artikel zu, es entsteht keine Dublette. Wichtig: dort „Bestand beibehalten“ wählen und nie „Artikel aus Angebot neu erstellen“. Ab der Übernahme kümmert sich JTL um Bestand, Preis und Aufträge; Preisradar ändert bestehende eBay-Angebote nie.'),
      p(h('b', {}, 'Chancen: '), 'Unter ', go('chancen', 'Chancen'), ' sammelt Preisradar, wo du mehr verkaufen oder verdienen kannst: Mitbewerber ausverkauft, fehlt auf eBay, eBay-Angebot zu teuer, bald ausverkauft, zu wenig Gewinn, Ladenhüter. Die Preisvorschläge gibt es als Datei für die JTL-Ameise. Dazu kommt ein Was-wäre-wenn-Rechner für Preis, Einkauf, Stückzahl und Werbung.')),

    sec('h-seitencheck', 'Seiten-Check: SEO der eigenen Produktseiten',
      p('Der ', go('seitencheck', 'Seiten-Check'), ' ruft deine Produktseiten im Hintergrund ab und prüft, was Google braucht: Seitentitel und Meta-Beschreibung (fehlt, zu lang, doppelt), Hauptüberschrift, ob die Seite für Google gesperrt ist (noindex) oder auf eine andere zeigt (Canonical), die strukturierten Produktdaten mit Preis, Lieferbarkeit, EAN und Marke, den Umfang des Produkttexts, gleiche Texte auf mehreren Seiten, Bilder ohne Alternativtext und die Antwortzeit.'),
      p(h('b', {}, 'Wichtigstes zuerst: '), 'Befunde sind nach Schwere (Fehler, Warnung, Hinweis) und nach Wichtigkeit des Artikels sortiert. Ein fehlender Preis in den Produktdaten bei einem Bestseller steht also vor einem zu langen Titel bei einem Artikel, der nie gesucht wird. Besonders teuer sind Abweichungen zwischen dem Preis in den Produktdaten und dem Shop-Preis: Das Merchant Center lehnt solche Angebote ab.'),
      p(h('b', {}, 'Vorschläge der KI: '), 'In der Detailansicht eines Artikels schreibt die KI auf Wunsch einen neuen Seitentitel und eine Meta-Beschreibung, mit den Suchbegriffen, über die Kunden die Seite bei Google finden. Preisradar ändert nichts im Shop; du kopierst den Text und trägst ihn in JTL bzw. Shopware ein.'),
      p('Geprüft werden standardmäßig 3000 Seiten am Tag, schonend verteilt; wichtige Artikel wöchentlich, alle anderen monatlich. Einstellbar unter ', go('einstellungen', 'Einstellungen → Abrufplan'), '. In der Preisliste findest du Artikel mit Fehlern über den Filter „SEO-Fehler“.')),

    sec('h-keywords', 'Keyword-Monitoring',
      p('Unter ', go('keywords', 'Keywords'), ' beobachtest du bis zu 200 Suchbegriffe. Preisradar prüft regelmäßig, auf welchem Platz deine Seite bei Google steht, bis Platz 50, und wo deine Mitbewerber stehen. Die Ergebnisse kommen von DataForSEO, einem Anbieter für Suchergebnis-Daten. Google selbst fragt Preisradar nicht ab, weil Google das für Programme sperrt.'),
      p('Je Keyword siehst du den Platz, die Veränderung seit der letzten Prüfung und über eine Woche, den bisher besten Platz, den Verlauf, das monatliche Suchvolumen und den Durchschnittsplatz aus der Search Console. Der Search-Console-Wert ist ein Mittel über 28 Tage und alle Orte, Geräte und Varianten; der Platz aus dem Monitoring ist ein Blick auf eine einzelne Suche in Deutschland. Beide weichen deshalb oft etwas voneinander ab.'),
      p(h('b', {}, 'Vorschläge: '), 'Preisradar schlägt Keywords aus deinen Search-Console-Suchanfragen und deinen Bestsellern vor. Auf Knopfdruck kommen Begriffe dazu, für die dein Shop oder deine Mitbewerber laut DataForSEO weit oben stehen, besonders solche, bei denen ein Mitbewerber vorne ist und du nicht.'),
      p(h('b', {}, 'Kosten: '), 'DataForSEO rechnet nach Verbrauch ab: 200 Keywords mit 50 Ergebnissen kosten täglich geprüft etwa 18 € im Monat, wöchentlich etwa 3 €. Den Verbrauch des laufenden Monats zeigt die Keyword-Seite. Einrichten unter ', go('einstellungen', 'Einstellungen → Keyword-Monitoring'), '.')),

    sec('h-ki', 'Was die KI macht und was sie kostet',
      p('Die KI ist ein Sprachmodell von OpenAI (derzeit ', h('b', {}, d.config.aiModel ?? 'gpt-4.1-mini'), '). Sie kann eine Shopseite ähnlich lesen wie ein Mensch und ist dort hilfreich, wo starre Regeln scheitern, etwa bei ungewöhnlich aufgebauten Shops. Sie wird nur eingesetzt, wenn die Regeln nicht weiterkommen:'),
      h('ul', { class: 'plainlist' },
        h('li', {}, h('b', {}, 'Preis lesen: '), 'Findet Preisradar auf einer Produktseite weder über die üblichen Produktdaten noch über eine gelernte Vorlage einen Preis, liest die KI Preis, Lieferbarkeit und ob es dasselbe Produkt ist.'),
        h('li', {}, h('b', {}, 'Treffer auswählen: '), 'Aus den ähnlichsten Seiten eines Mitbewerbers wählt sie die passende aus oder sagt „keine passt“.')),
      p(h('b', {}, 'Die KI lernt mit: '), 'Hat die KI auf einer Seite den Preis gefunden, merkt sich Preisradar, an welcher Stelle der Seite er steht (eine „Abruf-Vorlage“). Alle weiteren Seiten dieses Shops werden dann ohne KI ausgelesen. Ein Shop kann mehrere Vorlagen haben, etwa für Aktions- und Normalpreise. Vorlagen, die nicht mehr funktionieren, verschwinden von selbst; du siehst sie unter Mitbewerber. Die KI ist damit nur noch der Notfall für Seiten, die weder Regeln noch Vorlagen lesen können.'),
      p(h('b', {}, 'Schutz vor Fehlern: '), 'Einen Preis, der nicht wörtlich auf der Seite steht, verwirft Preisradar. Ist sich die KI nicht sicher, landet der Treffer bei „zu prüfen“. Die KI entscheidet nichts über deine Preise, rechnet nicht die Analyse und hat keinen Zugriff auf deinen Shop.'),
      p(h('b', {}, 'Kosten: '), 'OpenAI rechnet nach Verbrauch ab, nicht über ein Abo. Eine Anfrage kostet je nach Modell und Seitengröße typischerweise deutlich unter einem Cent. Damit die Kosten nicht davonlaufen, gibt es eine Tagesgrenze: ',
        ai ? h('b', {}, `heute ${ai.today.toLocaleString('de-DE')} von ${ai.limit.toLocaleString('de-DE')} Anfragen`) : 'siehe Einstellungen',
        '. Ist sie erreicht, arbeitet Preisradar bis Mitternacht ohne KI weiter. Bei nicht gefundenen Artikeln fragt Preisradar die KI höchstens einmal pro Woche erneut.'),
      p(d.config.ai ? 'Die KI ist eingerichtet. ' : h('b', {}, 'Die KI ist derzeit nicht eingerichtet. '), 'Ohne KI funktioniert Preisradar trotzdem, nur bei schwierigen Shops werden weniger Artikel gefunden. Schlüssel, Modell und Tagesgrenze unter ', go('einstellungen', 'Einstellungen → KI'), '. Pro Mitbewerber lässt sich die KI auch ganz abschalten.')),

    sec('h-google', 'Google-Daten und tägliche E-Mail',
      p('Ist die Google Search Console verbunden, holt Preisradar einmal täglich, wie oft deine Seiten in den letzten 28 Tagen bei Google erschienen sind (Impressionen), wie oft sie angeklickt wurden (Klicks) und auf welchem Platz sie im Schnitt standen. Die Daten kommen direkt von Google und sind 2 bis 3 Tage alt.'),
      p('Spannend wird es zusammen mit den Preisen. Unter ', go('sichtbarkeit', 'Sichtbarkeit'), ' findest du vier Listen:'),
      h('ul', { class: 'plainlist' },
        h('li', {}, h('b', {}, 'Viel gesucht, aber teurer: '), 'Seiten mit vielen Impressionen, bei denen ein Mitbewerber günstiger ist. Hier kostet dich der Preis am meisten Umsatz.'),
        h('li', {}, h('b', {}, 'Günstigster, aber kaum gefunden: '), 'Du hast den besten Preis, aber die Seite steht weit hinten. Hier hilft Arbeit an Titel, Beschreibung und internen Links mehr als der Preis.'),
        h('li', {}, h('b', {}, 'Knapp vor Seite 1: '), 'Seiten auf Platz 8 bis 15. Schon wenige Plätze mehr bringen deutlich mehr Besucher.'),
        h('li', {}, h('b', {}, 'Gut platziert, wenig Klicks: '), 'Weit oben, aber selten angeklickt. Oft helfen ein besserer Seitentitel oder sichtbare Vorteile wie Versand oder Preis im Suchergebnis.')),
      p(h('b', {}, 'Ansicht „Google-Sichtbarkeit“: '), 'In der Preisliste schaltest du oben rechts von „Preisvergleich“ auf „Google-Sichtbarkeit“ um. Dann stehen je Artikel Google-Platz, Impressionen, Klicks, Klickrate und das Klickpotenzial im Vordergrund, dazu ein kurzer Hinweis, was zu tun ist (Preis prüfen, Titel und Beschreibung verbessern, Seite stärken). Das Klickpotenzial schätzt, wie viele Klicks in 28 Tagen dazukämen, wenn die Seite unter den ersten drei stünde; vorsichtig gerechnet, weil Shopping-Anzeigen über den normalen Treffern Klicks abziehen. Die Google-Filter (gefragt, aber teurer; über Google-Vergleichspreis; Platz 4–20; wenig geklickt; verkauft, aber kaum sichtbar und weitere) gibt es in beiden Ansichten.'),
      p(h('b', {}, 'Suche über Google-Suchbegriffe: '), 'Das Suchfeld findet auch Artikel, deren Seite bei Google über einen Begriff angezeigt wird, etwa „unterschrank weiß“, selbst wenn das Wort nicht im Artikelnamen steht. Unter dem Artikel steht dann, über welche Suchanfrage er gefunden wurde.'),
      p('In der Preisliste kannst du nach Impressionen oder Klicks sortieren, und in der Analyse die Empfehlungen nach „Nachfrage × Abstand“: Zuerst kommen die Artikel, bei denen ein besserer Preis die meisten Interessenten erreicht.'),
      p(h('b', {}, 'Merchant Center: '), 'Google kennt für viele Produkte den Preis, zu dem andere Händler sie in Shopping anbieten (Vergleichspreis), auch Händler, die du noch nicht beobachtest. Dazu kommen Googles Preisvorschläge mit geschätzter Wirkung auf Klicks und Verkäufe. Unter Mitbewerber zeigt Preisradar außerdem Shops, die in deinen Kategorien bei Google sichtbar sind, und legt sie auf Klick an.'),
      p(h('b', {}, 'Tägliche E-Mail: '), 'Auf Wunsch kommt jeden Morgen eine Zusammenfassung: wer seit gestern seine Preise geändert hat und wer jetzt unter deinem Preis liegt, die wichtigsten Preissenkungs-Kandidaten nach Umsatz und Nachfrage, neu offline gegangene Artikel und die Google-Zahlen. Einrichten unter ', go('einstellungen', 'Einstellungen'), '.')),

    sec('h-analyse', 'Wie die Empfehlungen entstehen',
      p('Die Empfehlungen folgen festen, nachvollziehbaren Regeln, nicht der KI. Verglichen wird dein Preis mit dem günstigsten bestätigten Angebot eines Mitbewerbers, der den Artikel liefern kann:'),
      h('ul', { class: 'plainlist' },
        h('li', {}, h('b', {}, 'Preis halten: '), `bis ${r.tolerance} % über dem günstigsten Angebot oder günstiger.`),
        h('li', {}, h('b', {}, 'Preis senken: '), `mehr als ${r.tolerance} % teurer. Vorgeschlagen wird der Preis des günstigsten Angebots.`),
        h('li', {}, h('b', {}, 'Preis erhöhen: '), `mehr als ${r.raiseAbove} % günstiger als alle anderen. Vorgeschlagen wird knapp unter dem günstigsten Angebot.`),
        h('li', {}, h('b', {}, 'Prüfen: '), `Abweichungen über ${r.outlier} % sind meist eine falsche Zuordnung (andere Größe, anderes Set) und werden nicht als Marktpreis gewertet.`)),
      p(h('b', {}, 'Mindestmarge: '), `Liegt ein Einkaufspreis vor (aus Shopware oder per CSV, z. B. Export aus JTL-Wawi), schlägt Preisradar nie einen Preis unter deiner Mindestmarge vor (derzeit ${r.minMargin ?? 10} %, bezogen auf den Nettoverkaufspreis). Liegt der Mitbewerber darunter, lautet die Empfehlung „halten“ mit Hinweis. Ohne Einkaufspreis prüfe Senkungen bitte selbst gegen deine Marge.`),
      p(h('b', {}, 'Verkäufe: '), 'Ist Shopware angebunden, siehst du je Artikel die verkauften Stück der letzten 30 Tage und kannst die Empfehlungen nach „Umsatz × Abstand“ sortieren. Zuerst kommen dann die Artikel, bei denen der Preis am meisten Umsatz betrifft. Preisradar liest aus Shopware nur, preisführend bleibt deine Warenwirtschaft.')),

    sec('h-selbst', 'Was du selbst tun kannst',
      h('ul', { class: 'plainlist' },
        h('li', {}, 'Treffer mit „zu prüfen“ bestätigen oder verwerfen. Das macht die Auswertung schnell genauer.'),
        h('li', {}, 'Bei „nicht gefunden“ über „suchen“ selbst nachsehen und den Link zur Produktseite eintragen. Er wird sofort abgefragt und ab dann immer verwendet.'),
        h('li', {}, 'Bei großen Mitbewerbern unter Mitbewerber → „Kategorien eingrenzen“ nur die passenden Bereiche wählen. Das spart Zeit und vermeidet falsche Treffer.'),
        h('li', {}, 'Nur die Artikel beobachten, deren Preise dich wirklich interessieren.'))),

    sec('h-daten', 'Deine Daten und faires Verhalten',
      p('Alle Daten liegen auf deinem eigenen Server. Die Oberfläche lädt nichts von fremden Servern (keine Schriften, kein Tracking). An OpenAI gehen nur der Inhalt öffentlicher Mitbewerberseiten und die Produktangaben deines Artikels (Name, Marke, Nummern), keine Kunden- oder Bestelldaten. Von Google liest Preisradar nur Statistiken aus Search Console und Merchant Center, aus Shopware nur Artikel und Bestellsummen, jeweils mit reinem Lesezugriff. Kundendaten werden nicht übernommen. Zugangsdaten werden verschlüsselt gespeichert.'),
      p('Über den Claude-Zugang (', go('einstellungen', 'Einstellungen'), ') kannst du Preisradar auch im Gespräch mit Claude abfragen und bedienen. Preise in deinem Shop werden auch dort nie geändert.'))));
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
      h('tbody', {}, a.moves.map((m) => h('tr', { onclick: () => openDrawer(m.id) },
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
    sales: (x, y) => (y.revenue_90 ?? -1) * Math.max(0.1, Math.abs(y.gap_percent)) - (x.revenue_90 ?? -1) * Math.max(0.1, Math.abs(x.gap_percent)),
    demand: (x, y) => (y.impressions ?? -1) * Math.max(0.1, Math.abs(y.gap_percent)) - (x.impressions ?? -1) * Math.max(0.1, Math.abs(x.gap_percent)),
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
        return h('tr', { tabindex: 0, onclick: () => openDrawer(x.id) },
          h('td', { class: 'prod' }, h('div', { class: 'pname' }, x.name), h('div', { class: 'pmeta' }, [x.brand, x.number, x.units_30 != null ? `${nf.format(x.units_30)} verkauft (30 T)` : null, x.margin_percent != null ? `Marge ${nf1.format(x.margin_percent)} %` : null, x.impressions != null ? `${nf.format(x.impressions)} Impr. bei Google` : null].filter(Boolean).join(' · '))),
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
        [['gap', 'Größter Abstand in %'], ['diff', 'Größter Abstand in €'], ['sales', 'Umsatz × Abstand (Shopware)'], ['demand', 'Nachfrage × Abstand (Google)'], ['price', 'Preis absteigend'], ['name', 'Name']].map(([v, l]) => h('option', { value: v, selected: v === aState.sort }, l)))),
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
      kpiTile('Zu teuer', h('span', { 'data-count': k.senken }, String(k.senken)), k.gap_sum_down ? `${eur.format(k.gap_sum_down)} Differenz je Stück gesamt` : '', k.senken ? 'warm' : ''),
      kpiTile('Spielraum nach oben', h('span', { 'data-count': k.erhoehen }, String(k.erhoehen)), k.gap_sum_up ? `${eur.format(k.gap_sum_up)} je Stück gesamt` : '', 'cool')),
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
    h('p', { class: 'sub' }, 'In Shopware unter Einstellungen → System → Integrationen eine Integration anlegen. Lesezugriff genügt (für Shopware 6.7: Rolle mit Lesen auf Produkte, Steuersätze, Bestellungen inklusive Positionen und Status). Daraus kommen Preise, Einkaufspreise, Bestand sowie verkaufte Stück und Umsatz. Preisradar ändert in Shopware nichts, preisführend bleibt deine Warenwirtschaft. Das Secret wird verschlüsselt gespeichert und nie wieder angezeigt.'),
    cur.shopware_from_env ? h('p', { class: 'pmeta' }, 'Aktuell werden die Zugangsdaten aus der Server-Umgebung verwendet. Wenn du hier speicherst, gelten deine Eingaben.') : null,
    h('div', { class: 'grid' },
      f('Shopware-URL', 'shopware_url', cur.shopware_url, { type: 'url', ph: 'https://www.belkai.de' }),
      f('Client-ID', 'shopware_client_id', cur.shopware_client_id),
      f('Client-Secret', 'shopware_client_secret', '', { type: 'password', ph: cur.shopware_secret_set ? '•••••••• (gespeichert)' : '', hint: cur.shopware_secret_set ? 'Leer lassen, um das gespeicherte Secret zu behalten' : '' }),
      f('Mindestmarge (%)', 'min_margin', cur.min_margin, { type: 'number', hint: 'Untergrenze für Preisvorschläge: Marge auf den Nettoverkaufspreis. Wirkt nur, wenn ein Einkaufspreis vorliegt (aus Shopware oder per CSV).' })),
    h('p', { class: 'pmeta', id: 'swstatus' }, cur.sw_synced_at ? `Letzter Abgleich (Preise, Einkaufspreise, Bestand, Verkäufe): ${dt.format(new Date(cur.sw_synced_at))}. Danach automatisch täglich.` : 'Noch kein Abgleich. Er läuft nach dem Speichern automatisch einmal täglich.'),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => {
        out.hidden = false; out.textContent = 'Verbindung wird geprüft …';
        try { const r = await api('/api/settings/shopware/test', { body: vals() }); out.textContent = `Verbunden: ${r.products} aktive Produkte gefunden.`; }
        catch (e) { out.textContent = `Fehlgeschlagen: ${e.message}`; }
      }) }, 'Verbindung testen'),
      cur.shopware_secret_set || cur.shopware_from_env ? h('button', { class: 'btn', type: 'button', onclick: guard(async () => {
        await api('/api/shopware/sync', { method: 'POST', body: {} });
        out.hidden = false; out.textContent = 'Abgleich läuft …';
        const t = setInterval(guard(async () => {
          const st = await api('/api/shopware/status');
          if (st.job.running) return;
          clearInterval(t);
          out.textContent = st.job.error ? `Fehlgeschlagen: ${st.job.error}` : `Fertig: ${st.job.result.updated} Artikel aktualisiert, davon ${st.job.result.with_purchase} mit Einkaufspreis, ${st.job.result.sold_90} in 90 Tagen verkauft. ${st.job.result.unknown} Shopware-Artikel sind nicht im Preisradar.`;
        }), 3000);
      }) }, 'Jetzt abgleichen') : null,
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
      f('Modell', 'openai_model', cur.openai_model, { hint: `Name wie in der OpenAI-Modellliste, Standard: ${cur.openai_default_model}` }),
      f('KI-Anfragen pro Tag (Grenze)', 'ai_daily_limit', cur.ai_usage.limit, { type: 'number', hint: `Heute ${cur.ai_usage.today} von ${cur.ai_usage.limit} verbraucht. Ist die Grenze erreicht, arbeitet der Abruf bis Mitternacht ohne KI weiter. 0 = KI aus. Standard: ${cur.ai_daily_default}` })),
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
      f('Artikel je Mitbewerber und Paket', 'batch', sch.batch, { type: 'number', hint: 'Startmenge eines Laufs. Ist mehr fällig, arbeitet jeder Mitbewerber ohne Pause weiter (bis zu 25 Minuten am Stück).' }),
      f('Pause, wenn nichts fällig ist (Sekunden)', 'interval', sch.interval, { type: 'number', hint: 'Solange noch Artikel fällig sind, folgt der nächste Lauf nach 20 bis 40 Sekunden.' }),
      f('Zufälliger Aufschlag bis (Sekunden)', 'jitter', sch.jitter, { type: 'number' }),
      f('Mindestabstand je Artikel (Stunden)', 'refresh', sch.refresh, { type: 'number', hint: 'Mindestens 8. Jeder Artikel wird höchstens zweimal am Tag automatisch abgefragt.' }),
      f('Täglich geprüfte Artikel', 'tier_a_size', sch.tier_a_size, { type: 'number', hint: 'Die wichtigsten Artikel nach Verkäufen, Preisbewegung und Google-Nachfrage. Von Hand gesetzte kommen dazu.' }),
      f('Übrige Artikel alle … Tage', 'tier_b_days', sch.tier_b_days, { type: 'number', hint: 'Nicht gefundene Artikel werden wöchentlich erneut gesucht, nach vier erfolglosen Versuchen monatlich.' })),
    h('div', { class: 'grid', style: 'margin-top:8px' },
      f('Seiten-Check: eigene Seiten pro Tag', 'seo_pages_per_day', cur.seo_pages_per_day, { type: 'number', hint: '0 schaltet die Hintergrundprüfung ab. 3000 am Tag heißt etwa eine Seite alle 30 Sekunden, das merkt der Shop nicht.' })),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { const fd = Object.fromEntries(new FormData(plan)); const { seo_pages_per_day, ...schedule } = fd; await api('/api/settings', { method: 'PUT', body: { schedule, seo_pages_per_day } }); toast('Abrufplan gespeichert'); await refresh(); }) }, 'Speichern')));

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

  const m = cur.mail;
  const mout = h('div', { class: 'result', hidden: true });
  const mailVals = () => ({ ...Object.fromEntries(new FormData(mail)), mail_enabled: mail.elements.mail_enabled.checked, mail_secure: mail.elements.mail_secure.checked });
  const mail = h('form', { class: 'panel', id: 'mail-settings', onsubmit: (e) => e.preventDefault() },
    h('h3', {}, 'Tägliche Zusammenfassung per E-Mail'),
    h('p', { class: 'sub' }, 'Jeden Morgen eine kurze Mail: welche Mitbewerber seit gestern ihre Preise geändert haben (besonders, wer jetzt unter deinem Preis liegt), die wichtigsten Preissenkungs-Kandidaten nach Umsatz und Nachfrage, Spielraum nach oben, neu offline gegangene Artikel und die Google-Zahlen. Versand über deinen eigenen Mailserver (SMTP).'),
    h('div', { class: 'grid' },
      f('Empfänger', 'mail_to', m.to, { ph: 'marco@belkai.de, einkauf@belkai.de', hint: 'Mehrere Adressen mit Komma trennen' }),
      f('Versand um (Uhr)', 'mail_hour', m.hour, { type: 'number', hint: 'Volle Stunde, deutsche Zeit' }),
      f('Absender', 'mail_from', m.from, { ph: 'Preisradar <preisradar@belkai.de>' }),
      f('SMTP-Server', 'mail_host', m.host, { ph: 'smtp.belkai.de' }),
      f('Port', 'mail_port', m.port, { type: 'number', hint: '587 (STARTTLS) oder 465 (SSL)' }),
      f('Benutzer', 'mail_user', m.user),
      f('Passwort', 'mail_pass', '', { type: 'password', ph: m.pass_set ? '•••••••• (gespeichert)' : '', hint: m.pass_set ? 'Leer lassen, um das gespeicherte Passwort zu behalten' : '' })),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'mail_enabled', checked: m.enabled }), 'Täglich senden'),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'mail_secure', checked: m.secure }), 'SSL von Beginn an (Port 465)')),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('a', { class: 'btn', href: '/api/digest/preview', target: '_blank', rel: 'noopener' }, 'Vorschau ansehen'),
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => {
        await api('/api/settings', { method: 'PUT', body: mailVals() });
        mout.hidden = false; mout.textContent = 'Testmail wird gesendet …';
        try { const r = await api('/api/digest/test', { method: 'POST', body: {} }); mout.textContent = `Gesendet an ${r.to.join(', ')}: „${r.subject}“`; }
        catch (e) { mout.textContent = `Fehlgeschlagen: ${e.message}`; }
      }) }, 'Speichern und Testmail senden'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { await api('/api/settings', { method: 'PUT', body: mailVals() }); toast('E-Mail-Einstellungen gespeichert'); await refresh(); }) }, 'Speichern')),
    mout,
    m.last_sent ? h('p', { class: 'pmeta' }, `Zuletzt gesendet: ${dt.format(new Date(m.last_sent))}`) : null);

  const g = cur.seo.gsc;
  const gout = h('div', { class: 'result', hidden: true });
  const gsc = h('form', { class: 'panel', id: 'seo-settings', onsubmit: (e) => e.preventDefault() },
    h('h3', {}, 'Google Search Console'),
    h('p', { class: 'sub' }, 'Zeigt, wie oft deine Produktseiten bei Google erscheinen und angeklickt werden. Der Zugang läuft über ein Dienstkonto mit reinem Lesezugriff, der Schlüssel wird verschlüsselt gespeichert.'),
    h('details', { class: 'howto' }, h('summary', {}, 'So richtest du den Zugang ein (etwa 10 Minuten)'),
      h('ol', { class: 'plainlist' },
        h('li', {}, 'In der Google Cloud Console (console.cloud.google.com) ein Projekt wählen oder anlegen.'),
        h('li', {}, 'Unter „APIs und Dienste“ die „Google Search Console API“ aktivieren.'),
        h('li', {}, 'Unter „IAM und Verwaltung → Dienstkonten“ ein Dienstkonto anlegen (keine Rollen nötig) und unter „Schlüssel“ einen JSON-Schlüssel erstellen. Die Datei wird heruntergeladen.'),
        h('li', {}, 'In der Search Console die Property öffnen, „Einstellungen → Nutzer und Berechtigungen → Nutzer hinzufügen“: die E-Mail-Adresse des Dienstkontos (…@….iam.gserviceaccount.com) mit Berechtigung „Eingeschränkt“ eintragen.'),
        h('li', {}, 'Hier die Property eintragen und den Inhalt der JSON-Datei einfügen, speichern, „Verbindung testen“.'))),
    h('div', { class: 'grid' },
      f('Property', 'gsc_site', g.site, { ph: 'sc-domain:belkai.de', hint: 'Domain-Property: „sc-domain:belkai.de“. URL-Präfix-Property: „https://www.belkai.de/“ (mit / am Ende), genau wie in der Search Console.' }),
      h('div', { class: 'field', style: 'grid-column:1/-1' }, h('label', {}, 'Dienstkonto-Schlüssel (Inhalt der JSON-Datei)'),
        h('textarea', { name: 'gsc_service_account', rows: 4, placeholder: g.email ? `gespeichert für ${g.email} (leer lassen, um ihn zu behalten)` : '{ "type": "service_account", … }', spellcheck: 'false', autocomplete: 'off' }),
        g.email ? h('span', { class: 'hint' }, `Dienstkonto: ${g.email}. Diese Adresse muss in der Search Console als Nutzer eingetragen sein.`) : null)),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => {
        gout.hidden = false; gout.textContent = 'Verbindung wird geprüft …';
        try {
          const r = await api('/api/seo/gsc/test', { method: 'POST', body: {} });
          const want = cur.seo.gsc.site;
          const hit = r.sites.find((x) => x.site === want);
          gout.replaceChildren(h('div', {}, r.sites.length ? `Verbunden als ${r.email}. Zugriff auf: ${r.sites.map((x) => x.site).join(', ')}.` : `Verbunden als ${r.email}, aber noch ohne Zugriff auf eine Property. Bitte die Adresse in der Search Console als Nutzer eintragen.`),
            want && !hit && r.sites.length ? h('div', { class: 'warmtxt' }, `Die eingetragene Property „${want}“ ist nicht dabei. Bitte genau so schreiben wie oben aufgeführt.`) : null);
        } catch (e) { gout.textContent = e.message; }
      }) }, 'Verbindung testen'),
      g.configured ? h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await api('/api/seo/gsc/sync', { method: 'POST', body: {} }); toast('Abgleich gestartet'); }) }, 'Jetzt abgleichen') : null,
      g.email ? h('button', { class: 'btn danger', type: 'button', onclick: guard(async () => { if (confirm('Dienstkonto-Schlüssel entfernen?')) { await api('/api/settings', { method: 'PUT', body: { gsc_remove: true } }); toast('Schlüssel entfernt'); await refresh(); } }) }, 'Schlüssel entfernen') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(gsc)) }); toast('Search Console gespeichert'); await refresh(); }) }, 'Speichern')),
    gout,
    g.synced_at ? h('p', { class: 'pmeta' }, `Letzter Abgleich: ${dt.format(new Date(g.synced_at))}. Danach automatisch einmal täglich.`) : null);

  const mcCur = cur.merchant;
  const mcout = h('div', { class: 'result', hidden: true });
  const merchant = h('form', { class: 'panel', onsubmit: (e) => e.preventDefault() },
    h('h3', {}, 'Google Merchant Center'),
    h('p', { class: 'sub' }, 'Holt aus Google Shopping den Vergleichspreis anderer Händler, Googles Preisvorschläge und die Shops, die in deinen Kategorien sichtbar sind (so findest du weitere Mitbewerber). Nutzt dasselbe Dienstkonto wie die Search Console, nur lesend.'),
    h('details', { class: 'howto' }, h('summary', {}, 'So richtest du den Zugang ein'),
      h('ol', { class: 'plainlist' },
        h('li', {}, 'Zuerst oben unter „Google Search Console“ den Dienstkonto-Schlüssel hinterlegen.'),
        h('li', {}, 'In der Google Cloud Console im selben Projekt die „Merchant API“ aktivieren.'),
        h('li', {}, 'Im Merchant Center unter „Einstellungen → Personen und Zugriff“ die Adresse des Dienstkontos als Nutzer hinzufügen (Zugriff auf Berichte, z. B. Standard).'),
        h('li', {}, 'Die Konto-ID steht oben rechts im Merchant Center bzw. in der Adresszeile (Ziffern).'),
        h('li', {}, 'Optional: Google-Produktkategorie-IDs für die Wettbewerbsübersicht, z. B. aus der Google-Produkttaxonomie. Ohne Kategorien gibt es Vergleichspreise und Vorschläge, aber keine Mitbewerberliste.'))),
    h('div', { class: 'grid' },
      f('Merchant-Center-Konto-ID', 'mc_account', mcCur.account, { ph: '123456789' }),
      f('Land', 'mc_country', mcCur.country, { ph: 'DE' }),
      f('Kategorie-IDs (optional)', 'mc_categories', mcCur.categories, { ph: 'z. B. 574, 2206', hint: 'Bis zu 10, mit Komma getrennt. Für die Liste weiterer Mitbewerber.' })),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => {
        await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(merchant)) });
        mcout.hidden = false; mcout.textContent = 'Verbindung wird geprüft …';
        try { const r = await api('/api/merchant/test', { method: 'POST', body: {} }); mcout.textContent = `Verbunden als ${r.email}.${r.sample ? ` Beispiel-Angebot: ${r.sample}.` : ''}`; }
        catch (e) { mcout.textContent = e.message; }
      }) }, 'Speichern und testen'),
      mcCur.configured ? h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await api('/api/merchant/sync', { method: 'POST', body: {} }); toast('Abgleich gestartet'); }) }, 'Jetzt abgleichen') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(merchant)) }); toast('Merchant Center gespeichert'); await refresh(); }) }, 'Speichern')),
    mcout,
    mcCur.synced_at ? h('p', { class: 'pmeta' }, `Letzter Abgleich: ${dt.format(new Date(mcCur.synced_at))}. Danach automatisch täglich.`) : null);

  const kc = cur.keywords;
  const kwout = h('div', { class: 'result', hidden: true });
  const sel = (label, name, opts, value, hint) => h('div', { class: 'field' }, h('label', {}, label), h('select', { name }, opts.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t))), hint ? h('span', { class: 'hint' }, hint) : null);
  const kwPanel = h('form', { class: 'panel', id: 'kw-settings', onsubmit: (e) => e.preventDefault() },
    h('h3', {}, 'Keyword-Monitoring (DataForSEO)'),
    h('p', { class: 'sub' }, 'Die Google-Platzierungen kommen von DataForSEO, einem Anbieter für Suchergebnis-Daten. Google selbst fragt Preisradar nicht ab, weil Google das für Programme sperrt. Abgerechnet wird nach Verbrauch: für 200 Keywords mit 50 Ergebnissen täglich etwa 18 € im Monat, wöchentlich etwa 3 €. Dazu einmalig rund 2 Cent je Shop für Vorschläge.'),
    h('details', { class: 'howto' }, h('summary', {}, 'So richtest du den Zugang ein'),
      h('ol', { class: 'plainlist' },
        h('li', {}, 'Auf dataforseo.com ein Konto anlegen und Guthaben aufladen (Mindestbetrag laut Anbieter, kein Abo).'),
        h('li', {}, 'Im Dashboard unter „API Access“ stehen API-Login (deine E-Mail) und API-Passwort. Das API-Passwort ist nicht dein Konto-Passwort.'),
        h('li', {}, 'Beides hier eintragen und „Speichern und testen“ klicken. Danach werden alle Keywords täglich zur eingestellten Uhrzeit geprüft.'))),
    h('div', { class: 'grid' },
      f('API-Login', 'dfs_login', kc.login, { ph: 'name@firma.de' }),
      f('API-Passwort', 'dfs_password', '', { type: 'password', ph: kc.password_set ? 'gespeichert (leer lassen = behalten)' : '' }),
      sel('Gerät', 'kw_device', [['desktop', 'Desktop'], ['mobile', 'Smartphone']], kc.device),
      sel('Ergebnisse prüfen', 'kw_depth', [[10, 'Top 10'], [20, 'Top 20'], [30, 'Top 30'], [50, 'Top 50']], kc.depth, 'Abgerechnet wird je 10 Ergebnisse.'),
      sel('Rhythmus', 'kw_every_days', [[1, 'täglich'], [2, 'alle 2 Tage'], [3, 'alle 3 Tage'], [7, 'wöchentlich']], kc.every_days),
      f('Ab Uhrzeit (Stunde)', 'kw_hour', kc.hour, { type: 'number', hint: 'Die Ergebnisse kommen meist innerhalb einiger Minuten.' })),
    h('p', { class: 'pmeta' }, kc.own_host ? `Eigene Domain: ${kc.own_host} (aus der Shop-URL oben).` : 'Bitte oben die Shop-URL eintragen, damit Preisradar deine Platzierung erkennt.'),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => {
        await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(kwPanel)) });
        kwout.hidden = false; kwout.textContent = 'Verbindung wird geprüft …';
        try { const r = await api('/api/keywords/test', { method: 'POST', body: {} }); kwout.textContent = `Verbunden als ${r.login}.${r.balance != null ? ` Guthaben: ${Number(r.balance).toFixed(2).replace('.', ',')} US-$.` : ''}`; await refresh(); }
        catch (e) { kwout.textContent = e.message; }
      }) }, 'Speichern und testen'),
      kc.configured && !kc.from_env ? h('button', { class: 'btn danger', type: 'button', onclick: guard(async () => { if (confirm('DataForSEO-Zugang entfernen? Die bisherigen Platzierungen bleiben erhalten.')) { await api('/api/settings', { method: 'PUT', body: { dfs_remove: true } }); toast('Zugang entfernt'); await refresh(); } }) }, 'Zugang entfernen') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: guard(async () => { await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(kwPanel)) }); toast('Keyword-Monitoring gespeichert'); await refresh(); }) }, 'Speichern')),
    kwout);

  const pw = h('form', { class: 'panel', onsubmit: (e) => e.preventDefault() },
    h('h3', {}, 'Passwort ändern'),
    h('div', { class: 'grid' }, f('Aktuelles Passwort', 'current', '', { type: 'password' }), f('Neues Passwort (mind. 10 Zeichen)', 'password', '', { type: 'password' })),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: guard(async () => { await api('/api/auth/password', { body: Object.fromEntries(new FormData(pw)) }); pw.reset(); toast('Passwort geändert'); }) }, 'Passwort ändern')));
  const up = h('div', { id: 'userpanel' }, await userPanel());
  root.append(h('div', { class: 'settings' }, h('h2', {}, 'Einstellungen'), form, plan, await channelSettingsPanel(), ebaySettingsPanel(cur, f), mail, ki, gsc, merchant, kwPanel, mcp, up, pw));
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
      h('button', { class: 'btn primary small', 'aria-label': 'Preise jetzt abrufen', onclick: guard(async () => { const r = await api('/api/scrape', { body: {} }); toast(r.total ? `Abruf gestartet (${r.total} Prüfungen)` : 'Alles aktuell, nichts zu prüfen'); await refresh(); }) }, h('span', { class: 'long' }, 'Preise jetzt abrufen'), h('span', { class: 'short' }, 'Abrufen')));
  }
}

// ---------- Rahmen ----------
function setTab(t) { state.tab = t; closeDrawer(); render(); }
document.getElementById('tabs').addEventListener('click', (e) => { const t = e.target.closest('button')?.dataset.tab; if (t) setTab(t); });

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Einstieg in einen Bereich: Inhalte gestaffelt einblenden, Zahlen hochzählen (nur beim Wechsel, nicht beim Aktualisieren). */
function enterAnim(main) {
  if (reducedMotion()) return;
  main.classList.remove('enter');
  void main.offsetWidth; // Animation neu starten
  main.classList.add('enter');
  clearTimeout(enterAnim.t);
  enterAnim.t = setTimeout(() => main.classList.remove('enter'), 1600);
  for (const el of main.querySelectorAll('[data-count]')) countUp(el);
}
function countUp(el) {
  const to = Number(el.dataset.count);
  if (!Number.isFinite(to) || to < 2) return;
  const t0 = performance.now(), dur = 900;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString('de-DE');
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let renderSeq = 0;
let renderedTab = null;
/**
 * Bereich neu zeichnen ohne Aufblitzen: Bereiche, die erst Daten laden (Lagebild, Analyse, Import, Einstellungen),
 * werden abseits der Seite aufgebaut und erst ausgetauscht, wenn sie fertig sind. Bis dahin bleibt der alte Inhalt stehen.
 */
function render() {
  if (!state.data) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  renderRunbar();
  const main = document.getElementById('main');
  const sameTab = renderedTab === state.tab;
  const keepMain = main.scrollTop;
  const keepWin = window.scrollY;
  const seq = ++renderSeq;
  const done = () => {
    window.__preloaderDone?.();
    if (!sameTab) enterAnim(main);
    renderedTab = state.tab;
    if (sameTab) { main.scrollTop = keepMain; window.scrollTo(0, keepWin); } else { main.scrollTop = 0; window.scrollTo(0, 0); }
  };
  const fail = (e) => { if (!(e instanceof AuthError)) toast(e.message, true); };
  const asyncTabs = { start: renderStart, analyse: renderAnalysis, sichtbarkeit: renderSeo, keywords: renderKeywords, seitencheck: renderSeoCheck, ebay: renderEbay, chancen: renderChancen, einstellungen: renderSettings, import: renderImport };
  const fn = asyncTabs[state.tab] ?? (state.tab === 'mitbewerber' ? null : asyncTabs.import);
  if (state.tab === 'preise' || state.tab === 'hilfe' || state.tab === 'mitbewerber') {
    main.replaceChildren();
    if (state.tab === 'preise') renderPrices(main);
    else if (state.tab === 'hilfe') renderHelp(main);
    else renderCompetitors(main);
    done();
    return;
  }
  if (!sameTab) { main.setAttribute('aria-busy', 'true'); main.replaceChildren(h('div', { class: 'mainload' }, miniRadar(TAB_LOADING[state.tab] ?? 'Wird geladen'))); }
  const box = document.createElement('div');
  Promise.resolve(fn(box)).then(() => {
    if (seq !== renderSeq) return; // inzwischen anderer Bereich gewählt
    main.replaceChildren(...box.childNodes);
    main.removeAttribute('aria-busy');
    done();
  }).catch((e) => { main.removeAttribute('aria-busy'); fail(e); });
}

let pollTimer;
async function refresh({ poll = false } = {}) {
  const scrollY = window.scrollY;
  state.data = await api(`/api/overview${state.scope ? `?scope=${state.scope}` : ''}`);
  state.scope = state.data.scope;
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.getElementById('main').contains(document.activeElement);
  if (state.tab === 'preise' && document.getElementById('rows')) { renderRunbar(); loadRows(true, { keep: true }); } // geladene Zeilen und Scrollposition behalten
  else if (typing || (poll && state.tab !== 'start')) renderRunbar(); // Formulare nicht beim Abruf-Fortschritt neu aufbauen
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
      if (!st.running || ++ticks % 7 === 0) { clearInterval(pollTimer); await refresh({ poll: true }); }
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
boot().catch((e) => { window.__preloaderDone?.(); toast(e.message, true); });
