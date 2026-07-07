# japan-map-viewer 🗾

日本地図ビューア — 住所点群・コロプレス(都道府県/市区町村)・自治体統廃合タイムラインを描く
**純ESM・依存ゼロ**のライブラリ+デモ。tetsugo(鉄道すごろく)から地図部分(mapcore/basemap/terrain3d)を
切り出したもので、vacant-service から使う。

## 使い方(デモ)

```bash
npm start                  # http://localhost:8091/
npm run fetch:basemap      # 2D canvas 版に必要な basemap(png+投影パラメータ)を生成
npm run fetch:terrain      # 3D 地形版に必要な heightfield/texture を生成(地理院DEM由来)
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
| `public/js/mapcore/layers.js` | **汎用レイヤー機構のコア**(spec検証・レジストリ・mover補間。純JS・`npm test` 対象) |
| `public/js/mapcore/fx.js` | 画面演出(wipe)の共通実装 |
| `public/js/mapcore/renderer-2d.js` | 2D canvas レンダラ(要 basemap 生成) |
| `public/js/mapcore/renderer-deck.js` | MapLibre + deck.gl レンダラ(GSI/CARTO タイル直接参照) |
| `public/js/mapcore/renderer-3d.js` | 3D 地形レンダラ。`terrain3dUrl`/`terrainBase` で差し替え可(既定は同梱) |
| `public/js/terrain3d.js` | 3D 地形ビューア本体(three.js)。`public/terrain/*.heightfield.json` を読む |
| `public/data/*.json` | 都道府県/市区町村ポリゴン・地価・空き家率・統廃合データ(コミット済み) |
| `scripts/fetch-*.mjs` | 実データ取得(国土数値情報・e-Stat・地価公示・GSIタイル・地理院DEM) |
| `scripts/build-*.mjs` | 派生データ生成(統廃合 JSON・サンプル点群) |
| `server.js` | デモ用の薄い静的サーバ + `/api/address-points`(vacant プロキシ) |

## デモページ

- `/layers-demo` — **汎用レイヤー/演出デモ**(路線network・電車movers・人口柱extrusion・
  markers・クリック詳細・PiP・focusOn・wipe・heading-up)
- `/address-map-gl` — 住所マップ GL(点群/hex/heat + コロプレス)
- `/address-map` — 住所マップ 2D canvas / 3D 地形(`npm run fetch:terrain` 済みなら有効)
- `/municipality-map` — 市区町村コロプレス
- `/municipality-timeline` — 自治体統廃合のタイムライン再生

## 汎用レイヤーAPI(issue #1)

3レンダラ共通で、地図の上に任意のレイヤーを宣言的に積める:

```js
const renderer = createRendererDeck(el, { clock });   // clock 注入可(既定は実時計)

renderer.addLayer({
  id: 'rail', type: 'network',        // network | extrusion | movers | markers
  zIndex: 1, visible: true,
  data: { nodes: [{id, lat, lon, label}], edges: [{from, to}] },
  style: { edgeColor: '#5a8ac0', showLabels: true },
  pickable: true,
  onPick: (feature, { layerId, x, y }) => { /* 詳細ウィンドウはhost側で */ },
});
renderer.setLayerVisible('rail', false);
renderer.updateLayerData('rail', newData);
renderer.reorderLayers(['pop', 'rail']);              // z-order
renderer.getLayers();                                  // onPick を除きJSON往復可能
renderer.supportsLayerType('movers');                  // レンダラごとの対応宣言
```

type別 data: `network`(nodes+edges) / `extrusion`(points+value → 柱。2Dは円に
フォールバック) / `movers`(tokens+route[{lat,lon,t}] → clock で線形補間して毎フレーム
移動。`loop: true` で周回) / `markers`(絵文字アイコン+ラベルの静止点)。

カメラ演出・表示モード・PiP:

```js
renderer.focusOn({ lat, lon, zoom, pitch, duration });   // 注目演出(inset対象指定も可)
renderer.wipe({ type: 'circle', direction: 'inout', onMid });  // 画面切り替え
renderer.setViewMode('heading-up', { track: 'train-1' });      // ナビ的追従(deckのみ)
renderer.projectToScreen(lat, lon);                       // 地図座標→画面(HUD/ラベル用)
renderer.addInset({ id: 'chase', rect: {x,y,w,h},        // PiP小窓(レイヤーは共有・カメラ独立)
                    camera: { track: 'train-1', zoom: 8.5 }, viewMode: 'heading-up' });
```

対応状況: deck=全部 / 3D=レイヤー4種+focusOn+wipe(movers は terrain3d の tickHooks を
正式化) / 2D=レイヤー4種(extrusionは円)+focusOn+wipe。inset と heading-up は deck のみ
(`maxInsets()`/`supportsViewMode()` で宣言、非対応でもクラッシュしない)。
PiP の実装は issue #1 想定の deck MultiView ではなく「小さな MapLibre を最大3個」方式
(MapboxOverlay interleaved がベース地図と密結合のため。コンテキスト上限は maxInsets=3 で保護)。

## 利用側(host)からの使い方

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
