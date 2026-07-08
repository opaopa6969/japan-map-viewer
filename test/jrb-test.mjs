// jrb-test — サーバ側エンコード(lib/road-codec)↔ブラウザ側デコード(mapcore/jrb.js)の
// クロス検証。node上でUint8Arrayに落として突き合わせる。
//   node test/jrb-test.mjs
import assert from 'node:assert';
import { encodeRoads, QUANT } from '../lib/road-codec.mjs';
import { decodeJrb, jrbToBuildingBinary } from '../public/js/mapcore/jrb.js';

let pass = 0;
const ok = (c, label) => { assert.ok(c, label); pass++; console.log('ok   ' + label); };

const WAYS = [
  { class: 0, name: '東京タワー', value: 3330, coords: [[139.7454, 35.6586], [139.7456, 35.6586], [139.7456, 35.6588], [139.7454, 35.6586]] },   // CCW寄り
  { class: 0, name: null, value: 0, coords: [[139.75, 35.66], [139.751, 35.661], [139.751, 35.66], [139.75, 35.66]] },                            // CW
  { class: 0, name: '東京タワー', value: 80, coords: [[139.70, 35.60], [139.701, 35.60], [139.701, 35.601]] },
];
const buf = encodeRoads({
  region: 'wire', source: 'unit', classLabels: ['building'], ways: WAYS, withValues: true,
  extraMeta: { truncatedFlag: true },
});

// ----- 低レベルdecode(decodeJrb) --------------------------------------------------
{
  const jrb = decodeJrb(new Uint8Array(buf));   // BufferではなくUint8Arrayとして渡す(ブラウザ相当)
  ok(jrb.meta.wayCount === 3 && jrb.meta.truncatedFlag === true, 'meta(extraMeta含む)が読める');
  ok(jrb.meta.totalPoints === 11, 'meta.totalPoints(4+4+3)');
  const w0 = jrb.decodeWay(0);
  ok(w0.name === '東京タワー' && w0.value === 3330, 'decodeWay: name/value');
  for (let j = 0; j < WAYS[0].coords.length; j++) {
    assert.ok(Math.abs(w0.coords[j][0] - WAYS[0].coords[j][0]) < 1 / QUANT);
    assert.ok(Math.abs(w0.coords[j][1] - WAYS[0].coords[j][1]) < 1 / QUANT);
  }
  ok(true, 'decodeWay: 座標が量子化誤差内で一致');
  ok(jrb.decodeWay(1).name === null, '名無しway');
}

// ----- deck向けbinary変換(jrbToBuildingBinary) -------------------------------------
{
  const bin = jrbToBuildingBinary(new Uint8Array(buf));
  ok(bin.length === 3, 'length=3');
  ok(bin.startIndices.length === 4 && bin.startIndices[3] === 11, 'startIndices末尾=totalPoints');
  ok(Math.abs(bin.heights[0] - 333.0) < 1e-4 && bin.heights[1] === 0, 'heights(dm→m)');
  ok(bin.names[0] === '東京タワー' && bin.names[1] === null, 'names配列');
  // 頂点集合はwinding正規化後も同じ(順序のみ変わりうる)
  const ring0 = new Set();
  for (let j = bin.startIndices[0]; j < bin.startIndices[1]; j++) {
    ring0.add(`${bin.positions[j * 2].toFixed(5)},${bin.positions[j * 2 + 1].toFixed(5)}`);
  }
  for (const [lon, lat] of WAYS[0].coords) assert.ok(ring0.has(`${lon.toFixed(5)},${lat.toFixed(5)}`));
  ok(true, 'positionsに全頂点が入っている(winding正規化しても欠けない)');
  // 全リングがCW(符号付き面積<=0)であること
  for (let i = 0; i < bin.length; i++) {
    let a2 = 0;
    for (let j = bin.startIndices[i]; j < bin.startIndices[i + 1] - 1; j++) {
      a2 += bin.positions[j * 2] * bin.positions[(j + 1) * 2 + 1] - bin.positions[(j + 1) * 2] * bin.positions[j * 2 + 1];
    }
    assert.ok(a2 <= 1e-12, `ring${i} はCW`);
  }
  ok(true, '全リングの向きがCWに正規化されている');
}

console.log(`\nall ${pass} checks passed`);
