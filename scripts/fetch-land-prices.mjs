// fetch-land-prices.mjs — 国土数値情報「地価公示」(L01)を DL し、住宅地の
// 公示地価(円/㎡)の地点データを data/land-prices.json に保存する。鍵不要。
// これを盤面生成器が空間結合して物件価格を実地価ベースにする。
// 出典: 国土交通省 国土数値情報 地価公示(L01) https://nlftp.mlit.go.jp/ksj/
//
//   node scripts/fetch-land-prices.mjs [--year 23]
//
// 84MB の GeoJSON をストリームで読み、住宅用途の地点だけ {lon,lat,yen} に圧縮
// (約1.7万点 / 〜600KB)。依存: system の curl/unzip のみ。

import { execSync } from 'node:child_process';
import { createReadStream, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = join(root, '.mapdata');
const outDir = join(root, 'data');
mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });

const yearArg = process.argv.indexOf('--year');
const YY = yearArg >= 0 ? process.argv[yearArg + 1] : '23';
const url = `https://nlftp.mlit.go.jp/ksj/gml/data/L01/L01-${YY}/L01-${YY}_GML.zip`;
const zip = join(tmp, `L01-${YY}.zip`);
const geojson = join(tmp, `L01-${YY}_GML`, `L01-${YY}.geojson`);

if (!existsSync(geojson)) {
  if (!existsSync(zip)) {
    console.log('GET', url);
    execSync(`curl -sSL -m 240 -o "${zip}" "${url}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  console.log('unzip…');
  execSync(`unzip -o "${zip}" -d "${tmp}"`, { stdio: 'ignore' });
}

// 行ごとに正規表現で抽出(84MBを丸ごと JSON.parse しない)。
//  L01_006 = 価格(円/㎡), L01_027 = 用途, coordinates = [lon, lat]
const reFeat = /"type": "Feature"/;
const rePrice = /"L01_006":\s*(\d+)/;
const reUse = /"L01_027":\s*"([^"]*)"/;
const reCoord = /"coordinates":\s*\[\s*([\d.]+),\s*([\d.]+)\s*\]/;

const points = [];
let total = 0;
const rl = createInterface({ input: createReadStream(geojson, 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!reFeat.test(line)) continue;
  total++;
  const u = reUse.exec(line); if (!u || !u[1].includes('住宅')) continue;   // 住宅用途のみ
  const p = rePrice.exec(line); const c = reCoord.exec(line);
  if (!p || !c) continue;
  points.push({ lon: +(+c[1]).toFixed(5), lat: +(+c[2]).toFixed(5), yen: +p[1] });
}

const out = {
  source: '国土交通省 国土数値情報 地価公示 L01 (' + YY + ')',
  url, unit: '円/㎡(住宅地公示地価)', total, count: points.length, points,
};
writeFileSync(join(outDir, 'land-prices.json'), JSON.stringify(out));
const ys = points.map((p) => p.yen).sort((a, b) => a - b);
const med = ys[ys.length >> 1];
console.log(`\nwrote data/land-prices.json — 住宅地点 ${points.length}/${total}`);
console.log(`地価(円/㎡) 中央値 ${med.toLocaleString()}  最高 ${ys[ys.length - 1].toLocaleString()}  最低 ${ys[0].toLocaleString()}`);
