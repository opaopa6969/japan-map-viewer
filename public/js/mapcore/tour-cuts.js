// mapcore/tour-cuts.js — 「カット割り」のツアー。都市間は移動せず、いきなり切り替わる。
//
// tour.js が「日本地図の上を実際に飛ぶ」のに対し、こちらは映画の編集のように
// 都市ごとのショットを撮って繋ぐ。都市間トランジット(=上空へ上がって長距離を飛ぶ)が
// 無いので、タイル読み込みで止まらないし、尺が sec の総和ぴったりに決まる。
//
// 1都市 = enter(その都市に降り立つ初期状態) + moves[](振り付け)。
// move は「sec 秒かけて、いまの状態から目標へ寄せる」だけの汎用オブジェクト:
//
//   { sec: 1.8, alt: 90, pitch: 78, speed: 140, turn: -95, drift: 0.6, smear: 0.8 }
//
//   alt/pitch/speed … 目標値へ smoothstep で寄せる(省略=据え置き)。上から下、上のみ、
//                     下のみ、加速、減速(ブレーキ)は全部これで書ける。
//   turn            … この move の間に進路を何度回すか(+右/-左)。
//   drift           … 0=機首が進路に即追従、1=大きく遅れる。進行方向は turn 通りなので
//                     機首だけが遅れて外を向く = ドリフト。
//   smear           … 残像ブラーの濃さ(0..1)。demo が state.smear を見て合成する。
//
// 物理は step(dt) の陽的積分(決定論・Math.random不使用)。map操作は jumpTo のみ。
// カメラは flight.js と同じ「実高度→zoom」変換を使い、注視点は機首方向の前方に置く。

import { zoomForAltitude } from './flight.js';

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (u) => u * u * (3 - 2 * u);
const lerp = (a, b, u) => a + (b - a) * u;

/** 角度の最短差(-180..180)。 */
function angleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

// ドリフトは「機首が進路へ遅れて追従する」だけでは見えない。半径700m級の弧では
// 定常遅れが2〜4°にしかならず、画面上は真っ直ぐ曲がっているのと区別がつかない(実測)。
// そこで旋回率に比例したスリップ角を明示的に作る: 機首は進路より内側へ余計に向く
// (実車のドリフトと同じ。カメラは曲がりの外側を舐めるように見る)。
const SLIP_GAIN = 1.2;        // deg per (deg/s)
const SLIP_MAX = 40;          // deg
const NOSE_RATE = 6;          // 1/s スリップ角へ機首が寄る速さ(立ち上がり/戻りの滑らかさ)

/** 旋回率 omegaDeg(deg/s) と drift(0..1) から、機首が進路より内へ向く角(deg)。 */
export function slipAngle(omegaDeg, drift) {
  return clamp(clamp(drift ?? 0, 0, 1) * Math.abs(omegaDeg) * SLIP_GAIN, 0, SLIP_MAX) * Math.sign(omegaDeg);
}

/** ツアー全体の尺(秒)。JSONを読むだけで分かる。 */
export function tourSeconds(spec) {
  return (spec.cities || []).reduce(
    (t, c) => t + (c.moves || []).reduce((s, m) => s + (m.sec || 0), 0), 0,
  );
}

export function createCutTour(renderer, spec, { onShot, onDone } = {}) {
  const map = renderer.getMap();
  const cities = spec.cities || [];
  const lim = { minAlt: 25, maxAlt: 8000, minPitch: 20, maxPitch: 85, ...(spec.limits || {}) };

  // カメラ状態。bearing=機首(遅れる)、path=進路(turn通りに回る)
  const cam = { lon: 0, lat: 0, alt: 1000, bearing: 0, path: 0, slip: 0, pitch: 60, speed: 60 };
  const st = {
    phase: 'idle', cityIdx: 0, moveIdx: 0, t: 0, elapsed: 0,
    smear: 0, running: false, rafId: null,
  };
  let from = null;   // move開始時のスナップショット

  function viewportH() {
    try {
      const c = map.getCanvas();
      return c.clientHeight || c.height || 800;
    } catch (e) { return 800; }
  }

  function apply() {
    const pitch = clamp(cam.pitch, lim.minPitch, lim.maxPitch);
    const ground = cam.alt * Math.tan(pitch * DEG);        // 視線が地面と交わるまでの距離
    const kLon = 111320 * Math.cos(cam.lat * DEG);
    map.jumpTo({
      center: [
        cam.lon + Math.sin(cam.bearing * DEG) * ground / kLon,
        cam.lat + Math.cos(cam.bearing * DEG) * ground / 111320,
      ],
      zoom: clamp(zoomForAltitude(cam.alt, cam.lat, viewportH(), pitch), 3, 20),
      pitch,
      bearing: cam.bearing,
    });
  }

  /** 都市 i へカット(瞬間切り替え)。移動しない。 */
  function cutTo(i) {
    const city = cities[i];
    if (!city) return finish();
    const e = city.enter || {};
    cam.lon = city.lon;
    cam.lat = city.lat;
    cam.alt = clamp(e.alt ?? 1200, lim.minAlt, lim.maxAlt);
    cam.bearing = e.bearing ?? 0;
    cam.path = cam.bearing;
    cam.slip = 0;
    cam.pitch = clamp(e.pitch ?? 55, lim.minPitch, lim.maxPitch);
    cam.speed = e.speed ?? 60;
    st.cityIdx = i;
    st.moveIdx = 0;
    st.t = 0;
    st.phase = 'shot';
    from = null;
    if (onShot) onShot(city, currentMove(), i, 0);
    apply();
  }

  function currentMove() {
    const city = cities[st.cityIdx];
    return city && city.moves ? city.moves[st.moveIdx] : null;
  }

  function snapshot() {
    from = { alt: cam.alt, pitch: cam.pitch, speed: cam.speed, path: cam.path };
  }

  /** 1ステップ進める(dt秒)。テストから直接叩ける。 */
  function step(dt) {
    if (st.phase === 'done') return;
    if (st.phase === 'idle') cutTo(0);   // start()を経由せずstep()から回しても動くように
    if (st.phase === 'done') return;
    dt = Math.min(dt, 0.1);   // タブ復帰の巨大dtで振り付けが飛ばないように
    const city = cities[st.cityIdx];
    if (!city) return finish();
    const m = currentMove();
    if (!m) {                      // この都市のショットは撮り切った → 次の都市へカット
      if (st.cityIdx + 1 >= cities.length) return finish();
      return cutTo(st.cityIdx + 1);
    }
    if (!from) snapshot();

    st.t += dt;
    st.elapsed += dt;
    const sec = Math.max(1e-6, m.sec || 0);
    const u = smoothstep(Math.min(1, st.t / sec));
    const uLin = Math.min(1, st.t / sec);

    // --- 目標へ寄せる(省略された軸は据え置き) ---
    cam.alt = clamp(lerp(from.alt, m.alt ?? from.alt, u), lim.minAlt, lim.maxAlt);
    cam.pitch = clamp(lerp(from.pitch, m.pitch ?? from.pitch, u), lim.minPitch, lim.maxPitch);
    cam.speed = Math.max(0, lerp(from.speed, m.speed ?? from.speed, u));
    st.smear = m.smear ?? 0;

    // --- 進路は turn 通りに回り、機首は内側へスリップする(= ドリフト) ---
    // 平滑化するのはスリップ角だけ。機首=進路+スリップ なので drift=0 なら進路に貼り付く。
    // (機首そのものを一次遅れで追わせると、進路が回っている間ずっと ω/rate だけ
    //  遅れ続け、drift=0 でも 7.5° ずれてしまった)
    cam.path = from.path + (m.turn ?? 0) * uLin;
    const omega = (m.turn ?? 0) / sec;                    // deg/s
    cam.slip += (slipAngle(omega, m.drift) - cam.slip) * Math.min(1, NOSE_RATE * dt);
    cam.bearing = cam.path + cam.slip;

    // --- 並進: 進路方向へ speed で進む ---
    const kLon = 111320 * Math.cos(cam.lat * DEG);
    cam.lon += Math.sin(cam.path * DEG) * cam.speed * dt / kLon;
    cam.lat += Math.cos(cam.path * DEG) * cam.speed * dt / 111320;

    apply();

    if (st.t >= sec) {           // 次の move へ
      st.t = 0;
      st.moveIdx++;
      from = null;
      const next = currentMove();
      if (next && onShot) onShot(city, next, st.cityIdx, st.moveIdx);
    }
  }

  function finish() {
    st.phase = 'done';
    st.smear = 0;
    stop();
    if (onDone) onDone();
  }

  function start() {
    if (st.running) return;
    st.running = true;
    st.elapsed = 0;
    try { if (map.setMaxPitch) map.setMaxPitch(85); } catch (e) { /* noop */ }
    cutTo(0);
    let last = performance.now();
    const loop = (now) => {
      if (!st.running) return;
      step((now - last) / 1000);
      last = now;
      if (st.running) st.rafId = requestAnimationFrame(loop);
    };
    st.rafId = requestAnimationFrame(loop);
  }

  function stop() {
    st.running = false;
    if (st.rafId) cancelAnimationFrame(st.rafId);
    st.rafId = null;
  }

  return { start, stop, step, state: st, cam, seconds: tourSeconds(spec) };
}
