// mapcore/flight.js — ゲームパッドで操る自由飛行モード(フライトシミュレータ風)。
//
// tour.js が「再生」なのに対し、こちらは「操縦」。物理は同じ流儀で step(dt, input) の
// 陽的積分(決定論・Math.random不使用)。map操作は renderer.getMap().jumpTo() のみ。
//
// 機体状態は lon/lat/alt(実高度m)/heading/gamma(経路角)/bank(バンク角)/speed(m/s)。
// MapLibreのカメラには高度もロールも無いので、毎フレーム次の変換でカメラへ落とす:
//
//   pitch  = 85 + gamma        速度ベクトルの向きを見る(85=水平線, 25=急降下)。85が上限。
//   center = 機体位置から機首方向へ alt*tan(pitch) だけ前方(=視線が地面と交わる点)
//   zoom   = zoomForAltitude(alt, ...)   カメラ実高度が alt になるズーム
//
// これで「zoomを高度として扱う」ごまかしをせず、実高度で飛べる(マッハ10=約3400m/s)。
// bankは旋回率にのみ効く(協調旋回 ω = g·tan(bank)/V)。地平線は傾けられない
// (maplibre-gl 4.7.1 に roll が無いため)。

const DEG = Math.PI / 180;

/** Webメルカトルのズーム0・赤道でのm/px。 */
const MPP0 = 156543.03392804097;

/** MapLibreの既定FOV(rad)。cameraToCenterDistance = (H/2)/tan(fov/2) に使う。 */
const FOV = 0.6435011087932844;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** ISA標準大気の音速(m/s)。11km以遠は成層圏で一定(216.65K)。 */
export function speedOfSound(altM) {
  const T = altM < 11000 ? 288.15 - 0.0065 * altM : 216.65;
  return 20.0468 * Math.sqrt(T);
}

/** カメラ実高度 alt(m) を保つズーム。pitchが寝るほどカメラは中心から遠のく。 */
export function zoomForAltitude(altM, lat, viewportH, pitchDeg, fovRad = FOV) {
  const ccd = (viewportH / 2) / Math.tan(fovRad / 2);       // カメラ→中心の距離(px)
  const mpp = altM / (ccd * Math.cos(pitchDeg * DEG));      // 必要なm/px
  return Math.log2((MPP0 * Math.cos(lat * DEG)) / mpp);
}

/** zoomForAltitude の逆。テストと外部からの初期化に使う。 */
export function altitudeForZoom(zoom, lat, viewportH, pitchDeg, fovRad = FOV) {
  const ccd = (viewportH / 2) / Math.tan(fovRad / 2);
  const mpp = (MPP0 * Math.cos(lat * DEG)) / Math.pow(2, zoom);
  return mpp * ccd * Math.cos(pitchDeg * DEG);
}

export const FLIGHT_DEFAULTS = {
  maxMach: 10,        // マッハ10(高度で音速が変わるので実速度も変わる)
  minSpeed: 20,       // m/s 失速下限(スロットル0でもこの速度は残る=滑空。72km/h)
  thrustTau: 7,       // 秒 スロットル追従の時定数(大きいほど鈍い=重い機体)
  boostTau: 2.2,      // 秒 アフターバーナー時の時定数
  pitchRate: 32,      // deg/s エレベータ
  rollRate: 60,       // deg/s エルロン
  yawRate: 10,        // deg/s ラダー
  maxBank: 80,        // deg
  maxTurnRate: 25,    // deg/s 協調旋回の上限。低速+深バンクだと物理式では100°/s超で
                      //   独楽のように回ってしまい操縦不能になるので頭を押さえる
  maxGamma: 70,       // deg 経路角の上下限
  gammaDamp: 0.7,     // 入力なしのとき経路角が水平へ戻る速さ(1/s)
  levelRate: 2.2,     // 入力なしのときバンクが水平へ戻る速さ(1/s)
  minAlt: 25,         // m 地面(接地しても墜落はしない)
  maxAlt: 30000,      // m 成層圏の天井
  minZoom: 2,
  maxZoom: 20,
  g: 9.80665,
};

// スロットルは幾何級数(等比)にする。速度域が72km/h〜マッハ10と170倍もあるので、
// 線形や多項式カーブだと低速側だけが極端に敏感になり「街を眺める速度」で飛べない。
// v = minSpeed·(vMax/minSpeed)^t なら、レバーを同じだけ動かせば速度は常に同じ倍率で
// 変わる(既定レートなら1秒押して約1.66倍)。全域で同じ手応えになる。

/** スロットル位置(0..1)が指す目標速度(m/s)。 */
export function speedForThrottle(throttle, altM, cfg = FLIGHT_DEFAULTS) {
  const vMax = cfg.maxMach * speedOfSound(altM);
  return cfg.minSpeed * Math.pow(vMax / cfg.minSpeed, clamp(throttle, 0, 1));
}

/** speedForThrottle の逆。「時速100kmで飛び始める」ようなスロットル初期値に使う。 */
export function throttleForSpeed(speedMps, altM, cfg = FLIGHT_DEFAULTS) {
  const vMax = cfg.maxMach * speedOfSound(altM);
  if (speedMps <= cfg.minSpeed) return 0;
  return clamp(Math.log(speedMps / cfg.minSpeed) / Math.log(vMax / cfg.minSpeed), 0, 1);
}

const NO_INPUT = { pitch: 0, roll: 0, yaw: 0, throttle: null, boost: false };

/**
 * @param renderer mapcoreレンダラ(getMap()が要る)
 * @param opts     FLIGHT_DEFAULTS の上書き + { start:{lat,lon,alt,heading,throttle}, onState }
 */
export function createFlightSim(renderer, opts = {}) {
  const map = renderer.getMap();
  const cfg = { ...FLIGHT_DEFAULTS, ...opts };
  const s0 = opts.start || {};

  // 既定は東京駅上空600m・時速100km(=27.8m/s)。いきなりマッハで飛ばされると操作を
  // 覚える前に日本を出てしまうため、ゆっくり街を見られる速度から始める。
  const alt0 = s0.alt ?? 600;
  const speed0 = s0.speed ?? 100 / 3.6;
  const st = {
    lon: s0.lon ?? 139.767, lat: s0.lat ?? 35.681,
    alt: alt0,
    heading: s0.heading ?? 0,     // deg 真北基準
    gamma: 0,                     // deg 経路角(+上昇)
    bank: 0,                      // deg (+右バンク)
    speed: speed0,                // m/s
    throttle: s0.throttle ?? throttleForSpeed(speed0, alt0, cfg),
    mach: 0, gLoad: 1, vsMps: 0,  // HUD用の従属量
    running: false, rafId: null, t: 0,
  };

  /** 描画キャンバスの論理高さ(px)。ズーム⇔高度の変換に要る。 */
  function viewportH() {
    try {
      const c = map.getCanvas();
      return c.clientHeight || c.height || 800;
    } catch (e) { return 800; }
  }

  /** 現在の機体状態からカメラを作る(純粋)。 */
  function cameraFor(state, H) {
    const pitch = clamp(85 + state.gamma, 20, 85);
    const ground = state.alt * Math.tan(pitch * DEG);          // 視線が地面と交わるまでの水平距離
    const kLon = 111320 * Math.cos(state.lat * DEG);
    const zoom = clamp(zoomForAltitude(state.alt, state.lat, H, pitch), cfg.minZoom, cfg.maxZoom);
    return {
      center: [
        state.lon + Math.sin(state.heading * DEG) * ground / kLon,
        state.lat + Math.cos(state.heading * DEG) * ground / 111320,
      ],
      zoom, pitch, bearing: state.heading,
    };
  }

  /** 1ステップ進める(dt秒)。inputは各軸-1..1、throttleは0..1(nullで据え置き)。 */
  function step(dt, input) {
    dt = Math.min(dt, 0.1);   // タブ復帰の巨大dtで物理が飛ばないように
    st.t += dt;
    const inp = { ...NO_INPUT, ...(input || {}) };
    if (inp.throttle != null) st.throttle = clamp(inp.throttle, 0, 1);

    // --- 推力: スロットルの指す速度へ一次遅れで追従。ブーストは時定数が縮む ---
    const a = speedOfSound(st.alt);
    const vMax = cfg.maxMach * a;
    const target = speedForThrottle(st.throttle, st.alt, cfg);
    const tau = inp.boost ? cfg.boostTau : cfg.thrustTau;
    st.speed += (target - st.speed) * Math.min(1, dt / tau);
    st.speed = clamp(st.speed, cfg.minSpeed, vMax);

    // --- 姿勢: エルロン/エレベータ。入力を離すと水平へ戻る(スタビリティ) ---
    if (inp.roll) st.bank = clamp(st.bank + inp.roll * cfg.rollRate * dt, -cfg.maxBank, cfg.maxBank);
    else st.bank -= st.bank * Math.min(1, cfg.levelRate * dt);

    if (inp.pitch) st.gamma = clamp(st.gamma + inp.pitch * cfg.pitchRate * dt, -cfg.maxGamma, cfg.maxGamma);
    else st.gamma -= st.gamma * Math.min(1, cfg.gammaDamp * dt);

    // --- 協調旋回: ω = g·tan(bank)/V。速いほど曲がらない(ジェットの重さ) ---
    const turnRaw = (cfg.g * Math.tan(st.bank * DEG)) / Math.max(st.speed, 1) / DEG;   // deg/s
    const turn = clamp(turnRaw, -cfg.maxTurnRate, cfg.maxTurnRate);
    st.heading = (((st.heading + (turn + inp.yaw * cfg.yawRate) * dt) % 360) + 360) % 360;

    // --- 並進: 速度ベクトルを水平/垂直へ分解 ---
    const vH = st.speed * Math.cos(st.gamma * DEG);
    const vV = st.speed * Math.sin(st.gamma * DEG);
    st.alt = clamp(st.alt + vV * dt, cfg.minAlt, cfg.maxAlt);
    if (st.alt <= cfg.minAlt && st.gamma < 0) st.gamma = 0;   // 接地: 墜落させず水平飛行へ
    if (st.alt >= cfg.maxAlt && st.gamma > 0) st.gamma = 0;   // 天井
    const kLon = 111320 * Math.cos(st.lat * DEG);
    st.lon += Math.sin(st.heading * DEG) * vH * dt / kLon;
    st.lat += Math.cos(st.heading * DEG) * vH * dt / 111320;

    st.mach = st.speed / a;
    st.gLoad = 1 / Math.max(0.15, Math.cos(st.bank * DEG));
    st.vsMps = vV;

    map.jumpTo(cameraFor(st, viewportH()));
    if (opts.onState) opts.onState(st);
  }

  function start() {
    if (st.running) return;
    st.running = true;
    try { if (map.setMaxPitch) map.setMaxPitch(85); } catch (e) { /* noop */ }
    let last = performance.now();
    const loop = (now) => {
      if (!st.running) return;
      step((now - last) / 1000, opts.readInput ? opts.readInput((now - last) / 1000) : null);
      last = now;
      st.rafId = requestAnimationFrame(loop);
    };
    st.rafId = requestAnimationFrame(loop);
  }

  function stop() {
    st.running = false;
    if (st.rafId) cancelAnimationFrame(st.rafId);
    st.rafId = null;
  }

  /** 現在のマップ視点から機体を作り直す(ボタンで飛び始める時に使う)。 */
  function syncFromMap() {
    const c = map.getCenter();
    const pitch = Math.max(map.getPitch(), 20);
    st.lon = c.lng; st.lat = c.lat;
    st.alt = clamp(altitudeForZoom(map.getZoom(), c.lat, viewportH(), pitch), cfg.minAlt, cfg.maxAlt);
    st.heading = map.getBearing();
    st.gamma = 0; st.bank = 0;
  }

  return { start, stop, step, syncFromMap, cameraFor, state: st, cfg };
}
