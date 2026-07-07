// 住所可視化のサンプル点群を data/jp-cities.json を種に生成する。
// 実在都市の周辺に緯度経度をジッタさせ、エラー種別をランダムに割り当てる。
// 実 API 連携前に address-map UI をスタンドアロンで完成させるためのダミー。
//
//   node scripts/build-sample-error-points.mjs [count]
//
// 出力: public/data/sample-error-points.json（静的配信されるので fetch 可能）
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPrefectureIndex } from '../public/js/mapcore/prefectures.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const COUNT = Number(process.argv[2]) || 600;

// 都道府県名を漢字で付与するための索引（mapcore を再利用）。点の実座標から
// point-in-polygon で属する都道府県の nam_ja(例: 茨城県) を引く。ローマ字より正確。
let prefIndex = null;
try {
  const prefData = JSON.parse(await readFile(join(root, 'public/data/japan-prefectures.json'), 'utf8'));
  prefIndex = createPrefectureIndex(prefData);
} catch (e) {
  console.warn('都道府県ポリゴン未ロード: pref はローマ字のままにフォールバック', e.message);
}
const prefKanji = (lat, lon, fallback) => {
  if (!prefIndex) return fallback;
  const id = prefIndex.assign(lat, lon);
  if (id != null) return prefIndex.nameById.get(id) || fallback;
  // 簡略化ポリゴンの海側に落ちる沿岸都市向け: bbox中心が最近傍の県へ寄せる。
  let best = null;
  let bestD = Infinity;
  for (const f of prefIndex.features) {
    const cx = (f.bbox[0] + f.bbox[2]) / 2;
    const cy = (f.bbox[1] + f.bbox[3]) / 2;
    const d = (cx - lon) ** 2 + (cy - lat) ** 2;
    if (d < bestD) { bestD = d; best = f; }
  }
  return (best && best.name) || fallback;
};

// エラー種別（vacant-service の照合パイプラインを想定した分類）
const CATEGORIES = [
  { key: 'parse_failed', label: 'パース失敗', color: '#e15759', weight: 3 },
  { key: 'zip_mismatch', label: '郵便番号不一致', color: '#edc948', weight: 4 },
  { key: 'building_unresolved', label: '建物未解決', color: '#4e79a7', weight: 5 },
  { key: 'loose_pending', label: 'loose未レビュー', color: '#b07aa1', weight: 3 },
  { key: 'no_candidate', label: '候補なし', color: '#9c755f', weight: 2 },
];

// 都市人口で重み付けし、人口が多いほどエラー点も多くする（現実の分布に近づける）
function pickWeighted(items, weightOf, rnd) {
  const total = items.reduce((sum, it) => sum + weightOf(it), 0);
  let r = rnd() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// 決定性のための簡易 PRNG（mulberry32）
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20260626);

const citiesJson = JSON.parse(await readFile(join(root, 'data/jp-cities.json'), 'utf8'));
const cities = citiesJson.cities || [];

const points = [];
for (let i = 0; i < COUNT; i++) {
  const city = pickWeighted(cities, (c) => Math.sqrt(c.pop || 1000), rnd);
  const category = pickWeighted(CATEGORIES, (c) => c.weight, rnd);
  // 市の代表点から ±0.06° 程度ジッタ（市域内に散らす）
  const jitter = () => (rnd() - 0.5) * 0.12;
  const lat = +(city.lat + jitter()).toFixed(6);
  const lon = +(city.lon + jitter()).toFixed(6);
  const zip = String(1000000 + Math.floor(rnd() * 8999999));
  points.push({
    id: `sample-${i}`,
    lat,
    lon,
    category: category.key,
    label: `${city.jaName || city.name} 付近のサンプル住所 ${i}`,
    props: {
      // 県はジッタ後でなく都市代表点で判定（点は「その都市付近」＝その県に属する）。
      pref: prefKanji(city.lat, city.lon, city.pref),
      city: city.jaName || city.name,
      zip: `${zip.slice(0, 3)}-${zip.slice(3)}`,
      epCompanyId: ['10033', '10066', '10077', '10099'][Math.floor(rnd() * 4)],
      indexDate: ['20250601', '20250901'][Math.floor(rnd() * 2)],
    },
  });
}

const out = {
  source: 'sample (jp-cities ベースの合成データ)',
  generatedFor: 'address-map standalone UI 開発',
  categories: CATEGORIES.map(({ key, label, color }) => ({ key, label, color })),
  count: points.length,
  points,
};

await mkdir(join(root, 'public/data'), { recursive: true });
await writeFile(join(root, 'public/data/sample-error-points.json'), JSON.stringify(out));
console.log(`wrote public/data/sample-error-points.json (${points.length} points across ${CATEGORIES.length} categories)`);
