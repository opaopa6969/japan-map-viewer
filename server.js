// japan-map-viewer demo server — 依存ゼロの静的配信 + /api/address-points。
// ライブラリ本体は public/js/mapcore/(純ESM)。このサーバはデモページを動かすためだけの薄い器。
//  - 既定: 同梱サンプル(public/data/sample-error-points.json)を返す。
//  - VACANT_SERVICE_URL 設定時: vacant-service の geo エクスポート
//    (/api/errorAddresses/geo)を単純プロキシ(クエリはそのまま転送)。
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { openRoads } from './lib/road-codec.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(root, 'public');
const PORT = Number(process.env.PORT) || 8091;

const VACANT_SERVICE_URL = (process.env.VACANT_SERVICE_URL || '').replace(/\/+$/, '');
const SAMPLE_POINTS_FILE = join(PUBLIC, 'data/sample-error-points.json');

const CONTENT_TYPE = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// 拡張子なしの便宜エイリアス
const ALIASES = {
  '/': '/index.html',
  '/address-map': '/address-map.html',
  '/address-map-gl': '/address-map-gl.html',
  '/municipality-map': '/municipality-map.html',
  '/municipality-timeline': '/municipality-timeline.html',
  '/layers-demo': '/layers-demo.html',
};

async function serveAddressPoints(req, res) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  try {
    if (VACANT_SERVICE_URL) {
      const query = (req.url || '').split('?')[1] || '';
      const upstream = `${VACANT_SERVICE_URL}/api/errorAddresses/geo${query ? `?${query}` : ''}`;
      const upstreamRes = await fetch(upstream, { headers: { Accept: 'application/json' } });
      const text = await upstreamRes.text();
      res.writeHead(upstreamRes.ok ? 200 : upstreamRes.status, headers);
      res.end(text);
      return;
    }
    res.writeHead(200, headers);
    res.end(await readFile(SAMPLE_POINTS_FILE));
  } catch (e) {
    // 失敗時もサンプルにフォールバック（UI を止めない）
    try {
      res.writeHead(200, headers);
      res.end(await readFile(SAMPLE_POINTS_FILE));
    } catch (_) {
      res.writeHead(502, headers);
      res.end(JSON.stringify({ error: String(e && e.message ? e.message : e), categories: [], points: [] }));
    }
  }
}

// --- 鉄道メタデータ API (/api/railways/…) --------------------------------------
// scripts/fetch-railways.mjs の出力(public/data/japan-railways.json、N02由来)を
// サーバ側でフィルタして返す。全量10MBをブラウザに送らずに済む検索用の口。
//   GET /api/railways                       … サマリ(件数・事業者種別ラベル・路線一覧なし)
//   GET /api/railways/lines?q=&company=&kind=  … 路線メタデータ(名寄せ済み・ジオメトリなし)
//   GET /api/railways/line?name=山手線[&company=…] … 1路線のジオメトリ(区間)+駅
//   GET /api/railways/stations?q=渋谷&limit=50    … 駅名の部分一致検索
let railwaysCache = null;
async function railways() {
  if (!railwaysCache) {
    railwaysCache = JSON.parse(await readFile(join(PUBLIC, 'data/japan-railways.json'), 'utf8'));
  }
  return railwaysCache;
}

async function serveRailways(req, res, path) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' };
  const q = new URL(req.url, 'http://x').searchParams;
  let rail;
  try {
    rail = await railways();
  } catch {
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'japan-railways.json が無い。先に `npm run fetch:railways` を実行。' }));
    return;
  }
  const send = (obj) => { res.writeHead(200, headers); res.end(JSON.stringify(obj)); };

  if (path === '/api/railways') {
    send({
      source: rail.source, kindLabels: rail.kindLabels,
      lineCount: rail.lineCount, stationCount: rail.stationCount,
      distinctLines: new Set(rail.lines.map((l) => `${l.name}|${l.company}`)).size,
      companies: new Set(rail.lines.map((l) => l.company)).size,
    });
    return;
  }
  if (path === '/api/railways/lines') {
    const query = (q.get('q') || '').toLowerCase();
    const company = q.get('company');
    const kind = q.get('kind') ? +q.get('kind') : null;
    const byLine = new Map();   // `${name}|${company}` -> meta
    for (const l of rail.lines) {
      if (query && !l.name.toLowerCase().includes(query) && !l.company.toLowerCase().includes(query)) continue;
      if (company && l.company !== company) continue;
      if (kind && l.kind !== kind) continue;
      const key = `${l.name}|${l.company}`;
      const m = byLine.get(key) || { name: l.name, company: l.company, kind: l.kind, kindLabel: rail.kindLabels[l.kind], sections: 0, points: 0 };
      m.sections++;
      m.points += l.coords.length;
      byLine.set(key, m);
    }
    const stByLine = new Map();
    for (const s of rail.stations) {
      const key = `${s.line}|${s.company}`;
      if (byLine.has(key)) stByLine.set(key, (stByLine.get(key) || 0) + 1);
    }
    const list = [...byLine.entries()].map(([key, m]) => ({ ...m, stations: stByLine.get(key) || 0 }))
      .sort((a, b) => (a.company + a.name).localeCompare(b.company + b.name, 'ja'));
    send({ count: list.length, lines: list });
    return;
  }
  if (path === '/api/railways/line') {
    const name = q.get('name');
    const company = q.get('company');
    if (!name) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'name が必要' })); return; }
    const sections = rail.lines.filter((l) => l.name === name && (!company || l.company === company));
    const stations = rail.stations.filter((s) => s.line === name && (!company || s.company === company));
    send({ name, companies: [...new Set(sections.map((l) => l.company))], sections, stations });
    return;
  }
  if (path === '/api/railways/stations') {
    const query = (q.get('q') || '').toLowerCase();
    const limit = Math.min(500, +(q.get('limit') || 50));
    const hits = [];
    for (const s of rail.stations) {
      if (query && !s.name.toLowerCase().includes(query)) continue;
      hits.push(s);
      if (hits.length >= limit) break;
    }
    send({ count: hits.length, stations: hits });
    return;
  }
  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: 'unknown railways endpoint' }));
}

// --- OSM道路 API (/api/roads) -----------------------------------------------------
// scripts/fetch-osm-roads.mjs が生成する data/osm-roads-*.jrb(自作バイナリcodec)を
// 起動後の初回アクセスで全部オンメモリに開き(lib/road-codec.mjs がグリッド索引を構築)、
// ビューポートのbboxに交差するwayだけ部分デコードして返す。全国データを
// ブラウザに丸ごと送らないための、このリポジトリ内で完結する小さなタイルサーバ相当。
//   GET /api/roads/meta                              … 読み込んだ地域・クラス・件数
//   GET /api/roads?bbox=lon0,lat0,lon1,lat1&classes=primary,…&limit=4000
let roadsHandles = null;   // [{region, handle}]
async function roads() {
  if (!roadsHandles) {
    roadsHandles = [];
    const dataDir = join(root, 'data');
    let files = [];
    try { files = (await readdir(dataDir)).filter((f) => /^osm-roads-.*\.jrb$/.test(f)); } catch { /* dataDir無し */ }
    for (const f of files) {
      try {
        const handle = openRoads(await readFile(join(dataDir, f)));
        roadsHandles.push({ file: f, handle });
        console.log(`  roads: ${f} loaded (${handle.count.toLocaleString()} ways, region=${handle.meta.region})`);
      } catch (e) {
        console.error(`  roads: ${f} 読み込み失敗: ${e.message}`);
      }
    }
  }
  return roadsHandles;
}

async function serveRoads(req, res, path) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const q = new URL(req.url, 'http://x').searchParams;
  const handles = await roads();
  const send = (obj) => { res.writeHead(200, headers); res.end(JSON.stringify(obj)); };
  if (!handles.length) {
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'osm-roads-*.jrb が無い。先に `npm run fetch:osm-roads -- --region <region>` を実行。' }));
    return;
  }
  if (path === '/api/roads/meta') {
    send({ regions: handles.map(({ file, handle }) => ({ file, ...handle.meta })) });
    return;
  }
  const bboxRaw = (q.get('bbox') || '').split(',').map(Number);
  if (bboxRaw.length !== 4 || bboxRaw.some((v) => !Number.isFinite(v))) {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ error: 'bbox=lon0,lat0,lon1,lat1 が必要' }));
    return;
  }
  const classNames = q.get('classes') ? q.get('classes').split(',') : null;
  const limit = Math.min(20000, +(q.get('limit') || 4000));
  // 上限超過時は「bbox中心から近い順」で切り詰める(buildings側と同じ方針)
  const cx = (bboxRaw[0] + bboxRaw[2]) / 2 * 1e5;
  const cy = (bboxRaw[1] + bboxRaw[3]) / 2 * 1e5;
  const candidates = [];
  for (const { handle } of handles) {
    const classFilter = classNames
      ? new Set(classNames.map((c) => handle.meta.classLabels.indexOf(c)).filter((i) => i >= 0))
      : null;
    if (classFilter && classFilter.size === 0) continue;
    const r = handle.queryBbox(bboxRaw, { classFilter, maxWays: 80000 - candidates.length });
    for (const i of r.indices) {
      const [mnx, mny, mxx, mxy] = handle.bboxOf(i);
      const dx = (mnx + mxx) / 2 - cx;
      const dy = (mny + mxy) / 2 - cy;
      candidates.push({ handle, i, d: dx * dx + dy * dy });
    }
  }
  const truncated = candidates.length > limit;
  if (truncated) candidates.sort((a, b) => a.d - b.d);
  const paths = candidates.slice(0, limit).map(({ handle, i }) => {
    const w = handle.decodeWay(i);
    return { id: `${handle.meta.region}:${i}`, name: w.name, kind: handle.meta.classLabels[w.class], coords: w.coords };
  });
  send({ count: paths.length, total: candidates.length, truncated, paths });
}

// --- OSM建物 API (/api/buildings) ---------------------------------------------------
// data/osm-buildings-*.jrb(JRB v2、value=高さdm)をオンメモリに開き、bboxで部分配信。
//   GET /api/buildings/meta
//   GET /api/buildings?bbox=lon0,lat0,lon1,lat1&limit=3000
let buildingsHandles = null;
async function buildings() {
  if (!buildingsHandles) {
    buildingsHandles = [];
    let files = [];
    try { files = (await readdir(join(root, 'data'))).filter((f) => /^osm-buildings-.*\.jrb$/.test(f)); } catch { /* 無し */ }
    for (const f of files) {
      try {
        const handle = openRoads(await readFile(join(root, 'data', f)), { cellDeg: 0.02 });
        buildingsHandles.push({ file: f, handle });
        console.log(`  buildings: ${f} loaded (${handle.count.toLocaleString()} polygons)`);
      } catch (e) { console.error(`  buildings: ${f} 読み込み失敗: ${e.message}`); }
    }
  }
  return buildingsHandles;
}

async function serveBuildings(req, res, path) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const q = new URL(req.url, 'http://x').searchParams;
  const handles = await buildings();
  const send = (obj) => { res.writeHead(200, headers); res.end(JSON.stringify(obj)); };
  if (!handles.length) {
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'osm-buildings-*.jrb が無い。先に `npm run fetch:osm-buildings -- --region <region>` を実行。' }));
    return;
  }
  if (path === '/api/buildings/meta') {
    send({ regions: handles.map(({ file, handle }) => ({ file, ...handle.meta })) });
    return;
  }
  const bboxRaw = (q.get('bbox') || '').split(',').map(Number);
  if (bboxRaw.length !== 4 || bboxRaw.some((v) => !Number.isFinite(v))) {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ error: 'bbox=lon0,lat0,lon1,lat1 が必要' }));
    return;
  }
  const limit = Math.min(20000, +(q.get('limit') || 3000));
  // 上限超過時の切り詰めを「bbox中心から近い順」で行う(グリッド走査順の恣意的な
  // 欠け=パンのたびに別の一角が消える現象を防ぎ、画面中心は常に埋まる)。
  const cx = (bboxRaw[0] + bboxRaw[2]) / 2 * 1e5;
  const cy = (bboxRaw[1] + bboxRaw[3]) / 2 * 1e5;
  const candidates = [];
  for (const { handle } of handles) {
    const r = handle.queryBbox(bboxRaw, { maxWays: 80000 - candidates.length });
    for (const i of r.indices) {
      const [mnx, mny, mxx, mxy] = handle.bboxOf(i);
      const dx = (mnx + mxx) / 2 - cx;
      const dy = (mny + mxy) / 2 - cy;
      candidates.push({ handle, i, d: dx * dx + dy * dy });
    }
  }
  const truncated = candidates.length > limit;
  if (truncated) candidates.sort((a, b) => a.d - b.d);
  const polygons = candidates.slice(0, limit).map(({ handle, i }) => {
    const w = handle.decodeWay(i);
    return { id: `${handle.meta.region}:${i}`, name: w.name, height: w.value / 10, ring: w.coords };
  });
  send({ count: polygons.length, total: candidates.length, truncated, polygons });
}

// --- 標高 API (/api/elevation) ------------------------------------------------------
// 地理院DEM由来のheightfield(public/terrain/japan.heightfield.json)をバイリニア補間。
// 表示用に間引かれた格子(z10・約1km)なので精度は±数十m — sourceで明示する。
// 高精度が要る用途は地理院標高APIへの差し替え余地(issue #4)。
let hfCache = null;
async function heightfield() {
  if (!hfCache) {
    const d = JSON.parse(await readFile(join(PUBLIC, 'terrain/japan.heightfield.json'), 'utf8'));
    // fetch-terrain.mjs はタイル整列したWebメルカトルのモザイクをダウンサンプルする。
    // bounds はリクエスト範囲であって実カバー範囲ではないため、zoom+bounds から
    // タイル範囲(floor整列)を再構成し、タイル座標系で引く(検証: 富士3426m/琵琶湖85m)。
    const Z = d.zoom;
    const lon2tx = (lon) => (lon + 180) / 360 * 2 ** Z;
    const lat2ty = (lat) => {
      const r = lat * Math.PI / 180;
      return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z;
    };
    const xMin = Math.floor(lon2tx(d.bounds.lon0));
    const xMax = Math.floor(lon2tx(d.bounds.lon1));
    const yMin = Math.floor(lat2ty(d.bounds.lat1));
    const yMax = Math.floor(lat2ty(d.bounds.lat0));
    hfCache = {
      grid: d.grid, height: d.height, lon2tx, lat2ty,
      xMin, yMin, cols: xMax - xMin + 1, rows: yMax - yMin + 1,
    };
  }
  return hfCache;
}

async function serveElevation(req, res) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' };
  const q = new URL(req.url, 'http://x').searchParams;
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ error: 'lat= と lon= が必要' }));
    return;
  }
  let hf;
  try {
    hf = await heightfield();
  } catch {
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'heightfieldが無い。先に `npm run fetch:terrain` を実行。' }));
    return;
  }
  const { grid, height, lon2tx, lat2ty, xMin, yMin, cols, rows } = hf;
  // タイル整列メルカトルのモザイク座標(0..1) → グリッド。行0=北。
  const fx = (lon2tx(lon) - xMin) / cols;
  const fy = (lat2ty(lat) - yMin) / rows;
  const inside = fx >= 0 && fx < 1 && fy >= 0 && fy < 1;
  let elevation = null;
  if (inside) {
    const gx = fx * grid - 0.5;   // ダウンサンプルはセル左上サンプリングなので中心補正
    const gy = fy * grid - 0.5;
    const x0 = Math.max(0, Math.floor(gx));
    const y0 = Math.max(0, Math.floor(gy));
    const x1 = Math.min(grid - 1, x0 + 1);
    const y1 = Math.min(grid - 1, y0 + 1);
    const tx = Math.min(1, Math.max(0, gx - x0));
    const ty = Math.min(1, Math.max(0, gy - y0));
    const h = (X, Y) => height[Y * grid + X];
    elevation = Math.round(
      (h(x0, y0) * (1 - tx) + h(x1, y0) * tx) * (1 - ty)
      + (h(x0, y1) * (1 - tx) + h(x1, y1) * tx) * ty,
    );
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify({
    lat, lon, elevation, inside,
    source: 'heightfield(地理院DEM z10・約1km格子・±数十m。海/範囲外はnullまたは0)',
  }));
}

const server = createServer(async (req, res) => {
  let path = (req.url || '/').split('?')[0];
  if (path === '/api/address-points') { serveAddressPoints(req, res); return; }
  if (path === '/api/elevation') { serveElevation(req, res); return; }
  if (path === '/api/railways' || path.startsWith('/api/railways/')) { serveRailways(req, res, path); return; }
  if (path === '/api/roads' || path.startsWith('/api/roads/')) { serveRoads(req, res, path); return; }
  if (path === '/api/buildings' || path.startsWith('/api/buildings/')) { serveBuildings(req, res, path); return; }
  if (ALIASES[path]) path = ALIASES[path];
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPE[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 not found');
  }
});

server.listen(PORT, () => {
  console.log(`japan-map-viewer: http://localhost:${PORT}/`);
  if (VACANT_SERVICE_URL) console.log(`  address-points: proxy → ${VACANT_SERVICE_URL}/api/errorAddresses/geo`);
  else console.log('  address-points: 同梱サンプル (VACANT_SERVICE_URL で vacant-service に接続)');
});
