// mapcore/renderer-deck.js — MapLibre GL + deck.gl レンダラ（GPU可視化）。
// renderer-2d/3d と同じ mapcore モデル(point/filter/regionAggregate)を受け取り、
// ベース地図(MapLibre) の上に deck.gl レイヤー(点群/集約/ヒート/コロプレス)を重ねる。
// Mini Tokyo 3D と同じ「地図(MapLibre) + データ層(deck.gl)」の2階建て構成。
//
// issue #1 で汎用レイヤー機構を追加: layers.js のレイヤーspec(network/extrusion/
// movers/markers)を addLayer() で積み、カメラ演出(focusOn/wipe)・表示モード
// (north-up/heading-up)・PiP(addInset) をサポートする。
//
// 前提: MapLibre GL JS と deck.gl(UMD) がグローバル(maplibregl / deck)に読み込み済み。
//   （opts.maplibregl / opts.deck で明示注入も可）
// 引数: container(DOM要素), opts = {
//   model,            // createMapModel(...) の戻り（省略可 — レイヤー専用利用もできる）
//   onPick,           // (object, {x,y}, info) => void  ホバー(点群/コロプレス用・従来互換)
//   baseStyles,       // { dark, gsi } 差し替え可
//   initialView,      // { center:[lon,lat], zoom, pitch }
//   clock,            // { now(): 秒 }。省略時は実時計。movers/追従はこの時計で動く
//   maplibregl, deck, // 明示注入(省略時はグローバル)
// }
// 返り値は renderer-2d と同型 + deck 固有メソッド:
//   refresh / resize / setChoropleth / setLayers / home / destroy
//   + setMode / setBase / setKanji / setAnim / getMap / getOverlay
//   + addLayer / removeLayer / setLayerVisible / updateLayerData / reorderLayers
//     / supportsLayerType / getLayers
//   + projectToScreen / focusOn / wipe / setViewMode / supportsViewMode
//   + addInset / removeInset / updateInset / maxInsets

import { rampColor } from './metrics.js';
import {
  LAYER_TYPES, createLayerRegistry, moverPosition, hasActiveMovers, realClock,
} from './layers.js';
import { createWipe } from './fx.js';

const DEFAULT_STYLES = {
  // dark: CARTO 無料ダーク(OpenMapTiles スキーマ = name:ja あり)。gsi: 国土地理院ラスタ。
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  gsi: {
    version: 8,
    sources: {
      gsi: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
        tileSize: 256, attribution: '地理院タイル', maxzoom: 18,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0e1116' } },
      { id: 'gsi', type: 'raster', source: 'gsi', paint: { 'raster-brightness-max': 0.85 } },
    ],
  },
};

function hexToRgb(h) {
  const n = parseInt(String(h || '#888888').replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rampRGBA(t, a) {
  const m = rampColor(t).match(/\d+/g);
  return [+m[0], +m[1], +m[2], a];
}
/** 角度の最短差(-180..180)。heading追従のスムージング用。 */
function angleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

// --- カスタムレイヤーspec → deck.gl レイヤー群 ---------------------------------
// registry の spec(network/extrusion/movers/markers)を deck レイヤーへ写像する。
// deck レイヤーid は `L|<specId>|<part>` — onClick で spec を引くのに使う。
// insets からも呼ぶため純関数(deckNS と時刻を引数で受ける)。
function buildCustomDeckLayers(deckNS, registry, tNow) {
  const { LineLayer, ScatterplotLayer, ColumnLayer, TextLayer } = deckNS;
  const out = [];
  for (const spec of registry.list()) {
    if (!spec.visible) continue;
    const st = spec.style;
    if (spec.type === 'network') {
      const nodeById = new Map(spec.data.nodes.map((n) => [n.id, n]));
      const edges = spec.data.edges
        .map((e) => ({ ...e, a: nodeById.get(e.from), b: nodeById.get(e.to) }))
        .filter((e) => e.a && e.b);
      out.push(new LineLayer({
        id: `L|${spec.id}|edges`,
        data: edges,
        getSourcePosition: (e) => [e.a.lon, e.a.lat],
        getTargetPosition: (e) => [e.b.lon, e.b.lat],
        getColor: hexToRgb(st.edgeColor || '#7a8aa0').concat(200),
        getWidth: st.edgeWidth ?? 1.5,
        widthUnits: 'pixels',
        pickable: false,
      }));
      out.push(new ScatterplotLayer({
        id: `L|${spec.id}|nodes`,
        data: spec.data.nodes,
        getPosition: (n) => [n.lon, n.lat],
        getFillColor: (n) => hexToRgb(n.color || st.nodeColor || '#e8c468'),
        getRadius: st.nodeRadius ?? 3.5, radiusUnits: 'pixels',
        stroked: true, getLineColor: [14, 17, 22], lineWidthUnits: 'pixels', getLineWidth: 0.5,
        pickable: spec.pickable,
      }));
      if (st.showLabels) {
        out.push(new TextLayer({
          id: `L|${spec.id}|labels`,
          data: spec.data.nodes.filter((n) => n.label),
          getPosition: (n) => [n.lon, n.lat],
          getText: (n) => n.label,
          getSize: st.labelSize ?? 11, sizeUnits: 'pixels',
          getColor: [230, 232, 235, 220],
          getPixelOffset: [0, -12],
          characterSet: 'auto',
          pickable: false,
        }));
      }
    } else if (spec.type === 'extrusion') {
      const maxV = spec.data.points.reduce((m, p) => Math.max(m, p.value || 0), 0) || 1;
      out.push(new ColumnLayer({
        id: `L|${spec.id}|columns`,
        data: spec.data.points,
        diskResolution: 12,
        radius: st.radius ?? 6000,
        extruded: true,
        getPosition: (p) => [p.lon, p.lat],
        getElevation: (p) => (p.value || 0) * (st.heightScale ?? 1),
        getFillColor: (p) => (p.color ? hexToRgb(p.color).concat(210)
          : st.color ? hexToRgb(st.color).concat(210)
            : rampRGBA((p.value || 0) / maxV, 210)),
        pickable: spec.pickable,
      }));
    } else if (spec.type === 'markers') {
      out.push(new TextLayer({
        id: `L|${spec.id}|icons`,
        data: spec.data.points,
        getPosition: (p) => [p.lon, p.lat],
        getText: (p) => p.icon || '📍',
        getSize: st.iconSize ?? 20, sizeUnits: 'pixels',
        characterSet: 'auto',
        pickable: spec.pickable,
      }));
      if (st.showLabels !== false) {
        out.push(new TextLayer({
          id: `L|${spec.id}|labels`,
          data: spec.data.points.filter((p) => p.label),
          getPosition: (p) => [p.lon, p.lat],
          getText: (p) => p.label,
          getSize: st.labelSize ?? 11, sizeUnits: 'pixels',
          getColor: [230, 232, 235, 220],
          getPixelOffset: [0, 14],
          characterSet: 'auto',
          pickable: false,
        }));
      }
    } else if (spec.type === 'movers') {
      const placed = spec.data.tokens.map((tk) => ({ ...tk, _pos: moverPosition(tk, tNow) }));
      out.push(new ScatterplotLayer({
        id: `L|${spec.id}|halo`,
        data: placed,
        getPosition: (t) => [t._pos.lon, t._pos.lat],
        getFillColor: hexToRgb(st.haloColor || '#ffffff').concat(60),
        getRadius: (st.iconSize ?? 22) * 0.8, radiusUnits: 'pixels',
        pickable: false,
      }));
      out.push(new TextLayer({
        id: `L|${spec.id}|icons`,
        data: placed,
        getPosition: (t) => [t._pos.lon, t._pos.lat],
        getText: (t) => t.icon || '🚄',
        getSize: st.iconSize ?? 22, sizeUnits: 'pixels',
        characterSet: 'auto',
        pickable: spec.pickable,
        getAngle: st.rotateWithHeading ? (t) => -t._pos.heading : 0,
      }));
    }
  }
  return out;
}

export function createRendererDeck(container, opts = {}) {
  const model = opts.model;
  const onPick = opts.onPick;
  const maplibregl = opts.maplibregl || window.maplibregl;
  const deck = opts.deck || window.deck;
  if (!maplibregl || !deck) throw new Error('renderer-deck: maplibregl と deck が必要です');
  const clock = opts.clock || realClock();

  const STYLES = { ...DEFAULT_STYLES, ...(opts.baseStyles || {}) };
  const view = { center: [138.2, 37.5], zoom: 4.3, pitch: 0, ...(opts.initialView || {}) };
  const PR = { radius: 3, min: 2, max: 7, ...(opts.pointRadius || {}) }; // 点(px)。呼び出し側で拡大可

  const state = {
    mode: 'points',      // points | hex | heat
    base: 'dark',        // dark | gsi
    kanji: true,
    anim: true,
    pulse: 1,            // アンビエント演出の半径スケール
    showPoints: true,    // '点' トグル（renderer-2d の layers.points 相当）
    choro: opts.choropleth || null, // { index, kind:'errors'|'metric', values?, max? }
    viewMode: 'north-up',           // north-up | heading-up
    trackToken: null,               // heading-up 追従対象の mover token id
    bearing: 0,                     // 追従時のスムージング済みbearing
  };

  const registry = createLayerRegistry();

  // MapLibre は div コンテナが要る。OpaDeck geoMap は <canvas> を渡すので、その場合は
  // 親要素をコンテナに使い canvas は隠す（div を渡す tetsugo 単体ページとも両対応）。
  let hiddenCanvas = null;
  const mount = (container && container.tagName === 'CANVAS') ? container.parentElement : container;
  if (container && container.tagName === 'CANVAS') { container.style.display = 'none'; hiddenCanvas = container; }
  // inset(PiP)/wipe を重ねるため、mount は positioning context にする
  if (mount && getComputedStyle(mount).position === 'static') mount.style.position = 'relative';

  const map = new maplibregl.Map({
    container: mount,
    style: STYLES.dark,
    center: view.center, zoom: view.zoom, pitch: view.pitch, bearing: 0,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  // クリック: deck レイヤーid `L|<specId>|…` から spec を引き、spec.onPick に届ける。
  function dispatchLayerPick(info) {
    const lid = info && info.layer && String(info.layer.id || '');
    if (!lid || !lid.startsWith('L|')) return;
    const spec = registry.get(lid.split('|')[1]);
    if (spec && spec.onPick) spec.onPick(info.object ?? null, { layerId: spec.id, x: info.x, y: info.y });
  }

  const overlay = new deck.MapboxOverlay({
    interleaved: true,
    layers: [],
    onHover: (info) => { if (onPick) onPick(info && info.object, info ? { x: info.x, y: info.y } : null, info); },
    onClick: (info) => dispatchLayerPick(info),
  });
  map.addControl(overlay);

  // choro.index ごとに GeoJSON FeatureCollection をキャッシュ（index.features の polys から生成）。
  const fcCache = new Map();
  function choroFC(index) {
    const key = index.key || 'region';
    if (fcCache.has(key)) return fcCache.get(key);
    const fc = {
      type: 'FeatureCollection',
      features: index.features.map((f) => ({
        type: 'Feature',
        properties: { id: f.id, name: f.name },
        geometry: { type: 'MultiPolygon', coordinates: f.polys },
      })),
    };
    fcCache.set(key, fc);
    return fc;
  }

  function choroLayers() {
    const c = state.choro;
    if (!c || !c.index || !model) return [];
    const { GeoJsonLayer } = deck;
    const isMuni = (c.index.key === 'muni');
    let fillOf;
    if (c.kind === 'metric') {
      const max = c.max || 1;
      fillOf = (f) => {
        const v = c.values ? c.values.get(f.properties.id) : undefined;
        return v == null ? [40, 46, 57, 30] : rampRGBA(v / max, 150);
      };
    } else { // 'errors' — 地域内の最多カテゴリ色 × 件数濃度（renderer-2d と同じ表現）
      const agg = model.regionAggregate(c.index);
      const max = agg.max || 1;
      fillOf = (f) => {
        const cell = agg.get(f.properties.id);
        if (!cell) return [40, 46, 57, 30];
        const [r, g, b] = hexToRgb(model.colorOf(cell.topCategory));
        return [r, g, b, Math.round(255 * (0.25 + 0.55 * Math.sqrt(cell.count / max)))];
      };
    }
    return [new GeoJsonLayer({
      id: 'choro',
      data: choroFC(c.index),
      stroked: true, filled: true, pickable: true,
      getFillColor: fillOf,
      getLineColor: [120, 132, 150, isMuni ? 90 : 180],
      lineWidthUnits: 'pixels', getLineWidth: isMuni ? 0.3 : 0.6,
      updateTriggers: { getFillColor: [c.kind, c.max, model.filterSig ? model.filterSig() : Math.random()] },
    })];
  }

  function modeLayers() {
    if (!model || !state.showPoints) return [];
    const pts = model.visible();
    const { ScatterplotLayer, HexagonLayer, HeatmapLayer } = deck;
    if (state.mode === 'hex') {
      return [new HexagonLayer({
        id: 'hex', data: pts, getPosition: (d) => [d.lon, d.lat],
        radius: 8000, elevationScale: 40, extruded: true, pickable: true, coverage: 0.9,
        colorRange: [[46, 58, 89], [52, 90, 120], [78, 121, 167], [120, 160, 190], [200, 120, 90], [225, 87, 89]],
      })];
    }
    if (state.mode === 'heat') {
      return [new HeatmapLayer({
        id: 'heat', data: pts, getPosition: (d) => [d.lon, d.lat],
        radiusPixels: 40, intensity: 1, threshold: 0.05,
      })];
    }
    return [new ScatterplotLayer({
      id: 'pts', data: pts, getPosition: (d) => [d.lon, d.lat],
      getFillColor: (d) => hexToRgb(model.colorOf(d.category)),
      getRadius: PR.radius, radiusScale: state.pulse, radiusUnits: 'pixels',
      radiusMinPixels: PR.min, radiusMaxPixels: PR.max,
      stroked: true, getLineColor: [14, 17, 22], lineWidthUnits: 'pixels', getLineWidth: 0.5,
      pickable: true, opacity: 0.9,
      transitions: { getFillColor: 300, opacity: 300 },
      updateTriggers: { getFillColor: model.filterSig ? model.filterSig() : Math.random() },
    })];
  }

  function buildLayers() {
    // 下から: コロプレス → 点群/集約 → カスタムレイヤー(zIndex順)
    return [...choroLayers(), ...modeLayers(), ...buildCustomDeckLayers(deck, registry, clock.now())];
  }
  function draw() {
    overlay.setProps({ layers: buildLayers() });
    drawInsets();
  }

  // ベース地図ラベルの日本語(漢字)化。CARTO(dark) の name:ja を優先。地理院は no-op。
  function localizeLabels() {
    if (!state.kanji) return;
    const style = map.getStyle();
    if (!style || !style.layers) return;
    for (const layer of style.layers) {
      if (layer.type !== 'symbol' || !layer.layout || layer.layout['text-field'] === undefined) continue;
      try {
        map.setLayoutProperty(layer.id, 'text-field',
          ['coalesce', ['get', 'name:ja'], ['get', 'name_ja'], ['get', 'name:latin'], ['get', 'name']]);
      } catch (e) { /* レイヤーにより不可 */ }
    }
  }

  // --- mover token の現在位置(全 movers レイヤー横断) ---------------------------
  function tokenPosition(tokenId) {
    for (const spec of registry.list()) {
      if (spec.type !== 'movers') continue;
      const tk = spec.data.tokens.find((t) => t.id === tokenId);
      if (tk) return moverPosition(tk, clock.now());
    }
    return null;
  }

  // --- PiP(inset) ---------------------------------------------------------------
  // メインとレイヤーspec(registry)を共有し、カメラ/ビューモードだけ独立の小窓。
  // 実装は「小さな MapLibre + MapboxOverlay」方式(WebGLコンテキストを1個ずつ使う)。
  // issue #1 は deck MultiView(1コンテキスト)を想定していたが、MapboxOverlay(interleaved)
  // はベース地図と密結合のため、実装コストと引き換えに mini-map 方式を採用し
  // maxInsets を 3 に制限してコンテキスト上限(≈8-16)を守る。
  const MAX_INSETS = 3;
  const insets = new Map(); // id -> { spec, el, map, overlay, bearing }

  function insetLayers(spec) {
    const custom = buildCustomDeckLayers(deck, registry, clock.now())
      .filter((l) => !spec.layers || spec.layers.includes(String(l.id).split('|')[1]));
    if (spec.layers) return custom; // レイヤー指定があればカスタムのみ絞り込み
    return [...choroLayers(), ...modeLayers(), ...custom];
  }

  function addInset(spec) {
    if (insets.size >= MAX_INSETS) throw new Error(`inset は最大 ${MAX_INSETS} 個`);
    if (insets.has(spec.id)) removeInset(spec.id);
    const rect = spec.rect || { x: 0.7, y: 0.02, w: 0.28, h: 0.28 };
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;z-index:20;overflow:hidden;border-radius:6px;`
      + `left:${rect.x * 100}%;top:${rect.y * 100}%;width:${rect.w * 100}%;height:${rect.h * 100}%;`
      + `border:${(spec.border && spec.border.width) || 2}px solid ${(spec.border && spec.border.color) || 'rgba(230,232,235,0.5)'};`
      + `pointer-events:${spec.interactive ? 'auto' : 'none'};`;
    mount.appendChild(el);
    const cam = spec.camera || {};
    const center = (cam.lat != null) ? [cam.lon, cam.lat] : view.center;
    const imap = new maplibregl.Map({
      container: el, style: STYLES[state.base],
      center, zoom: cam.zoom ?? 8, pitch: cam.pitch ?? 0, bearing: 0,
      interactive: spec.interactive === true,
      attributionControl: false,
    });
    const ioverlay = new deck.MapboxOverlay({ interleaved: true, layers: [] });
    imap.addControl(ioverlay);
    const inset = { spec: { viewMode: 'north-up', ...spec, rect }, el, map: imap, overlay: ioverlay, bearing: 0 };
    insets.set(spec.id, inset);
    imap.once('load', () => ioverlay.setProps({ layers: insetLayers(inset.spec) }));
    return inset.spec;
  }
  function removeInset(id) {
    const it = insets.get(id);
    if (!it) return false;
    try { it.overlay.finalize && it.overlay.finalize(); it.map.remove(); } catch (_) { /* noop */ }
    it.el.remove();
    insets.delete(id);
    return true;
  }
  function updateInset(id, partial) {
    const it = insets.get(id);
    if (!it) return false;
    Object.assign(it.spec, partial);
    if (partial.camera && partial.camera.lat != null) {
      it.map.jumpTo({ center: [partial.camera.lon, partial.camera.lat], zoom: partial.camera.zoom ?? it.map.getZoom() });
    }
    return true;
  }
  function drawInsets() {
    for (const it of insets.values()) {
      if (!it.map.loaded()) continue;
      it.overlay.setProps({ layers: insetLayers(it.spec) });
    }
  }
  function tickInsets() {
    for (const it of insets.values()) {
      const cam = it.spec.camera || {};
      if (!cam.track) continue;
      const pos = tokenPosition(cam.track);
      if (!pos) continue;
      let bearing = 0;
      if (it.spec.viewMode === 'heading-up') {
        it.bearing += angleDelta(it.bearing, pos.heading) * 0.15;
        bearing = it.bearing;
      }
      it.map.jumpTo({ center: [pos.lon, pos.lat], zoom: cam.zoom ?? it.map.getZoom(), bearing });
    }
  }

  // --- 毎フレーム処理: アンビエント演出 / movers / heading-up 追従 -------------------
  let rafId = null;
  let t0 = null;
  function tick(ts) {
    if (t0 === null) t0 = ts;
    const moving = hasActiveMovers(registry);
    if (state.anim && state.mode === 'points') {
      state.pulse = 1 + 0.22 * Math.sin((ts - t0) / 900);
    }
    // メインビューの heading-up 追従
    if (state.viewMode === 'heading-up' && state.trackToken) {
      const pos = tokenPosition(state.trackToken);
      if (pos) {
        state.bearing += angleDelta(state.bearing, pos.heading) * 0.15;
        map.jumpTo({ center: [pos.lon, pos.lat], bearing: state.bearing });
      }
    }
    if ((state.anim && state.mode === 'points') || moving) draw();
    else if (insets.size) drawInsets();
    tickInsets();
    rafId = requestAnimationFrame(tick);
  }

  function applyStyle() {
    map.setStyle(STYLES[state.base]);
    map.once('styledata', () => { localizeLabels(); draw(); });
  }

  // --- wipe(画面切り替え演出): 共通実装(fx.js) -------------------------------------
  const wipe = createWipe(mount);

  const ready = () => { localizeLabels(); draw(); rafId = requestAnimationFrame(tick); };
  if (map.loaded()) ready(); else map.once('load', ready);

  return {
    kind: 'deck',
    refresh() { draw(); },
    resize() { map.resize(); for (const it of insets.values()) it.map.resize(); },
    setChoropleth(config) { state.choro = config; draw(); },
    setLayers(next) { if (next && 'points' in next) state.showPoints = next.points; draw(); },
    setMode(m) {
      state.mode = m;
      if (m === 'hex' && map.getPitch() < 20) map.easeTo({ pitch: 45, duration: 600 });
      draw();
    },
    setBase(b) { state.base = b; applyStyle(); },
    setKanji(v) { state.kanji = v; applyStyle(); },
    setAnim(v) { state.anim = v; },
    home() { map.easeTo({ center: view.center, zoom: view.zoom, pitch: 0, bearing: 0 }); },
    getMap() { return map; },
    getOverlay() { return overlay; },

    // --- 汎用レイヤーAPI(issue #1) ---
    addLayer(spec) { const s = registry.add(spec); draw(); return s; },
    removeLayer(id) { const r = registry.remove(id); draw(); return r; },
    setLayerVisible(id, v) { const r = registry.setVisible(id, v); draw(); return r; },
    updateLayerData(id, data) { const r = registry.updateData(id, data); draw(); return r; },
    reorderLayers(ids) { registry.reorder(ids); draw(); },
    supportsLayerType(t) { return LAYER_TYPES.includes(t); },
    getLayers() { return registry.toJSON(); },

    // --- カメラ演出・表示モード ---
    projectToScreen(lat, lon) { const p = map.project([lon, lat]); return { x: p.x, y: p.y }; },
    focusOn({ lat, lon, zoom, pitch, bearing, duration = 800 } = {}, { view: viewId } = {}) {
      const target = viewId ? insets.get(viewId)?.map : map;
      if (!target) return;
      target.easeTo({
        ...(lat != null ? { center: [lon, lat] } : {}),
        ...(zoom != null ? { zoom } : {}),
        ...(pitch != null ? { pitch } : {}),
        ...(bearing != null ? { bearing } : {}),
        duration,
      });
    },
    wipe,
    setViewMode(mode, { track } = {}) {
      state.viewMode = mode;
      state.trackToken = mode === 'heading-up' ? (track || state.trackToken) : null;
      if (mode === 'north-up') map.easeTo({ bearing: 0, duration: 500 });
    },
    supportsViewMode(m) { return m === 'north-up' || m === 'heading-up'; },

    // --- PiP(inset) ---
    addInset, removeInset, updateInset,
    maxInsets() { return MAX_INSETS; },

    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      for (const id of [...insets.keys()]) removeInset(id);
      wipe.destroy();
      overlay.finalize && overlay.finalize();
      map.remove();
      if (hiddenCanvas) hiddenCanvas.style.display = ''; // 元の canvas を復帰
    },
  };
}
