// mapcore/renderer-3d.js — three.js 地形上に住所点群を描く（GPU）。
// tetsugo の initTerrainViewer が返す latLonToWorld / elevWorld / scene / THREE を借りて、
// 点(カテゴリ色のインスタンス球) と グリッドコロプレス(件数で extrude した柱) を載せる。
// 任意 canvas に描けるので、フルスクリーンでも OpaDeck パネル内でも同じ。

import { rampColor } from './metrics.js';

export async function createRenderer3D(canvas, opts = {}) {
  const model = opts.model;
  const onPick = opts.onPick;
  const terrainName = opts.terrainName || 'japan';
  const terrainBase = opts.terrainBase || '/terrain/';
  const terrain3dUrl = opts.terrain3dUrl || '/js/terrain3d.js';
  const cacheBust = opts.cacheBust || '';
  const layers = { points: true, grid: false, choropleth: false, ...(opts.layers || {}) };
  let gridDeg = opts.gridDeg || 0.5;
  let choro = opts.choropleth || null; // { index, kind, values?, max? }
  const CHORO_MAX_FEATURES_3D = 300; // 市区町村(1902)は重いので 3D ではスキップ(2D を使う)

  const { initTerrainViewer } = await import(terrain3dUrl + (cacheBust ? `?v=${cacheBust}` : ''));
  const viewer = await initTerrainViewer(canvas, {
    heightfieldUrl: `${terrainBase}${terrainName}.heightfield.json${cacheBust ? `?v=${cacheBust}` : ''}`,
    cacheBust,
    spectate: true, // ゲーム装飾(線路/電車/駅)を抑制してマップに専念
  });
  const { THREE, scene, latLonToWorld, elevWorld, camera } = viewer;
  viewer.state.autoOrbit = false;

  const pointGroup = new THREE.Group();
  const gridGroup = new THREE.Group();
  const choroGroup = new THREE.Group();
  scene.add(pointGroup);
  scene.add(gridGroup);
  scene.add(choroGroup);

  function clearGroup(group) {
    while (group.children.length) {
      const child = group.children.pop();
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
  }

  const sphereGeo = new THREE.SphereGeometry(0.8, 8, 8);

  function buildPoints() {
    clearGroup(pointGroup);
    if (!layers.points || !model) return;
    const byCat = new Map();
    for (const p of model.visible()) {
      const w = latLonToWorld(p.lat, p.lon);
      if (!w || !w.inside) continue;
      if (!byCat.has(p.category)) byCat.set(p.category, []);
      byCat.get(p.category).push({ x: w.x, y: elevWorld(w.x, w.z) + 1.2, z: w.z, idx: p._i });
    }
    const matrix = new THREE.Matrix4();
    for (const [cat, arr] of byCat) {
      const color = new THREE.Color(model.colorOf(cat));
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.6 });
      const mesh = new THREE.InstancedMesh(sphereGeo, mat, arr.length);
      mesh.userData.indices = arr.map((a) => a.idx);
      arr.forEach((a, i) => { matrix.makeTranslation(a.x, a.y, a.z); mesh.setMatrixAt(i, matrix); });
      mesh.instanceMatrix.needsUpdate = true;
      pointGroup.add(mesh);
    }
  }

  function buildGrid() {
    clearGroup(gridGroup);
    if (!layers.grid || !model) return;
    const cells = model.grid(gridDeg);
    const maxCount = cells.maxCount || 1;
    for (const cell of cells) {
      const nw = latLonToWorld(cell.lat0 + cell.cellDeg, cell.lon0);
      const se = latLonToWorld(cell.lat0, cell.lon0 + cell.cellDeg);
      if (!nw || !se) continue;
      const w = Math.abs(se.x - nw.x);
      const d = Math.abs(se.z - nw.z);
      const h = 2 + 45 * (cell.count / maxCount);
      const geo = new THREE.BoxGeometry(w * 0.82, h, d * 0.82);
      const color = new THREE.Color(model.colorOf(cell.topCategory));
      const mat = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.82 });
      const box = new THREE.Mesh(geo, mat);
      const cx = (nw.x + se.x) / 2;
      const cz = (nw.z + se.z) / 2;
      box.position.set(cx, elevWorld(cx, cz) + h / 2, cz);
      gridGroup.add(box);
    }
  }

  // 地域ポリゴン(都道府県/市区町村)を地形上に色塗り。THREE.Shape を XZ 平面へ寝かせ、
  // 海面少し上に半透明で配置(山は上に飛び出して隠れる=オーバーレイとして読める)。
  function ringToShape(ring, Ctor) {
    if (!ring || ring.length < 3) return null;
    const shape = new Ctor();
    ring.forEach(([lon, lat], i) => {
      const w = latLonToWorld(lat, lon);
      if (i === 0) shape.moveTo(w.x, w.z); else shape.lineTo(w.x, w.z);
    });
    return shape;
  }

  function buildChoropleth() {
    clearGroup(choroGroup);
    if (!layers.choropleth || !choro || !choro.index || !model) return;
    if (choro.index.features.length > CHORO_MAX_FEATURES_3D) return; // muni は 3D では重いのでスキップ
    const useMetric = choro.kind === 'metric';
    const aggregate = useMetric ? null : model.regionAggregate(choro.index);
    const max = useMetric ? (choro.max || 1) : (aggregate.max || 1);
    const Y = 1.2;
    for (const feature of choro.index.features) {
      let color;
      let opacity;
      if (useMetric) {
        const value = choro.values ? choro.values.get(feature.id) : undefined;
        if (value == null) continue;
        color = new THREE.Color(rampColor(value / max));
        opacity = 0.72;
      } else {
        const cell = aggregate.get(feature.id);
        if (!cell) continue;
        color = new THREE.Color(model.colorOf(cell.topCategory));
        opacity = 0.3 + 0.5 * Math.sqrt(cell.count / max);
      }
      for (const poly of feature.polys) {
        const shape = ringToShape(poly[0], THREE.Shape);
        if (!shape) continue;
        for (let h = 1; h < poly.length; h++) {
          const hole = ringToShape(poly[h], THREE.Path);
          if (hole) shape.holes.push(hole);
        }
        const geo = new THREE.ShapeGeometry(shape);
        geo.rotateX(Math.PI / 2); // XY(shape) -> XZ(world): (x, z_world) を平面化
        geo.translate(0, Y, 0);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
        choroGroup.add(new THREE.Mesh(geo, mat));
      }
    }
  }

  function refresh() { buildPoints(); buildGrid(); buildChoropleth(); }
  refresh();

  // --- pick: raycast on click (drag と区別) ---
  const raycaster = new THREE.Raycaster();
  let downX = 0;
  let downY = 0;
  function onDown(e) { downX = e.clientX; downY = e.clientY; }
  function onUp(e) {
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) return;
    if (!onPick) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pointGroup.children, false);
    if (hits.length) {
      const hit = hits[0];
      const indices = hit.object.userData.indices || [];
      const idx = indices[hit.instanceId];
      onPick(idx != null ? model.points[idx] : null, { x: e.clientX, y: e.clientY });
    } else {
      onPick(null);
    }
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  return {
    kind: '3d',
    viewer,
    refresh,
    setLayers(next) { Object.assign(layers, next); refresh(); },
    setGridDeg(d) { gridDeg = d; buildGrid(); },
    setChoropleth(config) { choro = config; buildChoropleth(); },
    choroMaxFeatures: CHORO_MAX_FEATURES_3D, // 呼び出し側がスキップ閾値を知れるように
    choroMeshCount: () => choroGroup.children.length, // 検証/デバッグ用
    pointMeshCount: () => pointGroup.children.length,
    home() { /* OrbitControls reset は省略 */ },
    destroy() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      clearGroup(pointGroup);
      clearGroup(gridGroup);
      clearGroup(choroGroup);
      try { viewer.renderer.dispose(); } catch (_) { /* noop */ }
    },
  };
}
