// mapcore/metrics.js — コロプレスの指標(空き家率)と設定ビルダ、連続値ランプ・凡例。

// 連続値ランプ（青→緑→黄→赤）。t∈[0,1] → "rgb(r,g,b)"。renderer と凡例で共用。
export function rampColor(t) {
  const stops = [[46, 121, 167], [89, 161, 79], [237, 201, 72], [225, 87, 89]];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// 連続値コロプレスの色スケール凡例 DOM を返す。fmt は値→ラベル(既定: % 表示)。
export function createRampLegend(doc, { max, label, steps = 5, fmt } = {}) {
  const format = fmt || ((v) => `${(v * 100).toFixed(1)}%`);
  const wrap = doc.createElement('div');
  wrap.className = 'opa-ramp-legend';
  if (label) {
    const title = doc.createElement('div');
    title.className = 'opa-ramp-title';
    title.textContent = label;
    wrap.appendChild(title);
  }
  const bar = doc.createElement('div');
  bar.className = 'opa-ramp-bar';
  const gradient = [];
  for (let i = 0; i <= 10; i++) gradient.push(`${rampColor(i / 10)} ${i * 10}%`);
  bar.style.background = `linear-gradient(to right, ${gradient.join(', ')})`;
  wrap.appendChild(bar);
  const ticks = doc.createElement('div');
  ticks.className = 'opa-ramp-ticks';
  for (let i = 0; i < steps; i++) {
    const span = doc.createElement('span');
    span.textContent = format((max * i) / (steps - 1));
    ticks.appendChild(span);
  }
  wrap.appendChild(ticks);
  return wrap;
}



// estat 空き家率 JSON({byLgCode:{ "13101":{vacancyRate:0.126}, ... }}) → 市区町村 lgCode→率。
export function vacancyByMunicipality(estat) {
  const values = new Map();
  let max = 0;
  for (const [code, obj] of Object.entries((estat && estat.byLgCode) || {})) {
    if (obj && typeof obj.vacancyRate === 'number') {
      values.set(code, obj.vacancyRate);
      if (obj.vacancyRate > max) max = obj.vacancyRate;
    }
  }
  return { values, max: max || 1 };
}

// 市区町村率を都道府県(コード先頭2桁=1..47)平均へ集約。pref index の id(数値)に合わせる。
export function vacancyByPrefecture(estat) {
  const sum = new Map();
  const count = new Map();
  for (const [code, obj] of Object.entries((estat && estat.byLgCode) || {})) {
    if (!obj || typeof obj.vacancyRate !== 'number') continue;
    const pref = parseInt(code.slice(0, 2), 10);
    sum.set(pref, (sum.get(pref) || 0) + obj.vacancyRate);
    count.set(pref, (count.get(pref) || 0) + 1);
  }
  const values = new Map();
  let max = 0;
  for (const [pref, s] of sum) {
    const v = s / count.get(pref);
    values.set(pref, v);
    if (v > max) max = v;
  }
  return { values, max: max || 1 };
}

// 任意の点群 [{lat,lon,...}] を地域索引へ集約し「平均値」の地域値マップにする。
// estat(市区町村率)以外の指標(地価・人口減少率など任意の点データ)を汎用にコロプレス化できる。
//   valueOf: (point) => number  （非有限は無視）
export function meanByRegion(points, index, valueOf) {
  const sum = new Map();
  const count = new Map();
  for (const p of points || []) {
    const id = index.assign(p.lat, p.lon);
    if (id == null) continue;
    const v = valueOf(p);
    if (!Number.isFinite(v)) continue;
    sum.set(id, (sum.get(id) || 0) + v);
    count.set(id, (count.get(id) || 0) + 1);
  }
  const values = new Map();
  let max = 0;
  for (const [id, s] of sum) {
    const m = s / count.get(id);
    values.set(id, m);
    if (m > max) max = m;
  }
  return { values, max: max || 1 };
}

// 指標の表示名と値フォーマット（凡例・ツールチップ共用）。config に載せて汎用化。
const PCT = (v) => `${(v * 100).toFixed(1)}%`;
const YEN_M2 = (v) => `${(v / 10000).toFixed(1)}万円/m²`;

// モード名 → renderer(setChoropleth) 設定。必要な index/指標が未ロードなら null。
//   ctx: { prefIndex, muniIndex, vacancyMuni, vacancyPref, landPref, landMuni }
//   metric 設定には label/fmt を持たせる（凡例を指標非依存に）。
export function buildChoroplethConfig(mode, ctx) {
  switch (mode) {
    case 'pref-errors':
      return ctx.prefIndex ? { index: ctx.prefIndex, kind: 'errors', label: 'エラー件数', fmt: (v) => `${Math.round(v)}件` } : null;
    case 'muni-errors':
      return ctx.muniIndex ? { index: ctx.muniIndex, kind: 'errors', label: 'エラー件数', fmt: (v) => `${Math.round(v)}件` } : null;
    case 'pref-vacancy':
      return ctx.prefIndex && ctx.vacancyPref
        ? { index: ctx.prefIndex, kind: 'metric', values: ctx.vacancyPref.values, max: ctx.vacancyPref.max, label: '空き家率', fmt: PCT }
        : null;
    case 'muni-vacancy':
      return ctx.muniIndex && ctx.vacancyMuni
        ? { index: ctx.muniIndex, kind: 'metric', values: ctx.vacancyMuni.values, max: ctx.vacancyMuni.max, label: '空き家率', fmt: PCT }
        : null;
    case 'pref-landprice':
      return ctx.prefIndex && ctx.landPref
        ? { index: ctx.prefIndex, kind: 'metric', values: ctx.landPref.values, max: ctx.landPref.max, label: '平均地価', fmt: YEN_M2 }
        : null;
    case 'muni-landprice':
      return ctx.muniIndex && ctx.landMuni
        ? { index: ctx.muniIndex, kind: 'metric', values: ctx.landMuni.values, max: ctx.landMuni.max, label: '平均地価', fmt: YEN_M2 }
        : null;
    default:
      return null;
  }
}
