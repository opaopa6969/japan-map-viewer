// mapcore/renderer-2d.js — WebGL 不要の 2D canvas レンダラ（非GPU機向け）。
// 合成済み日本地図 PNG(basemap) を背景に、緯度経度→ピクセル(mercatorXY)で点と
// グリッドコロプレスを描く。任意の canvas(=任意 rect) に描けるので、フルスクリーン
// でも OpaDeck パネル内でも同じコードで動く。
import { BASEMAP, mercatorXY } from '/js/basemap.js';
import { rampColor } from './metrics.js';

export function createRenderer2D(canvas, opts = {}) {
  const model = opts.model;
  const onPick = opts.onPick;
  const ctx = canvas.getContext('2d');
  const layers = { points: true, grid: false, choropleth: false, ...(opts.layers || {}) };
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

  function draw() {
    clear();
    drawBasemap();
    if (layers.choropleth) drawChoropleth();
    if (layers.grid) drawGrid();
    if (layers.points) drawPoints();
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
  function onUp(e) {
    dragging = false;
    if (!moved && onPick) {
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

  return {
    kind: '2d',
    // データ/フィルタ変更時の再描画。コロプレスキャッシュも作り直す。
    refresh() { choroCache = null; draw(); },
    resize, // 親rectのサイズ変更(fullscreen等)時に呼ぶ。キャッシュは画像空間なので維持
    setLayers(next) { Object.assign(layers, next); draw(); },
    setGridDeg(d) { gridDeg = d; draw(); },
    setChoropleth(config) { choro = config; choroCache = null; draw(); },
    home() { fit(); draw(); },
    destroy() {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
