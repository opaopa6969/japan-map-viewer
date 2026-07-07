// mapcore/municipalities.js — 市区町村ポリゴン索引（市区町村粒度コロプレス用）。
// prefectures.js と同型だが id は lgCode(5桁文字列・N03_007)。estat 空き家率(lgCode 키)
// との結合に使える。point-in-polygon + bbox 事前フィルタで点→市区町村を判定。
//
// data 形式: { municipalities:[{ code, name, pref, polys:[[ring,...hole],...] }] }

export function createMunicipalityIndex(data) {
  const features = (data.municipalities || []).map((feature) => {
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
      id: feature.code,
      name: feature.name,
      pref: feature.pref,
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
  function polyContains(lon, lat, poly) {
    if (!ringContains(lon, lat, poly[0])) return false;
    for (let h = 1; h < poly.length; h++) {
      if (ringContains(lon, lat, poly[h])) return false;
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

  return { features, assign, nameById, key: 'muni' };
}
