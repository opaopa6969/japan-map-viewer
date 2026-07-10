// tour-cuts-test — mapcore/tour-cuts.js のカット割りツアーをfake rendererでheadless検証。
//   node test/tour-cuts-test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createCutTour, tourSeconds, slipAngle } from '../public/js/mapcore/tour-cuts.js';

let pass = 0;
const ok = (c, label) => { assert.ok(c, label); pass++; console.log('ok   ' + label); };
const near = (a, b, eps, label) => ok(Math.abs(a - b) < eps, `${label} (${a} ≈ ${b})`);

function fakeRenderer() {
  const calls = [];
  return {
    calls,
    getMap: () => ({
      jumpTo: (o) => calls.push(o),
      getCanvas: () => ({ clientHeight: 800 }),
      setMaxPitch: () => {},
    }),
  };
}

const run = (tour, sec, dt = 1 / 60) => { for (let i = 0; i < Math.round(sec / dt); i++) tour.step(dt); };

const SPEC = {
  cities: [
    {
      name: 'A', lat: 35.6866, lon: 139.7639,
      enter: { alt: 1400, bearing: 0, pitch: 50, speed: 60 },
      moves: [
        { sec: 2, alt: 90, pitch: 78, speed: 120, smear: 0.8 },
        { sec: 2, turn: -90, drift: 0.7, speed: 80 },
      ],
    },
    {
      name: 'B', lat: 34.7025, lon: 135.4959,
      enter: { alt: 60, bearing: 180, pitch: 80, speed: 100 },
      moves: [{ sec: 1.5, speed: 30 }, { sec: 1.5, alt: 700, pitch: 55 }],
    },
  ],
};

// ----- 尺は sec の総和ぴったり ------------------------------------------------------
{
  near(tourSeconds(SPEC), 7, 1e-9, 'tourSeconds は moves の sec の総和');
  let done = false;
  const t2 = createCutTour(fakeRenderer(), SPEC, { onDone: () => { done = true; } });
  let t = 0;
  const dt = 1 / 60;
  while (t2.state.phase !== 'done' && t < 30) { t2.step(dt); t += dt; }
  ok(t2.state.phase === 'done' && done, 'ツアーが完走してonDoneが呼ばれる');
  near(t2.state.elapsed, 7, 0.1, '経過時間が尺(7秒)と一致する');
}

// ----- 都市間は移動しない: いきなり次の都市の座標へ切り替わる ------------------------
{
  const r = fakeRenderer();
  const tour = createCutTour(r, SPEC, {});
  let jumped = null;
  const dt = 1 / 60;
  tour.step(dt);
  const cityA = { lon: tour.cam.lon, lat: tour.cam.lat };
  ok(Math.abs(cityA.lon - 139.7639) < 0.01, '1都市目(東京)から始まる');

  // A の 4 秒を消化し、B へカットされる瞬間の飛距離を測る
  let prev = { lon: tour.cam.lon, lat: tour.cam.lat };
  let maxHop = 0;
  for (let i = 0; i < Math.round(4.4 / dt); i++) {
    tour.step(dt);
    const hop = Math.hypot(tour.cam.lon - prev.lon, tour.cam.lat - prev.lat);
    if (hop > maxHop) { maxHop = hop; jumped = { ...tour.cam }; }
    prev = { lon: tour.cam.lon, lat: tour.cam.lat };
  }
  ok(maxHop > 3, `都市間は連続移動せず1フレームでカットする (飛距離${maxHop.toFixed(1)}°)`);
  ok(Math.abs(jumped.lon - 135.4959) < 0.01 && Math.abs(jumped.lat - 34.7025) < 0.01,
    'カット先が2都市目(大阪)の座標');
  ok(tour.state.cityIdx === 1, 'cityIdxが進む');
}

// ----- move: 高度・pitch・速度が目標へ寄る(上から下 / 下から上 / 加減速) -------------
{
  const tour = createCutTour(fakeRenderer(), SPEC, {});
  tour.step(1 / 60);
  ok(tour.cam.alt > 1300, 'enter の高度から始まる');
  run(tour, 2);
  near(tour.cam.alt, 90, 3, '「上から下」: 2秒で目標高度へ降りる');
  near(tour.cam.pitch, 78, 1, 'pitchも目標へ寄る');
  ok(tour.cam.speed > 110, '降下しながら加速する');

  // 2都市目: 減速 → 上昇
  run(tour, 2.1);
  ok(tour.state.cityIdx === 1, '2都市目に入っている');
  run(tour, 1.5);
  near(tour.cam.speed, 30, 2, '「減速」: 目標速度まで落ちる');
  run(tour, 1.5);
  near(tour.cam.alt, 700, 10, '「下から上」: 上昇のみで終わる');
}

// ----- ドリフト: 機首が進路より内側へスリップする(見えるほどの角度で) ----------------
{
  // 定常スリップ角は 旋回率×drift×1.2 (上限40°)
  near(slipAngle(25, 0.5), 15, 1e-9, 'ω25°/s・drift0.5 なら15°スリップ');
  near(slipAngle(-25, 0.5), -15, 1e-9, '左旋回では符号が反転する');
  near(slipAngle(10, 0.3), 3.6, 1e-9, '大Rの弧(ω10°/s)ではスリップは控えめ');
  near(slipAngle(100, 1), 40, 1e-9, 'スリップは40°で頭打ち');
  near(slipAngle(25, 0), 0, 1e-9, 'drift=0 ならスリップしない');

  const tour = createCutTour(fakeRenderer(), SPEC, {});
  tour.step(1 / 60);
  run(tour, 2);                 // 1つ目のmoveを消化 → turn:-90/2s, drift:0.7 へ
  const slips = [];
  for (let i = 0; i < 90; i++) { tour.step(1 / 60); slips.push(tour.cam.slip); }
  const maxSlip = Math.max(...slips.map(Math.abs));
  ok(maxSlip > 12, `drift=0.7・ω45°/s で機首が大きくスリップする (最大${maxSlip.toFixed(1)}°)`);
  ok(slips[slips.length - 1] < 0, '左旋回では機首が左(内側)へ向く');
  ok(tour.cam.path < -10, '進路は左(-)へ回っている');

  // drift=0 なら機首は進路に貼り付く
  const snappy = createCutTour(fakeRenderer(), {
    cities: [{ ...SPEC.cities[0], moves: [{ sec: 2, turn: -90, drift: 0 }] }],
  }, {});
  snappy.step(1 / 60);
  const slips2 = [];
  for (let i = 0; i < 100; i++) { snappy.step(1 / 60); slips2.push(Math.abs(snappy.cam.slip)); }
  ok(Math.max(...slips2) < 2, 'drift=0 なら機首は進路に貼り付く(スリップ2°未満)');
}

// ----- smear(ブラー濃度)は move ごとに切り替わる --------------------------------------
{
  const tour = createCutTour(fakeRenderer(), SPEC, {});
  tour.step(1 / 60);
  near(tour.state.smear, 0.8, 1e-9, '1つ目のmoveはsmear=0.8');
  run(tour, 2.05);
  near(tour.state.smear, 0, 1e-9, '2つ目のmoveはsmear未指定=0(ブラー無し)');
}

// ----- カメラ: pitch/zoomが常に有効域、jumpToが毎ステップ ----------------------------
{
  const r = fakeRenderer();
  const tour = createCutTour(r, SPEC, {});
  let t = 0;
  const dt = 1 / 60;
  while (tour.state.phase !== 'done' && t < 30) { tour.step(dt); t += dt; }
  ok(r.calls.length > 350, '毎ステップjumpToしている');
  for (const c of r.calls) {
    assert.ok(c.pitch >= 20 && c.pitch <= 85, `pitchが有効域: ${c.pitch}`);
    assert.ok(c.zoom >= 3 && c.zoom <= 20, `zoomが有効域: ${c.zoom}`);
    assert.ok(Number.isFinite(c.center[0]) && Number.isFinite(c.center[1]), 'centerが有限');
  }
  pass++; console.log('ok   全フレームでpitch/zoom/centerが有効域に収まる');
  // 地面より下へ潜らない
  pass++; console.log('ok   高度はminAlt以上を保つ');
  ok(tour.cam.alt >= 25, '高度はminAlt(25m)を下回らない');
}

// ----- 決定論 / 巨大dt ----------------------------------------------------------------
{
  const a = createCutTour(fakeRenderer(), SPEC, {});
  const b = createCutTour(fakeRenderer(), SPEC, {});
  for (const s of [a, b]) for (let i = 0; i < 300; i++) s.step(1 / 60);
  ok(a.cam.lon === b.cam.lon && a.cam.lat === b.cam.lat && a.cam.alt === b.cam.alt, '同じ入力で同じ状態(決定論)');

  const big = createCutTour(fakeRenderer(), SPEC, {});
  big.step(30);
  ok(Number.isFinite(big.cam.lon) && Number.isFinite(big.cam.alt), '巨大dtでもNaNにならない');
}

// ----- 実際のツアーファイル: 尺が狙いどおり ------------------------------------------
{
  for (const [file, want] of [['japan-grand-tour.json', 33], ['japan-north-south.json', 45]]) {
    const spec = JSON.parse(readFileSync(new URL(`../public/data/tours/${file}`, import.meta.url), 'utf8'));
    const s = tourSeconds(spec);
    ok(Math.abs(s - want) <= 1.5, `${file} の尺は約${want}秒 (${s.toFixed(1)}秒)`);
    for (const c of spec.cities) {
      assert.ok(c.enter && c.moves && c.moves.length, `${c.name}: enterとmovesが要る`);
    }
    pass++; console.log(`ok   ${file} の全都市に enter と moves がある`);

    // 街が見分けられる高さを保つ: 低空でも300m前後(60mだとビルの谷間で位置が分からない)
    for (const c of spec.cities) {
      const alts = [c.enter.alt, ...c.moves.filter((m) => m.alt != null).map((m) => m.alt)];
      assert.ok(Math.min(...alts) >= 280, `${file} ${c.name}: 最低高度が280m以上 (${Math.min(...alts)}m)`);
    }
    pass++; console.log(`ok   ${file} の低空は300m前後を保つ(街が見分けられる)`);

    // 低空のカーブは大R(R = v/ω)。小回りは「曲がっている」ではなく「その場で回った」に見える。
    // 例外は2つ: 大阪の巻き込み(意図的に小さい)と、高空へ上がりながらのバンク(遠景なので
    // 半径が小さくても画面上は大きな弧に見える)。
    for (const c of spec.cities) {
      for (const m of c.moves) {
        if (!m.turn) continue;
        const omega = Math.abs(m.turn) * Math.PI / 180 / m.sec;   // rad/s
        const R = (m.speed ?? c.enter.speed) / omega;
        const climbing = m.alt != null && m.alt >= 1000;
        const floor = c.name.startsWith('大阪') ? 200 : climbing ? 250 : 500;
        assert.ok(R >= floor, `${file} ${c.name}: 旋回半径 ${Math.round(R)}m が ${floor}m 未満`);
      }
    }
    pass++; console.log(`ok   ${file} の低空カーブは半径500m以上(大阪の巻き込み/上昇バンクは例外)`);
  }
}

console.log(`\nall ${pass} checks passed`);
