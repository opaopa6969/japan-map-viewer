// fetch-osm-roads.mjs — OpenStreetMap(Geofabrik抽出)から道路網を取り出し、
// 自作バイナリcodec(lib/road-codec.mjs, "JRB1")で data/osm-roads-<region>.jrb に保存する。
// 全国の道路はJSONだと数百MBになるため、量子化+delta+varintのバイナリにして
// server.js がオンメモリに載せ /api/roads?bbox= で部分配信する(→ そちらを参照)。
// 出典: OpenStreetMap contributors (ODbL)。https://download.geofabrik.de/
//
//   node scripts/fetch-osm-roads.mjs [--region shikoku|kanto|kansai|...|japan]
//                                    [--classes motorway,trunk,primary,...]
//
// 既定クラスは幹線系(motorway〜tertiary+link)。residential まで含めると全国で
// 数百万wayに膨らむので、必要な時だけ --classes で明示する。
// 依存: system の curl のみ(PBF解析は lib/osm-pbf.mjs の純JS実装)。

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { osmDataBlocks, scanWays, scanDenseNodes } from '../lib/osm-pbf.mjs';
import { encodeRoads, QUANT } from '../lib/road-codec.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = join(root, '.mapdata', 'osm');
const outDir = join(root, 'data');
mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });

const argOf = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const REGION = argOf('region', 'japan');
const CLASSES = argOf('classes', 'motorway,motorway_link,trunk,trunk_link,primary,secondary,tertiary').split(',');
const classIdx = new Map(CLASSES.map((c, i) => [c, i]));

const url = REGION === 'japan'
  ? 'https://download.geofabrik.de/asia/japan-latest.osm.pbf'
  : `https://download.geofabrik.de/asia/japan/${REGION}-latest.osm.pbf`;
const pbf = join(tmp, `${REGION}-latest.osm.pbf`);

if (!existsSync(pbf)) {
  console.log('GET', url);
  execSync(`curl -sSL -m 3600 -o "${pbf}" "${url}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
}
console.log(`pbf: ${pbf} (${(statSync(pbf).size / 1e6).toFixed(0)}MB)`);

// --- Pass A: 対象クラスのwayを収集(タグ+ノード参照) ------------------------------
console.log('Pass A: ways…');
let wayCount = 0;
const ways = [];              // { cls, name, refs: number[] }
const refChunks = [];         // 必要ノードidの収集(後でsort/unique)
for await (const block of osmDataBlocks(pbf)) {
  scanWays(block, ({ tag, refs }) => {
    wayCount++;
    const highway = tag('highway');
    if (highway == null) return;
    const cls = classIdx.get(highway);
    if (cls === undefined) return;
    if (refs.length < 2) return;
    ways.push({ cls, name: tag('name'), refs });
    refChunks.push(refs);
  });
}
console.log(`  ways total=${wayCount.toLocaleString()} matched=${ways.length.toLocaleString()}`);

// 必要ノードid → ソート済みFloat64Array(id<2^53なのでNumberで安全)
let needCount = 0;
for (const r of refChunks) needCount += r.length;
const needed = new Float64Array(needCount);
{
  let o = 0;
  for (const r of refChunks) { for (const id of r) needed[o++] = id; }
}
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

// --- Pass B: DenseNodesから必要ノードの座標だけ拾う(1e5量子化) ---------------------
console.log('Pass B: node coords…');
const xs = new Int32Array(uniq);
const ysArr = new Int32Array(uniq);
const got = new Uint8Array(uniq);
let hit = 0;
for await (const block of osmDataBlocks(pbf)) {
  scanDenseNodes(block, (id, latNano, lonNano) => {
    const at = indexOfId(id);
    if (at < 0) return;
    xs[at] = Math.round(lonNano / 1e9 * QUANT);
    ysArr[at] = Math.round(latNano / 1e9 * QUANT);
    if (!got[at]) { got[at] = 1; hit++; }
  });
}
console.log(`  coords resolved: ${hit.toLocaleString()}/${uniq.toLocaleString()}`);

// --- 組み立て → JRB1 ---------------------------------------------------------------
const outWays = [];
let dropped = 0;
for (const w of ways) {
  const coords = [];
  let px = null;
  let py = null;
  for (const id of w.refs) {
    const at = indexOfId(id);
    if (at < 0 || !got[at]) continue;            // 抽出境界の欠けノードはスキップ
    const x = xs[at];
    const y = ysArr[at];
    if (x === px && y === py) continue;          // 量子化後の連続重複を除去
    coords.push([x / QUANT, y / QUANT]);
    px = x; py = y;
  }
  if (coords.length < 2) { dropped++; continue; }
  outWays.push({ class: w.cls, name: w.name, coords });
}

const buf = encodeRoads({
  region: REGION,
  source: `OpenStreetMap contributors (ODbL) via Geofabrik ${REGION}`,
  classLabels: CLASSES,
  ways: outWays,
});
const outFile = join(outDir, `osm-roads-${REGION}.jrb`);
writeFileSync(outFile, buf);
const pts = outWays.reduce((t, w) => t + w.coords.length, 0);
console.log(`wrote ${outFile} — ways ${outWays.length.toLocaleString()} (dropped ${dropped}) / pts ${pts.toLocaleString()} / ${(buf.length / 1e6).toFixed(1)}MB`);
