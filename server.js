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

const server = createServer(async (req, res) => {
  let path = (req.url || '/').split('?')[0];
  if (path === '/api/address-points') { serveAddressPoints(req, res); return; }
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
