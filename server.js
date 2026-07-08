// japan-map-viewer demo server — 依存ゼロの静的配信 + /api/address-points。
// ライブラリ本体は public/js/mapcore/(純ESM)。このサーバはデモページを動かすためだけの薄い器。
//  - 既定: 同梱サンプル(public/data/sample-error-points.json)を返す。
//  - VACANT_SERVICE_URL 設定時: vacant-service の geo エクスポート
//    (/api/errorAddresses/geo)を単純プロキシ(クエリはそのまま転送)。
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { openRoads, createRoadsEncoder } from './lib/road-codec.mjs';
import { gzipSync } from 'node:zlib';
import { cpus, totalmem, platform, release } from 'node:os';
import { execFileSync } from 'node:child_process';

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

// 大きいJSONレスポンス用: クライアントが許せばgzip(建物数万棟=数十MB級を1/5前後に)。
function sendJsonMaybeGzip(req, res, headers, obj) {
  const body = JSON.stringify(obj);
  const accept = String(req.headers['accept-encoding'] || '');
  if (body.length > 512 * 1024 && accept.includes('gzip')) {
    const gz = gzipSync(Buffer.from(body, 'utf8'));
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    res.end(gz);
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
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
  const send = (obj) => sendJsonMaybeGzip(req, res, headers, obj);
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
  const limit = Math.min(200000, +(q.get('limit') || 4000));
  // 上限超過時は「注視点から近い順」で切り詰める(buildings側と同じ方針。center=推奨)
  const centerRaw = (q.get('center') || '').split(',').map(Number);
  const center = (centerRaw.length === 2 && centerRaw.every(Number.isFinite))
    ? centerRaw
    : [(bboxRaw[0] + bboxRaw[2]) / 2, (bboxRaw[1] + bboxRaw[3]) / 2];
  const paths = [];
  let truncated = false;
  for (const { handle } of handles) {
    if (paths.length >= limit) { truncated = true; break; }
    const classFilter = classNames
      ? new Set(classNames.map((c) => handle.meta.classLabels.indexOf(c)).filter((i) => i >= 0))
      : null;
    if (classFilter && classFilter.size === 0) continue;
    const r = handle.queryBbox(bboxRaw, { classFilter, maxWays: limit - paths.length, center });
    truncated = truncated || r.truncated;
    for (const i of r.indices) {
      const w = handle.decodeWay(i);
      paths.push({ id: `${handle.meta.region}:${i}`, name: w.name, kind: handle.meta.classLabels[w.class], coords: w.coords });
    }
  }
  send({ count: paths.length, truncated, paths });
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
  const send = (obj) => sendJsonMaybeGzip(req, res, headers, obj);
  if (!handles.length) {
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'osm-buildings-*.jrb が無い。先に `npm run fetch:osm-buildings -- --region <region>` を実行。' }));
    return;
  }
  if (path === '/api/buildings/meta') {
    send({ regions: handles.map(({ file, handle }) => ({ file, ...handle.meta })) });
    return;
  }
  // 2つのクエリ形:
  //   bbox=lon0,lat0,lon1,lat1 [&center=]      … ビューポート配信(注視点優先切り詰め)
  //   center=lon,lat&radius=800                … ドームセレクタ(半径m内の建物だけ)
  const centerRaw = (q.get('center') || '').split(',').map(Number);
  const hasCenter = centerRaw.length === 2 && centerRaw.every(Number.isFinite);
  const radius = q.get('radius') ? +q.get('radius') : null;
  let bboxRaw = (q.get('bbox') || '').split(',').map(Number);
  if (radius && hasCenter) {
    const dLat = radius / 111320;
    const dLon = radius / (111320 * Math.cos(centerRaw[1] * Math.PI / 180));
    bboxRaw = [centerRaw[0] - dLon, centerRaw[1] - dLat, centerRaw[0] + dLon, centerRaw[1] + dLat];
  }
  if (bboxRaw.length !== 4 || bboxRaw.some((v) => !Number.isFinite(v))) {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ error: 'bbox=lon0,lat0,lon1,lat1 か center=lon,lat&radius=m が必要' }));
    return;
  }
  // format=bin: JRBバイナリで返す(100万棟級の本命経路。JSONは互換用に20万まで)
  const wantBin = q.get('format') === 'bin';
  const limit = Math.min(wantBin ? 6200000 : 200000, +(q.get('limit') || 3000));
  // 上限超過時の切り詰めは「注視点から近い順」(codecのqueryBboxがセル走査から中心優先)。
  // ピッチをつけたカメラではgetBounds()のbbox中心が地平線方向へ大きくズレるため、
  // クライアントは center=lon,lat(map.getCenter()=実際の注視点)を渡すこと。
  const center = hasCenter ? centerRaw : [(bboxRaw[0] + bboxRaw[2]) / 2, (bboxRaw[1] + bboxRaw[3]) / 2];
  const kLat = 111320;
  const kLon = 111320 * Math.cos(center[1] * Math.PI / 180);

  // 添字だけ先に集める(デコード前なので軽い)
  const picked = [];   // {handle, i}
  let truncated = false;
  for (const { handle } of handles) {
    if (picked.length >= limit) { truncated = true; break; }
    const r = handle.queryBbox(bboxRaw, { maxWays: limit - picked.length, center });
    truncated = truncated || r.truncated;
    for (const i of r.indices) {
      if (radius) {
        // ドーム: 半径内(建物bbox中心との距離)だけ。円形の縁がbboxでなく本当の円になる
        const [mnx, mny, mxx, mxy] = handle.bboxOf(i);
        const dx = ((mnx + mxx) / 2 / 1e5 - center[0]) * kLon;
        const dy = ((mny + mxy) / 2 / 1e5 - center[1]) * kLat;
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      picked.push({ handle, i });
    }
  }

  if (wantBin) {
    // 選んだwayをJRBに再エンコードして返す。座標はデコード→再量子化(可逆)。
    // ブラウザ側は mapcore/jrb.js の jrbToBuildingBinary が deck の binary attributes へ直行。
    const enc = createRoadsEncoder({
      region: 'query', source: 'api/buildings', classLabels: ['building'], withValues: true,
      extraMeta: { truncated, radius: radius ?? null },
    });
    let scratch = new Int32Array(1024);
    for (const { handle, i } of picked) {
      const w = handle.decodeWay(i);
      if (w.coords.length * 2 > scratch.length) scratch = new Int32Array(w.coords.length * 2);
      for (let j = 0; j < w.coords.length; j++) {
        scratch[j * 2] = Math.round(w.coords[j][0] * 1e5);
        scratch[j * 2 + 1] = Math.round(w.coords[j][1] * 1e5);
      }
      enc.addWay({ cls: 0, name: w.name, value: w.value, coordsQ: scratch, count: w.coords.length });
    }
    const bin = enc.finish();
    const accept = String(req.headers['accept-encoding'] || '');
    const binHeaders = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (accept.includes('gzip')) {
      const gz = gzipSync(bin);
      res.writeHead(200, { ...binHeaders, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      res.end(gz);
    } else {
      res.writeHead(200, { ...binHeaders, 'Content-Length': bin.length });
      res.end(bin);
    }
    return;
  }

  const polygons = picked.map(({ handle, i }) => {
    const w = handle.decodeWay(i);
    return { id: `${handle.meta.region}:${i}`, name: w.name, height: w.value / 10, ring: w.coords };
  });
  send({ count: polygons.length, truncated, radius, polygons });
}

// --- サーバマシン情報 API (/api/sysinfo) --------------------------------------------
// ブラウザはCPUモデル名を非公開にするため、サーバ側(Node)のos情報をbest effortで返す。
// localhostで動かしている限り「ブラウザと同じマシン」の実名が出る。GPU名はnvidia-smiが
// あれば取得(無ければnull — クライアント側のWebGL名を使えばよい)。
let sysinfoCache = null;
function serveSysinfo(res) {
  if (!sysinfoCache) {
    let gpu = null;
    try {
      gpu = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 3000 })
        .toString().trim().split('\n')[0] || null;
    } catch (_) { /* nvidia-smi無し(非NVIDIA/コンテナ等) */ }
    const cpuList = cpus();
    sysinfoCache = {
      cpu: cpuList[0] ? cpuList[0].model.replace(/\s+/g, ' ').trim() : null,
      cores: cpuList.length,
      memGB: Math.round(totalmem() / 2 ** 30),
      gpu,
      platform: `${platform()} ${release()}`,
      note: 'サーバ(Node)側の実測。localhostならブラウザと同一マシン',
    };
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  res.end(JSON.stringify(sysinfoCache));
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
  if (path === '/api/sysinfo') { serveSysinfo(res); return; }
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
