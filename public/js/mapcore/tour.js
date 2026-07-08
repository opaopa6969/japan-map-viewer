// mapcore/tour.js — グランドツアー: 慣性+重力つきの飛行カメラでツアーファイルを再生する。
//
// フェーズマシン: overview → [dive → cruise → climb] × 都市 → done
//   dive:   隼の急降下。zoom方向に「重力」で加速し、地表(cruiseZoom)接近でフレア(引き起こし)。
//           水平は目標都市への慣性つき誘導。pitchは降下に応じて寝る→起きる。
//   cruise: 実道路のポリライン(getRouteが返す)に沿って低空を疾走。bearingは進行方位に
//           遅れて追従する(LPF)ことでドリフト感を出す。注視点はルートのlook-ahead。
//   climb:  ブースト上昇+次都市方向へバンク旋回。overviewズームまで戻ったら次のdiveへ。
//
// 物理はすべて step(dt) の陽的積分(決定論・Math.random不使用)。rAFループは start() が
// 起動するが、テストは step(dt) を直接叩ける。map操作は renderer.getMap().jumpTo() のみ。
//
// ツアーファイル(JSON):
// {
//   "name": "japan-grand-tour",
//   "overview": { "zoom": 5.8, "pitch": 35 },
//   "cruise":   { "zoom": 15.8, "pitch": 66, "speed": 60, "lookAhead": 80, "bearingLag": 2.2 },
//   "dive":     { "gravity": 3.2, "maxVz": 3.6, "flare": 8, "steer": 2.4 },
//   "climb":    { "boost": 2.4, "maxVz": 3.0 },
//   "cities": [ { "name": "東京", "lat": 35.681, "lon": 139.767, "cruiseSec": 30 }, ... ]
// }
//   cruise.speed は m/s(実速)。getRoute(city) は [[lon,lat],...] の実道路ポリラインを返す
//   (無ければ都市中心の周回にフォールバック)。

import { headingDeg } from './layers.js';

const DEG = Math.PI / 180;

/** 角度の最短差(-180..180)。 */
function angleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

/** ルートの累積距離(m)テーブルを作る。 */
function buildRouteTable(coords) {
  const dist = [0];
  for (let i = 1; i < coords.length; i++) {
    const kLon = 111320 * Math.cos(coords[i][1] * DEG);
    const dx = (coords[i][0] - coords[i - 1][0]) * kLon;
    const dy = (coords[i][1] - coords[i - 1][1]) * 111320;
    dist.push(dist[i - 1] + Math.hypot(dx, dy));
  }
  return { coords, dist, total: dist[dist.length - 1] };
}

/** 距離sの位置と進行方位(ルート上、範囲外はループ)。 */
function routeAt(table, s) {
  const { coords, dist, total } = table;
  if (total <= 0) return { lon: coords[0][0], lat: coords[0][1], heading: 0 };
  s = ((s % total) + total) % total;
  let i = 0;
  while (i < dist.length - 2 && dist[i + 1] < s) i++;
  const seg = dist[i + 1] - dist[i];
  const u = seg > 0 ? (s - dist[i]) / seg : 0;
  const lon = coords[i][0] + (coords[i + 1][0] - coords[i][0]) * u;
  const lat = coords[i][1] + (coords[i + 1][1] - coords[i][1]) * u;
  return { lon, lat, heading: headingDeg(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]) };
}

/** フォールバック: 都市中心の周回コース(半径600m・32角形)。 */
function fallbackLoop(city) {
  const kLon = 111320 * Math.cos(city.lat * DEG);
  const out = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * 2 * Math.PI;
    out.push([city.lon + Math.cos(a) * 600 / kLon, city.lat + Math.sin(a) * 600 / 111320]);
  }
  return out;
}

export function createTourPlayer(renderer, spec, { getRoute, onPhase, onDone } = {}) {
  const map = renderer.getMap();
  const ov = { zoom: 5.8, pitch: 35, ...(spec.overview || {}) };
  const cz = { zoom: 15.8, pitch: 66, speed: 60, lookAhead: 80, bearingLag: 2.2, ...(spec.cruise || {}) };
  const dv = { gravity: 3.2, maxVz: 3.6, flare: 8, steer: 2.4, ...(spec.dive || {}) };
  const cl = { boost: 2.4, maxVz: 3.0, ...(spec.climb || {}) };
  const cities = spec.cities || [];

  // カメラ物理状態(lon/lat/zoom/bearing/pitch + 速度)
  const cam = { lon: 137, lat: 37, zoom: ov.zoom, bearing: 0, pitch: ov.pitch, vLon: 0, vLat: 0, vZoom: 0 };
  const st = {
    phase: 'idle', cityIdx: 0, t: 0,           // t=フェーズ内経過秒
    route: null, s: 0, speed: 0,               // cruise用(ルート/走行距離m/現在速度)
    routePromise: null, rafId: null, running: false,
  };

  function setPhase(p) {
    st.phase = p;
    st.t = 0;
    if (onPhase) onPhase(p, cities[st.cityIdx] || null);
  }

  function beginDive() {
    const city = cities[st.cityIdx];
    setPhase('dive');
    // ルートは降下中に先読み(失敗しても周回フォールバック)
    st.routePromise = Promise.resolve(getRoute ? getRoute(city) : null)
      .catch(() => null)
      .then((coords) => {
        st.route = buildRouteTable(coords && coords.length >= 2 ? coords : fallbackLoop(city));
      });
  }

  /** 1ステップ進める(dt秒)。テストから直接呼べる。 */
  function step(dt) {
    dt = Math.min(dt, 0.1);   // タブ復帰などの巨大dtで物理が破綻しないように
    st.t += dt;
    const city = cities[st.cityIdx];
    if (!city) return finish();

    if (st.phase === 'dive') {
      // --- 垂直: 重力で降下加速、cruiseZoom接近でフレア(引き起こし) ---
      const remain = cz.zoom - cam.zoom;                    // 残り降下量(zoom)
      if (remain > 1.6) cam.vZoom = Math.min(cam.vZoom + dv.gravity * dt, dv.maxVz);
      else cam.vZoom = Math.max(cam.vZoom - dv.flare * dt, 0.35);   // フレア: 強減速(Gを感じる所)
      cam.zoom = Math.min(cam.zoom + cam.vZoom * dt, cz.zoom);
      // --- 水平: 目標都市へ慣性つき誘導(高高度ほど大きく舵) ---
      const k = dv.steer * Math.max(0.15, (cz.zoom - cam.zoom) / (cz.zoom - ov.zoom));
      cam.vLon += (city.lon - cam.lon) * k * dt;
      cam.vLat += (city.lat - cam.lat) * k * dt;
      cam.vLon *= Math.max(0, 1 - 1.6 * dt);                // 減衰(慣性)
      cam.vLat *= Math.max(0, 1 - 1.6 * dt);
      cam.lon += cam.vLon * dt;
      cam.lat += cam.vLat * dt;
      // 機首: 降下中は進行方向へ、pitchは降下量に応じて起きる
      const hdg = headingDeg(cam.lat, cam.lon, city.lat, city.lon);
      cam.bearing += angleDelta(cam.bearing, hdg) * Math.min(1, 1.5 * dt);
      const prog = 1 - Math.max(0, remain) / (cz.zoom - ov.zoom);
      cam.pitch = ov.pitch + (cz.pitch - ov.pitch) * Math.min(1, prog * 1.15);
      if (cam.zoom >= cz.zoom - 0.02 && st.route) {
        // 接地: ルート上の最寄り点から巡航開始
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i < st.route.coords.length; i++) {
          const d = (st.route.coords[i][0] - cam.lon) ** 2 + (st.route.coords[i][1] - cam.lat) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
        st.s = st.route.dist[best];
        st.speed = cz.speed * 0.5;
        setPhase('cruise');
      }
    } else if (st.phase === 'cruise') {
      // --- 実道路に沿って疾走。speedも慣性、bearingは遅れて追従=ドリフト ---
      st.speed += (cz.speed - st.speed) * Math.min(1, 1.2 * dt);
      st.s += st.speed * dt;
      const p = routeAt(st.route, st.s);
      const ahead = routeAt(st.route, st.s + cz.lookAhead);
      cam.lon = p.lon + (ahead.lon - p.lon) * 0.35;         // 注視点は少し先(コーナーの内側を見る)
      cam.lat = p.lat + (ahead.lat - p.lat) * 0.35;
      cam.bearing += angleDelta(cam.bearing, p.heading) * Math.min(1, cz.bearingLag * dt);
      cam.zoom = cz.zoom;
      cam.pitch = cz.pitch;
      if (st.t >= (city.cruiseSec ?? 30)) {
        cam.vZoom = 0;
        setPhase('climb');
      }
    } else if (st.phase === 'climb') {
      // --- ブースト上昇+次都市へバンク旋回 ---
      cam.vZoom = Math.min(cam.vZoom + cl.boost * dt, cl.maxVz);
      cam.zoom -= cam.vZoom * dt;
      const next = cities[st.cityIdx + 1];
      if (next) {
        const hdg = headingDeg(cam.lat, cam.lon, next.lat, next.lon);
        cam.bearing += angleDelta(cam.bearing, hdg) * Math.min(1, 0.9 * dt);
        // 上昇しながら次都市方向へ滑り出す(慣性)
        cam.vLon += (next.lon - cam.lon) * 0.06 * dt;
        cam.vLat += (next.lat - cam.lat) * 0.06 * dt;
        cam.lon += cam.vLon * dt;
        cam.lat += cam.vLat * dt;
      }
      const prog = (cz.zoom - cam.zoom) / (cz.zoom - ov.zoom);
      cam.pitch = cz.pitch + (ov.pitch - cz.pitch) * Math.min(1, prog);
      if (cam.zoom <= ov.zoom) {
        cam.zoom = ov.zoom;
        st.cityIdx++;
        if (st.cityIdx >= cities.length) return finish();
        cam.vZoom = 0;
        beginDive();
      }
    }

    map.jumpTo({ center: [cam.lon, cam.lat], zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch });
  }

  function finish() {
    st.phase = 'done';
    stop();
    if (onDone) onDone();
  }

  function start() {
    if (st.running) return;
    st.running = true;
    st.cityIdx = 0;
    const c0 = map.getCenter();
    Object.assign(cam, { lon: c0.lng, lat: c0.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), vLon: 0, vLat: 0, vZoom: 0 });
    beginDive();
    let last = performance.now();
    const loop = (now) => {
      if (!st.running) return;
      step((now - last) / 1000);
      last = now;
      st.rafId = requestAnimationFrame(loop);
    };
    st.rafId = requestAnimationFrame(loop);
  }

  function stop() {
    st.running = false;
    if (st.rafId) cancelAnimationFrame(st.rafId);
    st.rafId = null;
  }

  return { start, stop, step, state: st, cam };
}
