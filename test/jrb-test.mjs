// jrb-test — サーバ側エンコード(lib/road-codec)↔ブラウザ側デコード(mapcore/jrb.js)の
// クロス検証。node上でUint8Arrayに落として突き合わせる。
//   node test/jrb-test.mjs
import assert from 'node:assert';
import { encodeRoads, QUANT } from '../lib/road-codec.mjs';
import { decodeJrb, jrbToBuildingBinary, jrbToBuildingChunks } from '../public/js/mapcore/jrb.js';

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
  ok(bin.heightsV.length === 11, 'heightsVは頂点数ぶん');
  ok(Math.abs(bin.heightsV[0] - 333.0) < 1e-4 && Math.abs(bin.heightsV[3] - 333.0) < 1e-4
    && bin.heightsV[4] === 0, 'heightsVは各建物の高さが頂点範囲に展開される');
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

// ----- 旧ファイル互換: totalPoints無しでもフォールバック走査で正しく変換 ------------
{
  const legacy = encodeRoads({ region: 'wire', source: 'unit', classLabels: ['building'], ways: WAYS.slice(0, 2), withValues: true,
    extraMeta: { totalPoints: undefined } });   // undefinedはJSON化で落ちる=旧ファイル相当
  const jrb = decodeJrb(new Uint8Array(legacy));
  ok(jrb.meta.totalPoints === undefined, '旧ファイル相当(totalPoints無し)を用意できた');
  const bin = jrbToBuildingBinary(new Uint8Array(legacy));
  ok(bin.startIndices[2] === 8 && bin.positions.length === 16, '旧ファイルでもフォールバック走査で頂点が入る');
}

// ----- チャンク分割デコード(jrbToBuildingChunks) — 一枚岩を作らない経路 --------------
{
  const buf2 = encodeRoads({ region: 'wire', source: 'unit', classLabels: ['building'], ways: WAYS, withValues: true });
  const whole = jrbToBuildingBinary(new Uint8Array(buf2));
  const ck = jrbToBuildingChunks(new Uint8Array(buf2), { maxVerts: 5, spatial: false });   // 4+4+3点 → 5頂点予算で3分割(ファイル順)
  ok(ck.count === 3 && ck.totalPoints === 11, 'chunks: count/totalPoints');
  ok(ck.chunks.length === 3 && ck.chunks.map((c) => c.base).join(',') === '0,1,2', 'maxVerts=5で1棟ずつ3チャンク');
  // 一枚岩版と頂点列が一致(チャンク連結で比較)
  let off = 0;
  let same = true;
  for (const ch of ck.chunks) {
    for (let j = 0; j < ch.positions.length; j++) {
      if (ch.positions[j] !== whole.positions[off + j]) { same = false; break; }
    }
    off += ch.positions.length;
  }
  ok(same, 'チャンク連結の頂点列が一枚岩版と完全一致(winding込み)');
  ok(ck.chunks[0].heights[0] === whole.heights[0] && ck.chunks[0].names[0] === '東京タワー', 'チャンクのheights/names');
  ok(ck.chunks[2].startIndices[1] === 3, '各チャンクのstartIndicesはチャンク相対');
  const noNames = jrbToBuildingChunks(new Uint8Array(buf2), { maxVerts: 5, withNames: false, spatial: false });
  ok(noNames.chunks[0].names === null, 'withNames:falseでnames省略(メモリ節約)');
}

// ----- 空間チャンク(spatial:true 既定) — 地理セル単位で束ねbboxを持つ(視錐台カリング用) --
{
  // 東京2棟+大阪2棟(各8頂点)。予算10頂点 → 空間モードならセル順で「大阪」「東京」の2つに割れる
  // (ファイル順の逐次分割だと交互に混ざる)
  const FAR = [
    { class: 0, name: '東京A', value: 100, coords: [[139.70, 35.60], [139.701, 35.60], [139.701, 35.601], [139.70, 35.60]] },
    { class: 0, name: '大阪A', value: 200, coords: [[135.50, 34.70], [135.501, 34.70], [135.501, 34.701], [135.50, 34.70]] },
    { class: 0, name: '東京B', value: 300, coords: [[139.71, 35.61], [139.711, 35.61], [139.711, 35.611], [139.71, 35.61]] },
    { class: 0, name: '大阪B', value: 400, coords: [[135.51, 34.71], [135.511, 34.71], [135.511, 34.711], [135.51, 34.71]] },
  ];
  const bufF = encodeRoads({ region: 'wire', source: 'unit', classLabels: ['building'], ways: FAR, withValues: true });
  const sp = jrbToBuildingChunks(new Uint8Array(bufF), { maxVerts: 10, cellDeg: 0.25 });
  ok(sp.chunks.length === 2, '空間モード: 東京/大阪が別チャンクに割れる(ファイル順では交互)');
  const total = sp.chunks.reduce((a, c) => a + c.startIndices[c.length], 0);
  ok(total === 16 && sp.totalPoints === 16, '全頂点が保存される(欠落・重複なし)');
  for (const ch of sp.chunks) {
    ok(Array.isArray(ch.bbox) && ch.bbox.length === 4 && ch.bbox[0] <= ch.bbox[2] && ch.bbox[1] <= ch.bbox[3],
      `チャンクbboxがある [${ch.bbox.map((v) => v.toFixed(2)).join(',')}]`);
    // bboxが全頂点を包む+names/heightsがそのチャンクの建物と整合
    const isOsaka = ch.bbox[0] < 137;
    for (let li = 0; li < ch.length; li++) {
      assert.ok(ch.names[li].startsWith(isOsaka ? '大阪' : '東京'), 'チャンク内の建物は同じ街');
      for (let j = ch.startIndices[li]; j < ch.startIndices[li + 1]; j++) {
        assert.ok(ch.positions[j * 2] >= ch.bbox[0] - 1e-9 && ch.positions[j * 2] <= ch.bbox[2] + 1e-9);
        assert.ok(ch.positions[j * 2 + 1] >= ch.bbox[1] - 1e-9 && ch.positions[j * 2 + 1] <= ch.bbox[3] + 1e-9);
      }
    }
  }
  ok(true, 'bboxが全頂点を包み、names/heightsがチャンク再配列後も対応を保つ');
  // baseはチャンク順の累積(クリックpickのグローバルindex→チャンク解決に使う)
  ok(sp.chunks[0].base === 0 && sp.chunks[1].base === sp.chunks[0].length, 'baseはチャンク順の累積');
  // 東京の高さ値が正しい建物に付いている(dm→m)
  const tokyo = sp.chunks.find((c) => c.bbox[0] > 137);
  const ia = tokyo.names.indexOf('東京A');
  ok(Math.abs(tokyo.heights[ia] - 10) < 1e-4, '再配列後もheightsが正しい建物に対応(東京A=10m)');
}

console.log(`\nall ${pass} checks passed`);
