/* ML Paper Atlas — static deck.gl app (no build step, loaded from CDN).
 * Data: data/<profile>/{meta.json, points.bin, aux.bin, terrain.png, cards/, edges/, search/, ids/}
 * URL params: ?profile=m1|m2, ?paper=<arXiv id>, ?q=<query>
 *
 * Performance notes: layer data objects and extensions are created once and reused, so a
 * view change only updates uniforms (re-creating them per frame re-uploads 600k+ points).
 * Only render-critical columns load up front; the rest is fetched lazily in shards.
 */
const {Deck, OrthographicView, ScatterplotLayer, TextLayer, LineLayer, BitmapLayer, LinearInterpolator,
  DataFilterExtension} = deck;

const PROFILE = new URLSearchParams(location.search).get('profile') || 'm2';
const BASE = `data/${PROFILE}/`;
const CAT_RGB = [[91, 192, 235], [253, 231, 76], [155, 197, 61], [229, 89, 52], [250, 121, 33],
  [193, 123, 224], [242, 95, 156], [61, 218, 180], [150, 150, 150]];
const LABEL_SIZE = [28, 21, 17, 15.5, 14.5];
const MAX_LINES = 300;
const FILTER = new DataFilterExtension({filterSize: 1, categorySize: 1});
const ADDITIVE = {depthCompare: 'always', blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one'};
const TYPES = {float32: Float32Array, uint8: Uint8Array, uint16: Uint16Array};
const $ = (id) => document.getElementById(id);

const S = {
  meta: null, n: 0, cols: {}, aux: null, viewState: null, z0: 0,
  y0: 0, y1: 0, soft: null, venues: new Set(), venueList: [],
  selected: null, edgeLines: [], playing: false,
  cards: new Map(), edgeShards: new Map(), searchShards: new Map(), idShards: new Map(),
};

const fetchJSON = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); });
const fetchBuf = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); });

function readColumns(buf, spec, n) {
  const out = {};
  for (const [k, c] of Object.entries(spec)) out[k] = new TYPES[c.dtype](buf, c.offset, n);
  return out;
}

async function main() {
  $('stats').textContent = 'Loading map…';
  const [meta, buf] = await Promise.all([fetchJSON(BASE + 'meta.json'), fetchBuf(BASE + 'points.bin')]);
  S.meta = meta; S.n = meta.count;
  S.cols = readColumns(buf, meta.columns, S.n);
  decodeColumns();
  buildLayerData();
  initView();
  initControls();
  render();
  loadAux();  // topic paths and search ranking need it; not needed for the first frame
  deepLink();
}

/* days since epoch → fractional year; sqrt-coded citations → counts (-1 = unknown) */
function decodeColumns() {
  const {t, cq} = S.cols, n = S.n, m = S.meta;
  const epoch = Date.UTC(1990, 0, 1) / 864e5;
  const yearStart = [];
  for (let y = 1990; y <= 2100; y++) yearStart.push(Date.UTC(y, 0, 1) / 864e5 - epoch);
  const year = new Float32Array(n), cites = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const d = t[i];
    y = 0;
    while (yearStart[y + 1] <= d) y++;
    year[i] = 1990 + y + (d - yearStart[y]) / (yearStart[y + 1] - yearStart[y]);
    cites[i] = cq[i] === m.cite_unknown ? -1 : (cq[i] / 100) ** 2;
  }
  S.cols.year = year; S.cols.cites = cites;
  S.tMin = year.reduce((a, b) => (b < a ? b : a), Infinity); S.tMax = year.reduce((a, b) => (b > a ? b : a), 0);
}

function buildLayerData() {
  const {x, y, year, cites, cat, venue} = S.cols;
  const n = S.n, tMin = S.tMin, tMax = S.tMax;
  const pos = new Float32Array(n * 2), col = new Uint8Array(n * 4), rad = new Float32Array(n), vf = new Float32Array(n);
  const [bx0, by0, bx1, by1] = S.meta.bounds;
  const unit = Math.max(bx1 - bx0, by1 - by0) / 2500;
  const recent = [];
  for (let i = 0; i < n; i++) {
    pos[2 * i] = x[i]; pos[2 * i + 1] = y[i];
    const c = CAT_RGB[cat[i]] || CAT_RGB[8];
    const age = (year[i] - tMin) / Math.max(tMax - tMin, 1e-6);  // 0 = oldest
    col[4 * i] = c[0]; col[4 * i + 1] = c[1]; col[4 * i + 2] = c[2];
    col[4 * i + 3] = 70 + 185 * Math.pow(age, 1.6);
    rad[i] = unit * (0.7 + 0.32 * Math.cbrt(Math.max(0, cites[i])));  // radius ∝ citations^(1/3)
    vf[i] = venue[i];
    if (tMax - year[i] <= 30 / 366) recent.push(i);
  }
  S.pointsData = {length: n, attributes: {
    getPosition: {value: pos, size: 2}, getFillColor: {value: col, size: 4}, getRadius: {value: rad, size: 1},
    getFilterValue: {value: year, size: 1}, getFilterCategory: {value: vf, size: 1}}};
  // glow for papers from the last 30 days
  const g = recent.length, gp = new Float32Array(g * 2), gc = new Uint8Array(g * 4), gr = new Float32Array(g);
  const gt = new Float32Array(g), gv = new Float32Array(g);
  recent.forEach((i, k) => {
    gp[2 * k] = x[i]; gp[2 * k + 1] = y[i];
    const c = CAT_RGB[cat[i]] || CAT_RGB[8];
    gc.set([c[0], c[1], c[2], 60], 4 * k);
    gr[k] = rad[i] * 3.2; gt[k] = year[i]; gv[k] = venue[i];
  });
  S.glowData = {length: g, attributes: {
    getPosition: {value: gp, size: 2}, getFillColor: {value: gc, size: 4}, getRadius: {value: gr, size: 1},
    getFilterValue: {value: gt, size: 1}, getFilterCategory: {value: gv, size: 1}}};
}

function loadAux() {
  if (!S.auxPromise) {
    S.auxPromise = fetchBuf(BASE + 'aux.bin').then((buf) => { S.aux = readColumns(buf, S.meta.aux_columns, S.n); return S.aux; });
  }
  return S.auxPromise;
}

function initView() {
  const [x0, y0, x1, y1] = S.meta.bounds;
  const el = $('map');
  const w = el.clientWidth - 320, h = el.clientHeight;
  const zoom = Math.log2(Math.min(w / (x1 - x0), h / (y1 - y0))) - 0.15;
  S.z0 = zoom;
  S.viewState = {target: [(x0 + x1) / 2 - 160 / Math.pow(2, zoom), (y0 + y1) / 2, 0], zoom, minZoom: zoom - 2, maxZoom: zoom + 9};
  S.deck = new Deck({
    parent: el,
    views: new OrthographicView({id: 'ortho', flipY: false}),
    viewState: S.viewState,
    controller: {doubleClickZoom: true, inertia: true},
    useDevicePixels: Math.min(window.devicePixelRatio || 1, 1.5),
    onViewStateChange: ({viewState}) => { S.viewState = viewState; render(); },
    getCursor: ({isHovering}) => (isHovering ? 'pointer' : 'grab'),
    onClick: (info) => { if (!info.picked) select(null); },
  });
}

function currentLevel() {
  const L = S.meta.levels;
  const lv = Math.floor((S.viewState.zoom - S.z0 + 0.4) / (L <= 3 ? 1.6 : 1.2));
  return Math.max(0, Math.min(L - 1, lv));
}

function render() {
  const dz = S.viewState.zoom - S.z0;
  const radiusScale = Math.pow(2, -0.6 * Math.max(0, dz));  // points grow gently when zooming in
  const range = [S.y0, S.soft ?? S.y1 + 1];
  const filter = {
    extensions: [FILTER], filterRange: range, filterCategories: S.venueList,
    filterSoftRange: S.soft != null ? [S.y0, S.soft - 0.6] : range,
  };
  const lv = currentLevel();
  const layers = [
    new BitmapLayer({
      id: 'terrain', image: BASE + 'terrain.png', bounds: S.meta.terrain_bounds,
      opacity: Math.max(0.12, Math.min(1, 1.15 - dz * 0.28)),
    }),
    new ScatterplotLayer({
      id: 'glow', data: S.glowData, radiusUnits: 'common', radiusScale, radiusMinPixels: 2.5, radiusMaxPixels: 22,
      stroked: false, parameters: ADDITIVE, ...filter,
    }),
    new ScatterplotLayer({
      id: 'points', data: S.pointsData, radiusUnits: 'common', radiusScale, radiusMinPixels: 0.55, radiusMaxPixels: 48,
      stroked: false, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 230],
      onHover: hover, onClick: (info) => { if (info.index >= 0) select(info.index); return true; },
      ...filter,
    }),
    new LineLayer({
      id: 'cites', data: S.edgeLines, getSourcePosition: (d) => d.s, getTargetPosition: (d) => d.t,
      getColor: (d) => (d.out ? [140, 190, 255, 120] : [255, 210, 122, 130]), getWidth: 1, widthUnits: 'pixels',
      parameters: ADDITIVE,
    }),
    new ScatterplotLayer({
      id: 'cite-ends', data: S.edgeLines, getPosition: (d) => d.t,
      getFillColor: (d) => (d.out ? [190, 220, 255, 230] : [255, 225, 160, 230]), getRadius: 2.2, radiusUnits: 'pixels',
    }),
    new ScatterplotLayer({
      id: 'selected', data: S.selectedData || [], getPosition: (i) => [S.cols.x[i], S.cols.y[i]],
      getFillColor: [255, 255, 255, 40], getLineColor: [255, 255, 255, 255], stroked: true, lineWidthUnits: 'pixels',
      getLineWidth: 1.5, getRadius: 9, radiusUnits: 'pixels',
    }),
    new TextLayer({
      id: `labels-${lv}`, data: placeLabels(lv),
      getPosition: (d) => [d.x, d.y], getText: (d) => d.text,
      getSize: LABEL_SIZE[lv] ?? 14, sizeUnits: 'pixels', getColor: lv === 0 ? [255, 255, 255, 255] : [240, 243, 248, 245],
      fontFamily: 'Inter, system-ui, sans-serif', fontWeight: lv === 0 ? 700 : 600, characterSet: 'auto',
      fontSettings: {sdf: true, fontSize: 64, buffer: 6}, outlineWidth: 7, outlineColor: [0, 0, 0, 255], lineHeight: 1.1,
    }),
  ];
  S.deck.setProps({viewState: S.viewState, layers});
}

/* ---------- label placement ----------
 * Boxes are computed in screen space: largest clusters first, labels that would overlap are dropped.
 * The result is memoized per view so unrelated re-renders (e.g. year playback) reuse the same array. */
const wrapCache = new Map();
function wrapLabel(name, size) {
  const key = name + '|' + size;
  if (!wrapCache.has(key)) {
    const maxChars = 22, lines = [];
    let cur = '';
    for (const w of name.split(/\s+/)) {
      if (cur && (cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) lines.push(cur);
    const width = Math.max(...lines.map((l) => l.length)) * size * 0.6, height = lines.length * size * 1.32;
    wrapCache.set(key, {text: lines.join('\n'), width, height});
  }
  return wrapCache.get(key);
}

let labelMemo = {key: '', data: []};
function placeLabels(lv) {
  const vs = S.viewState, el = $('map'), W = el.clientWidth, H = el.clientHeight;
  const key = `${lv}|${vs.zoom.toFixed(4)}|${vs.target[0].toFixed(5)}|${vs.target[1].toFixed(5)}|${W}x${H}`;
  if (labelMemo.key === key) return labelMemo.data;
  const size = LABEL_SIZE[lv] ?? 14, scale = Math.pow(2, vs.zoom), pad = 8;
  const placed = [], out = [];
  const cand = S.meta.labels.filter((l) => l.l === lv).sort((a, b) => b.n - a.n);
  for (const l of cand) {
    const sx = (l.x - vs.target[0]) * scale + W / 2, sy = H / 2 - (l.y - vs.target[1]) * scale;
    const w = wrapLabel(l.name, size);
    const box = [sx - w.width / 2 - pad, sy - w.height / 2 - pad, sx + w.width / 2 + pad, sy + w.height / 2 + pad];
    if (box[2] < 0 || box[0] > W || box[3] < 0 || box[1] > H) continue;
    if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    out.push({x: l.x, y: l.y, text: w.text});
  }
  labelMemo = {key, data: out};
  return out;
}

/* ---------- lazily loaded shards ---------- */
function cached(map, key, load) {
  if (!map.has(key)) map.set(key, load().catch((e) => { map.delete(key); throw e; }));
  return map.get(key);
}

async function card(i) {
  const k = Math.floor(i / S.meta.shard);
  const sh = await cached(S.cards, k, () => fetchJSON(`${BASE}cards/${String(k).padStart(3, '0')}.json`));
  const j = i - sh.start;
  return {id: sh.id[j], title: sh.title[j], authors: sh.authors[j], date: sh.date[j], cites: sh.cites[j]};
}

async function neighbors(i) {
  const k = Math.floor(i / S.meta.shard);
  const u = await cached(S.edgeShards, k, () => fetchBuf(`${BASE}edges/${String(k).padStart(3, '0')}.bin`).then((b) => new Uint32Array(b)));
  const m = u[0], j = i - k * S.meta.shard;
  const outOff = u.subarray(1, m + 2), inOff = u.subarray(m + 2, 2 * m + 3), base = 2 * m + 3;
  const outIds = u.subarray(base + outOff[j], base + outOff[j + 1]);
  const inBase = base + outOff[m];
  return {out: outIds, in: u.subarray(inBase + inOff[j], inBase + inOff[j + 1])};
}

const idKey = (s) => s.toLowerCase().replace(/[^0-9a-z]/g, '');
async function rowOfId(arxivId) {
  const key = idKey(arxivId), sk = key.slice(0, 4);
  if (!S.meta.id_shards.includes(sk)) return null;
  const sh = await cached(S.idShards, sk, () => fetchJSON(`${BASE}ids/${sk}.json`));
  return sh[key] ?? null;
}

/* ?paper=<arXiv id> opens a paper, ?q=<query> fills the search box */
async function deepLink() {
  const sp = new URLSearchParams(location.search);
  if (sp.get('q')) { $('q').value = sp.get('q'); onSearch(); }
  if (sp.get('paper')) {
    const i = await rowOfId(sp.get('paper'));
    if (i != null) flyTo(i);
  }
}

let hoverToken = 0;
async function hover(info) {
  const tip = $('tooltip');
  if (info.index == null || info.index < 0) { tip.hidden = true; return; }
  const tok = ++hoverToken;
  const c = await card(info.index);
  if (tok !== hoverToken) return;
  tip.innerHTML = `${esc(c.title)}<br><small>${c.date.slice(0, 4)} · ${esc(S.meta.venues[S.cols.venue[info.index]])}</small>`;
  tip.style.left = `${info.x + 14}px`; tip.style.top = `${info.y + 14}px`;
  tip.hidden = false;
}

/* ---------- selection: card + citation lines ---------- */
async function select(i) {
  S.selected = i;
  S.selectedData = i == null ? [] : [i];
  if (i == null) { $('card').hidden = true; S.edgeLines = []; render(); return; }
  const [c, nb, aux] = await Promise.all([card(i), neighbors(i), loadAux()]);
  if (S.selected !== i) return;
  const X = S.cols.x, Y = S.cols.y, C = S.cols.cites;
  const lines = [];
  for (const o of nb.out) lines.push({s: [X[i], Y[i]], t: [X[o], Y[o]], out: true, o});
  for (const o of nb.in) lines.push({s: [X[i], Y[i]], t: [X[o], Y[o]], out: false, o});
  // too many lines wash the screen out: keep the ones whose other end is most cited
  const shown = lines.length > MAX_LINES ? lines.sort((a, b) => C[b.o] - C[a.o]).slice(0, MAX_LINES) : lines;
  S.edgeLines = shown;
  const m = S.meta;
  const path = [];
  for (let l = 0; l < m.levels; l++) {
    const id = aux[`l${l}`][i];
    const lab = m.labels.find((x) => x.l === l && x.id === id);
    if (lab) path.push(esc(lab.name));
  }
  $('cardBody').innerHTML = `
    <h3>${esc(c.title)}</h3>
    <div class="authors">${esc(c.authors)}</div>
    <dl>
      <dt>Date</dt><dd>${c.date}</dd>
      <dt>Venue</dt><dd>${esc(m.venues[S.cols.venue[i]])}</dd>
      <dt>Citations</dt><dd>${c.cites == null ? 'not yet known' : c.cites.toLocaleString('en-US')}</dd>
      <dt>Category</dt><dd>${m.categories[S.cols.cat[i]]}</dd>
      <dt>Links</dt><dd><span style="color:#8cbeff">${nb.out.length} references</span> · <span style="color:#ffd27a">${nb.in.length} cited by</span>
        <small>(within this map${lines.length > shown.length ? `; showing the ${shown.length} most-cited` : ''})</small></dd>
    </dl>
    <div class="topics">${path.join(' › ')}</div>
    <p><a href="https://arxiv.org/abs/${c.id}" target="_blank" rel="noopener">arXiv:${c.id} ↗</a></p>`;
  $('card').hidden = false;
  render();
}

function flyTo(i) {
  S.viewState = {...S.viewState, target: [S.cols.x[i], S.cols.y[i], 0], zoom: Math.max(S.viewState.zoom, S.z0 + 4.5),
    transitionDuration: 900, transitionInterpolator: new LinearInterpolator(['target', 'zoom'])};
  render();
  select(i);
}

/* ---------- search ----------
 * Inverted index of title tokens and author surnames, sharded by the first two letters; only the
 * shards for the query's tokens are fetched. Each term matches by prefix; terms are intersected.
 * Ranking: title equals the query > exact token matches > prefix matches, then citations. */
const STOP = new Set('a an and are as at be by for from in into is of on or the to with via using towards toward we our its their this that'.split(' '));
const ARXIV_ID = /^\s*(arxiv:)?\s*(\d{4}\.\d{4,5}|[a-z-]+(\.[a-z]{2})?\/\d{7})(v\d+)?\s*$/i;

function searchShard(k) {
  if (!S.meta.search_shards.includes(k)) return Promise.resolve({});
  return cached(S.searchShards, k, () => fetchJSON(`${BASE}search/${k}.json`));
}

async function renderResults(top, total, seq) {
  const ul = $('results');
  const cards = await Promise.all(top.map(card));
  if (seq !== searchSeq) return;
  ul.innerHTML = top.length ? '' : '<li><small>No results</small></li>';
  if (total > top.length) ul.innerHTML = `<li><small>Top ${top.length} of ${total.toLocaleString('en-US')} (title match, then citations)</small></li>`;
  top.forEach((i, k) => {
    const li = document.createElement('li');
    const ci = cards[k].cites;
    li.innerHTML = `${esc(cards[k].title)}<small>${cards[k].date.slice(0, 4)} · ${esc(S.meta.venues[S.cols.venue[i]])}${ci != null ? ' · ' + ci.toLocaleString('en-US') + ' citations' : ''}</small>`;
    li.onclick = () => flyTo(i);
    ul.appendChild(li);
  });
}

let searchTimer, searchSeq = 0;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const ul = $('results'), q = $('q').value;
    const idm = q.match(ARXIV_ID);
    if (idm) {
      const i = await rowOfId(idm[2]);
      if (seq === searchSeq) renderResults(i == null ? [] : [i], i == null ? 0 : 1, seq);
      return;
    }
    const uniq = [...new Set((q.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 2 && !STOP.has(w)))];
    if (!uniq.length) { ul.innerHTML = ''; return; }
    ul.innerHTML = '<li><small>Searching…</small></li>';
    let hits = null, exact = null;
    for (const w of uniq) {
      const sh = await searchShard(w.slice(0, 2));
      const set = new Set(), ex = new Set(sh[w] || []);
      for (const [tok, ids] of Object.entries(sh)) if (tok.startsWith(w)) for (const i of ids) set.add(i);
      hits = hits ? new Set([...hits].filter((i) => set.has(i))) : set;
      exact = exact ? new Set([...exact].filter((i) => ex.has(i))) : ex;
      if (!hits.size) break;
    }
    const aux = await loadAux();
    if (seq !== searchSeq) return;
    const C = S.cols.cites, T = S.cols.year, NT = aux.ntok;
    const score = (i) => {
      let s = Math.log10(1 + Math.max(0, C[i])) * 0.8;
      if (exact.has(i)) s += 2 - 0.15 * Math.max(0, NT[i] - uniq.length) + (NT[i] === uniq.length ? 5 : 0);
      return s;
    };
    const top = [...hits].map((i) => [score(i), i]).sort((a, b) => (b[0] - a[0]) || (T[b[1]] - T[a[1]]))
      .slice(0, 30).map((x) => x[1]);
    renderResults(top, hits.size, seq);
  }, 200);
}

/* ---------- year slider, playback, venue filter ---------- */
function initControls() {
  const m = S.meta;
  const yMin = Math.floor(S.tMin), yMax = Math.floor(S.tMax);
  for (const id of ['y0', 'y1']) { $(id).min = yMin; $(id).max = yMax; }
  $('y0').value = S.y0 = yMin; $('y1').value = S.y1 = yMax;
  const onRange = () => {
    let a = +$('y0').value, b = +$('y1').value;
    if (a > b) [a, b] = [b, a];
    S.y0 = a; S.y1 = b; S.soft = null; updateYearText(); render();
  };
  $('y0').oninput = onRange; $('y1').oninput = onRange;
  $('reset').onclick = () => { stop(); $('y0').value = yMin; $('y1').value = yMax; onRange(); };
  $('play').onclick = () => (S.playing ? stop() : play(yMax));
  updateYearText();

  // venues arrive ordered: named venues by paper count, then Workshop / Other venue / Preprint only / Not checked yet
  const order = m.venues.map((v, i) => i);
  const box = $('venues');
  const SPECIAL = new Set(['Workshop', 'Other venue', 'Preprint only', 'Not checked yet']);
  let named = 0;
  for (const i of order) {
    if (!m.venue_counts[i]) continue;
    S.venues.add(i);
    const lab = document.createElement('label');
    const special = SPECIAL.has(m.venues[i]);
    if (!special && ++named > 18) lab.className = 'more';  // long tail hidden until "Show all"
    if (special) lab.classList.add('special');
    lab.innerHTML = `<input type="checkbox" checked data-v="${i}"> ${esc(m.venues[i])} <small>${compact(m.venue_counts[i])}</small>`;
    box.appendChild(lab);
  }
  if (named > 18) {
    const more = document.createElement('button');
    more.className = 'link'; more.type = 'button'; more.textContent = `Show all ${named} venues`;
    more.onclick = () => { box.classList.toggle('expanded'); more.textContent = box.classList.contains('expanded') ? 'Show fewer' : `Show all ${named} venues`; };
    box.after(more);
  }
  const syncVenues = () => { S.venueList = [...S.venues]; render(); };
  box.onchange = (e) => {
    const v = +e.target.dataset.v;
    e.target.checked ? S.venues.add(v) : S.venues.delete(v);
    syncVenues();
  };
  const setAll = (on) => {
    box.querySelectorAll('input').forEach((el) => { el.checked = on; const v = +el.dataset.v; on ? S.venues.add(v) : S.venues.delete(v); });
    syncVenues();
  };
  $('vAll').onclick = () => setAll(true);
  $('vNone').onclick = () => setAll(false);
  S.venueList = [...S.venues];

  $('legend').innerHTML = m.categories.slice(0, 8).map((c, i) =>
    `<span><i style="background:rgb(${CAT_RGB[i]});color:rgb(${CAT_RGB[i]})"></i>${c}</span>`).join('');
  $('stats').textContent = `${S.n.toLocaleString('en-US')} papers · ${PROFILE.toUpperCase()} · ${m.edges.toLocaleString('en-US')} citation links`;
  $('citeNote').textContent = m.citations_ready < 0.99
    ? `Citation counts are ${(m.citations_ready * 100).toFixed(0)}% loaded (papers without data are drawn at minimum size).` : '';
  $('q').oninput = onSearch;
  $('cardClose').onclick = () => select(null);
}

function updateYearText() {
  const shown = S.soft != null ? Math.floor(S.soft) : S.y1;
  $('yearText').textContent = S.y0 === shown ? `${S.y0}` : `${S.y0} – ${shown}`;
}

function play(yMax) {
  S.playing = true; $('play').textContent = '■ Stop';
  const span = yMax + 1 - S.y0, dur = Math.min(14000, Math.max(5000, span * 900));
  const t0 = performance.now(), start = S.y0;
  const step = (now) => {
    if (!S.playing) return;
    const p = Math.min(1, (now - t0) / dur);
    S.soft = start + 0.6 + p * (yMax + 1 - start);
    updateYearText(); render();
    if (p < 1) requestAnimationFrame(step); else stop();
  };
  requestAnimationFrame(step);
}

function stop() {
  S.playing = false; S.soft = null; $('play').textContent = '▶ Play';
  updateYearText(); render();
}

function compact(n) { return n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : n.toLocaleString('en-US'); }

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }

main().catch((e) => { $('stats').textContent = 'Failed to load: ' + e.message; console.error(e); });
