# 設計 — mapcore / レイヤー機構 / JRB codec / API

japan-map-viewer の設計契約。設計の経緯・受け入れ条件は
[issue #1](https://github.com/opaopa6969/japan-map-viewer/issues/1) を参照。
データの出どころは [data-sources.md](./data-sources.md)。

## 全体像

```
public/js/mapcore/           ← ライブラリ本体(純ESM・依存ゼロ・フレームワーク非依存)
  model.js                   点群モデル(フィルタ/グリッド/地域集約)。レンダラ非依存
  layers.js                  汎用レイヤー機構のコア(spec検証/レジストリ/mover補間/clock)
  fx.js                      画面演出(wipe)
  metrics.js                 指標→コロプレス設定・色ランプ・凡例
  prefectures.js/municipalities.js   point-in-polygon 地域索引
  renderer-2d.js             2D canvas(basemap PNG。WebGL不要)
  renderer-3d.js             three.js 地形(terrain3d.js + heightfield)
  renderer-deck.js           MapLibre + deck.gl(推奨。全機能対応)
lib/                         ← サーバ/スクリプト用(ブラウザには出さない)
  road-codec.mjs             JRBバイナリcodec(encode/decode/グリッド索引)
  osm-pbf.mjs                OSM PBFリーダー(純JS)
server.js                    デモサーバ + データAPI(/api/…)
scripts/fetch-*.mjs          データ取得・変換(それぞれ冒頭に出典コメント)
```

方針: **core(mapcore)はDOM以外の外部依存ゼロ**。MapLibre/deck.gl/three.js は
ホストページがCDN等で読み込み、レンダラ生成時に注入 or グローバル参照する。
suite-contract(game-workspace)の「pure・決定論・headlessテスト」文化を地図に翻訳したもので、
決定論が要る部分(mover補間・レジストリ・codec)は `npm test` でnode単体テストできる。

## 3レンダラ共通のインターフェース

すべてのレンダラ(`createRenderer2D/3D/Deck`)が同じ形を返す:

```
refresh / resize / home / destroy
setLayers({points,grid,choropleth}) / setChoropleth(config)      ← 従来の固定レイヤー(後方互換)
addLayer(spec) / removeLayer(id) / setLayerVisible(id, v)         ← 汎用レイヤー(issue #1)
updateLayerData(id, data) / reorderLayers([ids]) / getLayers()
supportsLayerType(t) / supportsViewMode(m) / maxInsets()          ← 対応宣言(非対応でも落ちない)
projectToScreen(lat, lon)                                         ← HUD/ラベル/ウィンドウ位置決め
focusOn({lat,lon,zoom,pitch,bearing,duration}, {view})            ← カメラ演出
wipe({type,center,duration,direction,onMid,onDone})               ← 画面切り替え演出
setViewMode('north-up'|'heading-up', {track})                     ← ナビ的表示(deckのみheading-up)
addInset(spec) / removeInset(id) / updateInset(id, partial)       ← PiP小窓(deckのみ、最大3)
```

### レイヤーspec(宣言的・JSON往復可能)

関数は `onPick` だけ。`getLayers()` の出力はそのままシリアライズでき、
`fromJSON(arr, bindPicks)` で復元できる(観戦者同期・シーン共有を意図)。

| type | data | 描画(deck / 2D / 3D) |
|---|---|---|
| `network` | nodes+edges(グラフ) | Line+Scatterplot / 線+円 / LineSegments+球 |
| `paths` | ポリラインの束(鉄道・道路) | PathLayer / 線 / LineSegments |
| `extrusion` | 点+value(統計の柱) | ColumnLayer / 円(半径+色) / Cylinder |
| `movers` | route[{lat,lon,t}]の移動体 | Text+Scatterplot / 絵文字 / Sprite(tickHooks) |
| `markers` | 静止アイコン+ラベル | TextLayer / 絵文字 / Sprite |
| `polygons` | ring+height(建物) | SolidPolygonLayer押し出し / 塗り / ExtrudeGeometry |
| `tiles3d` | tileset.json URL(PLATEAU) | Tile3DLayer / **非対応** / **非対応** |

### 時計と決定論

`movers` の位置は `moverPosition(token, clock.now())` の**純関数**で決まる。
clock はレンダラ生成時に注入可能(`opts.clock`、既定は実時計)なので、fake clock で
決定論テスト・リプレイができる。カメラ/画面演出(focusOn/wipe)はブラウザ描画と
同期する必要があるため実時計(rAF)駆動 — fake clock の対象外と割り切る。

### 演出とdrama-engineの接続

focusOn/wipe は「単発コマンド+duration+割り込み(新しい呼び出しが進行中を置き換え)」の
形に揃えてあり、tetsugo では drama-engine の Director の第4ターゲット `camera` として
cue から発火する(tetsugo `src/cues.js` / `public/rail-map.html` が実例)。

## JRB codec("JRB1"、lib/road-codec.mjs)

大規模ジオメトリ(OSM道路/建物)用のバイナリ形式。JSONだと全国道路で数百MBに
なるため、**座標1e5量子化(≈1.1m)+delta+zigzag varint+名前テーブル**で1/10前後に圧縮する。

```
"JRB1" | u32 metaLen | meta JSON
| names(varint count, varint len+utf8 …)
| offsets(u32 × wayCount)
| ways( u8 class | varint nameIdx+1 | [varint value] | varint pointCount | svarint座標列 )
```

- meta.version=2 で `hasValues`(建物高さdm等)を追加。v1ファイルも読める
- `createRoadsEncoder()` はストリーミングエンコード(数百万件でJS配列を溜めない=OOM対策)
- `openRoads(buf)` が読み込み時に1スキャンでbbox配列+グリッド索引(既定0.1°)を構築し、
  `queryBbox()` が交差wayを返す(maxWays超過は `truncated: true` を明示 — 黙って切らない)
- 決定論: 同入力→同バイト列(test/road-codec-test.mjs)

## サーバAPI(server.js)

薄い静的サーバ+データAPI。DBなし、`.jrb`/`.json` をオンメモリに開くだけ。

| endpoint | 中身 |
|---|---|
| `/api/address-points` | エラー住所点群(既定サンプル、`VACANT_SERVICE_URL` でvacantを中継) |
| `/api/railways` `/lines` `/line` `/stations` | 鉄道メタデータ検索(N02、名寄せ済み) |
| `/api/roads` `/meta` | OSM道路のbbox部分配信(JRBオンメモリ) |
| `/api/buildings` `/meta` | OSM建物のbbox部分配信(JRB v2、height=m) |

bbox系は `limit` 付き(既定 roads 4000 / buildings 3000、上限20000)。

## 未実装・既知の割り切り

- PiPは「小さなMapLibre×最大3」方式(deck MultiViewはMapboxOverlay密結合のため見送り)
- heading-up/insetはdeckのみ。2D/3Dは `supports*()` が false を返しフォールバック
- `movers` の高度(alt)はdeckで対応済み(issue #2、2D/3D対応と立体デモが残り)。
  `paths` はdeckが3要素座標`[lon,lat,alt]`を素で受ける
- N06の供用年タイムライン再生は/layers-demoに実装済み(issue #3)
- OSM建物の高さ確定は約10%(残りは既定8m)。実測が欲しい都市はPLATEAUを重ねる
- `/api/elevation`(標高)実装済み。terrain3dの座標写像ズレはissue #6参照
