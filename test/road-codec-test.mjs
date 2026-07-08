// road-codec-test — lib/road-codec.mjs のroundtrip/決定論/bboxクエリのheadlessテスト。
//   node test/road-codec-test.mjs
import assert from 'node:assert';
import { encodeRoads, openRoads, QUANT } from '../lib/road-codec.mjs';

let pass = 0;
const ok = (c, label) => { assert.ok(c, label); pass++; console.log('ok   ' + label); };

const WAYS = [
  { class: 0, name: '国道11号', coords: [[134.0466, 34.3428], [134.05, 34.35], [134.06, 34.36]] },
  { class: 1, name: null, coords: [[133.5, 33.5], [133.6, 33.55]] },
  { class: 2, name: '国道11号', coords: [[134.1, 34.4], [134.2, 34.5]] },   // 名前重複→テーブル共有
  { class: 0, name: 'さぬき浜街道', coords: [[-0.001, -0.002], [0.003, 0.004]] },  // 負座標も通る
];
const OPTS = { region: 'test', source: 'unit', classLabels: ['primary', 'secondary', 'tertiary'] };

// ----- roundtrip ---------------------------------------------------------------
{
  const buf = encodeRoads({ ...OPTS, ways: WAYS });
  ok(buf.toString('ascii', 0, 4) === 'JRB1', 'magicはJRB1');
  const h = openRoads(buf);
  ok(h.meta.wayCount === 4 && h.meta.quant === QUANT, 'meta(wayCount/quant)が往復する');
  ok(h.meta.nameCount === 2, '名前テーブルは重複排除(2件)');
  for (let i = 0; i < WAYS.length; i++) {
    const w = h.decodeWay(i);
    assert.strictEqual(w.class, WAYS[i].class);
    assert.strictEqual(w.name, WAYS[i].name);
    assert.strictEqual(w.coords.length, WAYS[i].coords.length);
    for (let j = 0; j < w.coords.length; j++) {
      assert.ok(Math.abs(w.coords[j][0] - WAYS[i].coords[j][0]) < 1 / QUANT, `way${i} pt${j} lon`);
      assert.ok(Math.abs(w.coords[j][1] - WAYS[i].coords[j][1]) < 1 / QUANT, `way${i} pt${j} lat`);
    }
  }
  ok(true, '全way roundtrip(class/name/座標が量子化誤差内)');
}

// ----- 決定論: 同入力→同バイト列 ---------------------------------------------------
{
  const a = encodeRoads({ ...OPTS, ways: WAYS });
  const b = encodeRoads({ ...OPTS, ways: WAYS });
  ok(a.equals(b), '同入力→同バイト列(決定論)');
}

// ----- bboxクエリ ----------------------------------------------------------------
{
  const h = openRoads(encodeRoads({ ...OPTS, ways: WAYS }));
  const hit = h.queryBbox([134.0, 34.3, 134.3, 34.6]);
  ok(hit.indices.sort().join(',') === '0,2' && !hit.truncated, 'bbox内のwayだけヒット(0,2)');
  const cls = h.queryBbox([134.0, 34.3, 134.3, 34.6], { classFilter: new Set([2]) });
  ok(cls.indices.join(',') === '2', 'classFilterで絞れる');
  const none = h.queryBbox([140, 40, 141, 41]);
  ok(none.indices.length === 0, '範囲外は0件');
  const trunc = h.queryBbox([-1, -1, 135, 35], { maxWays: 1 });
  ok(trunc.indices.length === 1 && trunc.truncated === true, 'maxWays超過はtruncated=true(黙って切らない)');
}

console.log(`\nall ${pass} checks passed`);
