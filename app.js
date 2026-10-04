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
// map labels: a clean, legible sans in sentence case; size and weight step down with depth
const LABEL_FONT = '"Manrope", "Inter", system-ui, sans-serif';
const LABEL_STYLE = [
  {size: 26, weight: 700, color: [255, 255, 255, 245]},
  {size: 19, weight: 700, color: [245, 247, 250, 240]},
  {size: 16, weight: 600, color: [236, 240, 245, 235]},
  {size: 14.5, weight: 600, color: [230, 235, 242, 230]},
  {size: 13.5, weight: 600, color: [226, 232, 240, 225]},
];
const labelStyle = (lv) => LABEL_STYLE[Math.min(lv, LABEL_STYLE.length - 1)];
const MAX_LINES = 300;
const FILTER = new DataFilterExtension({filterSize: 4, categorySize: 1});  // [year, citation pct, age-adjusted pct, in focus set]
const PCT_STEPS = [100, 50, 25, 10, 5, 2, 1, 0.5, 0.1];  // slider positions: show the top N% of papers
const ADDITIVE = {depthCompare: 'always', blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one'};
const TYPES = {float32: Float32Array, uint8: Uint8Array, uint16: Uint16Array};
const $ = (id) => document.getElementById(id);

const S = {
  meta: null, n: 0, cols: {}, aux: null, viewState: null, z0: 0, colorMode: 'topic', citeTop: 100, hotTop: 100, focus: null, fontKey: 0,
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
  // label glyphs are rasterized once per font, so give the web font a moment to arrive first
  const fonts = [`700 26px ${LABEL_FONT}`, `600 15px ${LABEL_FONT}`].map((f) => document.fonts.load(f));
  await Promise.race([Promise.all(fonts), new Promise((r) => setTimeout(r, 2500))]);
  document.fonts.ready.then(() => { S.fontKey++; if (S.deck) render(); });
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

/* Percentiles (0–100 = share of papers with strictly fewer citations; -1 = citations unknown).
 * citePct compares against every paper; hotPct only against papers published in the same quarter,
 * so a recent paper is ranked against papers that had the same time to collect citations. */
function computePercentiles() {
  const {cites, year} = S.cols, n = S.n;
  const pct = (idx) => {
    const v = Float32Array.from(idx, (i) => cites[i]).sort();
    const out = new Map();
    for (const i of idx) {
      let lo = 0, hi = v.length;  // lower bound: number of values < cites[i]
      while (lo < hi) { const mid = (lo + hi) >> 1; if (v[mid] < cites[i]) lo = mid + 1; else hi = mid; }
      out.set(i, v.length > 1 ? (100 * lo) / v.length : 100);
    }
    return {out, sorted: v};
  };
  const known = [];
  const cohorts = new Map();
  for (let i = 0; i < n; i++) {
    if (cites[i] < 0) continue;
    known.push(i);
    const q = Math.floor(year[i] * 4);
    (cohorts.get(q) || cohorts.set(q, []).get(q)).push(i);
  }
  S.citePct = new Float32Array(n).fill(-1); S.hotPct = new Float32Array(n).fill(-1);
  const all = pct(known);
  for (const [i, p] of all.out) S.citePct[i] = p;
  S.citeSorted = all.sorted;
  for (const idx of cohorts.values()) for (const [i, p] of pct(idx).out) S.hotPct[i] = p;
}

function citeThreshold(top) {  // smallest citation count inside the top `top` percent
  const v = S.citeSorted;
  return v[Math.min(v.length - 1, Math.floor(v.length * (1 - top / 100)))];
}

/* Draw order: big circles first so small points stay visible on top of them.
 * Attributes are stored in that order; S.perm maps a drawn index back to the paper's row. */
function buildLayerData() {
  const {x, y, year, cites, cq, venue} = S.cols;
  const n = S.n, tMin = S.tMin, tMax = S.tMax, unknown = S.meta.cite_unknown;
  // counting sort by citation code, descending (unknown counts as 0)
  const key = (i) => (cq[i] === unknown ? 0 : cq[i]);
  const counts = new Uint32Array(65537);
  for (let i = 0; i < n; i++) counts[key(i)]++;
  for (let k = 65535, acc = 0; k >= 0; k--) { const c = counts[k]; counts[k] = acc; acc += c; }
  const perm = new Uint32Array(n);
  for (let i = 0; i < n; i++) perm[counts[key(i)]++] = i;
  S.perm = perm;
  computePercentiles();
  S.fv = new Float32Array(n * 4);  // filter values in draw order
  S.inv = new Uint32Array(n);       // row → draw index
  for (let k = 0; k < n; k++) { const i = perm[k]; S.inv[i] = k; S.fv[4 * k] = year[i]; S.fv[4 * k + 1] = S.citePct[i]; S.fv[4 * k + 2] = S.hotPct[i]; }

  const pos = new Float32Array(n * 2), rad = new Float32Array(n), vf = new Float32Array(n), yf = new Float32Array(n);
  const lw = new Float32Array(n);
  const [bx0, by0, bx1, by1] = S.meta.bounds;
  const unit = Math.max(bx1 - bx0, by1 - by0) / 2500;
  S.big = new Uint8Array(n);  // in draw order: 1 = drawn as a translucent bubble with a rim
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    pos[2 * k] = x[i]; pos[2 * k + 1] = y[i];
    const c = Math.max(0, cites[i]);
    rad[k] = unit * (0.7 + 0.32 * Math.cbrt(c));  // radius ∝ citations^(1/3)
    vf[k] = venue[i]; yf[k] = year[i];
    if (c >= 300) { S.big[k] = 1; lw[k] = 1; }
  }
  S.colorBuf = new Uint8Array(n * 4); S.lineBuf = new Uint8Array(n * 4);
  fillColors();
  S.pointsData = {length: n, attributes: {
    getPosition: {value: pos, size: 2}, getRadius: {value: rad, size: 1},
    getFillColor: {value: S.colorBuf, size: 4}, getLineColor: {value: S.lineBuf, size: 4}, getLineWidth: {value: lw, size: 1},
    getFilterValue: {value: S.fv, size: 4}, getFilterCategory: {value: vf, size: 1}}};

  // glow for papers from the last 30 days
  const recent = [];
  for (let k = 0; k < n; k++) if (tMax - yf[k] <= 30 / 366) recent.push(k);
  const g = recent.length, gp = new Float32Array(g * 2), gr = new Float32Array(g), gt = new Float32Array(g * 4), gv = new Float32Array(g);
  S.glowSrc = Uint32Array.from(recent);
  recent.forEach((k, j) => { gp[2 * j] = pos[2 * k]; gp[2 * j + 1] = pos[2 * k + 1]; gr[j] = rad[k] * 3.2; gt.set(S.fv.subarray(4 * k, 4 * k + 4), 4 * j); gv[j] = vf[k]; });
  S.glowColor = new Uint8Array(g * 4);
  fillGlowColors();
  S.glowData = {length: g, attributes: {
    getPosition: {value: gp, size: 2}, getFillColor: {value: S.glowColor, size: 4}, getRadius: {value: gr, size: 1},
    getFilterValue: {value: gt, size: 4}, getFilterCategory: {value: gv, size: 1}}};
  S.glowFv = gt;
}

/* point colors: by top-level topic (default) or by arXiv primary category; brightness = recency */
function topicRGB(l0) {
  const hex = S.meta.terrain_colors[l0 % S.meta.terrain_colors.length];
  const c = [1, 3, 5].map((j) => parseInt(hex.slice(j, j + 2), 16));
  return c.map((v) => Math.round(v + (255 - v) * 0.35));  // brighter than the terrain wash
}

function colorOf(i) {
  return S.colorMode === 'cat' ? (CAT_RGB[S.cols.cat[i]] || CAT_RGB[8]) : S.topicRGB[S.cols.l0[i]];
}

function fillColors() {
  const n = S.n, perm = S.perm, year = S.cols.year, tMin = S.tMin, span = Math.max(S.tMax - S.tMin, 1e-6);
  S.topicRGB = [...Array(256).keys()].map(topicRGB);
  for (let k = 0; k < n; k++) {
    const i = perm[k], c = colorOf(i);
    const a = 70 + 185 * Math.pow((year[i] - tMin) / span, 1.6);
    S.colorBuf.set([c[0], c[1], c[2], S.big[k] ? a * 0.42 : a], 4 * k);
    S.lineBuf.set([c[0], c[1], c[2], S.big[k] ? 235 : 0], 4 * k);
  }
}

function fillGlowColors() {
  S.glowSrc.forEach((k, j) => { const c = colorOf(S.perm[k]); S.glowColor.set([c[0], c[1], c[2], 60], 4 * j); });
}

function setColorMode(mode) {
  S.colorMode = mode;
  fillColors(); fillGlowColors();
  // new attribute objects so deck.gl re-uploads only the colors
  const at = S.pointsData.attributes;
  S.pointsData = {...S.pointsData, attributes: {...at, getFillColor: {value: S.colorBuf, size: 4}, getLineColor: {value: S.lineBuf, size: 4}}};
  S.glowData = {...S.glowData, attributes: {...S.glowData.attributes, getFillColor: {value: S.glowColor, size: 4}}};
  document.querySelectorAll('#colorMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  renderLegend();
  render();
}

function renderLegend() {
  const m = S.meta, el = $('legend');
  if (S.colorMode === 'cat') {
    el.className = '';
    el.innerHTML = m.categories.slice(0, 8).map((c, i) =>
      `<span><i style="background:rgb(${CAT_RGB[i]});color:rgb(${CAT_RGB[i]})"></i>${c}</span>`).join('');
  } else {
    el.className = 'topics';
    el.innerHTML = m.labels.filter((l) => l.l === 0).sort((a, b) => b.n - a.n).map((l) => {
      const c = S.topicRGB[l.id];
      return `<span title="${esc(l.name)}"><i style="background:rgb(${c});color:rgb(${c})"></i>${esc(l.name)}</span>`;
    }).join('');
  }
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
  const yr = [S.y0, S.soft ?? S.y1 + 1];
  const cr = [S.citeTop >= 100 ? -2 : 100 - S.citeTop, 101], hr = [S.hotTop >= 100 ? -2 : 100 - S.hotTop, 101];
  const fr = [S.focus ? 0.5 : -1, 2];
  const filter = {
    extensions: [FILTER], filterRange: [yr, cr, hr, fr], filterCategories: S.venueList,
    filterSoftRange: [S.soft != null ? [S.y0, S.soft - 0.6] : yr, cr, hr, fr],
  };
  const lv = currentLevel();
  const layers = [
    new BitmapLayer({
      id: 'terrain', image: BASE + 'terrain.png', bounds: S.meta.terrain_bounds,
      opacity: Math.max(0.12, Math.min(1, 1.15 - dz * 0.28)) * (S.focus ? 0.45 : 1),
    }),
    new ScatterplotLayer({
      id: 'glow', data: S.glowData, radiusUnits: 'common', radiusScale, radiusMinPixels: 2.5, radiusMaxPixels: 22,
      stroked: false, parameters: ADDITIVE, ...filter,
    }),
    new ScatterplotLayer({
      id: 'points', data: S.pointsData, radiusUnits: 'common', radiusScale, radiusMinPixels: 0.55, radiusMaxPixels: 48,
      stroked: true, lineWidthUnits: 'pixels', lineWidthMinPixels: 0, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 230],
      onHover: (info) => hover(info.index >= 0 ? {...info, index: S.perm[info.index]} : info),
      onClick: (info) => { if (info.index >= 0) select(S.perm[info.index]); return true; },
      ...filter,
    }),
    new ScatterplotLayer({  // papers in the focus set, drawn larger so they stand out at any zoom
      id: 'focus', data: S.focus ? S.focusRows : [], getPosition: (i) => [S.cols.x[i], S.cols.y[i]],
      getRadius: (i) => 3 + 0.9 * Math.cbrt(Math.max(0, S.cols.cites[i])), radiusUnits: 'pixels', radiusMaxPixels: 26,
      getFillColor: (i) => [...colorOf(i), 210], getLineColor: [255, 255, 255, 200], stroked: true, lineWidthUnits: 'pixels', getLineWidth: 1,
      updateTriggers: {getFillColor: S.colorMode}, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 230],
      onHover: (info) => hover(info.index >= 0 ? {...info, index: info.object} : info),
      onClick: (info) => { if (info.object != null) select(info.object); return true; },
      extensions: [FILTER], filterRange: [yr, cr, hr, [-1, 2]], filterCategories: S.venueList,
      getFilterValue: (i) => [S.cols.year[i], S.citePct[i], S.hotPct[i], 1], getFilterCategory: (i) => S.cols.venue[i],
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
      id: `labels-${lv}-${S.fontKey}`, data: placeLabels(lv),
      getPosition: (d) => [d.x, d.y], getText: (d) => d.text,
      getSize: labelStyle(lv).size, sizeUnits: 'pixels', getColor: labelStyle(lv).color,
      fontFamily: LABEL_FONT, fontWeight: labelStyle(lv).weight, characterSet: 'auto',
      fontSettings: {sdf: true, fontSize: 72, buffer: 8, radius: 12}, outlineWidth: 5, outlineColor: [5, 7, 11, 225],
      lineHeight: 1.12,
    }),
  ];
  S.deck.setProps({viewState: S.viewState, layers});
}

/* ---------- label placement ----------
 * Boxes are computed in screen space: largest clusters first, labels that would overlap are dropped.
 * The result is memoized per view so unrelated re-renders (e.g. year playback) reuse the same array. */
const wrapCache = new Map();
const measureCtx = document.createElement('canvas').getContext('2d');
function wrapLabel(name, lv) {
  const st = labelStyle(lv), key = name + '|' + lv + '|' + S.fontKey;
  if (!wrapCache.has(key)) {
    // capitals get hair spaces between letters (TextLayer has no letter-spacing)
    const text = st.caps ? name.toUpperCase() : name;
    const spaced = (s) => (st.caps ? [...s].join('\u200A') : s);
    measureCtx.font = `${st.weight} ${st.size}px ${LABEL_FONT}`;
    const maxW = st.size * 11, lines = [];
    let cur = '';
    for (const w of text.split(/\s+/)) {
      const next = cur ? cur + ' ' + w : w;
      if (cur && measureCtx.measureText(spaced(next)).width > maxW) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    const out = lines.map(spaced);
    const width = Math.max(...out.map((l) => measureCtx.measureText(l).width)), height = out.length * st.size * 1.22;
    wrapCache.set(key, {text: out.join('\n'), width, height});
  }
  return wrapCache.get(key);
}

let labelMemo = {key: '', data: []};
function placeLabels(lv) {
  const vs = S.viewState, el = $('map'), W = el.clientWidth, H = el.clientHeight;
  const key = `${lv}|${S.fontKey}|${vs.zoom.toFixed(4)}|${vs.target[0].toFixed(5)}|${vs.target[1].toFixed(5)}|${W}x${H}`;
  if (labelMemo.key === key) return labelMemo.data;
  const scale = Math.pow(2, vs.zoom), pad = 9;
  const placed = [], out = [];
  const cand = S.meta.labels.filter((l) => l.l === lv).sort((a, b) => b.n - a.n);
  for (const l of cand) {
    const sx = (l.x - vs.target[0]) * scale + W / 2, sy = H / 2 - (l.y - vs.target[1]) * scale;
    const w = wrapLabel(l.name, lv);
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
  if (sp.get('q')) { S.autoFocus = sp.get('focus') === '1'; $('q').value = sp.get('q'); onSearch(); }
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
    if (lab && path[path.length - 1] !== esc(lab.name)) path.push(esc(lab.name));  // unsplit levels repeat the parent's name
  }
  $('cardBody').innerHTML = `
    <h3>${esc(c.title)}</h3>
    <div class="authors">${esc(c.authors)}</div>
    <dl>
      <dt>Date</dt><dd>${c.date}</dd>
      <dt>Venue</dt><dd>${esc(m.venues[S.cols.venue[i]])}</dd>
      <dt>Citations</dt><dd>${c.cites == null ? 'not yet known' : c.cites.toLocaleString('en-US') + ` <small>(top ${topText(S.citePct[i])} overall · top ${topText(S.hotPct[i])} for its age)</small>`}</dd>
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

/* ---------- focus: show only a chosen set of papers (an author's papers, or all search matches) ---------- */
function setFocus(rows, label) {
  const fv = S.fv, n = S.n;
  for (let k = 0; k < n; k++) fv[4 * k + 3] = 0;
  for (const i of rows) fv[4 * S.inv[i] + 3] = 1;
  S.glowSrc.forEach((k, j) => { S.glowFv[4 * j + 3] = fv[4 * k + 3]; });
  S.focus = rows.length ? {n: rows.length, label} : null;
  S.focusRows = Array.from(rows);
  // new attribute objects so deck.gl re-uploads only the filter values
  S.pointsData = {...S.pointsData, attributes: {...S.pointsData.attributes, getFilterValue: {value: fv, size: 4}}};
  S.glowData = {...S.glowData, attributes: {...S.glowData.attributes, getFilterValue: {value: S.glowFv, size: 4}}};
  const bar = $('focusBar');
  if (S.focus) {
    $('focusText').textContent = `Showing ${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? 'paper' : 'papers'} ${label}`;
    bar.hidden = false;
    fitTo(rows);
  } else {
    bar.hidden = true;
    render();
  }
}

function fitTo(rows) {
  const X = S.cols.x, Y = S.cols.y;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of rows) { x0 = Math.min(x0, X[i]); x1 = Math.max(x1, X[i]); y0 = Math.min(y0, Y[i]); y1 = Math.max(y1, Y[i]); }
  const el = $('map'), w = el.clientWidth - 360, h = el.clientHeight - 120;
  const span = Math.max(x1 - x0, y1 - y0, (S.meta.bounds[2] - S.meta.bounds[0]) / 40);
  const zoom = Math.min(S.z0 + 6, Math.log2(Math.min(w, h) / span));
  const scale = Math.pow(2, zoom);
  S.viewState = {...S.viewState, target: [(x0 + x1) / 2 - 160 / scale, (y0 + y1) / 2, 0], zoom,
    transitionDuration: 800, transitionInterpolator: new LinearInterpolator(['target', 'zoom'])};
  render();
}

/* exact author name → rows (given-name family-name order, or reversed) */
async function authorRows(q) {
  const toks = normText(q).match(/[a-z0-9]+/g) || [];
  if (toks.length < 2 || !S.meta.name_shards) return null;
  for (const t of [toks, [...toks.slice(1), toks[0]], [...toks].reverse()]) {
    const sk = t[t.length - 1].slice(0, 2);
    if (!S.meta.name_shards.includes(sk)) continue;
    const sh = await cached(S.nameShards ||= new Map(), sk, () => fetchJSON(`${BASE}names/${sk}.json`));
    const rows = sh[t.join(' ')];
    if (rows) return {rows, key: t.join(' ')};
  }
  return null;
}

function displayName(authors, key) {  // the author's name as written in the paper
  for (const a of authors.replace(/ and /g, ',').split(',')) if ((normText(a).match(/[a-z0-9]+/g) || []).join(' ') === key) return a.trim();
  return key;
}

/* ---------- search ----------
 * Two inverted indexes, sharded by the first two letters of a token: title tokens (search/) and
 * author name tokens (authors/: given and family names). Only shards for the query's terms load.
 * A term matches a paper if it hits the title or an author, exactly or as a prefix.
 * Ranking is by relevance first: rare terms count more (idf), exact beats prefix, titles made up
 * mostly of the query score higher, a full author-name match gets a bonus; citations only break ties.
 * When few papers match every term, papers missing one term follow, ranked lower. */
const STOP = new Set('a an and are as at be by for from in into is of on or the to with via using towards toward we our its their this that'.split(' '));
const ARXIV_ID = /^\s*(arxiv:)?\s*(\d{4}\.\d{4,5}|[a-z-]+(\.[a-z]{2})?\/\d{7})(v\d+)?\s*$/i;
const normText = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

function indexShard(kind, k) {
  const list = kind === 'authors' ? S.meta.author_shards : S.meta.search_shards;
  if (!list || !list.includes(k)) return Promise.resolve({});
  const map = kind === 'authors' ? (S.authorShards ||= new Map()) : S.searchShards;
  return cached(map, k, () => fetchJSON(`${BASE}${kind}/${k}.json`));
}

// postings for one term: {exact: Set, prefix: Set} for titles and authors
async function lookup(term) {
  const k = term.slice(0, 2);
  const [ts, as] = await Promise.all([indexShard('search', k), indexShard('authors', k)]);
  const collect = (sh) => {
    const exact = new Set(sh[term] || []), prefix = new Set();
    for (const [tok, ids] of Object.entries(sh)) if (tok !== term && tok.startsWith(term)) for (const i of ids) prefix.add(i);
    return {exact, prefix};
  };
  return {title: collect(ts), author: collect(as)};
}

async function renderResults(top, total, seq, partial = 0, focusRows = null, header = null) {
  const ul = $('results');
  const cards = await Promise.all(top.map(card));
  if (seq !== searchSeq) return;
  ul.innerHTML = top.length ? '' : '<li><small>No results. The map only has arXiv papers in its eight AI categories.</small></li>';
  if (header || (focusRows && focusRows.length > 1)) {
    const li = document.createElement('li');
    li.className = 'head';
    li.innerHTML = `<small>${header || `${total.toLocaleString('en-US')} matches · top ${top.length} by relevance`}</small>`;
    if (focusRows && focusRows.length > 1) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = 'Show only these on the map';
      b.onclick = (e) => { e.stopPropagation(); setFocus(focusRows, header ? header.replace(/ ·.*$/, '').replace(/^Papers /, '') : `matching “${$('q').value.trim()}”`); };
      li.appendChild(b);
      if (S.autoFocus) { S.autoFocus = false; b.click(); }  // ?q=…&focus=1 shares a focused view
    }
    ul.appendChild(li);
  }
  top.forEach((i, k) => {
    const li = document.createElement('li');
    const ci = cards[k].cites;
    const authors = cards[k].authors.length > 70 ? cards[k].authors.slice(0, 70) + '…' : cards[k].authors;
    li.innerHTML = `${esc(cards[k].title)}<small>${esc(authors)}</small><small>${cards[k].date.slice(0, 4)} · ${esc(S.meta.venues[S.cols.venue[i]])}${ci != null ? ' · ' + ci.toLocaleString('en-US') + ' citations' : ''}</small>`;
    if (k >= top.length - partial) li.classList.add('partial');
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
    const terms = [...new Set((normText(q).match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 2 && !STOP.has(w)))];
    if (!terms.length) { ul.innerHTML = ''; return; }
    ul.innerHTML = '<li><small>Searching…</small></li>';
    const au = await authorRows(q);
    if (seq !== searchSeq) return;
    if (au) {  // the query is an author's full name: list their papers, most cited first
      const C = S.cols.cites, rows = au.rows;
      const top = [...rows].sort((x, y) => C[y] - C[x]).slice(0, 30);
      const first = await card(top[0]);
      const name = displayName(first.authors, au.key);
      renderResults(top, rows.length, seq, 0, rows, `Papers by ${esc(name)} · ${rows.length.toLocaleString('en-US')} on the map, most cited first`);
      return;
    }
    const [posts, aux] = await Promise.all([Promise.all(terms.map(lookup)), loadAux()]);
    if (seq !== searchSeq) return;

    const N = S.n, nt = terms.length, NT = aux.ntok, C = S.cols.cites, T = S.cols.year;
    const idf = posts.map((p) => {
      const df = p.title.exact.size + p.title.prefix.size + p.author.exact.size + p.author.prefix.size;
      return Math.log(1 + N / (1 + df));
    });
    // per paper: matched weight, terms hit, title hits, author hits
    const acc = new Map();
    posts.forEach((p, t) => {
      const add = (ids, w, field) => {
        for (const i of ids) {
          let r = acc.get(i);
          if (!r) acc.set(i, (r = {w: 0, hit: 0, title: 0, author: 0, seen: -1}));
          if (r.seen === t) continue;  // count each term once, at its best match (callers go best-first)
          r.seen = t; r.w += idf[t] * w; r.hit++;
          if (field === 'title') r.title++; else r.author++;
        }
      };
      add(p.title.exact, 1, 'title'); add(p.author.exact, 1, 'author');
      add(p.title.prefix, 0.7, 'title'); add(p.author.prefix, 0.7, 'author');
    });
    const maxW = idf.reduce((a, b) => a + b, 0);
    const need = nt === 1 ? 1 : nt;
    let cand = [...acc].filter(([, r]) => r.hit >= need);
    let partial = [];
    if (cand.length < 10 && nt >= 2) partial = [...acc].filter(([, r]) => r.hit === nt - 1);
    const score = ([i, r], penalty = 0) => {
      let s = r.w / maxW;                                         // 0..1: how much of the query matched
      if (r.title) s += 0.6 * Math.min(1, r.title / Math.max(NT[i], 1));  // title made of the query terms
      if (r.title === nt && NT[i] === nt) s += 1.0;               // the title is the query
      if (r.author === nt && nt >= 2) s += 0.8;                   // full author name (e.g. "kaiming he")
      s += 0.08 * Math.log10(1 + Math.max(0, C[i]));             // tiebreak only
      return s - penalty;
    };
    const ranked = cand.map((e) => [score(e), e[0]]).sort((a, b) => (b[0] - a[0]) || (T[b[1]] - T[a[1]]));
    const extra = partial.map((e) => [score(e, 1), e[0]]).sort((a, b) => b[0] - a[0]);
    const top = ranked.slice(0, 30).map((x) => x[1]);
    const more = extra.slice(0, Math.max(0, 30 - top.length)).map((x) => x[1]);
    renderResults([...top, ...more], ranked.length + extra.length, seq, more.length, ranked.map((x) => x[1]));
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

  // citation and age-adjusted ("hot") sliders: positions map to PCT_STEPS
  const known = S.citeSorted.length;
  for (const [id, key, text] of [['citeTop', 'citeTop', 'citeText'], ['hotTop', 'hotTop', 'hotText']]) {
    const el = $(id);
    el.min = 0; el.max = PCT_STEPS.length - 1; el.step = 1;
    const want = parseFloat(new URLSearchParams(location.search).get(key === 'citeTop' ? 'top' : 'hot'));
    el.value = Number.isFinite(want) ? PCT_STEPS.reduce((b, s, j) => (Math.abs(s - want) < Math.abs(PCT_STEPS[b] - want) ? j : b), 0) : 0;
    el.oninput = () => {
      S[key] = PCT_STEPS[+el.value];
      const top = S[key];
      if (top >= 100) $(text).textContent = 'All papers';
      else if (key === 'citeTop') $(text).textContent = `Top ${top}% · ≥ ${Math.round(citeThreshold(top)).toLocaleString('en-US')} citations`;
      else $(text).textContent = `Top ${top}% for their age`;
      render();
    };
    el.oninput();
  }
  $('rankNote').textContent = known < S.n ? `Ranks use the ${((100 * known) / S.n).toFixed(0)}% of papers with citation data; filtering hides the rest.` : '';

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

  renderLegend();
  document.querySelectorAll('#colorMode button').forEach((b) => { b.onclick = () => setColorMode(b.dataset.mode); });
  $('stats').textContent = `${S.n.toLocaleString('en-US')} papers · ${m.edges.toLocaleString('en-US')} citation links`;
  $('citeNote').textContent = m.citations_ready < 0.99
    ? `Citation counts are ${(m.citations_ready * 100).toFixed(0)}% loaded (papers without data are drawn at minimum size).` : '';
  $('q').oninput = onSearch;
  const lastDay = new Date(Date.UTC(1990, 0, 1) + m.t_range_days[1] * 864e5).toISOString().slice(0, 10);
  $('dataAsOf').textContent = `through ${lastDay}`;
  $('topicNote').textContent = m.labels.filter((l) => l.l === 0).length === 13 && PROFILE === 'm2'
    ? 'Topics: HDBSCAN clusters grouped into 13 research fields.'
    : 'Topics: HDBSCAN clusters grouped by similarity.';
  const setPanel = (open) => {
    document.body.classList.toggle('panel-closed', !open);
    $('panelOpen').hidden = open;
    try { localStorage.setItem('panelOpen', open ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  };
  $('panelClose').onclick = () => setPanel(false);
  $('panelOpen').onclick = () => setPanel(true);
  let saved = null;
  try { saved = localStorage.getItem('panelOpen'); } catch (e) { /* storage unavailable */ }
  setPanel(saved !== '0');
  $('focusClear').onclick = () => setFocus([], '');
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

function topText(p) { const t = 100 - p; return t < 1 ? t.toFixed(1) + '%' : Math.round(t) + '%'; }

function compact(n) { return n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : n.toLocaleString('en-US'); }

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }

main().catch((e) => { $('stats').textContent = 'Failed to load: ' + e.message; console.error(e); });
