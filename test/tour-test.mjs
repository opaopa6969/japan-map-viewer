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

console.log(`\nall ${pass} checks passed`);
