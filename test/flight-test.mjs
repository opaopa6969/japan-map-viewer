// flight-test — mapcore/flight.js の飛行物理/カメラ変換をfake rendererでheadless検証。
//   node test/flight-test.mjs
import assert from 'node:assert';
import {
  createFlightSim, speedOfSound, zoomForAltitude, altitudeForZoom,
  speedForThrottle, throttleForSpeed, FLIGHT_DEFAULTS,
} from '../public/js/mapcore/flight.js';

let pass = 0;
const ok = (c, label) => { assert.ok(c, label); pass++; console.log('ok   ' + label); };
const near = (a, b, eps, label) => ok(Math.abs(a - b) < eps, `${label} (${a} ≈ ${b})`);

const H = 800;   // fakeキャンバス高さ

function fakeRenderer() {
  const calls = [];
  return {
    calls,
    getMap: () => ({
      jumpTo: (o) => calls.push(o),
      getCanvas: () => ({ clientHeight: H }),
      getCenter: () => ({ lng: 139.767, lat: 35.681 }),
      getZoom: () => 12,
      getBearing: () => 90,
      getPitch: () => 60,
      setMaxPitch: () => {},
    }),
  };
}

/** 入力なしで n 秒進める。 */
function run(sim, sec, input, dt = 1 / 60) {
  for (let i = 0; i < Math.round(sec / dt); i++) sim.step(dt, input);
}

// ----- 大気: 音速 -------------------------------------------------------------------
{
  near(speedOfSound(0), 340.3, 0.5, '海面の音速は約340.3 m/s');
  near(speedOfSound(11000), 295.1, 0.5, '11kmの音速は約295.1 m/s');
  ok(speedOfSound(20000) === speedOfSound(11000), '成層圏では音速が一定');
  ok(speedOfSound(0) > speedOfSound(10000), '高度が上がると音速は下がる');
}

// ----- 高度⇔ズーム変換 --------------------------------------------------------------
{
  for (const [alt, pitch] of [[30, 85], [3000, 60], [30000, 85], [1200, 20]]) {
    const z = zoomForAltitude(alt, 35.681, H, pitch);
    const back = altitudeForZoom(z, 35.681, H, pitch);
    near(back, alt, alt * 1e-9 + 1e-6, `zoom⇔alt が可逆 (alt=${alt}, pitch=${pitch})`);
  }
  const zLow = zoomForAltitude(100, 35.681, H, 85);
  const zHigh = zoomForAltitude(20000, 35.681, H, 85);
  ok(zLow > zHigh, '高度が上がるとズームは引く(単調減少)');
}

// ----- スロットルカーブ(等比): 低速域が潰れず、上限はマッハ10 -------------------------
{
  near(speedForThrottle(0, 600), FLIGHT_DEFAULTS.minSpeed, 1e-9, 'スロットル0は失速下限');
  near(speedForThrottle(1, 0), FLIGHT_DEFAULTS.maxMach * speedOfSound(0), 1e-6, 'スロットル全開はマッハ10');
  for (const t of [0.1, 0.3, 0.5, 0.9]) {
    ok(speedForThrottle(t, 600) > speedForThrottle(t - 0.05, 600), `スロットルは単調増加 (t=${t})`);
  }
  // 等比の要: レバーを同じだけ動かせば、どこでも速度は同じ倍率で変わる
  const ratio = (t) => speedForThrottle(t + 0.1, 600) / speedForThrottle(t, 600);
  for (const t of [0, 0.2, 0.5, 0.8]) near(ratio(t), ratio(0), 1e-9, `+10%の速度倍率が位置によらず一定 (t=${t})`);
  near(ratio(0), Math.pow(FLIGHT_DEFAULTS.maxMach * speedOfSound(600) / FLIGHT_DEFAULTS.minSpeed, 0.1), 1e-9,
    '1秒(レバー10%)で約1.66倍');

  // 低速で街を眺められること / 中間で音速前後に収まること
  const kmh = (t) => speedForThrottle(t, 600) * 3.6;
  ok(kmh(0.15) < 200, `スロットル15%で200km/h未満 (${Math.round(kmh(0.15))}km/h)`);
  ok(kmh(0.5) < 1200, `スロットル50%で1200km/h未満 (${Math.round(kmh(0.5))}km/h)`);

  // 逆関数: 時速100kmを指すスロットルを求めて戻せる
  for (const v of [100 / 3.6, 300 / 3.6, 1500 / 3.6]) {
    near(speedForThrottle(throttleForSpeed(v, 600), 600), v, 1e-6, `throttle⇔speedが可逆 (${Math.round(v * 3.6)}km/h)`);
  }
  near(throttleForSpeed(1e9, 0), 1, 1e-9, '速すぎる要求はスロットル1で頭打ち');
  near(throttleForSpeed(0, 0), 0, 1e-9, '失速下限以下はスロットル0');
  near(throttleForSpeed(-5, 0), 0, 1e-9, '負の速度でもNaNにならない');
}

// ----- 既定の初期状態: 東京上空・時速100km ------------------------------------------
{
  const sim = createFlightSim(fakeRenderer(), {});
  const s = sim.state;
  near(s.lat, 35.681, 1e-9, '既定の初期位置は東京駅');
  near(s.lon, 139.767, 1e-9, '既定の初期位置は東京駅(経度)');
  near(s.alt, 600, 1e-9, '既定の初期高度は600m');
  near(s.speed * 3.6, 100, 1e-9, '既定の初期速度は時速100km');
  ok(s.heading === 0 && s.gamma === 0 && s.bank === 0, '既定は北向き水平飛行');
  // スロットルは初期速度を保つ位置にある(離陸直後に勝手に加減速しない)
  sim.step(1 / 60, {});
  near(sim.state.speed * 3.6, 100, 0.01, '離陸直後は時速100kmを維持する');
}

// ----- 旋回率の上限: 低速+深バンクでも独楽にならない --------------------------------
{
  const sim = createFlightSim(fakeRenderer(), { start: { alt: 600, speed: 100 / 3.6, heading: 0 } });
  // 物理式なら ω=g·tan(80°)/27.8 ≈ 114°/s。上限55°/sで頭を押さえている
  run(sim, 8, { roll: 1 });
  ok(sim.state.bank > 70, '低速でも深バンクは入る');
  const sim2 = createFlightSim(fakeRenderer(), { start: { alt: 600, speed: 100 / 3.6, heading: 0 } });
  let maxTurn = 0;
  let prev = sim2.state.heading;
  for (let i = 0; i < 600; i++) {
    sim2.step(1 / 60, { roll: 1 });
    const d = Math.abs(((sim2.state.heading - prev + 540) % 360) - 180) * 60;   // deg/s
    if (d > maxTurn) maxTurn = d;
    prev = sim2.state.heading;
  }
  ok(maxTurn <= FLIGHT_DEFAULTS.maxTurnRate + FLIGHT_DEFAULTS.yawRate + 1e-6,
    `旋回率が上限を超えない (最大${maxTurn.toFixed(1)}°/s ≤ ${FLIGHT_DEFAULTS.maxTurnRate}°/s)`);
}

// ----- スロットル: マッハ10まで出る / 超えない --------------------------------------
{
  const r = fakeRenderer();
  const sim = createFlightSim(r, { start: { alt: 12000, speed: 240, throttle: 1 } });
  run(sim, 120, { pitch: 0, roll: 0, yaw: 0, throttle: 1 });
  ok(sim.state.mach > 9.5, `全開でマッハ9.5超に到達 (mach=${sim.state.mach.toFixed(2)})`);
  ok(sim.state.mach <= FLIGHT_DEFAULTS.maxMach + 1e-9, `マッハ10を超えない (mach=${sim.state.mach.toFixed(4)})`);

  run(sim, 200, { throttle: 0 });
  near(sim.state.speed, FLIGHT_DEFAULTS.minSpeed, 1, 'スロットル0で失速下限まで落ちる');
}

// ----- 加速は単調 / ブーストの方が速い ----------------------------------------------
{
  const mk = () => createFlightSim(fakeRenderer(), { start: { alt: 8000, speed: 200, throttle: 1 } });
  const normal = mk(); const boosted = mk();
  run(normal, 5, { throttle: 1, boost: false });
  run(boosted, 5, { throttle: 1, boost: true });
  ok(normal.state.speed > 200, 'スロットル全開で加速する');
  ok(boosted.state.speed > normal.state.speed, 'アフターバーナーの方が速く加速する');
}

// ----- 協調旋回: 右バンクで機首は右へ / 速いほど曲がらない --------------------------
{
  const sim = createFlightSim(fakeRenderer(), { start: { alt: 5000, heading: 0, speed: 200, throttle: 0.5 } });
  run(sim, 3, { roll: 1, throttle: 0.5 });
  ok(sim.state.bank > 0, '右エルロンで右バンクが付く');
  ok(sim.state.heading > 0 && sim.state.heading < 180, `右バンクで機首が右へ回る (hdg=${sim.state.heading.toFixed(1)})`);

  const slow = createFlightSim(fakeRenderer(), { start: { alt: 5000, heading: 0, speed: 150, throttle: 0 } });
  const fast = createFlightSim(fakeRenderer(), { start: { alt: 5000, heading: 0, speed: 2000, throttle: 1 } });
  run(slow, 2, { roll: 1, throttle: 0.05 });
  run(fast, 2, { roll: 1, throttle: 1 });
  ok(slow.state.heading > fast.state.heading, '同じバンクでも高速機の方が旋回が鈍い');
}

// ----- スタビリティ: 入力を離すと水平に戻る ------------------------------------------
{
  const sim = createFlightSim(fakeRenderer(), { start: { alt: 6000 } });
  run(sim, 2, { roll: 1, pitch: 1 });
  ok(sim.state.bank > 10 && sim.state.gamma > 5, '操作中はバンク・上昇角が付く');
  run(sim, 10, {});
  near(sim.state.bank, 0, 0.5, '手を離すとバンクが水平へ戻る');
  near(sim.state.gamma, 0, 0.5, '手を離すと経路角が水平へ戻る');
}

// ----- 上昇/降下と地面・天井のクランプ ------------------------------------------------
{
  const sim = createFlightSim(fakeRenderer(), { start: { alt: 3000, throttle: 0.6 } });
  const a0 = sim.state.alt;
  run(sim, 5, { pitch: 1, throttle: 0.6 });
  ok(sim.state.alt > a0, 'エレベータ引きで上昇する');
  ok(sim.state.vsMps > 0, '上昇中は昇降率が正');

  const dive = createFlightSim(fakeRenderer(), { start: { alt: 400, throttle: 1 } });
  run(dive, 60, { pitch: -1, throttle: 1 });
  ok(dive.state.alt >= FLIGHT_DEFAULTS.minAlt - 1e-9, '地面を突き抜けない');
  near(dive.state.gamma, 0, 1e-6, '接地したら経路角は水平になる');

  const climb = createFlightSim(fakeRenderer(), { start: { alt: 29500, throttle: 1 } });
  run(climb, 60, { pitch: 1, throttle: 1 });
  ok(climb.state.alt <= FLIGHT_DEFAULTS.maxAlt + 1e-9, '天井を突き抜けない');
}

// ----- カメラ: pitch/zoomが常に有効域、centerは機首方向の前方 -----------------------
{
  const r = fakeRenderer();
  const sim = createFlightSim(r, { start: { alt: 2000, heading: 0, throttle: 0.8 } });
  run(sim, 6, { pitch: -1, roll: 0.5, throttle: 0.8 });
  ok(r.calls.length > 300, 'ステップごとにjumpToしている');
  for (const c of r.calls) {
    assert.ok(c.pitch >= 20 && c.pitch <= 85, `pitchが有効域: ${c.pitch}`);
    assert.ok(c.zoom >= FLIGHT_DEFAULTS.minZoom && c.zoom <= FLIGHT_DEFAULTS.maxZoom, `zoomが有効域: ${c.zoom}`);
    assert.ok(Number.isFinite(c.center[0]) && Number.isFinite(c.center[1]), 'centerが有限');
  }
  pass++; console.log('ok   全フレームでpitch/zoom/centerが有効域に収まる');

  // 真北へ水平飛行するとき、注視点は機体より北(緯度が大きい)
  const north = createFlightSim(fakeRenderer(), { start: { alt: 2000, heading: 0, lat: 35, lon: 139 } });
  const cam = north.cameraFor(north.state, H);
  ok(cam.center[1] > north.state.lat, '注視点は機首方向(北)の前方にある');
  near(cam.bearing, 0, 1e-9, 'bearingは機首方位');
}

// ----- カメラ: 高いほどズームは引ける -------------------------------------------------
{
  const low = createFlightSim(fakeRenderer(), { start: { alt: 100 } });
  const high = createFlightSim(fakeRenderer(), { start: { alt: 20000 } });
  ok(low.cameraFor(low.state, H).zoom > high.cameraFor(high.state, H).zoom, '低空ほどズームは寄る');
}

// ----- syncFromMap: 現在の地図視点から機体を作る --------------------------------------
{
  const sim = createFlightSim(fakeRenderer(), {});
  sim.syncFromMap();
  near(sim.state.lon, 139.767, 1e-9, 'syncFromMapで経度を引き継ぐ');
  near(sim.state.heading, 90, 1e-9, 'syncFromMapでbearingを機首方位に');
  ok(sim.state.alt > 0 && sim.state.alt < FLIGHT_DEFAULTS.maxAlt, `zoom12から妥当な高度 (${Math.round(sim.state.alt)}m)`);
  ok(sim.state.gamma === 0 && sim.state.bank === 0, 'syncFromMapで姿勢は水平');
}

// ----- 決定論: 同じ入力列なら同じ軌跡 -------------------------------------------------
{
  const mk = () => createFlightSim(fakeRenderer(), { start: { alt: 4000, throttle: 0.7 } });
  const a = mk(); const b = mk();
  for (const sim of [a, b]) {
    for (let i = 0; i < 400; i++) sim.step(1 / 60, { pitch: Math.sin(i / 30), roll: Math.cos(i / 20), throttle: 0.7 });
  }
  ok(a.state.lon === b.state.lon && a.state.lat === b.state.lat && a.state.alt === b.state.alt, '同じ入力列で同じ状態(決定論)');
}

// ----- 巨大dtでも物理が破綻しない -----------------------------------------------------
{
  const sim = createFlightSim(fakeRenderer(), { start: { alt: 5000, throttle: 1 } });
  sim.step(30, { pitch: 1, roll: 1, throttle: 1 });   // タブ復帰相当
  const s = sim.state;
  ok(Number.isFinite(s.lon) && Number.isFinite(s.lat) && Number.isFinite(s.alt), '巨大dtでもNaNにならない');
  ok(s.alt >= FLIGHT_DEFAULTS.minAlt && s.alt <= FLIGHT_DEFAULTS.maxAlt, '巨大dtでも高度は有効域');
  ok(s.heading >= 0 && s.heading < 360, 'headingは常に0..360に正規化');
}

console.log(`\nall ${pass} checks passed`);
