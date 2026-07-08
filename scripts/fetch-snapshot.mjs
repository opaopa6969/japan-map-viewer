// fetch-snapshot.mjs — GitHub Release(data-v1)からJRBスナップショットを取得して
// data/ に展開する。OSM由来のバイナリは再生成に時間がかかる(全国建物=約20分+
// 2.4GBのPBF DL)ため、ABR-Snapshot方式でRelease資産として配布する。
//
//   node scripts/fetch-snapshot.mjs [--tag data-v1] [--assets japan|kanto|all|min]
//     min(既定): 全国道路+全国建物 (デモがフル機能で動く最小セット)
//     kanto:     +関東建物(全関東直送オプション用)
//     all:       全部(四国の小型セット含む)
//
// .gz はそのまま残す(サーバの region直送 がディスクキャッシュとして使う)。
// 出典: © OpenStreetMap contributors (ODbL) via Geofabrik

import { execSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'data');
mkdirSync(outDir, { recursive: true });

const argOf = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const TAG = argOf('tag', 'data-v1');
const PROFILE = argOf('assets', 'min');

const SETS = {
  min: ['osm-roads-japan.jrb.gz', 'osm-buildings-japan.jrb.gz'],
  kanto: ['osm-roads-japan.jrb.gz', 'osm-buildings-japan.jrb.gz', 'osm-buildings-kanto.jrb.gz'],
  all: ['osm-roads-japan.jrb.gz', 'osm-buildings-japan.jrb.gz', 'osm-buildings-kanto.jrb.gz',
    'osm-buildings-shikoku.jrb.gz', 'osm-roads-shikoku.jrb.gz'],
};
const assets = SETS[PROFILE];
if (!assets) { console.error(`--assets は ${Object.keys(SETS).join('|')}`); process.exit(1); }

const base = `https://github.com/opaopa6969/japan-map-viewer/releases/download/${TAG}`;
for (const name of assets) {
  const gz = join(outDir, name);
  const raw = gz.replace(/\.gz$/, '');
  if (existsSync(raw)) { console.log(`skip(既にある): ${name.replace('.gz', '')}`); continue; }
  if (!existsSync(gz)) {
    console.log(`GET ${base}/${name}`);
    execSync(`curl -sSL -m 3600 -o "${gz}" "${base}/${name}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  console.log(`gunzip ${name} …`);
  execSync(`gunzip -k "${gz}"`);   // .gzは残す(サーバのregion直送キャッシュ)
  console.log(`  -> ${raw.split('/').pop()} (${(statSync(raw).size / 1e6).toFixed(0)}MB)`);
}
console.log('done. `npm start` で /api/roads と /api/buildings が全国対応になる');
