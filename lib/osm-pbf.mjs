// lib/osm-pbf.mjs — OpenStreetMap PBF(.osm.pbf)の純JSリーダー(依存ゼロ)。
// 道路抽出に必要な最小限だけ実装する: Blob展開(zlib)・PrimitiveBlock・
// DenseNodes(座標)・Way(タグ+ノード参照)。リレーションは読まない。
//
// フォーマット参照: https://wiki.openstreetmap.org/wiki/PBF_Format
//   file   = repeated [ u32be len | BlobHeader | Blob ]
//   BlobHeader: 1=type(string) 3=datasize(varint)
//   Blob:       1=raw(bytes) 3=zlib_data(bytes)
//   PrimitiveBlock: 1=stringtable 2=primitivegroup(rep) 17=granularity 19=lat_offset 20=lon_offset
//   PrimitiveGroup: 2=dense(DenseNodes) 3=ways(rep Way)
//   DenseNodes: 1=id(packed sint64 delta) 8=lat 9=lon(packed sint64 delta)
//   Way: 2=keys(packed u32) 3=vals(packed u32) 8=refs(packed sint64 delta)
//
// 数値はJSのNumberで扱う(OSMのid/座標ナノ度は2^53未満なので安全)。

import { createReadStream } from 'node:fs';
import { inflateSync } from 'node:zlib';

// --- protobuf wire helpers -------------------------------------------------------
function readVarint(buf, pos) {
  let v = 0;
  let shift = 1;
  for (;;) {
    const b = buf[pos++];
    v += (b & 0x7f) * shift;
    if (b < 0x80) return [v, pos];
    shift *= 128;
  }
}
const zigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

/** メッセージを走査し fieldNo ごとにコールバック。wireType2はBufferスライスを渡す。 */
function scanMessage(buf, start, end, onField) {
  let pos = start;
  while (pos < end) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      onField(field, v, null);
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      onField(field, null, { start: pos, end: pos + len });
      pos += len;
    } else if (wire === 5) { onField(field, buf.readUInt32LE(pos), null); pos += 4; } else if (wire === 1) { pos += 8; } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

function packedVarints(buf, { start, end }, cb) {
  let pos = start;
  while (pos < end) {
    let v;
    [v, pos] = readVarint(buf, pos);
    cb(v);
  }
}

// --- ブロック列挙 ------------------------------------------------------------------
/** .osm.pbf の OSMData ブロック(展開済みBuffer)を順に yield する。 */
export async function* osmDataBlocks(file) {
  const stream = createReadStream(file);
  let pending = Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    pending = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    chunks.length = 0;
    chunks.push(pending);
    // pending からブロックを取り出せるだけ取り出す
    let off = 0;
    for (;;) {
      if (pending.length - off < 4) break;
      const headerLen = pending.readUInt32BE(off);
      if (pending.length - off < 4 + headerLen) break;
      // BlobHeader: type / datasize
      let type = '';
      let datasize = 0;
      scanMessage(pending, off + 4, off + 4 + headerLen, (f, v, slice) => {
        if (f === 1 && slice) type = pending.toString('ascii', slice.start, slice.end);
        if (f === 3 && v != null) datasize = v;
      });
      if (pending.length - off < 4 + headerLen + datasize) break;
      const blobStart = off + 4 + headerLen;
      if (type === 'OSMData') {
        let raw = null;
        let zdata = null;
        scanMessage(pending, blobStart, blobStart + datasize, (f, v, slice) => {
          if (f === 1 && slice) raw = pending.subarray(slice.start, slice.end);
          if (f === 3 && slice) zdata = pending.subarray(slice.start, slice.end);
        });
        yield zdata ? inflateSync(zdata) : raw;
      }
      off = blobStart + datasize;
    }
    if (off > 0) {
      pending = pending.subarray(off);
      chunks.length = 0;
      chunks.push(pending);
    }
  }
}

// --- PrimitiveBlock 解析 ------------------------------------------------------------
/**
 * ブロックから Way を列挙: cb({ tags: (key)=>value|null, refs: Float64Array })
 * tags はブロックの stringtable を引く遅延アクセサ。
 */
export function scanWays(block, cb) {
  let strtabSlice = null;
  const groups = [];
  scanMessage(block, 0, block.length, (f, v, slice) => {
    if (f === 1 && slice) strtabSlice = slice;
    if (f === 2 && slice) groups.push(slice);
  });
  if (!strtabSlice) return;
  // stringtable: 全文字列をデコード(ブロックあたり数千〜数万)
  const strings = [];
  scanMessage(block, strtabSlice.start, strtabSlice.end, (f, v, slice) => {
    if (f === 1 && slice) strings.push(block.toString('utf8', slice.start, slice.end));
  });
  for (const g of groups) {
    const ways = [];
    scanMessage(block, g.start, g.end, (f, v, slice) => {
      if (f === 3 && slice) ways.push(slice);
    });
    for (const w of ways) {
      let keysSlice = null;
      let valsSlice = null;
      let refsSlice = null;
      scanMessage(block, w.start, w.end, (f, v, slice) => {
        if (f === 2 && slice) keysSlice = slice;
        if (f === 3 && slice) valsSlice = slice;
        if (f === 8 && slice) refsSlice = slice;
      });
      if (!refsSlice) continue;
      const keys = [];
      const vals = [];
      if (keysSlice) packedVarints(block, keysSlice, (x) => keys.push(x));
      if (valsSlice) packedVarints(block, valsSlice, (x) => vals.push(x));
      const tag = (name) => {
        for (let i = 0; i < keys.length; i++) if (strings[keys[i]] === name) return strings[vals[i]] ?? null;
        return null;
      };
      const refs = [];
      let acc = 0;
      packedVarints(block, refsSlice, (x) => { acc += zigzag(x); refs.push(acc); });
      cb({ tag, refs });
    }
  }
}

/**
 * ブロックから DenseNodes を列挙: cb(id, latNano, lonNano)
 * latNano/lonNano は granularity/offset 適用済みのナノ度(1e-9度)整数。
 */
export function scanDenseNodes(block, cb) {
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;
  const groups = [];
  scanMessage(block, 0, block.length, (f, v, slice) => {
    if (f === 17 && v != null) granularity = v;
    if (f === 19 && v != null) latOffset = v;
    if (f === 20 && v != null) lonOffset = v;
    if (f === 2 && slice) groups.push(slice);
  });
  for (const g of groups) {
    let dense = null;
    scanMessage(block, g.start, g.end, (f, v, slice) => {
      if (f === 2 && slice) dense = slice;
    });
    if (!dense) continue;
    let idsSlice = null;
    let latSlice = null;
    let lonSlice = null;
    scanMessage(block, dense.start, dense.end, (f, v, slice) => {
      if (f === 1 && slice) idsSlice = slice;
      if (f === 8 && slice) latSlice = slice;
      if (f === 9 && slice) lonSlice = slice;
    });
    if (!idsSlice || !latSlice || !lonSlice) continue;
    const ids = [];
    const lats = [];
    const lons = [];
    let a = 0;
    packedVarints(block, idsSlice, (x) => { a += zigzag(x); ids.push(a); });
    let b = 0;
    packedVarints(block, latSlice, (x) => { b += zigzag(x); lats.push(b); });
    let c = 0;
    packedVarints(block, lonSlice, (x) => { c += zigzag(x); lons.push(c); });
    for (let i = 0; i < ids.length; i++) {
      cb(ids[i], latOffset + granularity * lats[i], lonOffset + granularity * lons[i]);
    }
  }
}
