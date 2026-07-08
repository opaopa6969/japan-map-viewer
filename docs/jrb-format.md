# JRBフォーマット仕様 (JRB1)

**JRB = Japan Roads Binary**。このリポジトリで設計したオリジナルのバイナリフォーマット。
OSM由来の大規模ジオメトリ(道路・建物)を、JSONの1/10前後のサイズで保存・配信し、
サーバのオンメモリ索引とブラウザのGPU直行デコードの両方で読めるようにする。

- エンコーダ/サーバ側デコーダ: [`lib/road-codec.mjs`](../lib/road-codec.mjs)
- ブラウザ側デコーダ(Buffer非依存): [`public/js/mapcore/jrb.js`](../public/js/mapcore/jrb.js)
- テスト: `test/road-codec-test.mjs`(roundtrip/決定論/bbox) + `test/jrb-test.mjs`(クロス検証)

## 設計目標

1. **小さい**: 座標量子化+delta+varintで、全国道路99.5万way=38.7MB、全国建物2,904万棟=792MB
   (JSONならそれぞれ数百MB/数GB)
2. **部分デコード可能**: wayごとのオフセット表を持ち、bboxクエリに合致したwayだけ
   デコードできる(サーバのビューポート配信)
3. **GPU直行**: ブラウザでフラットな型付き配列(positions/startIndices)へ一発変換でき、
   deck.glのbinary attributesにそのまま渡せる(JSON.parseもオブジェクト走査も無し)
4. **決定論**: 同じ入力から同じバイト列(テストで保証)。依存ゼロの純JS

## バイトレイアウト(リトルエンディアン)

```
┌──────────────────────────────────────────────────────────┐
│ magic "JRB1"                                    4 bytes  │
│ metaLen                                         u32 LE   │
│ meta JSON (utf8)                                metaLen  │
├──────────────────────────────────────────────────────────┤
│ 名前テーブル:                                             │
│   nameCount                                     varint   │
│   × { byteLen varint | utf8 bytes }                      │
├──────────────────────────────────────────────────────────┤
│ オフセット表:                                             │
│   offsets[wayCount]                             u32 × n  │
│   (waysセクション先頭からの相対バイト位置)                  │
├──────────────────────────────────────────────────────────┤
│ waysセクション: wayレコードの連続                          │
│   classIdx                                      u8       │
│   nameIdx+1 (0=名無し)                          varint   │
│   [value]   (meta.hasValues時のみ)              varint   │
│   pointCount                                    varint   │
│   lon0, lat0 (絶対値・量子化)                   svarint×2 │
│   × { dLon, dLat (直前点とのdelta) }            svarint×2 │
└──────────────────────────────────────────────────────────┘
```

- **varint**: LEB128(7bitずつ、最上位bit=継続)。JSのNumberで扱える範囲(2^53)に収まる値のみ
- **svarint**: zigzagエンコード(`n>=0 ? 2n : -2n-1`)したvarint。負のdeltaを短く保つ
- **量子化**: 座標×1e5を四捨五入した整数(分解能≈1.1m)。`meta.quant`に記録

## meta JSON

| キー | 型 | 説明 |
|---|---|---|
| version | number | 1: 初版 / 2: hasValues・totalPoints追加 |
| region | string | 生成単位(japan/kanto/…/query=APIレスポンス) |
| source | string | 出典表記(© OpenStreetMap contributors 等) |
| quant | number | 量子化係数(1e5) |
| classLabels | string[] | classIdx→ラベル(道路種別/`['building']`等) |
| wayCount | number | way数 |
| nameCount | number | 名前テーブル件数(重複排除済み) |
| totalPoints | number? | 全wayの総点数。**v2で追加・旧ファイルは無し** — デコーダは無ければ1パス走査で数えるフォールバック必須 |
| hasValues | bool? | trueならwayレコードにvalue(varint)が入る(建物高さdm等) |
| (任意) | | `extraMeta`で追加可(APIレスポンスの`truncated`/`radius`等) |

## 後方互換の規則

- v1ファイル(hasValues無し)はv2デコーダでそのまま読める(value=0扱い)
- `totalPoints`が無い場合はフォールバック走査(実測バグ: 無視すると頂点0で建物が消える)
- 未知のmetaキーは無視する
- magicが`JRB1`でなければ即エラー(黙って誤読しない)

## 実装上の限界

| 項目 | 限界 | 根拠 |
|---|---|---|
| waysセクションのサイズ | 4GB | offsetsがu32 |
| 1wayの点数 | 実質無制限(varint) | ただし用途上は数千点まで |
| value | 0〜2^53 | varint(建物高さdmは65535でクランプ) |
| 座標範囲 | ±21,474°(int32量子化) | 地球は±180°なので余裕 |

**deck.gl側の限界(フォーマット外の教訓)**: 1枚のSolidPolygonLayerに約600万頂点超を
入れると壁面ジオメトリのインデックスが巻き戻り巨大三角形が出る(全国29M棟で実測)。
レンダラ側でチャンク分割する(renderer-deck.jsは600万頂点/レイヤーで自動分割)。

## 配信経路

1. **静的ファイル**: `data/osm-{roads,buildings}-<region>.jrb`(gitignore)。
   スナップショットは[GitHub Release data-v1](https://github.com/opaopa6969/japan-map-viewer/releases/tag/data-v1)、
   取得は `npm run fetch:snapshot`
2. **bbox部分配信**: `/api/{roads,buildings}?bbox=…&format=bin` — サーバがオンメモリの
   グリッド索引(注視点優先)で選んだwayをJRBに**再エンコード**して返す(gzip)
3. **region直送**: `/api/buildings/region/<region>` — ファイル丸ごと
   (gzは初回生成でディスクキャッシュ。全関東0.14秒/全国478MB)

## 実測(2026-07-08、RTX 4090 / Ryzen 9 7950X)

| データ | way数 | 点数 | JRB | gz | ブラウザデコード |
|---|---|---|---|---|---|
| 全国道路(幹線) | 994,822 | 1,151万 | 38.7MB | 30MB | — |
| 関東建物 | 6,108,323 | 4,073万 | 170MB | 96MB | 2.0秒 |
| 全国建物 | 29,043,370 | 1.86億 | 791.7MB | 479MB | 〜10秒 |

デコード後、deck.gl binary attributesで関東611万棟(4,073万頂点)をFPS 60で描画できる
(針・三角形化・チャンク分割の教訓は [design.md](./design.md) とissue #1のベンチコメント参照)。
