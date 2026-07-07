// fetch-estat-vacancy.mjs — e-Stat から市区町村別の空き家率(2023 住宅・土地統計
// 調査)を取得して data/estat-enrich.json に保存する。盤面生成器が物件利回りの
// 補正に使う(空き家率が高い街＝うまみ減)。
// 出典: e-Stat 住宅・土地統計調査(令和5年) 統計表 0004021421
//   居住世帯の有無別住宅数(全国・都道府県・市区町村)、cat01: 0=総数 22=空き家
//
//   ESTAT_APP_ID=... node scripts/fetch-estat-vacancy.mjs
//   (もしくは tetsugo/.env.local に ESTAT_APP_ID=... を置く)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// appId: env か .env.local から(値は表示しない)
let appId = process.env.ESTAT_APP_ID;
if (!appId && existsSync(join(root, '.env.local'))) {
  const m = readFileSync(join(root, '.env.local'), 'utf8').match(/^ESTAT_APP_ID=(.+)$/m);
  if (m) appId = m[1].trim();
}
if (!appId) { console.error('ESTAT_APP_ID が無い(.env.local か環境変数)。e-Stat で取得して設定。'); process.exit(1); }

const STAT_ID = '0004021421';
const url = `https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData?appId=${appId}`
  + `&statsDataId=${STAT_ID}&cdTab=01-2023&metaGetFlg=N&limit=100000`;
console.log('GET e-Stat 住宅・土地統計2023 (市区町村別 居住世帯の有無)…');
const res = await fetch(url);
const j = await res.json();
const status = j.GET_STATS_DATA?.RESULT?.STATUS;
if (status !== 0) { console.error('e-Stat error:', j.GET_STATS_DATA?.RESULT?.ERROR_MSG || status); process.exit(1); }

// area コード→市区町村名(メタ情報)
const metaUrl = `https://api.e-stat.go.jp/rest/3.0/app/json/getMetaInfo?appId=${appId}&statsDataId=${STAT_ID}`;
const meta = await (await fetch(metaUrl)).json();
const areaName = new Map();
for (const o of meta.GET_META_INFO?.METADATA_INF?.CLASS_INF?.CLASS_OBJ || []) {
  if (o['@id'] !== 'area') continue;
  for (const c of (Array.isArray(o.CLASS) ? o.CLASS : [o.CLASS])) areaName.set(c['@code'], c['@name']);
}

const values = j.GET_STATS_DATA.STATISTICAL_DATA.DATA_INF.VALUE;
// area(市区町村コード) ごとに 総数(cat01=0) と 空き家(cat01=22) を集める
const byArea = new Map();
for (const v of values) {
  const area = v['@area'], cat = v['@cat01'];
  const n = Number(v.$);
  if (!Number.isFinite(n)) continue;
  const rec = byArea.get(area) || byArea.set(area, {}).get(area);
  if (cat === '0') rec.total = n;
  else if (cat === '22') rec.vacant = n;
}

// 市区町村コード→名称(メタ)。getMetaInfo は別途。ここでは byLgCode のみ(builder は
// jaName でも引けるよう、別途 jp-cities の jaName↔lgCode マッチは builder 側)。
const byLgCode = {};
const byName = {};   // 市区町村名(「○○市/区/町/村」末尾も裸も)→ {vacancyRate}
let n = 0;
for (const [area, r] of byArea) {
  if (area.length !== 5 || area.endsWith('000')) continue;   // 市区町村のみ(都道府県/全国を除く)
  if (!r.total || r.vacant == null) continue;
  const rate = Math.round((r.vacant / r.total) * 1000) / 1000;
  byLgCode[area] = { vacancyRate: rate };
  const nm = areaName.get(area);
  if (nm) {
    byName[nm] = { vacancyRate: rate };
    const bare = nm.replace(/(市|区|町|村)$/, '');   // 横浜市→横浜 でも引けるように
    if (bare.length >= 2 && !(bare in byName)) byName[bare] = { vacancyRate: rate };
  }
  n++;
}

const out = { source: 'e-Stat 住宅・土地統計調査2023 統計表' + STAT_ID, indicator: '空き家率(空き家/住宅総数)', count: n, byLgCode, byName };
writeFileSync(join(root, 'data', 'estat-vacancy.json'), JSON.stringify(out));
const rates = Object.values(byLgCode).map((x) => x.vacancyRate).sort((a, b) => a - b);
console.log(`\nwrote data/estat-vacancy.json — ${n} 市区町村`);
console.log(`空き家率 中央値 ${(rates[rates.length >> 1] * 100).toFixed(1)}%  最高 ${(rates[rates.length - 1] * 100).toFixed(1)}%  最低 ${(rates[0] * 100).toFixed(1)}%`);
