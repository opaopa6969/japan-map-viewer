// tour-test — mapcore/tour.js のフェーズマシン/物理をfake rendererでheadless検証。
//   node test/tour-test.mjs
import assert from 'node:assert';
import { createTourPlayer } from '../public/js/mapcore/tour.js';

let pass = 0;
const ok = (c, label) => { assert.ok(c, label); pass++; console.log('ok   ' + label); };

// fake renderer: jumpToを記録するだけ
function fakeRenderer() {
  const calls = [];
  return {
    calls,
    getMap: () => ({
      jumpTo: (o) => calls.push(o),
      getCenter: () => ({ lng: 137, lat: 37 }),
      getZoom: () => 5.8,
      getBearing: () => 0,
      getPitch: () => 35,
    }),
  };
}

const SPEC = {
  overview: { zoom: 5.8, pitch: 35 },
  cruise: { zoom: 15.9, pitch: 67, speed: 62, lookAhead: 85, bearingLag: 2.2 },
  dive: { gravity: 3.2, maxVz: 3.6, flare: 8, steer: 2.4 },
  climb: { boost: 2.4, maxVz: 3.0 },
  cities: [
    { name: 'A', lat: 35.68, lon: 139.77, cruiseSec: 3 },
    { name: 'B', lat: 34.70, lon: 135.50, cruiseSec: 2 },
  ],
};
// 単純な直線ルート(実道路の代役)
const ROUTE = [[139.76, 35.68], [139.77, 35.68], [139.78, 35.69]];

// ----- フェーズ遷移: dive → cruise → climb → 次都市 → done --------------------------
{
  const phases = [];
  let doneCalled = false;
  const r = fakeRenderer();
  const tour = createTourPlayer(r, SPEC, {
    getRoute: async () => ROUTE,
    onPhase: (p, city) => phases.push(`${p}:${city ? city.name : '-'}`),
    onDone: () => { doneCalled = true; },
  });
  // start()はrAFを使うので、beginDive相当を手動で: stateを直接駆動
  tour.state.cityIdx = 0;
  Object.assign(tour.cam, { lon: 137, lat: 37, zoom: 5.8, bearing: 0, pitch: 35, vLon: 0, vLat: 0, vZoom: 0 });
  // beginDiveはstart()内からしか呼ばれないため、stepの前にstartの中身を再現する
  // → 公開APIとしてstart()を呼ぶが、rAFが無い環境なので requestAnimationFrame をstub
  globalThis.requestAnimationFrame = () => 0;
  globalThis.performance = globalThis.performance || { now: () => 0 };
  tour.start();
  // ルート解決を待つ
  await new Promise((res) => setTimeout(res, 10));
  // 固定dtで回す(決定論)
  let guard = 20000;
  while (tour.state.phase !== 'done' && guard-- > 0) tour.step(1 / 30);
  ok(guard > 0, 'ツアーが有限ステップで完走する');
  ok(doneCalled, 'onDoneが呼ばれる');
  const seq = phases.join(' ');
  ok(seq.includes('dive:A') && seq.includes('cruise:A') && seq.includes('climb:A'), '都市Aで dive→cruise→climb');
  ok(seq.includes('dive:B') && seq.includes('cruise:B'), '都市Bへ続く');
  ok(r.calls.length > 100, 'jumpToが継続的に呼ばれる');
  // 物理の妥当性: zoomはoverview〜cruiseの範囲を出ない(多少のオーバーシュート許容)
  const zooms = r.calls.map((c) => c.zoom);
  ok(Math.min(...zooms) >= SPEC.overview.zoom - 0.5 && Math.max(...zooms) <= SPEC.cruise.zoom + 0.5,
    `zoomが範囲内(${Math.min(...zooms).toFixed(2)}〜${Math.max(...zooms).toFixed(2)})`);
  // cruise中はcruise zoomで固定される
  ok(zooms.filter((z) => Math.abs(z - SPEC.cruise.zoom) < 0.01).length > 50, 'cruise中はズーム固定で疾走');
}

// ----- getRoute失敗時は周回フォールバックで完走 -------------------------------------
{
  const r = fakeRenderer();
  let done = false;
  const tour = createTourPlayer(r, { ...SPEC, cities: [SPEC.cities[0]] }, {
    getRoute: async () => { throw new Error('no roads'); },
    onDone: () => { done = true; },
  });
  tour.start();
  await new Promise((res) => setTimeout(res, 10));
  let guard = 20000;
  while (tour.state.phase !== 'done' && guard-- > 0) tour.step(1 / 30);
  ok(done, 'ルート取得失敗でも周回フォールバックで完走');
}

// ----- cruiseKm(距離ベース)+ホップ: 上に飛んで左右を見て戻る --------------------------
{
  const r = fakeRenderer();
  let done = false;
  const spec2 = { ...SPEC, cruise: { ...SPEC.cruise, zoom: 17.3, pitch: 77, hopZoom: 0.9, hopSec: 2, lookDeg: 55 },
    cities: [{ name: 'C', lat: 35.68, lon: 139.77, cruiseKm: 0.4, hops: 2 }] };
  const longRoute = [];
  for (let i = 0; i <= 60; i++) longRoute.push([139.76 + i * 0.0002, 35.68]);   // ~1.1km直線
  const tour = createTourPlayer(r, spec2, { getRoute: async () => longRoute, onDone: () => { done = true; } });
  tour.start();
  await new Promise((res) => setTimeout(res, 10));
  let guard = 30000;
  while (tour.state.phase !== 'done' && guard-- > 0) tour.step(1 / 30);
  ok(done && guard > 0, 'cruiseKm(距離ベース)で完走する');
  const zooms = r.calls.map((c) => c.zoom);
  const minCruise = Math.min(...zooms.filter((z) => z > 10));   // 低空帯だけ見る
  ok(minCruise < 17.3 - 0.5, `ホップでzoomが一時的に下がる(最低 ${minCruise.toFixed(2)})`);
  const bearings = r.calls.map((c) => c.bearing);
  ok(Math.max(...bearings) > 20, '首振り(bearingオフセット)が入る');   // 直線東進(基準90度)+lookDegで振れる
}

// ----- arcモード: 道路不要の旋回フライバイ+高高度トランジット ------------------------
{
  const r = fakeRenderer();
  let done = false;
  const specArc = {
    overview: { zoom: 8.7, pitch: 48 },
    cruise: { mode: 'arc', zoom: 16.0, pitch: 73, speed: 170, turnRate: 16, bearingLag: 2.5 },
    dive: { gravity: 3.4, maxVz: 4.2, flare: 9, nearKm: 12, transitK: 0.35, transitZoom: 9.3 },
    climb: { boost: 2.8, maxVz: 3.4 },
    cities: [
      { name: '東京', lat: 35.68, lon: 139.77, cruiseSec: 3 },
      { name: '札幌', lat: 43.06, lon: 141.35, cruiseSec: 3 },   // 830km先=トランジットが要る
    ],
  };
  const tour = createTourPlayer(r, specArc, { onDone: () => { done = true; } });   // getRoute無しで動く
  tour.start();
  await new Promise((res) => setTimeout(res, 5));
  let guard = 60000;
  while (tour.state.phase !== 'done' && guard-- > 0) tour.step(1 / 30);
  ok(done && guard > 0, 'arcモード: getRoute無しで2都市(830km)を完走');
  const bearings = r.calls.map((c) => c.bearing);
  let spread = 0;
  for (let i = 1; i < bearings.length; i++) spread += Math.abs(bearings[i] - bearings[i - 1]) > 0.01 ? 1 : 0;
  ok(spread > 100, '旋回でbearingが回り続ける');
  const zooms = r.calls.map((c) => c.zoom);
  ok(zooms.some((z) => Math.abs(z - 16.0) < 0.05), '上空100m級(z16)まで降りる');
  ok(zooms.some((z) => z < 10 && z > 8.5), '都市間は飛行機高度(z9前後)で移動');
}

// ----- 区間距離に比例した上昇高度 / 低空トランジット / spec.start ---------------------
// zoomは小さいほど高い。近い都市へは低く、遠い都市へは高く上がること。
function arcSpec(cities, transit) {
  return {
    start: { lat: 36.05, lon: 139.6, zoom: 9.8, pitch: 50, bearing: 170 },
    overview: { zoom: 9.8, pitch: 50 },
    cruise: { mode: 'arc', zoom: 16.0, pitch: 73, speed: 170, turnRate: 16, bearingLag: 2.5 },
    dive: { gravity: 6.5, maxVz: 7.5, flare: 15, nearKm: 15, transitK: 3.0 },
    climb: { boost: 6.5, maxVz: 7.5 },
    transit: { shortKm: 50, longKm: 420, zoomNear: 13.2, zoomFar: 11.2, lowZoom: 15.9, lowK: 0.55, lowNearKm: 5, ...transit },
    cities,
  };
}

/** jumpTo を実際に保持する fake(上のfakeRendererはgetZoom等が固定値でspec.startを消す)。 */
function statefulRenderer(start) {
  const calls = [];
  const cam = { lng: start.lon, lat: start.lat, zoom: start.zoom, bearing: start.bearing ?? 0, pitch: start.pitch ?? 45 };
  return {
    calls, cam,
    getMap: () => ({
      jumpTo: (o) => {
        calls.push(o);
        cam.lng = o.center[0]; cam.lat = o.center[1];
        cam.zoom = o.zoom; cam.bearing = o.bearing; cam.pitch = o.pitch;
      },
      getCenter: () => ({ lng: cam.lng, lat: cam.lat }),
      getZoom: () => cam.zoom,
      getBearing: () => cam.bearing,
      getPitch: () => cam.pitch,
      setMaxPitch: () => {},
    }),
  };
}

/** ツアーを完走させ、climbに入るたびに「その区間の到達zoom」を拾う。 */
function flyThrough(spec) {
  const r = statefulRenderer(spec.start);
  const tour = createTourPlayer(r, spec, { onDone: () => {} });
  tour.start();
  let guard = 60000;
  const topPerLeg = [];
  let prev = tour.state.phase;
  while (tour.state.phase !== 'done' && guard-- > 0) {
    tour.step(1 / 60);
    if (tour.state.phase === 'climb' && prev !== 'climb') topPerLeg.push(tour.state.topZoom);
    prev = tour.state.phase;
  }
  return { calls: r.calls, topPerLeg, finished: guard > 0 };
}

{
  // 東京→(371km)→京都→(42km)→大阪。遠い区間ほど高く上がるはず
  const far = { name: '京都', lat: 35.0116, lon: 135.7681, cruiseSec: 2.1 };
  const near = { name: '大阪', lat: 34.7025, lon: 135.4959, cruiseSec: 2.1 };
  const tokyo = { name: '大手町', lat: 35.6866, lon: 139.7639, cruiseSec: 2.1 };
  const { topPerLeg, finished } = flyThrough(arcSpec([tokyo, far, near]));
  ok(finished, '大手町→京都→大阪を完走');
  ok(topPerLeg[0] < topPerLeg[1], `遠い区間ほど高く上がる (371km:z${topPerLeg[0].toFixed(1)} < 42km:z${topPerLeg[1].toFixed(1)})`);
  ok(topPerLeg[0] > 11.1 && topPerLeg[0] < 13.3, `到達高度が transit の zoomFar..zoomNear に収まる (z${topPerLeg[0].toFixed(2)})`);
}

{
  // lowTransit の行き先へは上がらない — cruise(z16)付近の低空を保つ
  const tokyo = { name: '大手町', lat: 35.6866, lon: 139.7639, cruiseSec: 2.1 };
  const kyoto = { name: '京都', lat: 35.0116, lon: 135.7681, cruiseSec: 2.1 };
  const osakaLow = { name: '大阪', lat: 34.7025, lon: 135.4959, cruiseSec: 2.1, lowTransit: true };
  const { topPerLeg } = flyThrough(arcSpec([tokyo, kyoto, osakaLow]));
  ok(topPerLeg[1] >= 15.85, `lowTransitの区間は上がらない (z${topPerLeg[1].toFixed(2)} ≈ lowZoom 15.9)`);

  // lowTransit を外すと、同じ42kmでも zoomNear まで上がる
  const osakaHigh = { ...osakaLow, lowTransit: false };
  const hi = flyThrough(arcSpec([tokyo, kyoto, osakaHigh]));
  ok(hi.topPerLeg[1] < 13.5 && hi.topPerLeg[1] > 12.5, `lowTransitを外せば通常の上昇になる (z${hi.topPerLeg[1].toFixed(2)})`);
  ok(topPerLeg[1] > hi.topPerLeg[1], 'lowTransitの方が低い高度で移動する');
}

{
  // spec.start があればそこから始まる
  const spec = arcSpec([{ name: '大手町', lat: 35.6866, lon: 139.7639, cruiseSec: 2.1 }]);
  const r = statefulRenderer({ lat: 0, lon: 0, zoom: 4, pitch: 0, bearing: 0 });   // 全然違う場所から
  const tour = createTourPlayer(r, spec, {});
  tour.start();
  ok(Math.abs(tour.cam.lat - 36.05) < 1e-9 && Math.abs(tour.cam.lon - 139.6) < 1e-9,
    'spec.start の関東平野上空から始まる(地図の現在位置を無視する)');
  ok(Math.abs(tour.cam.zoom - 9.8) < 1e-9, 'spec.start の zoom から始まる');
}

console.log(`\nall ${pass} checks passed`);
