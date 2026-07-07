// fetch-map-data.mjs — 実在の日本都市データを GeoNames から DL して
// data/jp-cities.json に整形保存する。鉄道すごろくの「駅＝実在都市(物件付き)」
// 粒度に合わせ、人口つき都市(cities15000: 人口1.5万以上の都市)を使う。
// 出典: GeoNames (https://www.geonames.org/, CC BY 4.0)。
//
//   node scripts/fetch-map-data.mjs
//
// 取得物:
//   cities15000.zip   … 全世界の人口1.5万以上の都市(name/緯度経度/人口/admin1)
//   admin1CodesASCII  … admin1コード→都道府県名(JP.40→Tokyo 等)の正引き
// 依存: system の curl と unzip のみ(npm 依存ゼロ)。

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = join(root, '.mapdata');
const outDir = join(root, 'data');
mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });

const BASE = 'https://download.geonames.org/export/dump';

function dl(url, dest) {
  if (existsSync(dest)) { console.log('  cached', dest.replace(root + '/', '')); return; }
  console.log('  GET', url);
  execSync(`curl -sSL -m 120 -o "${dest}" "${url}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
}

console.log('downloading GeoNames…');
dl(`${BASE}/cities15000.zip`, join(tmp, 'cities15000.zip'));
dl(`${BASE}/admin1CodesASCII.txt`, join(tmp, 'admin1.txt'));
dl(`${BASE}/alternatenames/JP.zip`, join(tmp, 'jp-alt.zip'));   // 日本語(漢字)名の出典
execSync(`unzip -o "${join(tmp, 'cities15000.zip')}" -d "${tmp}"`, { stdio: 'ignore' });
execSync(`unzip -o "${join(tmp, 'jp-alt.zip')}" -d "${tmp}"`, { stdio: 'ignore' });

// admin1 code (JP.xx) → 都道府県名(英語)
const admin1 = new Map();
for (const line of readFileSync(join(tmp, 'admin1.txt'), 'utf8').split('\n')) {
  const c = line.split('\t');
  if (c[0] && c[0].startsWith('JP.')) admin1.set(c[0], c[1]);
}

// geonameid → 日本語(漢字)名。alternateNames(lang=ja)の代表名を選ぶ。
//  列: 0 altId 1 geonameid 2 isolanguage 3 alternate_name 4 isPreferred 5 isShort
// 「市/区/町/村」で終わる漢字主体の名を優先(かな単独や「○○都」より望ましい)。
const jaName = new Map();
function jaScore(name, isPref) {
  let s = 0;
  if (isPref === '1') s += 3;
  if (/[一-鿿]/.test(name)) s += 4;            // 漢字を含む
  if (/(市|区|町|村)$/.test(name)) s += 2;            // 自治体接尾辞
  if (/^[぀-ゟ゠-ヿ]+$/.test(name)) s -= 3; // かなのみは減点
  s -= name.length * 0.05;                              // 短め優先
  return s;
}
for (const line of readFileSync(join(tmp, 'JP.txt'), 'utf8').split('\n')) {
  const c = line.split('\t');
  if (c[2] !== 'ja' || !c[3]) continue;
  const gid = c[1], sc = jaScore(c[3], c[4]);
  const cur = jaName.get(gid);
  if (!cur || sc > cur.sc) jaName.set(gid, { name: c[3], sc });
}

// cities15000.txt のTSV列(GeoNames仕様):
//  0 geonameid 1 name 2 asciiname 3 alternatenames 4 lat 5 lon 6 fclass 7 fcode
//  8 country 10 admin1code 14 population
const cities = [];
for (const line of readFileSync(join(tmp, 'cities15000.txt'), 'utf8').split('\n')) {
  const c = line.split('\t');
  if (c[8] !== 'JP') continue;
  const pref = admin1.get('JP.' + c[10]) || null;
  const ja = jaName.get(c[0]);
  cities.push({
    geonameid: c[0],
    name: c[2] || c[1],               // asciiname(ローマ字)
    jaName: ja ? ja.name : null,      // 日本語(漢字)名 — GeoNames alternateNames(lang=ja)由来
    lat: +c[4], lon: +c[5],
    pop: +c[14] || 0,
    pref,                              // 都道府県名(英語)
  });
}
cities.sort((a, b) => b.pop - a.pop);

const out = { source: 'GeoNames cities15000 (CC BY 4.0)', fetchedFrom: BASE, count: cities.length, cities };
writeFileSync(join(outDir, 'jp-cities.json'), JSON.stringify(out, null, 0));
console.log(`\nwrote data/jp-cities.json — ${cities.length} 都市 (人口1.5万以上)`);
console.log('上位:', cities.slice(0, 5).map((c) => `${c.name}(${c.pref},${c.pop})`).join(' '));
// 中間ファイルは残す(キャッシュ)。掃除は rm -rf .mapdata
void rmSync;
