// mapcore/renderer-2d.js — WebGL 不要の 2D canvas レンダラ（非GPU機向け）。
// 合成済み日本地図 PNG(basemap) を背景に、緯度経度→ピクセル(mercatorXY)で点と
// グリッドコロプレスを描く。任意の canvas(=任意 rect) に描けるので、フルスクリーン
// でも OpaDeck パネル内でも同じコードで動く。
//
// issue #1: 汎用レイヤーAPI(addLayer 等)対応。extrusion は 2D では柱にできないため
// 「値→円の半径+色」のフォールバック描画。movers はレイヤーがある間だけ rAF ループ。
import { BASEMAP, mercatorXY } from '/js/basemap.js';
import { rampColor } from './metrics.js';
import {
  LAYER_TYPES, createLayerRegistry, moverPosition, hasActiveMovers, realClock,
} from './layers.js';
import { createWipe } from './fx.js';

export function createRenderer2D(canvas, opts = {}) {
  const model = opts.model;
  const onPick = opts.onPick;
  const clock = opts.clock || realClock();
  const ctx = canvas.getContext('2d');
  const layers = { points: true, grid: false, choropleth: false, ...(opts.layers || {}) };
  const registry = createLayerRegistry();
  let gridDeg = opts.gridDeg || 0.5;
  // choropleth 設定: { index, kind:'errors'|'metric', values?:Map(id->number), max?:number }
  let choro = opts.choropleth || (opts.prefIndex ? { index: opts.prefIndex, kind: 'errors' } : null);

  const img = new Image();
  let imgReady = false;
  img.onload = () => { imgReady = true; draw(); };
  img.onerror = () => { imgReady = false; draw(); };
  img.src = BASEMAP.image;

  // view: 画像空間(0..BASEMAP.width) -> スクリーン。fit() で初期フィット。
  const view = { scale: 1, ox: 0, oy: 0 };

  function pxRatio() { return Math.min(window.devicePixelRatio || 1, 2); }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const r = pxRatio();
    canvas.width = Math.max(1, Math.round((rect.width || 800) * r));
    canvas.height = Math.max(1, Math.round((rect.height || 600) * r));
    fit();
    draw();
  }

  function fit() {
    const s = Math.min(canvas.width / BASEMAP.width, canvas.height / BASEMAP.height);
    view.scale = s;
    view.ox = (canvas.width - BASEMAP.width * s) / 2;
    view.oy = (canvas.height - BASEMAP.height * s) / 2;
  }

  function toScreen(px, py) {
    return [px * view.scale + view.ox, py * view.scale + view.oy];
  }
  function llToScreen(lat, lon) {
    const { x, y } = mercatorXY(lat, lon);
    return toScreen(x, y);
  }

  function clear() {
    ctx.save();
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function drawBasemap() {
    if (!imgReady) return;
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.drawImage(img, view.ox, view.oy, BASEMAP.width * view.scale, BASEMAP.height * view.scale);
    ctx.restore();
  }

  function drawGrid() {
    if (!model) return;
    const cells = model.grid(gridDeg);
    const maxCount = cells.maxCount || 1;
    ctx.save();
    for (const cell of cells) {
      const [x0, y0] = llToScreen(cell.lat0 + cell.cellDeg, cell.lon0); // 北西
      const [x1, y1] = llToScreen(cell.lat0, cell.lon0 + cell.cellDeg); // 南東
      const w = x1 - x0;
      const h = y1 - y0;
      const t = Math.sqrt(cell.count / maxCount); // 件数→濃度（sqrtで低件数も視認）
      ctx.globalAlpha = 0.18 + 0.55 * t;
      ctx.fillStyle = model.colorOf(cell.topCategory);
      ctx.fillRect(x0, y0, w, h);
    }
    ctx.restore();
  }

  // コロプレスは画像空間(mercatorXY ピクセル)に CF 倍率でオフスクリーン描画してキャッシュし、
  // パン/ズーム時は基図と同じ変換で1回 drawImage するだけにする(1902ポリゴンの再描画回避)。
  const CHORO_CF = 0.5;
  let choroCache = null;

  function fillRegionPathOffscreen(octx, feature) {
    for (const poly of feature.polys) {
      octx.beginPath();
      for (const ring of poly) {
        for (let i = 0; i < ring.length; i++) {
          const { x, y } = mercatorXY(ring[i][1], ring[i][0]);
          if (i === 0) octx.moveTo(x * CHORO_CF, y * CHORO_CF); else octx.lineTo(x * CHORO_CF, y * CHORO_CF);
        }
        octx.closePath();
      }
      const fill = octx.globalAlpha;
      octx.fill('evenodd');
      octx.globalAlpha = 0.4;
      octx.lineWidth = 0.6;
      octx.strokeStyle = 'rgba(255,255,255,0.25)';
      octx.stroke();
      octx.globalAlpha = fill;
    }
  }

  function buildChoroCache() {
    choroCache = null;
    if (!choro || !choro.index || !model) return;
    const w = Math.round(BASEMAP.width * CHORO_CF);
    const h = Math.round(BASEMAP.height * CHORO_CF);
    const off = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const octx = off.getContext('2d');
    if (choro.kind === 'metric') {
      const max = choro.max || 1;
      for (const feature of choro.index.features) {
        const v = choro.values ? choro.values.get(feature.id) : undefined;
        if (v == null) { octx.globalAlpha = 0.04; octx.fillStyle = '#7a818d'; } else { octx.globalAlpha = 0.72; octx.fillStyle = rampColor(v / max); }
        fillRegionPathOffscreen(octx, feature);
      }
    } else { // 'errors'
      const aggregate = model.regionAggregate(choro.index);
      const max = aggregate.max || 1;
      for (const feature of choro.index.features) {
        const cell = aggregate.get(feature.id);
        octx.globalAlpha = cell ? (0.25 + 0.55 * Math.sqrt(cell.count / max)) : 0.05;
        octx.fillStyle = cell ? model.colorOf(cell.topCategory) : '#7a818d';
        fillRegionPathOffscreen(octx, feature);
      }
    }
    choroCache = off;
  }

  function drawChoropleth() {
    if (!choro || !choro.index || !model) return;
    if (!choroCache) buildChoroCache();
    if (!choroCache) return;
    ctx.drawImage(choroCache, view.ox, view.oy, BASEMAP.width * view.scale, BASEMAP.height * view.scale);
  }

  function drawPoints() {
    if (!model) return;
    const pts = model.visible();
    const r = 3 * pxRatio();
    ctx.save();
    for (const p of pts) {
      const [sx, sy] = llToScreen(p.lat, p.lon);
      if (sx < -10 || sy < -10 || sx > canvas.width + 10 || sy > canvas.height + 10) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = model.colorOf(p.category);
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.lineWidth = 0.5 * pxRatio();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- 汎用レイヤー(network/extrusion/markers/movers) --------------------------
  function drawCustomLayers() {
    const r = pxRatio();
    const tNow = clock.now();
    for (const spec of registry.list()) {
      if (!spec.visible) continue;
      const st = spec.style;
      ctx.save();
      if (spec.type === 'paths') {
        ctx.lineWidth = (st.width ?? 1.5) * r;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const path of spec.data.paths) {
          ctx.strokeStyle = path.color || st.color || 'rgba(122,138,160,0.8)';
          ctx.beginPath();
          path.coords.forEach(([lon, lat], i) => {
            const [x, y] = llToScreen(lat, lon);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }
      } else if (spec.type === 'network') {
        const nodeById = new Map(spec.data.nodes.map((n) => [n.id, n]));
        ctx.strokeStyle = st.edgeColor || 'rgba(122,138,160,0.8)';
        ctx.lineWidth = (st.edgeWidth ?? 1.5) * r;
        ctx.beginPath();
        for (const e of spec.data.edges) {
          const a = nodeById.get(e.from);
          const b = nodeById.get(e.to);
          if (!a || !b) continue;
          const [ax, ay] = llToScreen(a.lat, a.lon);
          const [bx, by] = llToScreen(b.lat, b.lon);
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
        ctx.stroke();
        ctx.fillStyle = st.nodeColor || '#e8c468';
        for (const n of spec.data.nodes) {
          const [x, y] = llToScreen(n.lat, n.lon);
          ctx.beginPath();
          ctx.arc(x, y, (st.nodeRadius ?? 3.5) * r, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (spec.type === 'extrusion') {
        // 2Dフォールバック: 値→半径+ランプ色の円(柱は描けない)
        const maxV = spec.data.points.reduce((m, p) => Math.max(m, p.value || 0), 0) || 1;
        for (const p of spec.data.points) {
          const [x, y] = llToScreen(p.lat, p.lon);
          const t = (p.value || 0) / maxV;
          ctx.beginPath();
          ctx.arc(x, y, (4 + 14 * Math.sqrt(t)) * r, 0, Math.PI * 2);
          ctx.fillStyle = p.color || st.color || rampColor(t);
          ctx.globalAlpha = 0.75;
          ctx.fill();
        }
      } else if (spec.type === 'markers') {
        ctx.font = `${(st.iconSize ?? 18) * r}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const p of spec.data.points) {
          const [x, y] = llToScreen(p.lat, p.lon);
          ctx.fillText(p.icon || '📍', x, y);
          if (p.label && st.showLabels !== false) {
            ctx.font = `${11 * r}px sans-serif`;
            ctx.fillStyle = 'rgba(230,232,235,0.9)';
            ctx.fillText(p.label, x, y + (st.iconSize ?? 18) * r * 0.9);
            ctx.font = `${(st.iconSize ?? 18) * r}px sans-serif`;
          }
        }
      } else if (spec.type === 'movers') {
        ctx.font = `${(st.iconSize ?? 20) * r}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const tk of spec.data.tokens) {
          const pos = moverPosition(tk, tNow);
          const [x, y] = llToScreen(pos.lat, pos.lon);
          ctx.fillText(tk.icon || '🚄', x, y);
        }
      }
      ctx.restore();
    }
  }

  function draw() {
    clear();
    drawBasemap();
    if (layers.choropleth) drawChoropleth();
    if (layers.grid) drawGrid();
    if (layers.points) drawPoints();
    drawCustomLayers();
  }

  // movers がある間だけ rAF ループを回す(静的レイヤーだけなら消費ゼロのまま)
  let rafId = null;
  function maintainLoop() {
    const need = hasActiveMovers(registry);
    if (need && rafId == null) {
      const loop = () => { draw(); rafId = requestAnimationFrame(loop); };
      rafId = requestAnimationFrame(loop);
    } else if (!need && rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // --- pick: 画面座標に最も近い可視点（半径内）を返す ---
  function pick(clientX, clientY) {
    if (!model) return null;
    const rect = canvas.getBoundingClientRect();
    const r = pxRatio();
    const px = (clientX - rect.left) * r;
    const py = (clientY - rect.top) * r;
    let best = null;
    let bestD = (10 * r) ** 2;
    for (const p of model.visible()) {
      const [sx, sy] = llToScreen(p.lat, p.lon);
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  // --- パン/ズーム ---
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let moved = false;

  function onDown(e) { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; }
  function onMove(e) {
    if (!dragging) return;
    const r = pxRatio();
    const dx = (e.clientX - lastX) * r;
    const dy = (e.clientY - lastY) * r;
    if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) > 3) moved = true;
    view.ox += dx; view.oy += dy;
    lastX = e.clientX; lastY = e.clientY;
    draw();
  }
  // pickable な汎用レイヤーの近傍ヒット(markers/networkノード/extrusion)。
  function pickCustom(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const r = pxRatio();
    const px = (clientX - rect.left) * r;
    const py = (clientY - rect.top) * r;
    const maxD = (12 * r) ** 2;
    // 上のレイヤー(list末尾)から優先で当てる
    for (const spec of [...registry.list()].reverse()) {
      if (!spec.visible || !spec.pickable || !spec.onPick) continue;
      const candidates = spec.type === 'network' ? spec.data.nodes
        : (spec.type === 'markers' || spec.type === 'extrusion') ? spec.data.points : [];
      for (const p of candidates) {
        const [sx, sy] = llToScreen(p.lat, p.lon);
        if ((sx - px) ** 2 + (sy - py) ** 2 < maxD) {
          return { spec, feature: p };
        }
      }
    }
    return null;
  }

  function onUp(e) {
    dragging = false;
    if (moved) return;
    const custom = pickCustom(e.clientX, e.clientY);
    if (custom) {
      custom.spec.onPick(custom.feature, { layerId: custom.spec.id, x: e.clientX, y: e.clientY });
      return;
    }
    if (onPick) {
      const hit = pick(e.clientX, e.clientY);
      onPick(hit, { x: e.clientX, y: e.clientY });
    }
  }
  function onWheel(e) {
    e.preventDefault();
    const r = pxRatio();
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * r;
    const my = (e.clientY - rect.top) * r;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    // マウス位置を中心にズーム
    view.ox = mx - (mx - view.ox) * factor;
    view.oy = my - (my - view.oy) * factor;
    view.scale *= factor;
    draw();
  }

  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  resize();

  const wipe = createWipe(canvas.parentElement || canvas);
  if (canvas.parentElement && getComputedStyle(canvas.parentElement).position === 'static') {
    canvas.parentElement.style.position = 'relative';
  }

  // focusOn: view の ox/oy/scale を rAF でイーズ(指定地点を canvas 中心へ)。
  let focusRaf = null;
  function focusOn({ lat, lon, scale, duration = 700 } = {}) {
    if (focusRaf) { cancelAnimationFrame(focusRaf); focusRaf = null; }
    const { x: ix, y: iy } = mercatorXY(lat, lon);   // 画像空間
    const s1 = scale != null ? scale : view.scale;
    const from = { scale: view.scale, ox: view.ox, oy: view.oy };
    const to = { scale: s1, ox: canvas.width / 2 - ix * s1, oy: canvas.height / 2 - iy * s1 };
    const start = performance.now();
    function frame(now) {
      const u = Math.min(1, (now - start) / duration);
      const e = u * u * (3 - 2 * u); // smoothstep
      view.scale = from.scale + (to.scale - from.scale) * e;
      view.ox = from.ox + (to.ox - from.ox) * e;
      view.oy = from.oy + (to.oy - from.oy) * e;
      draw();
      if (u < 1) focusRaf = requestAnimationFrame(frame);
      else focusRaf = null;
    }
    focusRaf = requestAnimationFrame(frame);
  }

  return {
    kind: '2d',
    // データ/フィルタ変更時の再描画。コロプレスキャッシュも作り直す。
    refresh() { choroCache = null; draw(); },
    resize, // 親rectのサイズ変更(fullscreen等)時に呼ぶ。キャッシュは画像空間なので維持
    setLayers(next) { Object.assign(layers, next); draw(); },
    setGridDeg(d) { gridDeg = d; draw(); },
    setChoropleth(config) { choro = config; choroCache = null; draw(); },
    home() { fit(); draw(); },

    // --- 汎用レイヤーAPI(issue #1) ---
    addLayer(spec) { const s = registry.add(spec); maintainLoop(); draw(); return s; },
    removeLayer(id) { const r = registry.remove(id); maintainLoop(); draw(); return r; },
    setLayerVisible(id, v) { const r = registry.setVisible(id, v); maintainLoop(); draw(); return r; },
    updateLayerData(id, data) { const r = registry.updateData(id, data); maintainLoop(); draw(); return r; },
    reorderLayers(ids) { registry.reorder(ids); draw(); },
    supportsLayerType(t) { return LAYER_TYPES.includes(t); },
    getLayers() { return registry.toJSON(); },

    // --- カメラ演出・表示モード ---
    projectToScreen(lat, lon) {
      const [x, y] = llToScreen(lat, lon);
      const r = pxRatio();
      return { x: x / r, y: y / r };   // CSSピクセルで返す(deck/3dと揃える)
    },
    focusOn,
    wipe,
    setViewMode() { /* 2D は north-up 固定 */ },
    supportsViewMode(m) { return m === 'north-up'; },
    addInset() { throw new Error('renderer-2d は inset 未対応(renderer-deck を使う)'); },
    removeInset() { return false; },
    maxInsets() { return 0; },

    destroy() {
      ro.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
      if (focusRaf) cancelAnimationFrame(focusRaf);
      wipe.destroy();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
