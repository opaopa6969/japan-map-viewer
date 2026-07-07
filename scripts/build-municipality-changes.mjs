// 自治体統廃合(廃置分合等)の時系列 CSV → コロプレス用の集計 JSON を生成する。
// 出典: municipality-history/data/estat-haichi.csv（e-Stat 自治体変遷 3,507件・1970〜2024）。
// 現在の市区町村ポリゴンは「現況境界」しか無いので、境界モーフィングはせず
// 「現コード/都道府県ごとの 統廃合件数・最終統廃合年」を出して現況地図に塗る（案B）。
//
//   node scripts/build-municipality-changes.mjs
// 出力: public/data/municipality-changes.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ダブルクオート内の改行/カンマ/"" に対応した素朴 CSV パーサ。
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// 改正事由テキスト → 種別ラベル（重複時は代表を1つ）。
function classify(reason) {
  const s = reason || '';
  if (s.includes('政令指定都市')) return 'designated';
  if (s.includes('新設')) return 'newly';       // 新設合併
  if (s.includes('編入')) return 'absorb';       // 編入合併
  if (s.includes('市制')) return 'city';
  if (s.includes('町制')) return 'town';
  return 'other';
}

// ポリゴン集合 → id ごとの bbox中心（イベントを地図に置くための代表点）。
function centroids(features, idOf) {
  const map = new Map();
  for (const f of features) {
    let minLon = Infinity; let minLat = Infinity; let maxLon = -Infinity; let maxLat = -Infinity;
    for (const poly of f.polys) for (const ring of poly) for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    map.set(idOf(f), [(minLon + maxLon) / 2, (minLat + maxLat) / 2]);
  }
  return map;
}

const csv = await readFile(join(root, 'data/estat-haichi.csv'), 'utf8');
const rows = parseCsv(csv).slice(1).filter((r) => r.length >= 8);

// イベント配置用の代表点（現況ポリゴンから）。muni は 5桁コード、pref は id(数値)。
const muniData = JSON.parse(await readFile(join(root, 'public/data/japan-municipalities.json'), 'utf8'));
const prefData = JSON.parse(await readFile(join(root, 'public/data/japan-prefectures.json'), 'utf8'));
const muniCentroid = centroids(muniData.municipalities || [], (f) => String(f.code));
const prefCentroid = centroids(prefData.prefectures || [], (f) => f.id);
// 決定的ジッタ（県フォールバック時に点が重ならないよう散らす）
const jitter = (seed) => { let x = Math.sin(seed * 12.9898) * 43758.5453; x -= Math.floor(x); return (x - 0.5) * 0.5; };

const byLgCode = {}; // 5桁コード -> { count, firstYear, lastYear, byType }
const byPref = {};    // 県id(数値1..47) -> { count, firstYear, lastYear }
const yearHistogram = {}; // 年 -> 件数（案C の折れ線用）
const typeTotals = {};
const events = [];        // 案A: 座標付きイベント（時間スライダー再生用）
let placedPref = 0;

for (let ri = 0; ri < rows.length; ri++) {
  const r = rows[ri];
  const code = (r[0] || '').trim();
  const date = (r[6] || '').trim();
  const year = parseInt(date.slice(0, 4), 10);
  if (!code || !Number.isFinite(year)) continue;
  const type = classify(r[7]);
  const prefId = parseInt(code.slice(0, 2), 10);
  const name = (r[4] || r[2] || '').trim(); // 市区町村, 無ければ政令市/郡等

  // 配置: 現ポリゴン重心があればそれ、無ければ県重心＋ジッタ（消滅コードのフォールバック）。
  let pos = muniCentroid.get(code);
  if (!pos) {
    const pc = prefCentroid.get(prefId);
    if (pc) { pos = [pc[0] + jitter(ri + 1), pc[1] + jitter(ri + 7)]; placedPref++; }
  }
  if (pos) {
    events.push({ c: code, p: prefId, y: year, t: type, n: name, lon: +pos[0].toFixed(4), lat: +pos[1].toFixed(4) });
  }

  const m = (byLgCode[code] ||= { count: 0, firstYear: year, lastYear: year, byType: {} });
  m.count += 1;
  m.firstYear = Math.min(m.firstYear, year);
  m.lastYear = Math.max(m.lastYear, year);
  m.byType[type] = (m.byType[type] || 0) + 1;

  const p = (byPref[prefId] ||= { count: 0, firstYear: year, lastYear: year });
  p.count += 1;
  p.firstYear = Math.min(p.firstYear, year);
  p.lastYear = Math.max(p.lastYear, year);

  yearHistogram[year] = (yearHistogram[year] || 0) + 1;
  typeTotals[type] = (typeTotals[type] || 0) + 1;
}

const years = Object.keys(yearHistogram).map(Number);
const out = {
  source: 'e-Stat 自治体変遷(廃置分合等) via municipality-history/data/estat-haichi.csv',
  note: '現況境界に「現コード/都道府県ごとの統廃合件数・最終統廃合年」を塗るための集計。歴史境界は含まない。',
  records: rows.length,
  yearRange: [Math.min(...years), Math.max(...years)],
  typeLabels: { newly: '新設合併', absorb: '編入合併', designated: '政令市施行', city: '市制', town: '町制', other: 'その他' },
  typeTotals,
  yearHistogram,
  byLgCode,
  byPref,
  events,
};

await mkdir(join(root, 'public/data'), { recursive: true });
await writeFile(join(root, 'public/data/municipality-changes.json'), JSON.stringify(out));
console.log(`wrote public/data/municipality-changes.json`);
console.log(`  records=${out.records} years=${out.yearRange.join('-')} lgCodes=${Object.keys(byLgCode).length} prefs=${Object.keys(byPref).length}`);
console.log(`  events=${events.length}（うち県重心フォールバック=${placedPref}） typeTotals=${JSON.stringify(typeTotals)}`);
