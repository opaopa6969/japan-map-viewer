// mapcore/jrb.js — JRBバイナリ(lib/road-codec.mjs "JRB1")のブラウザ側デコーダ。
// Node Buffer非依存(Uint8Array+TextDecoder)なのでブラウザ/nodeどちらでも動く。
// 用途: /api/buildings?format=bin 等のバイナリ配信を受け取り、deck.glの
// binary attributes(フラットな型付き配列)へ直行させる — 100万棟級で
// JSON.parse(250MB)とオブジェクト走査を丸ごとスキップするための経路。

const td = new TextDecoder();

function readVarint(u8, pos) {
  let v = 0;
  let shift = 1;
  for (;;) {
    const b = u8[pos++];
    v += (b & 0x7f) * shift;
    if (b < 0x80) return [v, pos];
    shift *= 128;
  }
}
const zigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

/**
 * JRBバイナリをデコードして低レベルハンドルを返す。
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{ meta, names: string[], count, decodeWay(i), forEachWay(cb) }}
 */
export function decodeJrb(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== 'JRB1') throw new Error('not a JRB1 buffer');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const metaLen = dv.getUint32(4, true);
  const meta = JSON.parse(td.decode(u8.subarray(8, 8 + metaLen)));
  const quant = meta.quant || 1e5;
  let pos = 8 + metaLen;

  let nameCount;
  [nameCount, pos] = readVarint(u8, pos);
  const names = new Array(nameCount);
  for (let i = 0; i < nameCount; i++) {
    let len;
    [len, pos] = readVarint(u8, pos);
    names[i] = td.decode(u8.subarray(pos, pos + len));
    pos += len;
  }

  const offsets = new Uint32Array(meta.wayCount);
  for (let i = 0; i < meta.wayCount; i++) { offsets[i] = dv.getUint32(pos, true); pos += 4; }
  const waysStart = pos;
  const hasValues = !!meta.hasValues;

  /** 全wayを1パスで走査: cb(i, cls, nameIdx0based|-1, value, pointCount, readPoint(j)->[x,y]量子化int) */
  function forEachWay(cb) {
    let p = waysStart;
    for (let i = 0; i < meta.wayCount; i++) {
      p = waysStart + offsets[i];
      const cls = u8[p++];
      let nIdx;
      [nIdx, p] = readVarint(u8, p);
      let value = 0;
      if (hasValues) [value, p] = readVarint(u8, p);
      let count;
      [count, p] = readVarint(u8, p);
      cb(i, cls, nIdx - 1, value, count, () => {
        let v;
        [v, p] = readVarint(u8, p);
        const dx = zigzag(v);
        [v, p] = readVarint(u8, p);
        const dy = zigzag(v);
        return [dx, dy];   // delta(初回は絶対値)
      });
    }
  }

  function decodeWay(i) {
    let p = waysStart + offsets[i];
    const cls = u8[p++];
    let nIdx;
    [nIdx, p] = readVarint(u8, p);
    let value = 0;
    if (hasValues) [value, p] = readVarint(u8, p);
    let count;
    [count, p] = readVarint(u8, p);
    const coords = new Array(count);
    let x = 0;
    let y = 0;
    for (let j = 0; j < count; j++) {
      let v;
      [v, p] = readVarint(u8, p);
      x += zigzag(v);
      [v, p] = readVarint(u8, p);
      y += zigzag(v);
      coords[j] = [x / quant, y / quant];
    }
    return { class: cls, name: nIdx ? names[nIdx - 1] : null, value, coords };
  }

  /** ヘッダだけ読む(offsets表で直ジャンプ、座標は読まない)。チャンク計画用。 */
  function headerOf(i) {
    let p = waysStart + offsets[i];
    const cls = u8[p++];
    let nIdx;
    [nIdx, p] = readVarint(u8, p);
    let value = 0;
    if (hasValues) [value, p] = readVarint(u8, p);
    let count;
    [count, p] = readVarint(u8, p);
    return { cls, nameIdx: nIdx - 1, value, count };
  }

  return { meta, names, count: meta.wayCount, decodeWay, forEachWay, headerOf };
}

/**
 * 建物用: JRBを deck.gl SolidPolygonLayer の binary attributes へ一発変換する。
 * 返り値: { length, startIndices: Uint32Array, positions: Float64Array(2*totalPoints),
 *           heights: Float32Array(m), names: (string|null)[], meta }
 * リングは _windingOrder 既定(CW)に合わせて向きを正規化する(押し出しの側面が欠けないように)。
 */
export function jrbToBuildingBinary(data, { defaultHeight = 0 } = {}) {
  const jrb = decodeJrb(data);
  const { meta, names } = jrb;
  const quant = meta.quant || 1e5;
  const n = meta.wayCount;
  let total = meta.totalPoints || 0;
  if (!total) {
    // 旧ファイル(totalPoints導入前)互換: 1パスで数える(座標は読まないので軽い)
    jrb.forEachWay((i, cls, nameIdx, value, count) => { total += count; });
  }
  const positions = new Float64Array(total * 2);
  const startIndices = new Uint32Array(n + 1);
  const heights = new Float32Array(n);          // 建物ごと(統計/クリック用)
  const heightsV = new Float32Array(total);     // 頂点ごと(deckのbinary attributeはこちら!
                                                //  建物ごと配列を渡すと頂点が他建物の高さを
                                                //  読んで「針」が生える — 実測バグの教訓)
  const outNames = new Array(n);
  let vp = 0;   // 頂点書き込み位置(点単位)
  jrb.forEachWay((i, cls, nameIdx, value, count, readDelta) => {
    startIndices[i] = vp;
    const hM = value > 0 ? value / 10 : defaultHeight;   // dm -> m(0は既定値へ)
    heights[i] = hM;
    heightsV.fill(hM, vp, vp + count);
    outNames[i] = nameIdx >= 0 ? names[nameIdx] : null;
    const base = vp * 2;
    let x = 0;
    let y = 0;
    let area2 = 0;   // 符号付き面積×2(shoelace) — 向き判定
    for (let j = 0; j < count; j++) {
      const [dx, dy] = readDelta();
      const px = x;
      const py = y;
      x += dx;
      y += dy;
      positions[base + j * 2] = x / quant;
      positions[base + j * 2 + 1] = y / quant;
      if (j > 0) area2 += (px * y - x * py);
    }
    // CCW(area2>0)ならCWへ反転(deck SolidPolygonLayer _windingOrder 既定に合わせる)
    if (area2 > 0) {
      for (let a = 0, b = count - 1; a < b; a++, b--) {
        const ax = positions[base + a * 2];
        const ay = positions[base + a * 2 + 1];
        positions[base + a * 2] = positions[base + b * 2];
        positions[base + a * 2 + 1] = positions[base + b * 2 + 1];
        positions[base + b * 2] = ax;
        positions[base + b * 2 + 1] = ay;
      }
    }
    vp += count;
  });
  startIndices[n] = vp;
  return { length: n, startIndices, positions, heights, heightsV, names: outNames, meta };
}

/**
 * 建物用・チャンク分割版: 全国2,900万棟級で positions 3GB の一枚岩確保が
 * ChromeのArrayBuffer上限で失敗するため、maxVerts(既定600万頂点)ごとの
 * 独立チャンク(各~100MB)としてデコードする。deckレンダラはchunksをそのまま
 * レイヤー分割に使う。1パス目=ヘッダのみで点数収集(offsets表でO(n))、
 * 2パス目=1回のforEachWayで各チャンクへ充填(二度デコードしない)。
 * @returns { chunks: [{base, length, startIndices, positions, heightsV, heights, names}], meta, totalPoints }
 */
export function jrbToBuildingChunks(data, { defaultHeight = 0, maxVerts = 6000000, withNames = true } = {}) {
  const jrb = decodeJrb(data);
  const { meta, names } = jrb;
  const quant = meta.quant || 1e5;
  const n = meta.wayCount;

  // パス1: 点数だけ(ヘッダ直読み)
  const counts = new Uint32Array(n);
  let totalPoints = 0;
  for (let i = 0; i < n; i++) {
    counts[i] = jrb.headerOf(i).count;
    totalPoints += counts[i];
  }

  // チャンク境界(頂点予算で切る)
  const bounds = [0];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (acc + counts[i] > maxVerts && acc > 0) { bounds.push(i); acc = 0; }
    acc += counts[i];
  }
  bounds.push(n);

  // チャンクごとに正確なサイズで確保
  const chunks = [];
  for (let ci = 0; ci < bounds.length - 1; ci++) {
    const s = bounds[ci];
    const e = bounds[ci + 1];
    let verts = 0;
    for (let i = s; i < e; i++) verts += counts[i];
    chunks.push({
      base: s, length: e - s,
      startIndices: new Uint32Array(e - s + 1),
      positions: new Float64Array(verts * 2),
      heightsV: new Float32Array(verts),
      heights: new Float32Array(e - s),
      names: withNames ? new Array(e - s) : null,
    });
  }

  // パス2: 1回の走査で充填(winding CW正規化込み)
  let ci = 0;
  let vp = 0;   // 現チャンク内の頂点位置
  jrb.forEachWay((i, cls, nameIdx, value, count, readDelta) => {
    if (i >= bounds[ci + 1]) { ci++; vp = 0; }
    const ch = chunks[ci];
    const li = i - ch.base;
    ch.startIndices[li] = vp;
    const hM = value > 0 ? value / 10 : defaultHeight;
    ch.heights[li] = hM;
    ch.heightsV.fill(hM, vp, vp + count);
    if (ch.names) ch.names[li] = nameIdx >= 0 ? names[nameIdx] : null;
    const base = vp * 2;
    const pos = ch.positions;
    let x = 0;
    let y = 0;
    let area2 = 0;
    for (let j = 0; j < count; j++) {
      const [dx, dy] = readDelta();
      const px = x;
      const py = y;
      x += dx;
      y += dy;
      pos[base + j * 2] = x / quant;
      pos[base + j * 2 + 1] = y / quant;
      if (j > 0) area2 += (px * y - x * py);
    }
    if (area2 > 0) {
      for (let a = 0, b = count - 1; a < b; a++, b--) {
        const ax = pos[base + a * 2];
        const ay = pos[base + a * 2 + 1];
        pos[base + a * 2] = pos[base + b * 2];
        pos[base + a * 2 + 1] = pos[base + b * 2 + 1];
        pos[base + b * 2] = ax;
        pos[base + b * 2 + 1] = ay;
      }
    }
    vp += count;
    if (li === ch.length - 1) ch.startIndices[ch.length] = vp;
  });

  return { chunks, meta, totalPoints, count: n };
}
