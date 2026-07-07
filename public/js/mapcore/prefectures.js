// mapcore/prefectures.js — 都道府県ポリゴン索引（真コロプレス用）。
// 点(lat/lon)が属する都道府県を point-in-polygon で判定する（名前マッチ不要＝
// サンプルでも実データでも動く）。bbox 事前フィルタで 47 ポリゴンの走査を間引く。
//
// data 形式: { prefectures:[{ id, nam, nam_ja, polys:[[ ring:[[lon,lat],...], hole... ], ...] }] }

export function createPrefectureIndex(data) {
  const features = (data.prefectures || []).map((feature) => {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const poly of feature.polys) {
      for (const ring of poly) {
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }
    return {
      id: feature.id,
      name: feature.nam_ja || feature.nam,
      nameEn: feature.nam,
      polys: feature.polys,
      bbox: [minLon, minLat, maxLon, maxLat],
    };
  });

  function ringContains(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect = ((yi > lat) !== (yj > lat))
        && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // poly = [outerRing, hole1, hole2, ...]
  function polyContains(lon, lat, poly) {
    if (!ringContains(lon, lat, poly[0])) return false;
    for (let h = 1; h < poly.length; h++) {
      if (ringContains(lon, lat, poly[h])) return false; // 穴の中
    }
    return true;
  }

  function assign(lat, lon) {
    for (const feature of features) {
      const b = feature.bbox;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      for (const poly of feature.polys) {
        if (polyContains(lon, lat, poly)) return feature.id;
      }
    }
    return null;
  }

  const nameById = new Map(features.map((f) => [f.id, f.name]));

  return { features, assign, nameById, key: 'pref' };
}
