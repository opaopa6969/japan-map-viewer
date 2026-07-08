// lib/road-codec.mjs — 道路網のコンパクトなバイナリcodec("JRB1")。
// OSM由来の全国道路(数十万〜数百万way)はJSONだと数百MBになるため、
// 座標を1e5量子化(≈1.1m)+delta+zigzag varintで数十MBに圧縮し、
// サーバがオンメモリに載せてbboxクエリで部分デコードして返す。
//
// フォーマット(リトルエンディアン):
//   "JRB1"(4B) | u32 metaLen | meta JSON(utf8)
//   | names: varint count, 各 varint len + utf8   (重複排除済みの道路名テーブル)
//   | offsets: u32 wayCount 個 (waysセクション先頭からの各wayレコードの相対オフセット)
//   | ways: 各レコード = u8 classIdx | varint nameIdx+1(0=名無し) | varint pointCount
//           | zigzag varint lon0,lat0(絶対値・量子化) | 以降 zigzag varint delta...
//
// meta JSON: { version, region, source, quant, classLabels: [...], wayCount, nameCount }
//
// 純JS・依存ゼロ・決定論(同入力→同バイト列)。encode/decodeのroundtripは
// test/road-codec-test.mjs で検証する。

export const QUANT = 1e5;

// --- varint (LEB128) / zigzag --------------------------------------------------
// JSのNumberで2^53まで安全(座標量子化値は最大±1.8e7なので余裕)。

function zigzagEncode(n) { return n >= 0 ? n * 2 : -n * 2 - 1; }
function zigzagDecode(n) { return n % 2 === 0 ? n / 2 : -(n + 1) / 2; }

class Writer {
  constructor() {
    this.chunks = [];
    this.buf = Buffer.alloc(1 << 16);
    this.pos = 0;
  }
  _ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    this.chunks.push(this.buf.subarray(0, this.pos));
    this.buf = Buffer.alloc(Math.max(1 << 16, n));
    this.pos = 0;
  }
  u8(v) { this._ensure(1); this.buf[this.pos++] = v; }
  varint(v) {
    this._ensure(10);
    while (v >= 0x80) { this.buf[this.pos++] = (v & 0x7f) | 0x80; v = Math.floor(v / 128); }
    this.buf[this.pos++] = v;
  }
  svarint(v) { this.varint(zigzagEncode(v)); }
  bytes(b) { this._ensure(b.length); b.copy(this.buf, this.pos); this.pos += b.length; }
  concat() { return Buffer.concat([...this.chunks, this.buf.subarray(0, this.pos)]); }
  get length() { return this.chunks.reduce((t, c) => t + c.length, 0) + this.pos; }
}

export function readVarint(buf, pos) {
  let v = 0;
  let shift = 1;
  for (;;) {
    const b = buf[pos++];
    v += (b & 0x7f) * shift;
    if (b < 0x80) return [v, pos];
    shift *= 128;
  }
}
function readSvarint(buf, pos) {
  const [v, p] = readVarint(buf, pos);
  return [zigzagDecode(v), p];
}

// --- encode --------------------------------------------------------------------
/**
 * @param {object} opts { region, source, classLabels: string[],
 *   ways: [{ class: number(classLabelsの添字), name: string|null, coords: [[lon,lat],...] }] }
 * @returns {Buffer}
 */
export function encodeRoads({ region, source, classLabels, ways }) {
  // 名前テーブル(重複排除・出現順)
  const nameIdx = new Map();
  for (const w of ways) {
    if (w.name && !nameIdx.has(w.name)) nameIdx.set(w.name, nameIdx.size);
  }
  const meta = {
    version: 1, region, source, quant: QUANT,
    classLabels, wayCount: ways.length, nameCount: nameIdx.size,
  };
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');

  const names = new Writer();
  names.varint(nameIdx.size);
  for (const name of nameIdx.keys()) {
    const b = Buffer.from(name, 'utf8');
    names.varint(b.length);
    names.bytes(b);
  }

  const body = new Writer();
  const offsets = new Uint32Array(ways.length);
  ways.forEach((w, i) => {
    offsets[i] = body.length;
    body.u8(w.class);
    body.varint(w.name ? nameIdx.get(w.name) + 1 : 0);
    body.varint(w.coords.length);
    let px = 0;
    let py = 0;
    w.coords.forEach(([lon, lat], j) => {
      const x = Math.round(lon * QUANT);
      const y = Math.round(lat * QUANT);
      if (j === 0) { body.svarint(x); body.svarint(y); } else { body.svarint(x - px); body.svarint(y - py); }
      px = x; py = y;
    });
  });

  const head = Buffer.alloc(8);
  head.write('JRB1', 0, 'ascii');
  head.writeUInt32LE(metaBuf.length, 4);
  return Buffer.concat([
    head, metaBuf, names.concat(),
    Buffer.from(offsets.buffer, offsets.byteOffset, offsets.byteLength),
    body.concat(),
  ]);
}

// --- decode / on-memory handle ---------------------------------------------------
/**
 * バッファを開き、bboxクエリ可能なオンメモリハンドルを返す。
 * 全way一度スキャンしてbbox(Int32Array)とグリッド索引(cellDeg度)を構築する。
 */
export function openRoads(buf, { cellDeg = 0.1 } = {}) {
  if (buf.toString('ascii', 0, 4) !== 'JRB1') throw new Error('not a JRB1 file');
  const metaLen = buf.readUInt32LE(4);
  const meta = JSON.parse(buf.toString('utf8', 8, 8 + metaLen));
  let pos = 8 + metaLen;

  const [nameCount, p0] = readVarint(buf, pos);
  pos = p0;
  const names = new Array(nameCount);
  for (let i = 0; i < nameCount; i++) {
    const [len, p] = readVarint(buf, pos);
    names[i] = buf.toString('utf8', p, p + len);
    pos = p + len;
  }

  const offsets = new Uint32Array(meta.wayCount);
  for (let i = 0; i < meta.wayCount; i++) { offsets[i] = buf.readUInt32LE(pos); pos += 4; }
  const waysStart = pos;

  function decodeWay(i) {
    let p = waysStart + offsets[i];
    const cls = buf[p++];
    let nIdx;
    [nIdx, p] = readVarint(buf, p);
    let count;
    [count, p] = readVarint(buf, p);
    const coords = new Array(count);
    let x = 0;
    let y = 0;
    for (let j = 0; j < count; j++) {
      let dx;
      let dy;
      [dx, p] = readSvarint(buf, p);
      [dy, p] = readSvarint(buf, p);
      x += dx; y += dy;
      coords[j] = [x / QUANT, y / QUANT];
    }
    return { class: cls, name: nIdx ? names[nIdx - 1] : null, coords };
  }

  // bbox(量子化整数)とグリッド索引を1スキャンで構築(オンメモリ化のコスト)
  const n = meta.wayCount;
  const bminx = new Int32Array(n);
  const bminy = new Int32Array(n);
  const bmaxx = new Int32Array(n);
  const bmaxy = new Int32Array(n);
  const classes = new Uint8Array(n);
  const grid = new Map();   // `${gi}_${gj}` -> number[]
  const cellQ = cellDeg * QUANT;
  for (let i = 0; i < n; i++) {
    let p = waysStart + offsets[i];
    classes[i] = buf[p++];
    let skip;
    [skip, p] = readVarint(buf, p);       // nameIdx
    let count;
    [count, p] = readVarint(buf, p);
    let x = 0;
    let y = 0;
    let mnx = Infinity;
    let mny = Infinity;
    let mxx = -Infinity;
    let mxy = -Infinity;
    for (let j = 0; j < count; j++) {
      let dx;
      let dy;
      [dx, p] = readSvarint(buf, p);
      [dy, p] = readSvarint(buf, p);
      x += dx; y += dy;
      if (x < mnx) mnx = x;
      if (y < mny) mny = y;
      if (x > mxx) mxx = x;
      if (y > mxy) mxy = y;
    }
    bminx[i] = mnx; bminy[i] = mny; bmaxx[i] = mxx; bmaxy[i] = mxy;
    const gi0 = Math.floor(mnx / cellQ);
    const gi1 = Math.floor(mxx / cellQ);
    const gj0 = Math.floor(mny / cellQ);
    const gj1 = Math.floor(mxy / cellQ);
    for (let gi = gi0; gi <= gi1; gi++) {
      for (let gj = gj0; gj <= gj1; gj++) {
        const key = `${gi}_${gj}`;
        let cell = grid.get(key);
        if (!cell) { cell = []; grid.set(key, cell); }
        cell.push(i);
      }
    }
  }

  /**
   * bbox([lon0,lat0,lon1,lat1]) と交差するwayの添字を返す。
   * classFilter: Set<number> (classLabels の添字) | null=全部。maxWays 超過は打ち切り。
   */
  function queryBbox([lon0, lat0, lon1, lat1], { classFilter = null, maxWays = 5000 } = {}) {
    const qx0 = Math.round(Math.min(lon0, lon1) * QUANT);
    const qy0 = Math.round(Math.min(lat0, lat1) * QUANT);
    const qx1 = Math.round(Math.max(lon0, lon1) * QUANT);
    const qy1 = Math.round(Math.max(lat0, lat1) * QUANT);
    const out = [];
    const seen = new Set();
    let truncated = false;
    const gi0 = Math.floor(qx0 / cellQ);
    const gi1 = Math.floor(qx1 / cellQ);
    const gj0 = Math.floor(qy0 / cellQ);
    const gj1 = Math.floor(qy1 / cellQ);
    outer:
    for (let gi = gi0; gi <= gi1; gi++) {
      for (let gj = gj0; gj <= gj1; gj++) {
        const cell = grid.get(`${gi}_${gj}`);
        if (!cell) continue;
        for (const i of cell) {
          if (seen.has(i)) continue;
          seen.add(i);
          if (classFilter && !classFilter.has(classes[i])) continue;
          if (bmaxx[i] < qx0 || bminx[i] > qx1 || bmaxy[i] < qy0 || bminy[i] > qy1) continue;
          if (out.length >= maxWays) { truncated = true; break outer; }
          out.push(i);
        }
      }
    }
    return { indices: out, truncated };
  }

  return { meta, names, count: n, classes, decodeWay, queryBbox };
}
