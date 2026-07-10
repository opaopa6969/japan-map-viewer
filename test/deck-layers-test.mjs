// deck-layers-test — buildCustomDeckLayers の「隠れたレイヤーをdeckに初期化させない」
// 不変条件を fake deck で検証。
//   node test/deck-layers-test.mjs
//
// 背景: setInterleaved() は MapboxOverlay を作り直す。新品のoverlayに visible:false の
// 巨大レイヤー(全国29M棟)を渡すと、旧overlayの解放前にゼロから再テッセレーション+
// バッファ確保が走り Array buffer allocation failed で落ちた(ツアー開始時に実測)。
import assert from 'node:assert';
import { createLayerRegistry } from '../public/js/mapcore/layers.js';
import { buildCustomDeckLayers } from '../public/js/mapcore/renderer-deck.js';

let pass = 0;
const ok = (c, label) => { assert.ok(c, label); pass++; console.log('ok   ' + label); };

// fake deck: 生成されたレイヤーのidとpropsを記録するだけ
function fakeDeck() {
  const made = [];
  const mk = (name) => class { constructor(props) { made.push({ name, ...props }); Object.assign(this, props); } };
  return {
    made,
    ns: {
      LineLayer: mk('LineLayer'), ScatterplotLayer: mk('ScatterplotLayer'), ColumnLayer: mk('ColumnLayer'),
      TextLayer: mk('TextLayer'), PathLayer: mk('PathLayer'), SolidPolygonLayer: mk('SolidPolygonLayer'),
      Tile3DLayer: mk('Tile3DLayer'),
    },
  };
}

/** polygons(binary.chunks) の最小spec。実データ形状に合わせる。 */
function bldSpec(id, visible) {
  return {
    id, type: 'polygons', visible, zIndex: 6,
    data: { binary: { chunks: [{ base: 0, length: 1, startIndices: new Uint32Array([0, 4]), positions: new Float64Array(8), heights: new Float32Array(1) }] } },
    style: { color: '#8d99ae', opacity: 230 },
  };
}

const build = (registry, liveIds) => {
  const d = fakeDeck();
  const layers = buildCustomDeckLayers(d.ns, registry, 0, null, liveIds);
  return { layers, ids: layers.map((l) => l.id) };
};

// ----- liveIds を渡さない(insets等): 従来どおり非表示レイヤーも渡す ------------------
{
  const reg = createLayerRegistry();
  reg.add(bldSpec('buildings', false));
  const { ids } = build(reg, undefined);
  ok(ids.some((i) => i.startsWith('L|buildings|')), 'liveIds省略時は非表示レイヤーもdeckへ渡す(従来動作)');
}

// ----- 新品のoverlay: 一度も表示していない非表示レイヤーは渡さない --------------------
{
  const reg = createLayerRegistry();
  reg.add(bldSpec('buildings', false));   // ツアー開始時: メガ建物は隠してある
  reg.add(bldSpec('tour-bld', true));
  const liveIds = new Set();              // makeOverlay() 直後 = 空
  const { ids } = build(reg, liveIds);
  ok(!ids.some((i) => i.startsWith('L|buildings|')), '新品overlayに未初期化の非表示レイヤーを渡さない(29M二重確保の防止)');
  ok(ids.some((i) => i.startsWith('L|tour-bld|')), '表示中のレイヤーは渡す');
  ok(liveIds.has('tour-bld') && !liveIds.has('buildings'), '表示したidだけがliveIdsに入る');
}

// ----- 生きたoverlay: 一度表示したレイヤーは隠しても渡し続ける(リソース保持) ----------
{
  const reg = createLayerRegistry();
  reg.add(bldSpec('buildings', true));
  const liveIds = new Set();
  build(reg, liveIds);                    // 1回目: 表示 → 初期化される
  ok(liveIds.has('buildings'), '表示したのでliveIdsに載る');

  reg.setVisible('buildings', false);     // ユーザーがチェックを外す
  const { layers, ids } = build(reg, liveIds);
  ok(ids.some((i) => i.startsWith('L|buildings|')), '初期化済みなら非表示でもdeckに渡し続ける(540bb5cの不変条件)');
  const bld = layers.find((l) => l.id.startsWith('L|buildings|'));
  ok(bld.visible === false, '渡すがvisible:falseで描画だけスキップ');
}

// ----- overlay作り直し(liveIdsリセット)後は、隠れたままのレイヤーが外れる ------------
{
  const reg = createLayerRegistry();
  reg.add(bldSpec('buildings', true));
  let liveIds = new Set();
  build(reg, liveIds);
  reg.setVisible('buildings', false);
  ok(build(reg, liveIds).ids.some((i) => i.startsWith('L|buildings|')), '同じoverlayでは保持される');

  liveIds = new Set();                    // setInterleaved() → makeOverlay() 相当
  ok(!build(reg, liveIds).ids.some((i) => i.startsWith('L|buildings|')),
    'overlay作り直し後は隠れたレイヤーが外れる(ツアー開始時のクラッシュ経路)');
}

// ----- 再表示すれば戻る -----------------------------------------------------------
{
  const reg = createLayerRegistry();
  reg.add(bldSpec('buildings', false));
  const liveIds = new Set();
  build(reg, liveIds);
  reg.setVisible('buildings', true);      // ツアー終了 → 表示に戻す
  const { layers } = build(reg, liveIds);
  const bld = layers.find((l) => l.id.startsWith('L|buildings|'));
  ok(bld && bld.visible === true, '再表示すればdeckへ戻り、visible:trueで描画される');
}

// ----- 空間チャンク: 視界外はレイヤーごと外す(確保を解放させる) ----------------------
{
  const chunk = (base, bbox) => ({
    base, bbox, length: 1,
    startIndices: new Uint32Array([0, 4]), positions: new Float64Array(8), heights: new Float32Array(1),
  });
  const reg = createLayerRegistry();
  reg.add({
    id: 'buildings', type: 'polygons', visible: true, zIndex: 6, style: {},
    data: { binary: { chunks: [chunk(0, [139, 35, 140, 36]), chunk(1e6, [141, 43, 142, 44])] } },
  });
  const liveIds = new Set();
  const tokyo = [139.5, 35.5, 139.9, 35.9];    // 東京の視錐台
  const d1 = fakeDeck();
  const l1 = buildCustomDeckLayers(d1.ns, reg, 0, tokyo, liveIds);
  ok(l1.length === 1 && l1[0].id === 'L|buildings|polygons|0', '視界内チャンクだけをdeckへ渡す(札幌チャンクは外す)');

  const sapporo = [141.2, 43.0, 141.5, 43.2];
  const d2 = fakeDeck();
  const l2 = buildCustomDeckLayers(d2.ns, reg, 0, sapporo, liveIds);
  ok(l2.length === 1 && l2[0].id === 'L|buildings|polygons|1000000', '札幌へ飛ぶと東京チャンクが外れ、札幌チャンクが載る');
  ok(l2[0].visible === true, '視界内チャンクはvisible:true');

  // cullBounds無し(insets等)は全チャンクを渡す — 従来動作
  const d3 = fakeDeck();
  ok(buildCustomDeckLayers(d3.ns, reg, 0, null, undefined).length === 2, 'cullBounds無しなら全チャンクを渡す');

  // レイヤーごと非表示なら、視界内でも渡さない(新品overlay時)
  reg.setVisible('buildings', false);
  const d4 = fakeDeck();
  ok(buildCustomDeckLayers(d4.ns, reg, 0, tokyo, new Set()).length === 0, '非表示レイヤーのチャンクは新品overlayに渡さない');
}

console.log(`\nall ${pass} checks passed`);
