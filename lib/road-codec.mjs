// lib/road-codec.mjs — 道路網のコンパクトなバイナリcodec("JRB1")。
// OSM由来の全国道路(数十万〜数百万way)はJSONだと数百MBになるため、
// 座標を1e5量子化(≈1.1m)+delta+zigzag varintで数十MBに圧縮し、
// サーバがオンメモリに載せてbboxクエリで部分デコードして返す。
//
// フォーマット(リトルエンディアン):
//   "JRB1"(4B) | u32 metaLen | meta JSON(utf8)
//   | names: varint count, 各 varint len + utf8   (重複排除済みの道路名テーブル)
//   | offsets: u32 wayCount 個 (waysセクション先頭からの各wayレコードの相対オフセット)
//   | ways: 各レコード = u8 classIdx | varint nameIdx+1(0=名無し)
//           | [meta.hasValues時のみ varint value]   (建物高さdm等の任意の非負整数)
//           | varint pointCount
//           | zigzag varint lon0,lat0(絶対値・量子化) | 以降 zigzag varint delta...
//
// meta JSON: { version, region, source, quant, classLabels: [...], wayCount, nameCount,
//              hasValues? }   (version 2 で hasValues 追加。v1ファイルもそのまま読める)
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
 * ストリーミングエンコーダ。数百万wayでも [[lon,lat],...] のJS配列を溜め込まずに
 * 逐次書き込める(建物全国規模のOOM対策)。
 *   const enc = createRoadsEncoder({region, source, classLabels, withValues});
 *   enc.addWay({ cls, name, value?, coordsQ: Int32Array, count });  // coordsQ=量子化済み x,y,x,y,...
 *   const buf = enc.finish();
 */
export function createRoadsEncoder({ region, source, classLabels, withValues = false, extraMeta = null }) {
  const nameIdx = new Map();
  const body = new Writer();
  const offsets = [];   // number[](finishでUint32Array化)
  let totalPoints = 0;  // クライアントが配列を一発確保できるようmetaに記録

  function addWay({ cls, name, value = 0, coordsQ, count }) {
    offsets.push(body.length);
    totalPoints += count;
    body.u8(cls);
    if (name) {
      if (!nameIdx.has(name)) nameIdx.set(name, nameIdx.size);
      body.varint(nameIdx.get(name) + 1);
    } else body.varint(0);
    if (withValues) body.varint(value);
    body.varint(count);
    let px = 0;
    let py = 0;
    for (let j = 0; j < count; j++) {
      const x = coordsQ[j * 2];
      const y = coordsQ[j * 2 + 1];
      if (j === 0) { body.svarint(x); body.svarint(y); } else { body.svarint(x - px); body.svarint(y - py); }
      px = x; py = y;
    }
  }

  function finish() {
    const meta = {
      version: 2, region, source, quant: QUANT,
      classLabels, wayCount: offsets.length, nameCount: nameIdx.size, totalPoints,
      ...(withValues ? { hasValues: true } : {}),
      ...(extraMeta || {}),
    };
    const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
    const names = new Writer();
    names.varint(nameIdx.size);
    for (const name of nameIdx.keys()) {
      const b = Buffer.from(name, 'utf8');
      names.varint(b.length);
      names.bytes(b);
    }
    const offsetsArr = Uint32Array.from(offsets);
    const head = Buffer.alloc(8);
    head.write('JRB1', 0, 'ascii');
    head.writeUInt32LE(metaBuf.length, 4);
    return Buffer.concat([
      head, metaBuf, names.concat(),
      Buffer.from(offsetsArr.buffer, offsetsArr.byteOffset, offsetsArr.byteLength),
      body.concat(),
    ]);
  }

  return { addWay, finish };
}

/**
 * 一括エンコード(小規模データ向けの簡易API。内部はストリーミングエンコーダ)。
 * @param {object} opts { region, source, classLabels: string[],
 *   ways: [{ class, name, value?, coords: [[lon,lat],...] }] }
 */
export function encodeRoads({ region, source, classLabels, ways, withValues = false, extraMeta = null }) {
  const enc = createRoadsEncoder({ region, source, classLabels, withValues, extraMeta });
  const scratch = { arr: new Int32Array(1024) };
  for (const w of ways) {
    if (w.coords.length * 2 > scratch.arr.length) scratch.arr = new Int32Array(w.coords.length * 2);
    w.coords.forEach(([lon, lat], j) => {
      scratch.arr[j * 2] = Math.round(lon * QUANT);
      scratch.arr[j * 2 + 1] = Math.round(lat * QUANT);
    });
    enc.addWay({ cls: w.class, name: w.name, value: w.value || 0, coordsQ: scratch.arr, count: w.coords.length });
  }
  return enc.finish();
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

  const hasValues = !!meta.hasValues;

  function decodeWay(i) {
    let p = waysStart + offsets[i];
    const cls = buf[p++];
    let nIdx;
    [nIdx, p] = readVarint(buf, p);
    let value = 0;
    if (hasValues) [value, p] = readVarint(buf, p);
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
    return { class: cls, name: nIdx ? names[nIdx - 1] : null, value, coords };
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
    if (hasValues) [skip, p] = readVarint(buf, p);   // value
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
   * center: [lon,lat] を渡すと「centerに近いセルから外側へ」走査し、収集結果も
   * way中心距離でソートして maxWays 件に絞る(超広域bboxでも注視点周りが必ず返る。
   * 無指定は従来のグリッド順=全件が maxWays 未満の時に最速)。
   */
  function queryBbox([lon0, lat0, lon1, lat1], { classFilter = null, maxWays = 5000, center = null } = {}) {
    const qx0 = Math.round(Math.min(lon0, lon1) * QUANT);
    const qy0 = Math.round(Math.min(lat0, lat1) * QUANT);
    const qx1 = Math.round(Math.max(lon0, lon1) * QUANT);
    const qy1 = Math.round(Math.max(lat0, lat1) * QUANT);
    const gi0 = Math.floor(qx0 / cellQ);
    const gi1 = Math.floor(qx1 / cellQ);
    const gj0 = Math.floor(qy0 / cellQ);
    const gj1 = Math.floor(qy1 / cellQ);

    // 走査するセル列。center指定時はセル中心の距離昇順(螺旋相当)。
    const cells = [];
    for (let gi = gi0; gi <= gi1; gi++) {
      for (let gj = gj0; gj <= gj1; gj++) {
        const cell = grid.get(`${gi}_${gj}`);
        if (cell) cells.push({ gi, gj, cell });
      }
    }
    let cx = 0;
    let cy = 0;
    if (center) {
      cx = Math.round(center[0] * QUANT);
      cy = Math.round(center[1] * QUANT);
      cells.sort((a, b) => {
        const da = ((a.gi + 0.5) * cellQ - cx) ** 2 + ((a.gj + 0.5) * cellQ - cy) ** 2;
        const db = ((b.gi + 0.5) * cellQ - cx) ** 2 + ((b.gj + 0.5) * cellQ - cy) ** 2;
        return da - db;
      });
    }
    // 収集: center時は少し多めに取ってからway単位でソート(セル境界のギザつき緩和)
    const collectCap = center ? Math.ceil(maxWays * 1.5) : maxWays;
    const out = [];
    const seen = new Set();
    let truncated = false;
    outer:
    for (const { cell } of cells) {
      for (const i of cell) {
        if (seen.has(i)) continue;
        seen.add(i);
        if (classFilter && !classFilter.has(classes[i])) continue;
        if (bmaxx[i] < qx0 || bminx[i] > qx1 || bmaxy[i] < qy0 || bminy[i] > qy1) continue;
        if (out.length >= collectCap) { truncated = true; break outer; }
        out.push(i);
      }
    }
    if (center && out.length > maxWays) {
      out.sort((a, b) => {
        const da = ((bminx[a] + bmaxx[a]) / 2 - cx) ** 2 + ((bminy[a] + bmaxy[a]) / 2 - cy) ** 2;
        const db = ((bminx[b] + bmaxx[b]) / 2 - cx) ** 2 + ((bminy[b] + bmaxy[b]) / 2 - cy) ** 2;
        return da - db;
      });
      out.length = maxWays;
      truncated = true;
    }
    return { indices: out, truncated };
  }

  /** way i の量子化bbox [minx, miny, maxx, maxy](デコード不要の軽量アクセサ)。 */
  function bboxOf(i) {
    return [bminx[i], bminy[i], bmaxx[i], bmaxy[i]];
  }

  return { meta, names, count: n, classes, decodeWay, queryBbox, bboxOf };
}
