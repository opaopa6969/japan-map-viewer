# japan-map-viewer 🗾

日本地図ビューア — 住所点群・コロプレス(都道府県/市区町村)・自治体統廃合タイムラインを描く
**純ESM・依存ゼロ**のライブラリ+デモ。tetsugo(鉄道すごろく)から地図部分を切り出したもので、
[tetsugo](https://github.com/opaopa6969/tetsugo) と vacant-service の両方から使う。

## 使い方(デモ)

```bash
npm start                  # http://localhost:8091/
npm run fetch:basemap      # 2D canvas 版に必要な basemap(png+投影パラメータ)を生成
```

外部依存なし(`dependencies` 空)。GL 版(MapLibre + deck.gl)は CDN 読み込みなので
`npm start` だけで動く。住所点群は既定で同梱サンプル、`VACANT_SERVICE_URL` を設定すると
vacant-service の `/api/errorAddresses/geo` をプロキシして実データを表示する。

```bash
VACANT_SERVICE_URL=http://localhost:8080 npm start
```

## 構成

| パス | 役割 |
|---|---|
| `public/js/mapcore/model.js` | 点群モデル(カテゴリ・フィルタ・可視判定)。レンダラ非依存 |
| `public/js/mapcore/metrics.js` | 指標(空き家率・地価平均等)→コロプレス設定・色ランプ・凡例 |
| `public/js/mapcore/prefectures.js` / `municipalities.js` | ポリゴン索引(名寄せ・point-in-polygon) |
| `public/js/mapcore/renderer-2d.js` | 2D canvas レンダラ(要 basemap 生成) |
| `public/js/mapcore/renderer-deck.js` | MapLibre + deck.gl レンダラ(GSI/CARTO タイル直接参照) |
| `public/js/mapcore/renderer-3d.js` | 3D 地形レンダラ。**terrain 資産はホスト注入**(`terrain3dUrl`/`terrainBase`) |
| `public/data/*.json` | 都道府県/市区町村ポリゴン・地価・空き家率・統廃合データ(コミット済み) |
| `scripts/fetch-*.mjs` | 実データ取得(国土数値情報・e-Stat・地価公示・GSIタイル) |
| `scripts/build-*.mjs` | 派生データ生成(統廃合 JSON・サンプル点群) |
| `server.js` | デモ用の薄い静的サーバ + `/api/address-points`(vacant プロキシ) |

## デモページ

- `/address-map-gl` — 住所マップ GL(点群/hex/heat + コロプレス)
- `/address-map` — 住所マップ 2D canvas(3D はホストに terrain があれば有効)
- `/municipality-map` — 市区町村コロプレス
- `/municipality-timeline` — 自治体統廃合のタイムライン再生

## 利用側(host)からの使い方

**tetsugo**: `npm run vendor` が本リポジトリ(`../japan-map-viewer`)から
`public/js/mapcore/`・デモページ・`public/data/` をコピーする(他 engine と同じ vendor 方式)。
3D は tetsugo 側の `terrain3d.js` + `/terrain/` が注入されて有効になる。

**vacant-service**: `/api/errorAddresses/geo` を実装済み。エラー住所の可視化 UI として
このビューアを静的配信するか、`VACANT_SERVICE_URL` プロキシ経由で使う。

ライブラリとして使う最小形:

```js
import { createMapModel } from '/js/mapcore/model.js';
import { createRendererDeck } from '/js/mapcore/renderer-deck.js';

const model = createMapModel(await (await fetch('/api/address-points')).json());
const renderer = createRendererDeck(container, { model, onPick });
```

## データ出典

国土数値情報(行政区域)・e-Stat(住宅・土地統計/市区町村配置分合)・地価公示・地理院タイル・CARTO。
詳細は各 fetch スクリプト冒頭のコメントを参照。
