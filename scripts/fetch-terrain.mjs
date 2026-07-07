// fetch-terrain.mjs — 地理院の標高タイル(DEM)と地図タイルから、指定範囲の
// 3D地形データ(高さ場JSON＋テクスチャPNG)を作る。本物の日本の山岳が三次元で出る。
// 出典: 国土地理院 地理院タイル(標高DEM・淡色地図)。鍵不要・無料。
// 依存: curl と ImageMagick(montage)。npm 依存ゼロ。
//
//   node scripts/fetch-terrain.mjs [--zoom 11] [--lat0 34.5 --lat1 36.6 --lon0 137.4 --lon1 139.9]
//   既定は中部山岳(富士〜日本アルプス) の癒し範囲。
//
// 出力: public/terrain/<name>.heightfield.json (グリッド標高) と <name>.texture.png

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const Z = arg('zoom', 11);
const LAT0 = arg('lat0', 34.5), LAT1 = arg('lat1', 36.6), LON0 = arg('lon0', 137.4), LON1 = arg('lon1', 139.9);
const NAME = process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1] : 'chubu';
const TILE = 256;
const outDir = join(root, 'public/terrain');
mkdirSync(outDir, { recursive: true });
const tmp = join(root, '.mapdata', `terrain-${NAME}-${Z}`);
mkdirSync(tmp, { recursive: true });

const lon2tx = (lon) => (lon + 180) / 360 * 2 ** Z;
const lat2ty = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z; };
const xMin = Math.floor(lon2tx(LON0)), xMax = Math.floor(lon2tx(LON1));
const yMin = Math.floor(lat2ty(LAT1)), yMax = Math.floor(lat2ty(LAT0));
const cols = xMax - xMin + 1, rows = yMax - yMin + 1;
console.log(`地形 ${NAME} zoom${Z}: タイル ${cols}×${rows}=${cols * rows}枚`);

// 1) DEM 標高グリッドを取得・連結(各タイル 256×256 のCSV)
const demBase = 'https://cyberjapandata.gsi.go.jp/xyz/dem';
const GW = cols * TILE, GH = rows * TILE;
const height = new Float32Array(GW * GH);   // メートル。海/欠測は0
let maxH = 0, minH = 9999;
for (let ty = yMin; ty <= yMax; ty++) {
  for (let tx = xMin; tx <= xMax; tx++) {
    let text = '';
    try { text = execSync(`curl -sSL -m 30 "${demBase}/${Z}/${tx}/${ty}.txt"`, { maxBuffer: 1 << 24 }).toString(); }
    catch { text = ''; }
    const rows256 = text.trim() ? text.trim().split('\n') : [];
    const ox = (tx - xMin) * TILE, oy = (ty - yMin) * TILE;
    for (let j = 0; j < TILE; j++) {
      const cells = rows256[j] ? rows256[j].split(',') : [];
      for (let i = 0; i < TILE; i++) {
        let v = cells[i] === undefined || cells[i] === 'e' ? 0 : parseFloat(cells[i]);
        if (!Number.isFinite(v) || v < -500) v = 0;
        height[(oy + j) * GW + (ox + i)] = v;
        if (v > maxH) maxH = v; if (v < minH && v > 0) minH = v;
      }
    }
  }
}

// 2) 高さ場を扱いやすいグリッド(GRID×GRID)へダウンサンプル
const GRID = arg('grid', 192);
const hf = new Array(GRID * GRID);
for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
  const sx = Math.floor(gx / GRID * GW), sy = Math.floor(gy / GRID * GH);
  hf[gy * GRID + gx] = Math.round(height[sy * GW + sx]);
}

// 3) 地図テクスチャ(淡色)を同じ範囲で合成
const mapBase = 'https://cyberjapandata.gsi.go.jp/xyz/pale';
for (let ty = yMin; ty <= yMax; ty++) for (let tx = xMin; tx <= xMax; tx++) {
  const r = String(ty - yMin).padStart(3, '0'), c = String(tx - xMin).padStart(3, '0');
  const dest = join(tmp, `m_${r}_${c}.png`);
  if (!existsSync(dest)) { try { execSync(`curl -sSL -m 30 -o "${dest}" "${mapBase}/${Z}/${tx}/${ty}.png"`, { stdio: 'ignore' }); } catch {} }
  if (!existsSync(dest)) execSync(`convert -size ${TILE}x${TILE} xc:'#cfe8e0' "${dest}"`, { stdio: 'ignore' });
}
// 大量タイルを一発montageするとImageMagickのリソース上限(area/memory)で落ちるので、
// 行ごとに横帯へ montage → 各帯を目標幅へ即縮小 → 縮小済み帯を縦にappend、で軽く合成する。
// (高ズームだと素材が巨大(例 12288×14080=173MP)になり、append後にresizeすると落ちるため、
//  appendの前に各帯を縮小して中間画像を常に小さく保つ)
const LIM = '-limit memory 3GiB -limit map 3GiB -limit area 1024MP -limit disk 16GiB';
const TEXW = arg('texw', 4096);
const stripDir = join(tmp, 'strips');
mkdirSync(stripDir, { recursive: true });
const strips = [];
for (let r = 0; r < rows; r++) {
  const rr = String(r).padStart(3, '0');
  const rowFiles = [];
  for (let c = 0; c < cols; c++) rowFiles.push(`"${join(tmp, `m_${rr}_${String(c).padStart(3, '0')}.png`)}"`);
  const strip = join(stripDir, `strip_${rr}.png`);
  // 行をmontageし、その場で目標幅へ縮小(以降の中間画像を小さく保つ)
  execSync(`montage ${LIM} ${rowFiles.join(' ')} -tile ${cols}x1 -geometry ${TILE}x${TILE}+0+0 miff:- | convert ${LIM} - -resize ${TEXW}x "${strip}"`, { stdio: 'ignore', shell: '/bin/bash' });
  strips.push(`"${strip}"`);
}
const texPng = join(outDir, `${NAME}.texture.png`);
execSync(`convert ${LIM} ${strips.join(' ')} -append -quality 90 "${texPng}"`, { stdio: 'ignore' });

// 高さ誇張係数。広域マップ(全国)は山が針にならないよう小さめにする。--vexagg で指定。
const VEXAGG = arg('vexagg', 0.0085);
writeFileSync(join(outDir, `${NAME}.heightfield.json`), JSON.stringify({
  name: NAME, zoom: Z, grid: GRID,
  bounds: { lat0: LAT0, lat1: LAT1, lon0: LON0, lon1: LON1 },
  maxElev: Math.round(maxH), minElev: Math.round(minH),
  heightExagg: VEXAGG,                       // terrain3d がこの値で標高→ワールド高に変換
  texture: `/terrain/${NAME}.texture.png`,
  // 真北上・東右。高さ[gy*GRID+gx] はメートル(海=0)
  height: hf,
}));
console.log(`生成: public/terrain/${NAME}.heightfield.json (grid ${GRID}²), ${NAME}.texture.png`);
console.log(`標高 最高 ${Math.round(maxH)}m / 最低 ${Math.round(minH)}m  (富士=3776mが範囲内なら ${maxH > 3000 ? 'OK' : '?'})`);
