// japan-map-viewer demo server — 依存ゼロの静的配信 + /api/address-points。
// ライブラリ本体は public/js/mapcore/(純ESM)。このサーバはデモページを動かすためだけの薄い器。
//  - 既定: 同梱サンプル(public/data/sample-error-points.json)を返す。
//  - VACANT_SERVICE_URL 設定時: vacant-service の geo エクスポート
//    (/api/errorAddresses/geo)を単純プロキシ(クエリはそのまま転送)。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

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

const server = createServer(async (req, res) => {
  let path = (req.url || '/').split('?')[0];
  if (path === '/api/address-points') { serveAddressPoints(req, res); return; }
  if (path === '/api/railways' || path.startsWith('/api/railways/')) { serveRailways(req, res, path); return; }
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
