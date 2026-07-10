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
  // darkRaster: 同じ見た目のラスタ版 — ベクタ解析もラベル衝突判定も無いので
  // 高速移動(ツアー)中のFPSが段違い(タイルはデコードして貼るだけ)。
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  // photo: 地理院シームレス空中写真 — 「地面がリッチ」なツアー用(ラスタ=高速)
  photo: {
    version: 8,
    sources: {
      photo: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'],
        tileSize: 256, attribution: '地理院タイル(シームレス空中写真)', maxzoom: 18,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0b0e13' } },
      { id: 'photo', type: 'raster', source: 'photo' },
    ],
  },
  darkRaster: {
    version: 8,
    sources: {
      carto: {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        ],
        tileSize: 256, attribution: '© CARTO © OpenStreetMap contributors', maxzoom: 19,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0e1116' } },
      { id: 'carto', type: 'raster', source: 'carto' },
    ],
  },
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
//
// liveIds: 「この overlay で一度でも表示したspec id」の集合(省略時は従来どおり全部渡す)。
// 不変条件は「deckに隠れたレイヤーを初期化させない」。
//   - 生きたoverlay上: 既に初期化済みなので visible:false で保持(下のコメント参照)
//   - 作り直したoverlay: 未初期化なので渡してはいけない。渡すと隠れたままの全国29Mが
//     ゼロから再テッセレーションされ、旧overlay解放前との二重確保(実測2.8GB)で
//     Array buffer allocation failed になる(setInterleaved が overlay を作り直す)
export function buildCustomDeckLayers(deckNS, registry, tNow, cullBounds, liveIds) {
  const { LineLayer, ScatterplotLayer, ColumnLayer, TextLayer, PathLayer, SolidPolygonLayer, Tile3DLayer } = deckNS;
  const out = [];
  for (const spec of registry.list()) {
    // 非表示はdeckのvisibleプロパティで隠す。リストから外すとdeckがリソースを破棄し、
    // 再表示のたびに全再テッセレーション+巨大バッファ再確保が走る(全国29Mで
    // Array buffer allocation failed実測)。visible:falseなら保持したまま描画スキップ。
    if (liveIds) {
      if (!spec.visible && !liveIds.has(spec.id)) continue;   // 未初期化の非表示は渡さない
      if (spec.visible) liveIds.add(spec.id);
    }
    const st = spec.style;
    if (spec.type === 'polygons') {
      if (spec.data.binary) {
        // binary attributes経路(mapcore/jrb.js の jrbToBuildingBinary 出力)。
        // 100万棟級: JSONもオブジェクト走査も無しでフラット配列がGPUへ直行する。
        // ring向きはデコーダがCW正規化済み(_windingOrder既定と一致)。
        //
        // 1レイヤーに詰め込みすぎると壁面ジオメトリのインデックスが内部限界を超えて
        // 巻き戻り、遠隔頂点同士が繋がる巨大三角形が出る(全国2,900万棟=1.86億頂点で実測)。
        // 600万頂点ごとにチャンク分割し、分割結果はdataオブジェクトにキャッシュする
        // (毎フレームのdraw()で参照が変わるとdeckが再アップロードしてしまうため)。
        const b = spec.data.binary;
        if (b.chunks && !b._chunks) {
          // デコーダ分割済み(jrbToBuildingChunks) — そのままレイヤーデータ化してキャッシュ
          b._chunks = b.chunks.map((ch) => ({
            base: ch.base,
            bbox: ch.bbox,   // 地理セル由来のチャンクなら視錐台カリングに使える
            data: {
              length: ch.length,
              startIndices: ch.startIndices,
              attributes: {
                getPolygon: { value: ch.positions, size: 2 },
                getElevation: { value: ch.heightsV, size: 1 },
              },
            },
          }));
        }
        if (!b._chunks) {
          const VMAX = 6000000;
          const heightsSrc = b.heightsV || b.heights;
          b._chunks = [];
          let s = 0;
          while (s < b.length) {
            const vStart = b.startIndices[s];
            let e = s;
            while (e < b.length && b.startIndices[e + 1] - vStart <= VMAX) e++;
            if (e === s) e = s + 1;   // 1棟でVMAX超は無い想定の保険
            const vEnd = b.startIndices[e];
            const si = new Uint32Array(e - s + 1);
            for (let i = 0; i <= e - s; i++) si[i] = b.startIndices[s + i] - vStart;
            b._chunks.push({
              base: s,
              data: {
                length: e - s,
                startIndices: si,
                attributes: {
                  getPolygon: { value: b.positions.subarray(vStart * 2, vEnd * 2), size: 2 },
                  // binary attributeは頂点ごと。建物ごと(heights)でなくheightsV(頂点展開済み)
                  getElevation: { value: heightsSrc.subarray(vStart, vEnd), size: 1 },
                },
              },
            });
            s = e;
          }
        }
        for (const chunk of b._chunks) {
          // 空間チャンク(bbox付き)は視界外をレイヤーごと外す。visible:falseで残すと
          // deckが確保を保持し続け、全国29M(=1.88億頂点、positionsだけでFloat64換算3GB)を
          // 積んだまま新しいチャンクが視界に入った瞬間に Array buffer allocation failed で
          // 落ちる(札幌へ飛ぶと実測)。外せばdeckがfinalizeして解放し、視界内ぶんだけが
          // 常時確保される。再入時のテッセレーションは1チャンク(最大600万頂点)で済む。
          const inView = !cullBounds || !chunk.bbox
            || (chunk.bbox[0] <= cullBounds[2] && chunk.bbox[2] >= cullBounds[0]
              && chunk.bbox[1] <= cullBounds[3] && chunk.bbox[3] >= cullBounds[1]);
          if (chunk.bbox && cullBounds && !inView) continue;
          out.push(new SolidPolygonLayer({
            id: `L|${spec.id}|polygons|${chunk.base}`,
            visible: spec.visible,
            data: chunk.data,
            _normalize: false,
            // 重要: 既定はXYZ(頂点=3要素)。XY詰めなので明示しないと頂点が3個ずつ
            // ズレて読まれ「三角形の建物」だらけになる(実測)。
            positionFormat: 'XY',
            _windingOrder: 'CW',   // jrb.jsのデコーダがCW正規化済み
            extruded: true,
            elevationScale: st.heightScale ?? 1,
            getFillColor: hexToRgb(st.color || '#8d99ae').concat(st.opacity ?? 230),
            pickable: spec.pickable,
          }));
        }
      } else {
        out.push(new SolidPolygonLayer({
          id: `L|${spec.id}|polygons`,
          visible: spec.visible,
          data: spec.data.polygons,
          extruded: true,
          getPolygon: (p) => p.ring,
          getElevation: (p) => (p.height || st.defaultHeight || 8) * (st.heightScale ?? 1),
          getFillColor: (p) => hexToRgb(p.color || st.color || '#8d99ae').concat(st.opacity ?? 230),
          pickable: spec.pickable,
        }));
      }
    } else if (spec.type === 'tiles3d') {
      // PLATEAU等の3D Tiles(tileset.json+b3dm)。deckのUMDバンドルに入っている
      // Tile3DLayer(geo-layers)を使う。視点連動のLODストリーミングはdeck任せ。
      if (Tile3DLayer) {
        out.push(new Tile3DLayer({
          id: `L|${spec.id}|tiles3d`,
          visible: spec.visible,
          data: spec.data.url,
          opacity: st.opacity ?? 1,
          pickable: spec.pickable,
        }));
      }
    } else if (spec.type === 'paths') {
      out.push(new PathLayer({
        id: `L|${spec.id}|paths`,
          visible: spec.visible,
        data: spec.data.paths,
        getPath: (p) => p.coords,
        getColor: (p) => hexToRgb(p.color || st.color || '#7a8aa0').concat(st.opacity ?? 200),
        getWidth: st.width ?? 1.5,
        widthUnits: 'pixels', widthMinPixels: st.width ?? 1.5,
        capRounded: true, jointRounded: true,
        pickable: spec.pickable,
      }));
    } else if (spec.type === 'network') {
      const nodeById = new Map(spec.data.nodes.map((n) => [n.id, n]));
      const edges = spec.data.edges
        .map((e) => ({ ...e, a: nodeById.get(e.from), b: nodeById.get(e.to) }))
        .filter((e) => e.a && e.b);
      out.push(new LineLayer({
        id: `L|${spec.id}|edges`,
          visible: spec.visible,
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
          visible: spec.visible,
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
          visible: spec.visible,
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
          visible: spec.visible,
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
          visible: spec.visible,
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
          visible: spec.visible,
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
      // 位置は [lon, lat, alt] — alt はroute補間(既定0)。地下鉄(負)や高架も表現できる。
      const placed = spec.data.tokens.map((tk) => ({ ...tk, _pos: moverPosition(tk, tNow) }));
      out.push(new ScatterplotLayer({
        id: `L|${spec.id}|halo`,
          visible: spec.visible,
        data: placed,
        getPosition: (t) => [t._pos.lon, t._pos.lat, t._pos.alt],
        getFillColor: hexToRgb(st.haloColor || '#ffffff').concat(60),
        getRadius: (st.iconSize ?? 22) * 0.8, radiusUnits: 'pixels',
        pickable: false,
      }));
      out.push(new TextLayer({
        id: `L|${spec.id}|icons`,
          visible: spec.visible,
        data: placed,
        getPosition: (t) => [t._pos.lon, t._pos.lat, t._pos.alt],
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
    labels: true,   // ベース地図の地名ラベル(町名無しモードでfalse)
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
    if (spec && spec.onPick) {
      const base = +(lid.split('|')[3] || 0);   // binaryチャンクのオフセット(無ければ0)
      spec.onPick(info.object ?? null, { layerId: spec.id, x: info.x, y: info.y, index: info.index >= 0 ? info.index + base : info.index });
    }
  }

  // interleaved: deckレイヤーをMapLibreの描画パイプラインに差し込む(ラベルの下に
  // 建物を潜らせる等ができる)。ただしラスタ基図だとMapLibreのラスタパスが深度を
  // 占有し、deckの押し出し(3D建物)が地面に潰れる既知の問題がある。
  // overlaid(interleaved:false)はdeckが自前の深度バッファで最前面に描くので、
  // 基図がラスタでも押し出しが正しく立つ(航空写真ツアーで使用)。
  let interleaved = true;
  let overlay = null;
  // この overlay で一度でも表示したspec id。overlayを作り直したら空に戻す
  // (新品のoverlayには隠れたレイヤーを渡さない → 巨大レイヤーの二重確保を避ける)。
  let liveIds = new Set();

  function makeOverlay() {
    liveIds = new Set();
    return new deck.MapboxOverlay({
      interleaved,
      layers: [],
      onHover: (info) => { if (onPick) onPick(info && info.object, info ? { x: info.x, y: info.y } : null, info); },
      onClick: (info) => dispatchLayerPick(info),
    });
  }
  overlay = makeOverlay();
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

  // カリング境界: 現在のビューポートを30%パディングした[lonMin,latMin,lonMax,latMax]。
  // getBoundsは高ピッチだと地平線側へ大きく伸びる=保守的(見えるものを消さない方向)。
  function cullBoundsOf(m) {
    try {
      const b = m.getBounds();
      const w = b.getWest();
      const s = b.getSouth();
      const e = b.getEast();
      const nn = b.getNorth();
      const px = (e - w) * 0.3;
      const py = (nn - s) * 0.3;
      return [w - px, s - py, e + px, nn + py];
    } catch (_) { return null; }
  }

  function buildLayers() {
    // 下から: コロプレス → 点群/集約 → カスタムレイヤー(zIndex順)
    return [...choroLayers(), ...modeLayers(), ...buildCustomDeckLayers(deck, registry, clock.now(), cullBoundsOf(map), liveIds)];
  }
  function draw() {
    overlay.setProps({ layers: buildLayers() });
    drawInsets();
  }

  // ベース地図のラベル(シンボルレイヤー)表示切替 — 「町名無しモード」。
  // データレイヤーには触れない(ベーススタイル側のvisibilityだけ)。
  function applyLabelVisibility() {
    const style = map.getStyle();
    if (!style || !style.layers) return;
    for (const layer of style.layers) {
      if (layer.type !== 'symbol') continue;
      try { map.setLayoutProperty(layer.id, 'visibility', state.labels ? 'visible' : 'none'); } catch (e) { /* noop */ }
    }
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

  function insetLayers(spec, imap) {
    const custom = buildCustomDeckLayers(deck, registry, clock.now(), imap ? cullBoundsOf(imap) : null)
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
    imap.once('load', () => ioverlay.setProps({ layers: insetLayers(inset.spec, imap) }));
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
      it.overlay.setProps({ layers: insetLayers(it.spec, it.map) });
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

  // --- 視錐台カリングの再判定 ---------------------------------------------------
  // 空間チャンク(bbox付きbinaryポリゴン)を持つレイヤーがある時だけ、カメラが
  // 「画面幅の10%移動 or zoom0.25」動いたら150msスロットルでdraw()し直す。
  // draw()はvisibleプロパティの差分だけなのでdeck側の再アップロードは起きない。
  let cullLast = { x: 0, y: 0, z: 0, t: -1 };
  function needsRecull(ts) {
    let has = false;
    for (const spec of registry.list()) {
      const b = spec.type === 'polygons' && spec.data && spec.data.binary;
      if (b && b._chunks && b._chunks.length > 1 && b._chunks[0].bbox) { has = true; break; }
    }
    if (!has) return false;
    if (ts - cullLast.t < 150) return false;
    const ctr = map.getCenter();
    const z = map.getZoom();
    if (cullLast.t >= 0) {
      const spanX = 360 / Math.pow(2, z);   // 概算の画面経度スパン
      const moved = Math.abs(ctr.lng - cullLast.x) + Math.abs(ctr.lat - cullLast.y);
      if (moved < spanX * 0.1 && Math.abs(z - cullLast.z) < 0.25) return false;
    }
    cullLast = { x: ctr.lng, y: ctr.lat, z, t: ts };
    return true;
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
    // pulse演出はmodel(点群)がある時だけ意味がある。model無しのレイヤー専用ページで
    // 毎フレームdraw()=全レイヤー再構築するとメインスレッドを無駄に食う(建物20万棟で
    // lag15ms実測)ので、movers稼働中かmodelありのpulse時のみ再構築する。
    if ((state.anim && state.mode === 'points' && model) || moving) draw();
    else if (needsRecull(ts)) draw();
    else if (insets.size) drawInsets();
    tickInsets();
    rafId = requestAnimationFrame(tick);
  }

  function applyStyle() {
    map.setStyle(STYLES[state.base]);
    map.once('styledata', () => { localizeLabels(); applyLabelVisibility(); draw(); });
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
    // deckの合成モード切替。false=overlaid(自前深度・最前面)。ラスタ基図で
    // 3D押し出しが潰れる問題の回避に使う(ツアーの航空写真時)。再作成しdraw()で再投入。
    setInterleaved(v) {
      const next = !!v;
      if (next === interleaved) return;
      interleaved = next;
      try { map.removeControl(overlay); } catch (_) { /* noop */ }
      overlay = makeOverlay();
      map.addControl(overlay);
      draw();
    },
    setKanji(v) { state.kanji = v; applyStyle(); },
    setLabels(v) { state.labels = !!v; applyLabelVisibility(); },   // 町名無しモード
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
