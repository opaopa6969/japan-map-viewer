// fetch-plateau.mjs — Project PLATEAU(国交省)の3D Tiles(建築物モデル)を DL し、
// public/data/plateau/<code>/ に展開する。deck.gl の Tile3DLayer がそのまま読める
// tileset.json + b3dm 形式。実測高さ付きの3D都市モデル(LOD1/2)。
// 出典: 国土交通省 Project PLATEAU / G空間情報センター(CC BY 4.0 相当の政府標準利用規約)
//
//   node scripts/fetch-plateau.mjs [--code 13101] [--texture]
//     --code    区市町村コード(既定 13101=千代田区。東京23区: 13101〜13123)
//     --texture テクスチャ付き版を落とす(既定はテクスチャ無し=軽量)
//
// データセットは CKAN API から解決する(東京23区 2020年度版)。他都市は
// https://www.geospatial.jp/ckan/dataset?q=plateau+3dtiles で探して同じ構造で追加可。

import { execSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = join(root, '.mapdata', 'plateau');
const outBase = join(root, 'public', 'data', 'plateau');
mkdirSync(tmp, { recursive: true });
mkdirSync(outBase, { recursive: true });

const argOf = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const CODE = argOf('code', '13101');
const TEXTURE = process.argv.includes('--texture');
const DATASET = argOf('dataset', 'plateau-tokyo23ku-3dtiles-2020');

const api = `https://www.geospatial.jp/ckan/api/3/action/package_show?id=${DATASET}`;
console.log('CKAN', api);
const pkg = JSON.parse(execSync(`curl -sSL -m 60 "${api}"`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
if (!pkg.success) { console.error('CKAN package_show 失敗:', DATASET); process.exit(1); }

// URL に区コードを含み、texture 有無が一致する「建物」リソースを探す
const resource = pkg.result.resources.find((r) => {
  const url = r.url || '';
  if (!url.includes(`/${CODE}_`) || !url.endsWith('.zip')) return false;
  const noTex = url.includes('notexture');
  return TEXTURE ? !noTex : noTex;
});
if (!resource) {
  console.error(`code=${CODE} texture=${TEXTURE} のリソースが見つからない。候補:`);
  for (const r of pkg.result.resources.slice(0, 10)) console.error(' ', r.name, r.url);
  process.exit(1);
}
console.log('resource:', resource.name, resource.url);

const zip = join(tmp, `${CODE}${TEXTURE ? '' : '_notexture'}.zip`);
if (!existsSync(zip)) {
  console.log('GET', resource.url);
  execSync(`curl -sSL -m 1800 -o "${zip}" "${resource.url}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
}

const outDir = join(outBase, CODE);
mkdirSync(outDir, { recursive: true });
console.log('unzip…');
execSync(`unzip -o "${zip}" -d "${outDir}"`, { stdio: 'ignore' });

// tileset.json の場所を報告(zip内のディレクトリ構成は年度によって違う)
function findTilesets(dir, base = dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) findTilesets(p, base, out);
    else if (name.name === 'tileset.json') out.push(p.slice(root.length + 'public/'.length + 1));
  }
  return out;
}
const tilesets = findTilesets(outDir);
console.log(`done. tileset.json:`);
for (const t of tilesets) console.log('  /' + t);
