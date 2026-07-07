// mapcore/model.js — 住所点群の共有データモデル（2D/3D レンダラ非依存）。
// 点(lat/lon+category+props) と、フィルタ、グリッド集約(コロプレス用) を持つ。

export function createMapModel(data) {
  const categories = (data.categories || []).slice();
  const catByKey = new Map(categories.map((c) => [c.key, c]));
  const points = (data.points || []).map((p, i) => ({ ...p, _i: i }));
  const prefs = [...new Set(points.map((p) => p.props && p.props.pref).filter(Boolean))].sort();

  const filter = {
    categories: new Set(categories.map((c) => c.key)),
    prefs: new Set(prefs),
    query: '',
    range: null, // { prop, min, max } — props[prop] が数値かつ [min,max] の点のみ（年スライダー等）
  };

  function visible() {
    const query = filter.query.trim().toLowerCase();
    return points.filter((p) => {
      if (!filter.categories.has(p.category)) return false;
      const pref = p.props && p.props.pref;
      if (pref && !filter.prefs.has(pref)) return false;
      if (filter.range) {
        const v = p.props && p.props[filter.range.prop];
        if (!(typeof v === 'number' && v >= filter.range.min && v <= filter.range.max)) return false;
      }
      if (query) {
        const hay = `${p.label || ''} ${JSON.stringify(p.props || {})}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }

  function colorOf(categoryKey) {
    const c = catByKey.get(categoryKey);
    return (c && c.color) || '#888888';
  }

  function labelOf(categoryKey) {
    const c = catByKey.get(categoryKey);
    return (c && c.label) || categoryKey;
  }

  // lat/lon を cellDeg 度のグリッドに集約（コロプレス/ヒートマップ用）。
  // ポリゴンや lgCode マッピングが無くても点群だけで「塗り分け」を成立させる。
  function grid(cellDeg = 0.5) {
    const cells = new Map();
    for (const p of visible()) {
      const gi = Math.floor(p.lon / cellDeg);
      const gj = Math.floor(p.lat / cellDeg);
      const key = `${gi}_${gj}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          gi, gj, cellDeg,
          lon0: gi * cellDeg, lat0: gj * cellDeg,
          lonC: (gi + 0.5) * cellDeg, latC: (gj + 0.5) * cellDeg,
          count: 0, byCategory: {},
        };
        cells.set(key, cell);
      }
      cell.count += 1;
      cell.byCategory[p.category] = (cell.byCategory[p.category] || 0) + 1;
    }
    const list = [...cells.values()];
    list.maxCount = list.reduce((m, c) => Math.max(m, c.count), 0);
    // セルの代表カテゴリ（最多）= 塗り色
    for (const cell of list) {
      let top = null;
      let topN = -1;
      for (const [k, n] of Object.entries(cell.byCategory)) {
        if (n > topN) { topN = n; top = k; }
      }
      cell.topCategory = top;
    }
    return list;
  }

  // 点を任意の地域索引(都道府県/市区町村)へ point-in-polygon で集約（コロプレス用）。
  // 割当は索引ごと(index.key)に点へキャッシュ。id -> {count, topCategory}、.max に最大件数。
  function regionAggregate(index) {
    const cacheKey = `_rid_${index.key || 'region'}`;
    const counts = new Map();
    const catCounts = new Map();
    for (const p of visible()) {
      if (p[cacheKey] === undefined) p[cacheKey] = index.assign(p.lat, p.lon);
      const id = p[cacheKey];
      if (id == null) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
      const cc = catCounts.get(id) || {};
      cc[p.category] = (cc[p.category] || 0) + 1;
      catCounts.set(id, cc);
    }
    const result = new Map();
    let max = 0;
    for (const [id, n] of counts) {
      max = Math.max(max, n);
      const cc = catCounts.get(id);
      let top = null;
      let topN = -1;
      for (const [k, v] of Object.entries(cc)) {
        if (v > topN) { topN = v; top = k; }
      }
      result.set(id, { count: n, topCategory: top });
    }
    result.max = max;
    return result;
  }

  // 現在のフィルタ状態の署名。visible() の結果が変わると変化するので、
  // GPU レンダラ(deck)の updateTriggers 等の依存キーに使える。
  function filterSig() {
    const r = filter.range ? `${filter.range.prop}:${filter.range.min}-${filter.range.max}` : '';
    return `${[...filter.categories].sort().join(',')}|${[...filter.prefs].sort().join(',')}|${filter.query}|${r}`;
  }

  function counts(onlyVisible = false) { // eslint-disable-line no-unused-vars
    const src = onlyVisible ? visible() : points;
    const m = {};
    for (const p of src) m[p.category] = (m[p.category] || 0) + 1;
    return m;
  }

  return {
    data, categories, catByKey, points, prefs, filter,
    visible, colorOf, labelOf, grid, counts, regionAggregate, filterSig,
    // 後方互換
    prefectureAggregate: regionAggregate,
  };
}
