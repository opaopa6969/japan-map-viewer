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

console.log(`\nall ${pass} checks passed`);
