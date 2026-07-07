// fetch-basemap.mjs — 地理院タイル(GSI)の日本地図を1枚に合成して盤面背景にする。
// 駅座標と同じ Web Mercator 投影で重ねるので、本物の日本地図の上に駅が乗る。
// 出典: 国土地理院 地理院タイル(淡色地図) https://maps.gsi.go.jp/development/ichiran.html
// 依存: system の curl と ImageMagick(montage)。npm 依存ゼロ。
//
//   node scripts/fetch-basemap.mjs [--zoom 7] [--style pale]
//
// 出力: public/img/japan-basemap.png ＋ public/js/basemap.js(投影パラメータ)。
// build-board-from-data.mjs はこの basemap.js を読み、駅を同じ投影で配置する。

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const Z = Number(arg('zoom', 7));
const STYLE = arg('style', 'pale');   // pale(淡色) / std(標準) / blank(白地図)
const tmp = join(root, '.mapdata', `tiles-${STYLE}-${Z}`);
mkdirSync(tmp, { recursive: true });
mkdirSync(join(root, 'public/img'), { recursive: true });

// 日本の範囲(沖縄〜北海道を内包)
const LON_MIN = 122, LON_MAX = 149.5, LAT_MIN = 23.5, LAT_MAX = 46.2;
const TILE = 256;
const lon2tx = (lon) => (lon + 180) / 360 * 2 ** Z;
const lat2ty = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z; };

const xMin = Math.floor(lon2tx(LON_MIN)), xMax = Math.floor(lon2tx(LON_MAX));
const yMin = Math.floor(lat2ty(LAT_MAX)), yMax = Math.floor(lat2ty(LAT_MIN)); // 北で小さいy
const cols = xMax - xMin + 1, rows = yMax - yMin + 1;
console.log(`zoom ${Z} ${STYLE}: タイル ${cols}×${rows} = ${cols * rows}枚 → ${cols * TILE}×${rows * TILE}px`);

// タイル取得(row-major、名前でソートできるようゼロ詰め)
const base = `https://cyberjapandata.gsi.go.jp/xyz/${STYLE}`;
let got = 0;
for (let ty = yMin; ty <= yMax; ty++) {
  for (let tx = xMin; tx <= xMax; tx++) {
    const r = String(ty - yMin).padStart(3, '0'), c = String(tx - xMin).padStart(3, '0');
    const dest = join(tmp, `t_${r}_${c}.png`);
    if (!existsSync(dest)) {
      try {
        execSync(`curl -sSL -m 30 -o "${dest}" "${base}/${Z}/${tx}/${ty}.png"`, { stdio: 'ignore' });
      } catch { /* 海上などタイル欠落は白で埋める */ }
    }
    // 欠落/空タイルは白の256px で代替(montage の整列ずれ防止)
    if (!existsSync(dest) || require_size(dest) === 0) {
      execSync(`convert -size ${TILE}x${TILE} xc:white "${dest}"`, { stdio: 'ignore' });
    }
    got++;
  }
}
function require_size(p) { try { return execSync(`stat -c %s "${p}"`).toString().trim() | 0; } catch { return 0; } }
console.log(`取得 ${got}枚`);

// montage で row-major グリッド合成
const files = readdirSync(tmp).filter((f) => f.startsWith('t_')).sort().map((f) => `"${join(tmp, f)}"`).join(' ');
const outPng = join(root, 'public/img/japan-basemap.png');
console.log('合成中(montage)…');
execSync(`montage ${files} -tile ${cols}x${rows} -geometry ${TILE}x${TILE}+0+0 -background white "${outPng}"`, { stdio: 'ignore' });
// ネイティブ解像度を基本に。大きすぎる時だけ上限5000pxへ縮小(拡大はしない=ボケ防止)
const CAP_W = 5000;
const nativeW = cols * TILE;
if (nativeW > CAP_W) execSync(`convert "${outPng}" -resize ${CAP_W}x -quality 85 "${outPng}"`, { stdio: 'ignore' });
else execSync(`convert "${outPng}" -quality 88 "${outPng}"`, { stdio: 'ignore' });
const dim = execSync(`identify -format "%w %h" "${outPng}"`).toString().split(' ').map(Number);

// 投影パラメータ: 駅 (lat,lon) → basemap ピクセル。
//   px = (lon2tx(lon) - xMin) * TILE * scale ;  scale = 画像幅 / (cols*TILE)
const scale = dim[0] / (cols * TILE);
const basemap = {
  image: '/img/japan-basemap.png',
  width: dim[0], height: dim[1],
  zoom: Z, xMin, yMin, tile: TILE, scale: Math.round(scale * 1e6) / 1e6,
  // 駅配置に使う投影式は board 生成器/レンダラ側で実装(下の mercatorXY と同じ式)
};
writeFileSync(join(root, 'public/js/basemap.js'),
  `// 自動生成(scripts/fetch-basemap.mjs) — 地理院タイル(淡色)合成の日本地図と投影パラメータ\n`
  + `// 出典: 国土地理院 地理院タイル\n`
  + `export const BASEMAP = ${JSON.stringify(basemap)};\n`
  + `const P = BASEMAP, T = P.tile, S = P.scale, Z = P.zoom;\n`
  + `/** 緯度経度 → basemap ピクセル(=盤面WORLD座標)。Web Mercator。 */\n`
  + `export function mercatorXY(lat, lon) {\n`
  + `  const tx = (lon + 180) / 360 * Math.pow(2, Z);\n`
  + `  const r = lat * Math.PI / 180;\n`
  + `  const ty = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, Z);\n`
  + `  return { x: Math.round((tx - P.xMin) * T * S), y: Math.round((ty - P.yMin) * T * S) };\n`
  + `}\n`);
console.log(`\n生成: public/img/japan-basemap.png (${dim[0]}×${dim[1]}), public/js/basemap.js`);
// スポットチェック
const merc = (lat, lon) => ({ x: Math.round((lon2tx(lon) - xMin) * TILE * scale), y: Math.round((lat2ty(lat) - yMin) * TILE * scale) });
console.log('東京(35.68,139.69) →', merc(35.68, 139.69), ' 那覇(26.21,127.68) →', merc(26.21, 127.68), ' 札幌(43.06,141.35) →', merc(43.06, 141.35));
void rmSync;
