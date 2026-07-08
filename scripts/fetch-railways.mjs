// fetch-railways.mjs — 国土数値情報「鉄道」(N02)を DL し、全国の路線ポリラインと
// 駅を public/data/japan-railways.json に圧縮保存する。鍵不要。
// 出典: 国土交通省 国土数値情報 鉄道(N02) https://nlftp.mlit.go.jp/ksj/
//
//   node scripts/fetch-railways.mjs [--year 23]
//
// 収録メタデータ:
//   路線区間: 路線名(N02_003)・運営会社(N02_004)・鉄道区分(N02_001)・事業者種別(N02_002)
//   駅:       駅名(N02_005)・駅コード(N02_005c)・グループコード(N02_005g、同一駅の名寄せ用)
// 駅は N02 では「線路に沿った短い線分」なので中点を取って点にする。
// 座標は4桁丸め(≈10m)+連続重複除去で 40万点/約9MB に圧縮。依存: system の curl/unzip のみ。

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
const YY = yearArg >= 0 ? process.argv[yearArg + 1] : '23';
const url = `https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-${YY}/N02-${YY}_GML.zip`;
const zip = join(tmp, `N02-${YY}.zip`);
const sectionFile = join(tmp, 'UTF-8', `N02-${YY}_RailroadSection.geojson`);
const stationFile = join(tmp, 'UTF-8', `N02-${YY}_Station.geojson`);

if (!existsSync(sectionFile) || !existsSync(stationFile)) {
  if (!existsSync(zip)) {
    console.log('GET', url);
    execSync(`curl -sSL -m 300 -o "${zip}" "${url}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  console.log('unzip…');
  execSync(`unzip -o "${zip}" "UTF-8/*.geojson" -d "${tmp}"`, { stdio: 'ignore' });
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;
const round5 = (v) => Math.round(v * 1e5) / 1e5;

// --- 路線区間: 4桁丸め+連続重複除去 -----------------------------------------
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
    id: `s${i}`,
    name: pr.N02_003,        // 路線名
    company: pr.N02_004,     // 運営会社
    kind: +pr.N02_002 || 0,  // 事業者種別 1:JR新幹線 2:JR在来線 3:公営 4:民営 5:三セク
    rail: pr.N02_001,        // 鉄道区分(普通鉄道/モノレール/鋼索…のコード)
    coords: xy,
  });
});

// --- 駅: 線分の中点を駅点にする ------------------------------------------------
const stationFeatures = JSON.parse(readFileSync(stationFile, 'utf8')).features;
const stations = stationFeatures.map((f) => {
  const cs = f.geometry.coordinates;
  const mid = cs[Math.floor(cs.length / 2)];
  const pr = f.properties;
  return {
    id: pr.N02_005c,
    gid: pr.N02_005g,        // 同一駅グループ(乗り入れ名寄せ用)
    name: pr.N02_005,
    line: pr.N02_003,
    company: pr.N02_004,
    kind: +pr.N02_002 || 0,
    lat: round5(mid[1]),
    lon: round5(mid[0]),
  };
});

const out = {
  source: `国土交通省 国土数値情報 鉄道 N02 (20${YY})`,
  url,
  kindLabels: { 1: 'JR新幹線', 2: 'JR在来線', 3: '公営鉄道', 4: '民営鉄道', 5: '第三セクター' },
  lineCount: lines.length,
  stationCount: stations.length,
  lines,
  stations,
};
const json = JSON.stringify(out);
writeFileSync(join(outDir, 'japan-railways.json'), json);
console.log(`wrote public/data/japan-railways.json — 路線区間 ${lines.length} / 駅 ${stations.length} (${(json.length / 1e6).toFixed(1)}MB)`);
const names = new Set(lines.map((l) => `${l.name}|${l.company}`));
console.log(`路線(名寄せ後) ${names.size} 本`);
