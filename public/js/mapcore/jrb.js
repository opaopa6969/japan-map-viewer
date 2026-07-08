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

  return { meta, names, count: meta.wayCount, decodeWay, forEachWay };
}

/**
 * 建物用: JRBを deck.gl SolidPolygonLayer の binary attributes へ一発変換する。
 * 返り値: { length, startIndices: Uint32Array, positions: Float64Array(2*totalPoints),
 *           heights: Float32Array(m), names: (string|null)[], meta }
 * リングは _windingOrder 既定(CW)に合わせて向きを正規化する(押し出しの側面が欠けないように)。
 */
export function jrbToBuildingBinary(data) {
  const jrb = decodeJrb(data);
  const { meta, names } = jrb;
  const quant = meta.quant || 1e5;
  const n = meta.wayCount;
  const total = meta.totalPoints || 0;
  const positions = new Float64Array(total * 2);
  const startIndices = new Uint32Array(n + 1);
  const heights = new Float32Array(n);
  const outNames = new Array(n);
  let vp = 0;   // 頂点書き込み位置(点単位)
  jrb.forEachWay((i, cls, nameIdx, value, count, readDelta) => {
    startIndices[i] = vp;
    heights[i] = value / 10;   // dm -> m
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
  return { length: n, startIndices, positions, heights, names: outNames, meta };
}
