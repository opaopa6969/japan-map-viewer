// mapcore/layers.js — appendable/stackable なレイヤー機構のレンダラ非依存コア。
// (issue #1: 地図レイヤーのappendable化 + カメラ演出・PiP・表示モード設計)
//
// 責務:
//   - レイヤーspec(宣言的データ)の型検証
//   - レジストリ(id管理・zIndex順・visible・JSON往復)
//   - movers の位置補間(純関数・決定論 — headless テスト可能)
//   - clock(注入可能な時計。既定は実時計、テストは fake clock)
//
// レイヤーspec(JSON往復可能。関数は onPick だけ):
//   {
//     id: 'stations',          // 一意。既存idへのaddは上書き
//     type: 'network' | 'extrusion' | 'movers' | 'markers',
//     zIndex: 10,              // 省略時は登録順
//     visible: true,
//     pickable: false,         // クリック判定はopt-in(movers等のヒットテストは高コスト)
//     data: { ...type別... },
//     style: { ...type別... },
//     onPick: (feature, info) => {},   // info = { layerId, x, y }。シリアライズ対象外
//   }
//
// type別 data:
//   network:   { nodes: [{id, lat, lon, kind?, label?}], edges: [{from, to, kind?}] }
//   paths:     { paths: [{id, coords: [[lon, lat], ...], name?, kind?, color?}] }
//              実世界のポリライン(鉄道路線・道路・河川等)。network(グラフ)と違い
//              ノード共有を持たない「線の束」。kind/color でスタイル出し分け
//   extrusion: { points: [{id, lat, lon, value, category?, label?}] }
//              style: { heightScale?, radius?, color? }
//   movers:    { tokens: [{id, route: [{lat, lon, t}], icon?, label?, loop?}] }
//              t は clock.now() と同じ秒単位。loop=true でルート総時間で周回
//   markers:   { points: [{id, lat, lon, icon?, label?, color?}] }
//   polygons:  { polygons: [{id, ring: [[lon,lat],...], height?, name?, color?}] }
//              押し出しポリゴン(建物等)。height はメートル。2Dはフットプリント塗り
//   tiles3d:   { url: 'tileset.json のURL' }   (PLATEAU等の3D Tiles。deckレンダラのみ)

export const LAYER_TYPES = ['network', 'paths', 'extrusion', 'movers', 'markers', 'polygons', 'tiles3d'];

/** 既定の実時計(秒)。レンダラ生成時に opts.clock で差し替え可能(fake clockで決定論テスト)。 */
export function realClock() {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return { now: () => (nowMs() - t0) / 1000 };
}

/** spec を検証し、正規化したコピーを返す(不正は Error を投げる)。 */
export function validateLayerSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('layer spec が必要です');
  if (typeof spec.id !== 'string' || !spec.id) throw new Error('layer spec.id は非空文字列');
  if (!LAYER_TYPES.includes(spec.type)) throw new Error(`layer spec.type は ${LAYER_TYPES.join('|')} のいずれか: ${spec.type}`);
  const d = spec.data || {};
  if (spec.type === 'network') {
    if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('network は data.nodes[]/data.edges[] が必要');
  } else if (spec.type === 'paths') {
    if (!Array.isArray(d.paths)) throw new Error('paths は data.paths[] が必要');
    for (const p of d.paths) {
      if (!Array.isArray(p.coords) || p.coords.length < 2) throw new Error(`paths ${p.id}: coords[[lon,lat],...] (2点以上) が必要`);
    }
  } else if (spec.type === 'extrusion') {
    if (!Array.isArray(d.points)) throw new Error('extrusion は data.points[] が必要');
  } else if (spec.type === 'movers') {
    if (!Array.isArray(d.tokens)) throw new Error('movers は data.tokens[] が必要');
    for (const tk of d.tokens) {
      if (!Array.isArray(tk.route) || tk.route.length < 1) throw new Error(`movers token ${tk.id}: route[] が必要`);
    }
  } else if (spec.type === 'markers') {
    if (!Array.isArray(d.points)) throw new Error('markers は data.points[] が必要');
  } else if (spec.type === 'polygons') {
    if (!Array.isArray(d.polygons)) throw new Error('polygons は data.polygons[] が必要');
    for (const p of d.polygons) {
      if (!Array.isArray(p.ring) || p.ring.length < 3) throw new Error(`polygons ${p.id}: ring[[lon,lat],...] (3点以上) が必要`);
    }
  } else if (spec.type === 'tiles3d') {
    if (typeof d.url !== 'string' || !d.url) throw new Error('tiles3d は data.url(tileset.json) が必要');
  }
  return {
    id: spec.id,
    type: spec.type,
    zIndex: Number.isFinite(spec.zIndex) ? spec.zIndex : null, // null=登録順
    visible: spec.visible !== false,
    pickable: spec.pickable === true,
    data: d,
    style: spec.style || {},
    onPick: typeof spec.onPick === 'function' ? spec.onPick : null,
  };
}

/**
 * レイヤーレジストリ。全レンダラが同じものを内部に持つ(共有も可)。
 * list() は zIndex 昇順(同値/null は登録順) — 描画順=下から上。
 */
export function createLayerRegistry() {
  const specs = new Map();   // id -> normalized spec
  let seq = 0;               // 登録順(zIndex省略時のtiebreak)
  const order = new Map();   // id -> seq

  function add(spec) {
    const s = validateLayerSpec(spec);
    if (!order.has(s.id)) order.set(s.id, seq++);
    specs.set(s.id, s);
    return s;
  }
  function remove(id) {
    order.delete(id);
    return specs.delete(id);
  }
  function get(id) { return specs.get(id) || null; }
  function list() {
    return [...specs.values()].sort((a, b) => {
      const za = a.zIndex ?? 0;
      const zb = b.zIndex ?? 0;
      if (za !== zb) return za - zb;
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    });
  }
  function setVisible(id, v) {
    const s = specs.get(id);
    if (s) s.visible = !!v;
    return !!s;
  }
  function updateData(id, data) {
    const s = specs.get(id);
    if (!s) return false;
    add({ ...s, data }); // 再検証つき上書き(onPickは維持される: sをspreadしているため)
    return true;
  }
  /** ids の並び順で zIndex を振り直す(0,1,2,...)。含まれないレイヤーは末尾(既存順)。 */
  function reorder(ids) {
    let z = 0;
    for (const id of ids) {
      const s = specs.get(id);
      if (s) s.zIndex = z++;
    }
    for (const s of list()) {
      if (!ids.includes(s.id)) s.zIndex = z++;
    }
  }
  /** onPick(関数)を除いた JSON 往復可能なスナップショット。 */
  function toJSON() {
    return list().map(({ onPick, ...rest }) => rest);
  }
  /** toJSON() の出力から復元。onPick は bindPicks(id->fn) で再バインド。 */
  function fromJSON(arr, bindPicks = {}) {
    specs.clear();
    order.clear();
    seq = 0;
    for (const s of arr || []) add({ ...s, onPick: bindPicks[s.id] });
  }
  return { add, remove, get, list, setVisible, updateData, reorder, toJSON, fromJSON };
}

// --- movers の補間(純関数・決定論) ------------------------------------------

const DEG = Math.PI / 180;

/** 2点間の方位角(度、北=0、時計回り)。maplibre の bearing と同じ向き。 */
export function headingDeg(lat0, lon0, lat1, lon1) {
  const dLon = (lon1 - lon0) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat1 * DEG);
  const x = Math.cos(lat0 * DEG) * Math.sin(lat1 * DEG)
    - Math.sin(lat0 * DEG) * Math.cos(lat1 * DEG) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/**
 * token.route([{lat,lon,t,alt?}] 昇順) を時刻 tSec で線形補間する。
 * 返り値: { lat, lon, alt, heading, done } — heading は進行方向(度)、alt はメートル(省略時0)。
 * route が1点なら固定。loop=true なら総時間で周回。範囲外は端にクランプ(done=true)。
 * 純関数: 同じ (token, tSec) → 同じ結果(決定論テスト可能)。
 */
export function moverPosition(token, tSec) {
  const r = token.route;
  if (r.length === 1) return { lat: r[0].lat, lon: r[0].lon, alt: r[0].alt || 0, heading: 0, done: true };
  const t0 = r[0].t;
  const t1 = r[r.length - 1].t;
  const span = t1 - t0;
  let t = tSec;
  let done = false;
  if (token.loop && span > 0) {
    t = t0 + (((tSec - t0) % span) + span) % span;
  } else if (t <= t0) { t = t0; } else if (t >= t1) { t = t1; done = true; }
  // 区間探索(routeは高々数十点想定なので線形でよい)
  let i = 0;
  while (i < r.length - 2 && r[i + 1].t <= t) i++;
  const a = r[i];
  const b = r[i + 1];
  const seg = b.t - a.t;
  const u = seg > 0 ? (t - a.t) / seg : 1;
  return {
    lat: a.lat + (b.lat - a.lat) * u,
    lon: a.lon + (b.lon - a.lon) * u,
    alt: (a.alt || 0) + ((b.alt || 0) - (a.alt || 0)) * u,
    heading: headingDeg(a.lat, a.lon, b.lat, b.lon),
    done,
  };
}

/** レジストリ内に visible な movers レイヤーがあるか(レンダラが連続再描画の要否判定に使う)。 */
export function hasActiveMovers(registry) {
  return registry.list().some((s) => s.type === 'movers' && s.visible && s.data.tokens.length > 0);
}
