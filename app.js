/* AI Paper Map — deck.gl 정적 웹앱 (빌드 없이 CDN으로 실행)
 * 데이터: data/<profile>/{meta.json, points.bin, terrain.png, cards/NNN.json, edges.bin}
 * 주소 뒤에 ?profile=m2 처럼 붙이면 다른 프로필을 연다.
 */
const {Deck, OrthographicView, ScatterplotLayer, TextLayer, LineLayer, BitmapLayer, LinearInterpolator,
  DataFilterExtension} = deck;

const PROFILE = new URLSearchParams(location.search).get('profile') || 'm2';
const BASE = `data/${PROFILE}/`;
const CAT_RGB = [[91, 192, 235], [253, 231, 76], [155, 197, 61], [229, 89, 52], [250, 121, 33],
  [193, 123, 224], [242, 95, 156], [61, 218, 180], [150, 150, 150]];
const LABEL_SIZE = [28, 21, 17, 15.5, 14.5];
const $ = (id) => document.getElementById(id);

const S = {  // 앱 상태
  meta: null, n: 0, cols: {}, viewState: null, z0: 0,
  y0: 0, y1: 0, soft: null, venues: new Set(),
  selected: null, edges: null, edgeLines: [], cards: new Map(), playing: false,
};

async function main() {
  const meta = await (await fetch(BASE + 'meta.json')).json();
  const buf = await (await fetch(BASE + 'points.bin')).arrayBuffer();
  S.meta = meta; S.n = meta.count;
  const TYPES = {float32: Float32Array, uint8: Uint8Array, uint16: Uint16Array};
  for (const [k, c] of Object.entries(meta.columns)) S.cols[k] = new TYPES[c.dtype](buf, c.offset, S.n);
  buildAttributes();
  initView();
  initControls();
  render();
  deepLink();
}

/* ?paper=<arXiv id> 로 해당 논문을 열고, ?q=<검색어> 로 검색을 채운다 */
async function deepLink() {
  const sp = new URLSearchParams(location.search);
  if (sp.get('q')) { $('q').value = sp.get('q'); onSearch(); }
  const pid = sp.get('paper');
  if (pid) {
    const shards = await loadAllCards();
    for (const sh of shards) {
      const j = sh.id.indexOf(pid);
      if (j >= 0) { flyTo(sh.start + j); return; }
    }
  }
}

function buildAttributes() {
  const {x, y, t, cites, cat, venue} = S.cols;
  const n = S.n, [tMin, tMax] = S.meta.t_range;
  const pos = new Float32Array(n * 2), col = new Uint8Array(n * 4), rad = new Float32Array(n);
  const tf = new Float32Array(n), vf = new Float32Array(n);
  const [bx0, by0, bx1, by1] = S.meta.bounds;
  const unit = Math.max(bx1 - bx0, by1 - by0) / 2500;
  const recent = [];
  for (let i = 0; i < n; i++) {
    pos[2 * i] = x[i]; pos[2 * i + 1] = y[i];
    const c = CAT_RGB[cat[i]] || CAT_RGB[8];
    const age = (t[i] - tMin) / Math.max(tMax - tMin, 1e-6);  // 0 = 가장 오래됨
    col[4 * i] = c[0]; col[4 * i + 1] = c[1]; col[4 * i + 2] = c[2];
    col[4 * i + 3] = 70 + 185 * Math.pow(age, 1.6);
    const cc = cites[i] < 0 ? 0 : cites[i];
    rad[i] = unit * (0.7 + 0.32 * Math.cbrt(cc));  // 반지름 ∝ 피인용^(1/3): 100편 vs 1만 편이 약 3.5배
    tf[i] = t[i]; vf[i] = venue[i];
    if (tMax - t[i] <= 30 / 366) recent.push(i);
  }
  S.attr = {pos, col, rad, tf, vf, unit};
  // 최근 30일 논문의 glow용 별도 속성
  const m = recent.length, gp = new Float32Array(m * 2), gc = new Uint8Array(m * 4), gr = new Float32Array(m);
  const gt = new Float32Array(m), gv = new Float32Array(m);
  recent.forEach((i, k) => {
    gp[2 * k] = x[i]; gp[2 * k + 1] = y[i];
    const c = CAT_RGB[cat[i]] || CAT_RGB[8];
    gc.set([c[0], c[1], c[2], 60], 4 * k);
    gr[k] = rad[i] * 3.2; gt[k] = t[i]; gv[k] = venue[i];
  });
  S.glow = {n: m, gp, gc, gr, gt, gv};
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

function filterProps() {
  const range = [S.y0, S.soft ?? S.y1 + 1];
  return {
    filterRange: range,
    filterSoftRange: S.soft != null ? [S.y0, S.soft - 0.6] : range,
    filterCategories: [...S.venues],
    extensions: [new DataFilterExtension({filterSize: 1, categorySize: 1})],
  };
}

function render() {
  const z = S.viewState.zoom, dz = z - S.z0;
  const {pos, col, rad, tf, vf} = S.attr;
  const f = filterProps();
  const lv = currentLevel();
  const layers = [
    new BitmapLayer({
      id: 'terrain', image: BASE + 'terrain.png', bounds: S.meta.terrain_bounds,
      opacity: Math.max(0.12, Math.min(1, 1.15 - dz * 0.28)),
    }),
    new ScatterplotLayer({
      id: 'glow',
      data: {length: S.glow.n, attributes: {
        getPosition: {value: S.glow.gp, size: 2}, getFillColor: {value: S.glow.gc, size: 4},
        getRadius: {value: S.glow.gr, size: 1}, getFilterValue: {value: S.glow.gt, size: 1},
        getFilterCategory: {value: S.glow.gv, size: 1}}},
      radiusUnits: 'common', radiusScale: Math.pow(2, -0.6 * Math.max(0, dz)), radiusMinPixels: 2.5, radiusMaxPixels: 22, stroked: false,
      parameters: {depthCompare: 'always', blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one'},
      ...f,
    }),
    new ScatterplotLayer({
      id: 'points',
      data: {length: S.n, attributes: {
        getPosition: {value: pos, size: 2}, getFillColor: {value: col, size: 4},
        getRadius: {value: rad, size: 1}, getFilterValue: {value: tf, size: 1},
        getFilterCategory: {value: vf, size: 1}}},
      radiusUnits: 'common', radiusScale: Math.pow(2, -0.6 * Math.max(0, dz)), radiusMinPixels: 0.55, radiusMaxPixels: 48, stroked: false,
      pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 230],
      onHover: hover, onClick: (info) => { if (info.index >= 0) select(info.index); return true; },
      ...f,
    }),
    new LineLayer({
      id: 'cites', data: S.edgeLines, getSourcePosition: (d) => d.s, getTargetPosition: (d) => d.t,
      getColor: (d) => (d.out ? [140, 190, 255, 120] : [255, 210, 122, 130]), getWidth: 1, widthUnits: 'pixels',
      parameters: {depthCompare: 'always', blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one'},
    }),
    new ScatterplotLayer({
      id: 'cite-ends', data: S.edgeLines, getPosition: (d) => d.t, getFillColor: (d) => (d.out ? [190, 220, 255, 230] : [255, 225, 160, 230]),
      getRadius: 2.2, radiusUnits: 'pixels',
    }),
    new ScatterplotLayer({
      id: 'selected', data: S.selected != null ? [S.selected] : [], getPosition: (i) => [S.cols.x[i], S.cols.y[i]],
      getFillColor: [255, 255, 255, 40], getLineColor: [255, 255, 255, 255], stroked: true, lineWidthUnits: 'pixels',
      getLineWidth: 1.5, getRadius: 9, radiusUnits: 'pixels',
    }),
    new TextLayer({
      id: `labels-${lv}`, data: placeLabels(lv),
      getPosition: (d) => [d.x, d.y], getText: (d) => d.text,
      getSize: LABEL_SIZE[lv] ?? 14, sizeUnits: 'pixels', getColor: lv === 0 ? [255, 255, 255, 255] : [240, 243, 248, 245],
      fontFamily: 'Inter, system-ui, sans-serif', fontWeight: lv === 0 ? 700 : 600, characterSet: 'auto',
      fontSettings: {sdf: true, fontSize: 64, buffer: 6}, outlineWidth: 7, outlineColor: [0, 0, 0, 255],
      lineHeight: 1.1, updateTriggers: {getText: lv},
    }),
  ];
  S.deck.setProps({viewState: S.viewState, layers});
}

/* ---------- 라벨 배치 ----------
 * deck.gl CollisionFilter는 여러 줄 라벨을 잘 못 거르므로, 화면 좌표에서 상자를 직접 계산해
 * 큰 클러스터부터 놓고 이미 놓인 라벨과 겹치는 것은 뺀다. 줄바꿈도 여기서 직접 한다. */
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

function placeLabels(lv) {
  const size = LABEL_SIZE[lv] ?? 14, vs = S.viewState, scale = Math.pow(2, vs.zoom);
  const el = $('map'), W = el.clientWidth, H = el.clientHeight, pad = 8;
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
  return out;
}

/* ---------- 카드 메타데이터 (샤드 지연 로딩) ---------- */
async function card(i) {
  const k = Math.floor(i / S.meta.shard);
  if (!S.cards.has(k)) {
    S.cards.set(k, fetch(`${BASE}cards/${String(k).padStart(3, '0')}.json`).then((r) => r.json()));
  }
  const sh = await S.cards.get(k);
  const j = i - sh.start;
  return {id: sh.id[j], title: sh.title[j], authors: sh.authors[j], date: sh.date[j]};
}

let hoverToken = 0;
async function hover(info) {
  const tip = $('tooltip');
  if (info.index < 0 || info.index == null) { tip.hidden = true; return; }
  const tok = ++hoverToken;
  const c = await card(info.index);
  if (tok !== hoverToken) return;
  tip.innerHTML = `${esc(c.title)}<br><small>${c.date.slice(0, 4)} · ${esc(S.meta.venues[S.cols.venue[info.index]])}</small>`;
  tip.style.left = `${info.x + 14}px`; tip.style.top = `${info.y + 14}px`;
  tip.hidden = false;
}

/* ---------- 선택: 카드 + 인용선 ---------- */
async function loadEdges() {
  if (!S.edges) {
    S.edges = S.meta.edges ? new Uint32Array(await (await fetch(BASE + 'edges.bin')).arrayBuffer()) : new Uint32Array();
  }
  return S.edges;
}

async function select(i) {
  S.selected = i;
  if (i == null) { $('card').hidden = true; S.edgeLines = []; render(); return; }
  const [c, e] = await Promise.all([card(i), loadEdges()]);
  const X = S.cols.x, Y = S.cols.y, lines = [];
  let nOut = 0, nIn = 0;
  for (let k = 0; k < e.length; k += 2) {  // src 기준 정렬돼 있지만 피인용(in) 엣지도 찾아야 해서 전체를 훑는다
    if (e[k] === i) { lines.push({s: [X[i], Y[i]], t: [X[e[k + 1]], Y[e[k + 1]]], out: true, o: e[k + 1]}); nOut++; }
    else if (e[k + 1] === i) { lines.push({s: [X[i], Y[i]], t: [X[e[k]], Y[e[k]]], out: false, o: e[k]}); nIn++; }
  }
  // 선이 너무 많으면 화면이 하얗게 뜨므로, 상대 논문의 피인용이 많은 순으로 MAX_LINES개만 그린다
  const MAX_LINES = 300, Cc = S.cols.cites;
  const shown = lines.length > MAX_LINES ? lines.sort((a, b) => Cc[b.o] - Cc[a.o]).slice(0, MAX_LINES) : lines;
  S.edgeLines = shown;
  const m = S.meta, ci = S.cols.cites[i];
  const path = [];
  for (let l = 0; l < m.levels; l++) {
    const id = S.cols[`l${l}`][i];
    const lab = m.labels.find((x) => x.l === l && x.id === id);
    if (lab) path.push(esc(lab.name));
  }
  $('cardBody').innerHTML = `
    <h3>${esc(c.title)}</h3>
    <div class="authors">${esc(c.authors)}</div>
    <dl>
      <dt>날짜</dt><dd>${c.date}</dd>
      <dt>Venue</dt><dd>${esc(m.venues[S.cols.venue[i]])}</dd>
      <dt>피인용</dt><dd>${ci < 0 ? '아직 모름' : ci.toLocaleString()}</dd>
      <dt>분야</dt><dd>${m.categories[S.cols.cat[i]]}</dd>
      <dt>인용선</dt><dd><span style="color:#8cbeff">참고 ${nOut}</span> · <span style="color:#ffd27a">피인용 ${nIn}</span> <small>(지도 안 논문끼리${lines.length > shown.length ? `, 선은 피인용 상위 ${shown.length}개만` : ''})</small></dd>
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

/* ---------- 검색 ----------
 * 제목 토큰·저자 성 역색인(search/xx.json, 토큰 앞 두 글자별)에서 질의 토큰의 샤드만 받는다.
 * 각 질의 토큰은 앞부분 일치(prefix)로 찾고, 토큰들끼리는 교집합. 순위는 피인용 수, 같으면 최신순. */
const STOP = new Set('a an and are as at be by for from in into is of on or the to with via using towards toward we our its their this that'.split(' '));
const searchShards = new Map();
function searchShard(k) {
  if (!S.meta.search_shards.includes(k)) return Promise.resolve({});
  if (!searchShards.has(k)) searchShards.set(k, fetch(`${BASE}search/${k}.json`).then((r) => r.json()));
  return searchShards.get(k);
}

let allLoaded = null;  // ?paper= 딥링크용 (id → 행 번호를 찾으려고 카드 전체를 받음)
function loadAllCards() {
  if (!allLoaded) {
    const shards = Math.ceil(S.n / S.meta.shard);
    allLoaded = Promise.all([...Array(shards).keys()].map((k) => card(k * S.meta.shard)))
      .then(() => Promise.all([...S.cards.values()]));
  }
  return allLoaded;
}

let searchTimer, searchSeq = 0;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const ul = $('results');
    const terms = ($('q').value.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 2 && !STOP.has(w));
    if (!terms.length) { ul.innerHTML = ''; return; }
    ul.innerHTML = '<li><small>검색 중…</small></li>';
    let hits = null, exact = null;
    const uniq = [...new Set(terms)];
    for (const w of uniq) {
      const sh = await searchShard(w.slice(0, 2));
      const set = new Set(), ex = new Set(sh[w] || []);
      for (const [tok, ids] of Object.entries(sh)) if (tok.startsWith(w)) for (const i of ids) set.add(i);
      hits = hits ? new Set([...hits].filter((i) => set.has(i))) : set;
      exact = exact ? new Set([...exact].filter((i) => ex.has(i))) : ex;
      if (!hits.size) break;
    }
    if (seq !== searchSeq) return;
    const C = S.cols.cites, T = S.cols.t;
    // 순위: 제목이 질의와 같은 논문(정확한 토큰 일치 + 토큰 수 같음) > 정확한 토큰 일치 > 앞부분 일치, 그다음 피인용
    const NT = S.cols.ntok;
    const score = (i) => {
      let s = Math.log10(1 + Math.max(0, C[i])) * 0.8;
      if (exact.has(i)) s += 2 - 0.15 * Math.max(0, NT[i] - uniq.length) + (NT[i] === uniq.length ? 5 : 0);
      return s;
    };
    const top = [...hits].map((i) => [score(i), i]).sort((a, b) => (b[0] - a[0]) || (T[b[1]] - T[a[1]]))
      .slice(0, 30).map((x) => x[1]);
    const cards = await Promise.all(top.map(card));
    if (seq !== searchSeq) return;
    ul.innerHTML = top.length ? '' : '<li><small>결과 없음</small></li>';
    if (hits.size > 30) ul.innerHTML = `<li><small>${hits.size.toLocaleString()}편 중 상위 30편 (제목 일치 → 피인용 순)</small></li>`;
    top.forEach((i, k) => {
      const li = document.createElement('li');
      li.innerHTML = `${esc(cards[k].title)}<small>${cards[k].date.slice(0, 4)} · ${esc(S.meta.venues[S.cols.venue[i]])}${C[i] >= 0 ? ' · 피인용 ' + C[i].toLocaleString() : ''}</small>`;
      li.onclick = () => flyTo(i);
      ul.appendChild(li);
    });
  }, 200);
}

/* ---------- 연도 슬라이더와 재생 ---------- */
function initControls() {
  const m = S.meta;
  const yMin = Math.floor(m.t_range[0]), yMax = Math.floor(m.t_range[1]);
  for (const id of ['y0', 'y1']) { $(id).min = yMin; $(id).max = yMax; }
  $('y0').value = S.y0 = yMin; $('y1').value = S.y1 = yMax;
  const onRange = () => {
    let a = +$('y0').value, b = +$('y1').value;
    if (a > b) [a, b] = [b, a];
    S.y0 = a; S.y1 = b; S.soft = null; updateYearText(); render();
  };
  $('y0').oninput = onRange; $('y1').oninput = onRange;
  $('reset').onclick = () => { stop(); $('y0').value = yMin; $('y1').value = yMax; onRange(); };
  $('play').onclick = () => (S.playing ? stop() : play(yMin, yMax));
  updateYearText();

  // venue 체크박스: arXiv only를 맨 앞에, 나머지는 논문 수 순
  const order = m.venues.map((v, i) => i).sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : m.venue_counts[b] - m.venue_counts[a]));
  const box = $('venues');
  for (const i of order) {
    if (!m.venue_counts[i]) continue;
    S.venues.add(i);
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox" checked data-v="${i}"> ${esc(m.venues[i])} <small>${m.venue_counts[i].toLocaleString()}</small>`;
    box.appendChild(lab);
  }
  box.onchange = (e) => {
    const v = +e.target.dataset.v;
    e.target.checked ? S.venues.add(v) : S.venues.delete(v);
    render();
  };
  const setAll = (on) => {
    box.querySelectorAll('input').forEach((el) => { el.checked = on; const v = +el.dataset.v; on ? S.venues.add(v) : S.venues.delete(v); });
    render();
  };
  $('vAll').onclick = () => setAll(true);
  $('vNone').onclick = () => setAll(false);

  $('legend').innerHTML = m.categories.slice(0, 8).map((c, i) =>
    `<span><i style="background:rgb(${CAT_RGB[i]});color:rgb(${CAT_RGB[i]})"></i>${c}</span>`).join('');
  $('stats').textContent = `${S.n.toLocaleString()}편 · ${PROFILE.toUpperCase()} · 인용 엣지 ${m.edges.toLocaleString()}개`;
  $('citeNote').textContent = m.citations_ready < 0.99
    ? `피인용 데이터는 아직 ${(m.citations_ready * 100).toFixed(0)}%만 반영됨 (모르는 논문은 최소 크기)` : '';
  $('q').oninput = onSearch;
  $('cardClose').onclick = () => select(null);
}

function updateYearText() {
  const shown = S.soft != null ? Math.floor(S.soft) : S.y1;
  $('yearText').textContent = S.y0 === shown ? `${S.y0}` : `${S.y0} – ${shown}`;
}

function play(yMin, yMax) {
  S.playing = true; $('play').textContent = '■ 정지';
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
  S.playing = false; S.soft = null; $('play').textContent = '▶ 재생';
  updateYearText(); render();
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }

main().catch((e) => { $('stats').textContent = '불러오기 실패: ' + e.message; console.error(e); });
