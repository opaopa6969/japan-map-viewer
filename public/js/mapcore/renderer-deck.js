// mapcore/renderer-deck.js — MapLibre GL + deck.gl レンダラ（GPU可視化）。
// renderer-2d/3d と同じ mapcore モデル(point/filter/regionAggregate)を受け取り、
// ベース地図(MapLibre) の上に deck.gl レイヤー(点群/集約/ヒート/コロプレス)を重ねる。
// Mini Tokyo 3D と同じ「地図(MapLibre) + データ層(deck.gl)」の2階建て構成。
//
// 前提: MapLibre GL JS と deck.gl(UMD) がグローバル(maplibregl / deck)に読み込み済み。
//   （opts.maplibregl / opts.deck で明示注入も可）
// 引数: container(DOM要素), opts = {
//   model,            // createMapModel(...) の戻り（visible/colorOf/regionAggregate）
//   onPick,           // (object, {x,y}, info) => void  ホバー/クリック
//   baseStyles,       // { dark, gsi } 差し替え可
//   initialView,      // { center:[lon,lat], zoom, pitch }
//   maplibregl, deck, // 明示注入(省略時はグローバル)
// }
// 返り値は renderer-2d と同型 + deck 固有メソッド:
//   refresh / resize / setChoropleth / setLayers / home / destroy
//   + setMode('points'|'hex'|'heat') / setBase('dark'|'gsi') / setKanji(bool) / setAnim(bool) / getMap()

import { rampColor } from './metrics.js';

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

export function createRendererDeck(container, opts = {}) {
  const model = opts.model;
  const onPick = opts.onPick;
  const maplibregl = opts.maplibregl || window.maplibregl;
  const deck = opts.deck || window.deck;
  if (!maplibregl || !deck) throw new Error('renderer-deck: maplibregl と deck が必要です');

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
  };

  // MapLibre は div コンテナが要る。OpaDeck geoMap は <canvas> を渡すので、その場合は
  // 親要素をコンテナに使い canvas は隠す（div を渡す tetsugo 単体ページとも両対応）。
  let hiddenCanvas = null;
  const mount = (container && container.tagName === 'CANVAS') ? container.parentElement : container;
  if (container && container.tagName === 'CANVAS') { container.style.display = 'none'; hiddenCanvas = container; }

  const map = new maplibregl.Map({
    container: mount,
    style: STYLES.dark,
    center: view.center, zoom: view.zoom, pitch: view.pitch, bearing: 0,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  const overlay = new deck.MapboxOverlay({
    interleaved: true,
    layers: [],
    onHover: (info) => { if (onPick) onPick(info && info.object, info ? { x: info.x, y: info.y } : null, info); },
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
    return [...choroLayers(), ...modeLayers()]; // コロプレスは下層
  }
  function draw() { overlay.setProps({ layers: buildLayers() }); }

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

  // アンビエント演出: pulse を正弦で揺らし点群だけ radiusScale を更新（軽量）。
  let rafId = null;
  let t0 = null;
  function tick(ts) {
    if (t0 === null) t0 = ts;
    if (state.anim && state.mode === 'points') {
      state.pulse = 1 + 0.22 * Math.sin((ts - t0) / 900);
      draw();
    }
    rafId = requestAnimationFrame(tick);
  }

  function applyStyle() {
    map.setStyle(STYLES[state.base]);
    map.once('styledata', () => { localizeLabels(); draw(); });
  }

  const ready = () => { localizeLabels(); draw(); rafId = requestAnimationFrame(tick); };
  if (map.loaded()) ready(); else map.once('load', ready);

  return {
    kind: 'deck',
    refresh() { draw(); },
    resize() { map.resize(); },
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
    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      overlay.finalize && overlay.finalize();
      map.remove();
      if (hiddenCanvas) hiddenCanvas.style.display = ''; // 元の canvas を復帰
    },
  };
}
