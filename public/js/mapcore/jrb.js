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

  /** ヘッダ+先頭点(アンカー座標・量子化int)を読む。空間チャンク割当用。 */
  function wayMeta(i) {
    let p = waysStart + offsets[i];
    const cls = u8[p++];
    let nIdx;
    [nIdx, p] = readVarint(u8, p);
    let value = 0;
    if (hasValues) [value, p] = readVarint(u8, p);
    let count;
    [count, p] = readVarint(u8, p);
    let v;
    [v, p] = readVarint(u8, p);
    const x0 = zigzag(v);
    [v, p] = readVarint(u8, p);
    const y0 = zigzag(v);
    return { cls, nameIdx: nIdx - 1, value, count, x0, y0 };
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

  return { meta, names, count: meta.wayCount, decodeWay, forEachWay, headerOf, wayMeta };
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
// Mortonコード(Z階数曲線): gx,gyのbitを交互に編む。行順(緯度帯)だとチャンクが
// 日本を横断する細長い帯になり街ビューでも6〜7チャンク掛かる(実測36M頂点)。
// Z順なら近傍セルが正方形ブロックに固まり、街ビューは1〜3チャンクで済む。
function mortonOf(gx, gy) {
  let code = 0;
  for (let b = 0; b < 14; b++) {
    code += ((gx >> b) & 1) * Math.pow(2, 2 * b) + ((gy >> b) & 1) * Math.pow(2, 2 * b + 1);
  }
  return code;
}

export function jrbToBuildingChunks(data, { defaultHeight = 0, maxVerts = 1500000, withNames = true, spatial = true, cellDeg = 0.1 } = {}) {
  const jrb = decodeJrb(data);
  const { meta, names } = jrb;
  const quant = meta.quant || 1e5;
  const n = meta.wayCount;

  // パス1: ヘッダ+アンカー点(空間セル割当)。offsets表があるのでO(n)・座標全走査なし
  const counts = new Uint32Array(n);
  const cellOf = new Float64Array(n);   // cellId(整数だが範囲が広いのでf64)
  let totalPoints = 0;
  const cellQ = Math.round(cellDeg * quant);
  const cellVerts = new Map();          // cellId -> 頂点数
  for (let i = 0; i < n; i++) {
    const m = jrb.wayMeta(i);
    counts[i] = m.count;
    totalPoints += m.count;
    let cid = 0;
    if (spatial) {
      const gx = Math.floor(m.x0 / cellQ) + 4000;
      const gy = Math.floor(m.y0 / cellQ) + 4000;
      cid = gx * 100000 + gy;
    }
    cellOf[i] = cid;
    cellVerts.set(cid, (cellVerts.get(cid) || 0) + m.count);
  }

  if (n === 0) return { chunks: [], meta, totalPoints: 0, count: 0 };

  // セルをMorton順(Z階数曲線)に並べ、way列をセル順に再配列(counting sort・O(n))。
  // その順でway単位に頂点予算の貪欲詰め — 近傍セルが正方形ブロックに束ねられ、
  // 予算超過の巨大セルも正しく複数チャンクへ割れる(セル内はファイル順を保つ)
  const cellIds = [...cellVerts.keys()].sort((a, b) => {
    const ma = mortonOf(Math.floor(a / 100000), a % 100000);
    const mb = mortonOf(Math.floor(b / 100000), b % 100000);
    return ma - mb;
  });
  const rankOf = new Map();
  cellIds.forEach((cid, r) => rankOf.set(cid, r));
  const cursor = new Uint32Array(cellIds.length + 1);
  for (let i = 0; i < n; i++) cursor[rankOf.get(cellOf[i]) + 1]++;
  for (let r = 0; r < cellIds.length; r++) cursor[r + 1] += cursor[r];
  const orderBuf = new Uint32Array(n);
  for (let i = 0; i < n; i++) orderBuf[cursor[rankOf.get(cellOf[i])]++] = i;
  const wayChunk = new Uint32Array(n);
  let nChunks = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const i = orderBuf[k];
    const v = counts[i];
    if (acc > 0 && acc + v > maxVerts) { nChunks++; acc = 0; }
    wayChunk[i] = nChunks;
    acc += v;
  }
  nChunks++;

  // チャンクごとの確保(サイズは事前集計で正確に)
  const cWays = new Uint32Array(nChunks);
  const cVerts = new Uint32Array(nChunks);
  for (let i = 0; i < n; i++) {
    const ch = wayChunk[i];
    cWays[ch]++;
    cVerts[ch] += counts[i];
  }
  const chunks = [];
  let baseAcc = 0;
  for (let ci = 0; ci < nChunks; ci++) {
    chunks.push({
      base: baseAcc, length: cWays[ci],
      startIndices: new Uint32Array(cWays[ci] + 1),
      positions: new Float64Array(cVerts[ci] * 2),
      heightsV: new Float32Array(cVerts[ci]),
      heights: new Float32Array(cWays[ci]),
      names: withNames ? new Array(cWays[ci]) : null,
      bbox: null,
      _mnx: Infinity, _mny: Infinity, _mxx: -Infinity, _mxy: -Infinity,
    });
    baseAcc += cWays[ci];
  }
  const wCur = new Uint32Array(nChunks);
  const vCur = new Uint32Array(nChunks);

  // パス2: 1回の走査で各チャンクへ充填(winding CW正規化+チャンクbbox集計込み)
  jrb.forEachWay((i, cls, nameIdx, value, count, readDelta) => {
    const ci = wayChunk[i];
    const ch = chunks[ci];
    const li = wCur[ci]++;
    const vp = vCur[ci];
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
      if (x < ch._mnx) ch._mnx = x;
      if (y < ch._mny) ch._mny = y;
      if (x > ch._mxx) ch._mxx = x;
      if (y > ch._mxy) ch._mxy = y;
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
    vCur[ci] = vp + count;
  });
  for (let ci = 0; ci < nChunks; ci++) {
    const ch = chunks[ci];
    ch.startIndices[ch.length] = vCur[ci];
    if (ch._mnx !== Infinity) {
      ch.bbox = [ch._mnx / quant, ch._mny / quant, ch._mxx / quant, ch._mxy / quant];
    }
    delete ch._mnx; delete ch._mny; delete ch._mxx; delete ch._mxy;
  }

  return { chunks, meta, totalPoints, count: n };
}
