// fetch-highways.mjs — 国土数値情報「高速道路時系列」(N06)を DL し、高速道路の
// 区間ポリラインと IC/JCT を public/data/japan-highways.json に圧縮保存する。鍵不要。
// 出典: 国土交通省 国土数値情報 高速道路時系列(N06) https://nlftp.mlit.go.jp/ksj/
//
//   node scripts/fetch-highways.mjs [--year 24]
//
// 収録メタデータ:
//   区間: 路線名(N06_007)・供用開始年(N06_001)・廃止年(N06_003、9999=現役)
//   IC/JCT: 名称(N06_018)・供用開始年(N06_012)
// 供用開始年があるので「年を進めると道路網が伸びていく」タイムライン再生にも使える
// (municipality-timeline と同じ model.filter.range パターン)。
// 座標は4桁丸め(≈10m)+連続重複除去。依存: system の curl/unzip のみ。

import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = join(root, '.mapdata');
const outDir = join(root, 'public', 'data');
mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });

const yearArg = process.argv.indexOf('--year');
const YY = yearArg >= 0 ? process.argv[yearArg + 1] : '24';
const url = `https://nlftp.mlit.go.jp/ksj/gml/data/N06/N06-${YY}/N06-${YY}_GML.zip`;
const zip = join(tmp, `N06-${YY}.zip`);
const sectionFile = join(tmp, 'UTF-8', `N06-${YY}_HighwaySection.geojson`);
const jointFile = join(tmp, 'UTF-8', `N06-${YY}_Joint.geojson`);

if (!existsSync(sectionFile) || !existsSync(jointFile)) {
  if (!existsSync(zip)) {
    console.log('GET', url);
    execSync(`curl -sSL -m 300 -o "${zip}" "${url}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  console.log('unzip…');
  execSync(`unzip -o "${zip}" "UTF-8/*.geojson" -d "${tmp}"`, { stdio: 'ignore' });
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;
const round5 = (v) => Math.round(v * 1e5) / 1e5;

const sections = JSON.parse(readFileSync(sectionFile, 'utf8')).features;
const lines = [];
sections.forEach((f, i) => {
  const xy = [];
  for (const [lon, lat] of f.geometry.coordinates) {
    const p = [round4(lon), round4(lat)];
    if (!xy.length || xy[xy.length - 1][0] !== p[0] || xy[xy.length - 1][1] !== p[1]) xy.push(p);
  }
  if (xy.length < 2) return;
  const pr = f.properties;
  lines.push({
    id: `h${i}`,
    name: pr.N06_007,                                   // 路線名
    opened: pr.N06_001 || null,                         // 供用開始年
    closed: pr.N06_003 === 9999 ? null : pr.N06_003,    // 廃止年(null=現役)
    coords: xy,
  });
});

const joints = JSON.parse(readFileSync(jointFile, 'utf8')).features.map((f) => {
  const [lon, lat] = f.geometry.coordinates;
  const pr = f.properties;
  return { name: pr.N06_018, opened: pr.N06_012 || null, lat: round5(lat), lon: round5(lon) };
});

const out = {
  source: `国土交通省 国土数値情報 高速道路時系列 N06 (20${YY})`,
  url,
  lineCount: lines.length,
  jointCount: joints.length,
  lines,
  joints,
};
const json = JSON.stringify(out);
writeFileSync(join(outDir, 'japan-highways.json'), json);
console.log(`wrote public/data/japan-highways.json — 区間 ${lines.length} / IC・JCT ${joints.length} (${(json.length / 1e6).toFixed(1)}MB)`);
console.log(`路線 ${new Set(lines.map((l) => l.name)).size} 本`);
