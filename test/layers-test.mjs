// layers-test — mapcore/layers.js の純関数部分(レジストリ/mover補間)のheadless決定論テスト。
//   node test/layers-test.mjs
import assert from 'node:assert';
import {
  createLayerRegistry, validateLayerSpec, moverPosition, headingDeg, hasActiveMovers,
} from '../public/js/mapcore/layers.js';

let pass = 0;
const ok = (c, label) => { assert.ok(c, label); pass++; console.log('ok   ' + label); };

// ----- validate ----------------------------------------------------------------
{
  assert.throws(() => validateLayerSpec({ id: 'x', type: 'nope' }), /type/);
  assert.throws(() => validateLayerSpec({ id: 'x', type: 'network', data: {} }), /nodes/);
  const s = validateLayerSpec({ id: 'n', type: 'network', data: { nodes: [], edges: [] } });
  ok(s.visible === true && s.pickable === false, 'spec既定: visible=true / pickable=false');
}

// ----- paths型の検証 -------------------------------------------------------------
{
  assert.throws(() => validateLayerSpec({ id: 'p', type: 'paths', data: {} }), /paths/);
  assert.throws(() => validateLayerSpec({ id: 'p', type: 'paths', data: { paths: [{ id: 'x', coords: [[139, 35]] }] } }), /2点以上/);
  const s = validateLayerSpec({ id: 'p', type: 'paths', data: { paths: [{ id: 'x', coords: [[139, 35], [140, 36]] }] } });
  ok(s.type === 'paths', 'paths型のspecが通る(coords 2点以上)');
}

// ----- polygons/tiles3d型の検証 -----------------------------------------------------
{
  assert.throws(() => validateLayerSpec({ id: 'b', type: 'polygons', data: {} }), /polygons/);
  assert.throws(() => validateLayerSpec({ id: 'b', type: 'polygons', data: { polygons: [{ id: 'x', ring: [[139, 35]] }] } }), /3点以上/);
  const b = validateLayerSpec({ id: 'b', type: 'polygons', data: { polygons: [{ id: 'x', ring: [[139, 35], [139.1, 35], [139.1, 35.1]], height: 20 }] } });
  ok(b.type === 'polygons', 'polygons型のspecが通る');
  assert.throws(() => validateLayerSpec({ id: 't', type: 'tiles3d', data: {} }), /url/);
  const t = validateLayerSpec({ id: 't', type: 'tiles3d', data: { url: '/data/plateau/13101/tileset.json' } });
  ok(t.type === 'tiles3d', 'tiles3d型のspecが通る(url必須)');
}

// ----- registry: zIndex順・上書き・reorder・JSON往復 --------------------------------
{
  const reg = createLayerRegistry();
  reg.add({ id: 'a', type: 'markers', data: { points: [] } });
  reg.add({ id: 'b', type: 'markers', zIndex: -1, data: { points: [] } });
  reg.add({ id: 'c', type: 'markers', data: { points: [] } });
  ok(reg.list().map((s) => s.id).join(',') === 'b,a,c', 'zIndex昇順(null=登録順)');
  reg.reorder(['c', 'a', 'b']);
  ok(reg.list().map((s) => s.id).join(',') === 'c,a,b', 'reorderで並び替え');
  reg.setVisible('a', false);
  ok(reg.get('a').visible === false, 'setVisible');
  const picked = [];
  reg.add({ id: 'p', type: 'markers', data: { points: [{ id: 'x', lat: 35, lon: 139 }] }, pickable: true, onPick: (f) => picked.push(f) });
  const json = JSON.stringify(reg.toJSON());
  ok(!json.includes('onPick') && json.includes('"p"'), 'toJSONはonPickを含まないJSON往復可能データ');
  const reg2 = createLayerRegistry();
  reg2.fromJSON(JSON.parse(json), { p: (f) => picked.push(f) });
  ok(reg2.list().length === reg.list().length && reg2.get('a').visible === false,
    'fromJSONで同一状態を復元(visible含む)');
  ok(typeof reg2.get('p').onPick === 'function', 'onPickはbindPicksで再バインドされる');
  reg.updateData('p', { points: [] });
  ok(reg.get('p').data.points.length === 0 && typeof reg.get('p').onPick === 'function',
    'updateDataはデータ差し替え後もonPickを維持する');
}

// ----- moverPosition: 決定論・補間・loop・クランプ -----------------------------------
{
  const token = { id: 't', route: [
    { lat: 35, lon: 139, t: 0 },
    { lat: 36, lon: 139, t: 10 },   // 真北へ
    { lat: 36, lon: 140, t: 20 },   // 真東へ
  ] };
  const p5 = moverPosition(token, 5);
  ok(Math.abs(p5.lat - 35.5) < 1e-9 && p5.lon === 139, 't=5: 区間1の中点(線形補間)');
  ok(Math.abs(p5.heading - 0) < 0.5, 't=5: heading≈0(北向き)');
  const p15 = moverPosition(token, 15);
  ok(p15.lat === 36 && Math.abs(p15.lon - 139.5) < 1e-9, 't=15: 区間2の中点');
  ok(Math.abs(p15.heading - 90) < 1.5, 't=15: heading≈90(東向き)');
  const pEnd = moverPosition(token, 999);
  ok(pEnd.done === true && pEnd.lon === 140, '範囲外は終点にクランプ(done=true)');
  const loopToken = { ...token, loop: true };
  const pl = moverPosition(loopToken, 25);   // 20で一周 → t=5 相当
  ok(Math.abs(pl.lat - 35.5) < 1e-9 && pl.done === false, 'loop=trueで周回(t=25→t=5相当)');
  // 決定論: 同入力→同出力
  ok(JSON.stringify(moverPosition(token, 7.3)) === JSON.stringify(moverPosition(token, 7.3)),
    '同(token,t)→同結果(決定論)');
}

// ----- headingDeg の基本方位 -----------------------------------------------------
{
  ok(Math.abs(headingDeg(35, 139, 36, 139) - 0) < 0.5, '北=0');
  ok(Math.abs(headingDeg(35, 139, 35, 140) - 90) < 0.5, '東=90');
  ok(Math.abs(headingDeg(36, 139, 35, 139) - 180) < 0.5, '南=180');
}

// ----- hasActiveMovers ----------------------------------------------------------
{
  const reg = createLayerRegistry();
  ok(hasActiveMovers(reg) === false, 'movers無し=false');
  reg.add({ id: 'm', type: 'movers', data: { tokens: [{ id: 't', route: [{ lat: 0, lon: 0, t: 0 }] }] } });
  ok(hasActiveMovers(reg) === true, 'movers有り=true');
  reg.setVisible('m', false);
  ok(hasActiveMovers(reg) === false, '非表示movers=false');
}

console.log(`\nall ${pass} checks passed`);
