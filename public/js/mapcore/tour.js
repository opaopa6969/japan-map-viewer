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
//   cruise.speed は m/s(実速・直線時)。カーブは先読み方位差で自動減速(curveSlow)。
//   city.cruiseKm があれば距離ベースで走る(無ければ cruiseSec 秒)。cruiseKm 時は
//   途中で hops 回(既定2〜3)、進行方向を変えずに50m級に飛び上がって左右を見る
//   (hopZoom/hopSec/lookDeg)。getRoute(city) は実道路ポリライン(無ければ周回フォールバック)。

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
  const cz = { zoom: 15.8, pitch: 66, speed: 60, lookAhead: 80, bearingLag: 2.2, curveSlow: 1.2, hopZoom: 0.9, hopSec: 5, lookDeg: 55, ...(spec.cruise || {}) };
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
        let cs = coords && coords.length >= 2 ? coords : fallbackLoop(city);
        let table = buildRouteTable(cs);
        const need = (city.cruiseKm ? city.cruiseKm * 1000 : 0) * 1.15;
        while (need > 0 && table.total < need && table.total > 0 && cs.length < 20000) {
          cs = cs.concat([...cs].reverse().slice(1));   // 往復で延長(端→端のワープを防ぐ)
          table = buildRouteTable(cs);
        }
        st.route = table;
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
        st.s0 = st.s;
        st.speed = cz.speed * 0.5;
        // ホップ計画: 走行距離の等分点で hops 回(進行方向は変えず上に飛んで左右を見る)
        const runM = city.cruiseKm ? city.cruiseKm * 1000 : null;
        const nHops = runM ? (city.hops ?? (runM >= 2500 ? 3 : 2)) : 0;
        st.hopsAt = [];
        for (let h = 1; h <= nHops; h++) st.hopsAt.push(st.s0 + runM * h / (nHops + 1));
        st.hop = null;
        setPhase('cruise');
      }
    } else if (st.phase === 'cruise') {
      // --- 実道路に沿って疾走。カーブは先読み方位差で減速、bearingは遅れて追従=ドリフト ---
      const p = routeAt(st.route, st.s);
      const ahead = routeAt(st.route, st.s + cz.lookAhead);
      const turn = Math.abs(angleDelta(p.heading, routeAt(st.route, st.s + 40).heading));
      const targetSpeed = cz.speed * Math.max(0.35, 1 - Math.min(0.65, (turn / 90) * cz.curveSlow));
      st.speed += (targetSpeed - st.speed) * Math.min(1, 1.6 * dt);
      st.s += st.speed * dt;
      cam.lon = p.lon + (ahead.lon - p.lon) * 0.35;         // 注視点は少し先(コーナーの内側を見る)
      cam.lat = p.lat + (ahead.lat - p.lat) * 0.35;
      // ホップ: 到達点を跨いだら開始。進行方向は変えず、上に飛んで左右を見る
      if (!st.hop && st.hopsAt && st.hopsAt.length && st.s >= st.hopsAt[0]) {
        st.hopsAt.shift();
        st.hop = { t: 0 };
      }
      let lookOff = 0;
      let rise = 0;
      if (st.hop) {
        st.hop.t += dt;
        const u = st.hop.t / cz.hopSec;
        if (u >= 1) { st.hop = null; } else {
          rise = Math.sin(Math.PI * u);                     // 上がって降りる
          lookOff = Math.sin(2 * Math.PI * u) * cz.lookDeg * rise;   // 右→左を見て戻す
        }
      }
      cam.bearing += angleDelta(cam.bearing, p.heading) * Math.min(1, cz.bearingLag * dt);
      cam.zoom = cz.zoom - cz.hopZoom * rise;
      cam.pitch = cz.pitch - 16 * rise;
      const bearingOut = cam.bearing + lookOff;             // 首振りはカメラだけ(進路は不変)
      const done = city.cruiseKm
        ? (st.s - st.s0) >= city.cruiseKm * 1000 || st.t > 180
        : st.t >= (city.cruiseSec ?? 30);
      if (done && !st.hop) {
        cam.vZoom = 0;
        setPhase('climb');
      }
      map.jumpTo({ center: [cam.lon, cam.lat], zoom: cam.zoom, bearing: bearingOut, pitch: cam.pitch });
      return;   // 首振りbearingで描画済み
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
    try { if (map.setMaxPitch && cz.pitch > 60) map.setMaxPitch(Math.min(85, cz.pitch + 8)); } catch (e) { /* noop */ }
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
