# データソースカタログ

このプロダクトが使う全データの出どころ・ライセンス・形式・このプロダクトでの使い方の一覧。
新しいデータを足すときはここに1行増やすこと(fetchスクリプト冒頭の出典コメントと二重管理に
なるが、横断で見られる場所はここだけ)。

## 一覧(サマリ)

| # | データ | 提供元 | ライセンス/条件 | 取得 | 手元の形 | 配信 |
|---|---|---|---|---|---|---|
| 1 | ベクタ地図スタイル(dark) | CARTO (OpenMapTiles/OSM由来) | 出典表記(CARTO/OSM) | 実行時CDN | — | GL版ベース地図 |
| 2 | 地理院タイル(pale/std/photo/DEM) | 国土地理院 | 出典表記(測量法の範囲) | 実行時 or fetch | basemap PNG / heightfield | 2D背景・3D地形・GLベース |
| 3 | 都道府県ポリゴン | dataofjapan/land(国土数値情報由来) | 出典表記 | 生成済み同梱 | japan-prefectures.json (0.6MB) | 静的 |
| 4 | 市区町村ポリゴン | smartnews-smri/japan-topography(N03由来・MIT) | MIT+出典表記 | 生成済み同梱 | japan-municipalities.json (1.9MB) | 静的 |
| 5 | 空き家率 | e-Stat 住宅・土地統計調査 | e-Stat利用規約 | fetch:vacancy(要APIキー) | estat-vacancy.json (0.1MB) | 静的 |
| 6 | 市区町村配置分合(統廃合) | e-Stat | e-Stat利用規約 | 同梱CSV→build:changes | municipality-changes.json (0.5MB) | 静的 |
| 7 | 地価公示(住宅地) | 国土数値情報 L01 | 国土数値情報利用約款 | fetch:map | land-prices.json (1.0MB) | 静的 |
| 8 | 都市点(人口つき) | GeoNames cities15000 | CC BY 4.0 | fetch:map | jp-cities.json (0.2MB) | 静的 |
| 9 | 鉄道(路線+駅) | 国土数値情報 N02 | 国土数値情報利用約款 | fetch:railways | japan-railways.json (10.4MB) | 静的 + /api/railways |
| 10 | 高速道路時系列 | 国土数値情報 N06 | 国土数値情報利用約款 | fetch:highways | japan-highways.json (3.3MB) | 静的 |
| 11 | 道路網 | OpenStreetMap (Geofabrik抽出) | ODbL | fetch:osm-roads | osm-roads-*.jrb (全国38.7MB) | /api/roads (bbox) |
| 12 | 建物(足元+高さ) | OpenStreetMap (Geofabrik抽出) | ODbL | fetch:osm-buildings | osm-buildings-*.jrb (関東170MB) | /api/buildings (bbox) |
| 13 | 3D都市モデル(建築物) | Project PLATEAU(国交省) | 政府標準利用規約(CC BY 4.0互換) | fetch:plateau | 3D Tiles (千代田区40MB) | 静的(tileset.json+b3dm) |
| 14 | エラー住所点群 | vacant-service(ABRジオコード済み) | 内部データ | 実行時プロキシ | — | /api/address-points |

同梱(コミット済み)は `public/data/`、大きい生成物(`.jrb`・PLATEAU展開)はgitignoreで
`data/`・`public/data/plateau/` に置き、fetchスクリプトで再生成する。

## 各データの詳細

### 1. CARTO ベクタ地図スタイル(dark-matter)
- **URL**: `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json`(実行時にMapLibreが読む)
- **中身**: OpenMapTilesスキーマのベクタタイル。`name:ja` を持つため renderer-deck の
  `setKanji` で地名を漢字化できる。道路・鉄道・建物も**絵として**含まれるが、タイル断片で
  あり座標データとしては使わない(→ #9-#12 が座標データ側)
- **注意**: 外部CDN依存。落ちたら `setBase('gsi')` に切替可能

### 2. 地理院タイル / 地理院DEM
- **用途が3つ**: (a) GL版のベース地図選択肢(`pale`ラスタ、実行時参照)
  (b) 2D版の背景PNG(`fetch:basemap` が `pale` を合成して `public/js/basemap.js`+PNG を生成)
  (c) 3D地形(`fetch:terrain` が DEM から `public/terrain/*.heightfield.json`+テクスチャを生成)
- **条件**: 出典「国土地理院」表記。大量アクセスはタイルキャッシュ推奨(tetsugoの `/tiles/` プロキシが実例)

### 3-4. 行政境界ポリゴン(都道府県/市区町村)
- 座標2桁(≈1km)にsimplify済みの軽量版を**リポジトリに直接コミット**(再生成スクリプト無し。
  出典と加工内容は vacant-service の `console/VENDOR.json` の generated エントリにも記録)
- 形式: `{prefectures|municipalities: [{id|code, nam|name, pref, polys: MultiPolygon座標}]}`
- 用途: `prefectures.js`/`municipalities.js` の point-in-polygon 索引 → コロプレス

### 5-8. 統計・点データ(e-Stat/L01/GeoNames)
- **estat-vacancy.json**: 市区町村名→空き家率。コロプレス(metric)とtetsugo盤面の利回り補正の両方で使う
- **municipality-changes.json**: 1970〜2024の廃置分合3,507件。`/municipality-timeline` の再生データ
- **land-prices.json**: 住宅地公示地価1.7万点 `{lon,lat,yen}`。地域平均コロプレス(`meanByRegion`)
- **jp-cities.json**: 人口1.5万以上の日本の都市。サンプル点群の種・tetsugo盤面生成の種

### 9. 鉄道(N02) — メタデータが濃い
- 路線区間21,942本(路線名/運営会社/事業者種別/鉄道区分)、駅10,240(駅名/駅コード/
  グループコード=同一駅名寄せ)。駅は線分収録なので中点を取って点化している
- 4桁丸め(≈10m)+連続重複除去で10.4MB。**検索API**(`/api/railways/lines?q=` 等)は
  全量をブラウザに送らないための口
- 制約: 深度(地下鉄の深さ)は無い。ダイヤも無い(必要なら公共交通オープンデータセンターのGTFS)

### 10. 高速道路時系列(N06)
- 区間1,478本(路線名/**供用開始年**/廃止年)、IC・JCT 2,467点(名称/供用年)
- 供用年で `model.filter.range` と同じパターンの「道路網が伸びる」タイムライン再生が可能(未実装・データは保持)

### 11-12. OSM道路/建物 — 自作バイナリcodec(JRB)
- Geofabrikの日本抽出(`japan-latest.osm.pbf` 2.46GB / 地域別も可)を**純JSのPBFリーダー**
  (`lib/osm-pbf.mjs`)で読み、**JRB codec**(`lib/road-codec.mjs`: 座標1e5量子化+delta+
  zigzag varint+名前テーブル、v2で高さdm)に圧縮
- 道路: 幹線系(motorway〜tertiary+link)で全国99.5万way/1,151万点→38.7MB。
  residentialまで欲しい場合は `--classes` で明示(数倍に膨らむ)
- 建物: `height`タグ(実測)→`building:levels`×3m→無しの順で高さ解決。関東611万棟→170MB
  (高さ確定は62万棟=約10%。残りはクライアント既定8m)
- サーバがオンメモリ+0.02〜0.1°グリッド索引でbbox部分配信(丸の内313棟を0.01秒)
- **ODbLの注意**: 出典表記必須。JRBは「派生データベース」にあたるため、公開配布する場合は
  ODbL継承(このリポジトリ内ではgitignoreで配布していない)

### 13. PLATEAU 3D Tiles
- 実測高さのLOD1/2建築物モデル。`fetch:plateau -- --code 13101` がG空間情報センターの
  CKAN APIからzipを解決してDL・展開。deckの`Tile3DLayer`(レイヤー種別`tiles3d`)が
  tileset.jsonを直接ストリーミングする(LOD/視錐台カリングはdeck任せ)
- 東京23区は2020年度版(区ごとzip)。他都市はCKANで `plateau <都市名> 3dtiles` を検索して
  同じ構造で追加できる
- OSM建物(#12)との使い分け: PLATEAU=実測高さ・見た目重視・都市限定 / OSM=全国網羅・属性(名前)あり・高さは推定主体

### 14. vacant-service エラー住所点群
- `VACANT_SERVICE_URL` 設定時に `/api/address-points` が `/api/errorAddresses/geo` を中継。
  ジオコードはvacant-service側のABR(アドレス・ベース・レジストリ)で行われ、
  ここは中継のみ。未設定時は同梱サンプル(jp-cities種の合成データ)

## ライセンス上の出典表記(デモページに出すべきもの)

利用データを重ねたページでは以下の出典を表示する:
`© OpenStreetMap contributors` / `地理院タイル(国土地理院)` / `国土数値情報(国土交通省)` /
`e-Stat(総務省統計局)` / `CARTO` / `GeoNames` / `Project PLATEAU(国土交通省)`
