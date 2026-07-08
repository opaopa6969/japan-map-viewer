// fetch-osm-buildings.mjs — OpenStreetMapから建物フットプリント+高さを取り出し、
// JRB v2(withValues=高さdm)で data/osm-buildings-<region>.jrb に保存する。
// 出典: OpenStreetMap contributors (ODbL)。https://download.geofabrik.de/
//
//   node scripts/fetch-osm-buildings.mjs [--region kanto|shikoku|...|japan]
//
// 高さの解決順: height タグ(m) → building:levels × 3m → 0(クライアント側で既定値)。
// 建物は道路の10倍以上の件数になる(関東で数百万)ので、wayごとの小配列を作らず
// 大きなFloat64Array+オフセットで持つ(メモリをV8ヒープ外に逃がす)。
// 依存: system の curl のみ。

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { osmDataBlocks, scanWays, scanDenseNodes } from '../lib/osm-pbf.mjs';
import { createRoadsEncoder, QUANT } from '../lib/road-codec.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = join(root, '.mapdata', 'osm');
const outDir = join(root, 'data');
mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });

const argOf = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const REGION = argOf('region', 'kanto');

const url = REGION === 'japan'
  ? 'https://download.geofabrik.de/asia/japan-latest.osm.pbf'
  : `https://download.geofabrik.de/asia/japan/${REGION}-latest.osm.pbf`;
const pbf = join(tmp, `${REGION}-latest.osm.pbf`);

if (!existsSync(pbf)) {
  console.log('GET', url);
  execSync(`curl -sSL -m 3600 -o "${pbf}" "${url}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
}
console.log(`pbf: ${pbf} (${(statSync(pbf).size / 1e6).toFixed(0)}MB)`);

// 高さ(m)→dm。"12.5", "12.5 m" 等の先頭数値を拾う。上限6553.5m(u16相当)にクランプ。
function heightDm(tag) {
  const h = tag('height');
  if (h != null) {
    const v = parseFloat(h);
    if (Number.isFinite(v) && v > 0) return Math.min(65535, Math.round(v * 10));
  }
  const lv = tag('building:levels');
  if (lv != null) {
    const v = parseFloat(lv);
    if (Number.isFinite(v) && v > 0) return Math.min(65535, Math.round(v * 3 * 10));
  }
  return 0;
}

// --- Pass A: building=* のwayを収集(大配列方式) ------------------------------------
console.log('Pass A: building ways…');
let refsBig = new Float64Array(1 << 22);
let refLen = 0;
function pushRef(id) {
  if (refLen === refsBig.length) {
    const next = new Float64Array(refsBig.length * 2);
    next.set(refsBig);
    refsBig = next;
  }
  refsBig[refLen++] = id;
}
const refStart = [];     // way i の refs 開始位置(終わりは次のstart)
const heights = [];      // dm
const namesArr = [];     // string|null (建物はほぼnull)
let totalWays = 0;
for await (const block of osmDataBlocks(pbf)) {
  scanWays(block, ({ tag, refs }) => {
    totalWays++;
    const b = tag('building');
    if (b == null || b === 'no') return;
    if (refs.length < 4) return;             // 閉リング最低3頂点+終点
    refStart.push(refLen);
    for (const id of refs) pushRef(id);
    heights.push(heightDm(tag));
    namesArr.push(tag('name'));
  });
}
refStart.push(refLen);
const wayN = heights.length;
console.log(`  ways total=${totalWays.toLocaleString()} building=${wayN.toLocaleString()} refs=${refLen.toLocaleString()}`);

// 必要ノードid → ソート済み一意配列
const needed = refsBig.slice(0, refLen);
needed.sort();
let uniq = 0;
for (let i = 0; i < needed.length; i++) {
  if (i === 0 || needed[i] !== needed[i - 1]) needed[uniq++] = needed[i];
}
const ids = needed.subarray(0, uniq);
console.log(`  needed nodes: ${uniq.toLocaleString()}`);

function indexOfId(id) {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ids[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

// --- Pass B: 座標解決 ---------------------------------------------------------------
console.log('Pass B: node coords…');
const xs = new Int32Array(uniq);
const ysArr = new Int32Array(uniq);
const got = new Uint8Array(uniq);
for await (const block of osmDataBlocks(pbf)) {
  scanDenseNodes(block, (id, latNano, lonNano) => {
    const at = indexOfId(id);
    if (at < 0) return;
    xs[at] = Math.round(lonNano / 1e9 * QUANT);
    ysArr[at] = Math.round(latNano / 1e9 * QUANT);
    got[at] = 1;
  });
}

// --- 組み立て → JRB v2 (ストリーミングエンコード: 座標のJS配列を作らずOOM回避) --------
console.log('encode…');
const enc = createRoadsEncoder({
  region: REGION,
  source: `OpenStreetMap contributors (ODbL) via Geofabrik ${REGION} (building)`,
  classLabels: ['building'],
  withValues: true,
});
let scratch = new Int32Array(1024);
let written = 0;
let dropped = 0;
let withH = 0;
for (let i = 0; i < wayN; i++) {
  const refN = refStart[i + 1] - refStart[i];
  if (refN * 2 > scratch.length) scratch = new Int32Array(refN * 2);
  let count = 0;
  let px = null;
  let py = null;
  for (let r = refStart[i]; r < refStart[i + 1]; r++) {
    const at = indexOfId(refsBig[r]);
    if (at < 0 || !got[at]) continue;
    const x = xs[at];
    const y = ysArr[at];
    if (x === px && y === py) continue;
    scratch[count * 2] = x;
    scratch[count * 2 + 1] = y;
    count++;
    px = x; py = y;
  }
  if (count < 3) { dropped++; continue; }
  enc.addWay({ cls: 0, name: namesArr[i], value: heights[i], coordsQ: scratch, count });
  written++;
  if (heights[i] > 0) withH++;
}

const buf = enc.finish();
const outFile = join(outDir, `osm-buildings-${REGION}.jrb`);
writeFileSync(outFile, buf);
console.log(`wrote ${outFile} — buildings ${written.toLocaleString()} (dropped ${dropped}) / 高さあり ${withH.toLocaleString()} / ${(buf.length / 1e6).toFixed(1)}MB`);
