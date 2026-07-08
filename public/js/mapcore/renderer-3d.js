// mapcore/renderer-3d.js — three.js 地形上に住所点群を描く（GPU）。
// tetsugo の initTerrainViewer が返す latLonToWorld / elevWorld / scene / THREE を借りて、
// 点(カテゴリ色のインスタンス球) と グリッドコロプレス(件数で extrude した柱) を載せる。
// 任意 canvas に描けるので、フルスクリーンでも OpaDeck パネル内でも同じ。
//
// issue #1: 汎用レイヤーAPI(addLayer 等)対応。movers は terrain3d.js の tickHooks
// (spectate.js が実証したパターン)を mapcore の正式機能に格上げして毎フレーム動かす。

import { rampColor } from './metrics.js';
import {
  LAYER_TYPES, createLayerRegistry, moverPosition, realClock,
} from './layers.js';
import { createWipe } from './fx.js';

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

  const clock = opts.clock || realClock();

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
  const customGroup = new THREE.Group();   // 汎用レイヤー(network/extrusion/markers)
  const moverGroup = new THREE.Group();    // movers(tickHooksで毎フレーム位置更新)
  scene.add(pointGroup);
  scene.add(gridGroup);
  scene.add(choroGroup);
  scene.add(customGroup);
  scene.add(moverGroup);

  const registry = createLayerRegistry();

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

  // --- 汎用レイヤー(network/extrusion/markers/movers) ---------------------------
  function toGround(lat, lon, lift = 1.2) {
    const w = latLonToWorld(lat, lon);
    if (!w) return null;
    return { x: w.x, y: elevWorld(w.x, w.z) + lift, z: w.z, inside: w.inside };
  }

  // 絵文字/テキストのスプライト(canvasテクスチャ)。markers/movers のアイコンに使う。
  function makeTextSprite(text, worldSize = 6) {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const c2 = cv.getContext('2d');
    c2.font = '48px sans-serif';
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    c2.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(worldSize, worldSize, 1);
    return sp;
  }

  function buildCustomLayers() {
    clearGroup(customGroup);
    for (const spec of registry.list()) {
      if (!spec.visible || spec.type === 'movers') continue;
      const st = spec.style;
      if (spec.type === 'polygons') {
        // 建物等の押し出し。ringをTHREE.Shape(XZ平面)にしてExtrudeGeometryで立てる。
        const scaleH = st.heightScale3d ?? 0.15;   // 地形ワールドは非メートルなので縮尺
        for (const p of spec.data.polygons) {
          const shape = ringToShape(p.ring, THREE.Shape);
          if (!shape) continue;
          const h = Math.max(1, (p.height || st.defaultHeight || 8) * scaleH);
          const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
          geo.rotateX(Math.PI / 2);
          geo.translate(0, h, 0);
          const w0 = latLonToWorld(p.ring[0][1], p.ring[0][0]);
          if (!w0) continue;
          geo.translate(0, elevWorld(w0.x, w0.z), 0);
          const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color || st.color || '#8d99ae') });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.userData = { layerId: spec.id, feature: p };
          customGroup.add(mesh);
        }
      } else if (spec.type === 'paths') {
        for (const path of spec.data.paths) {
          const verts = [];
          let prev = null;
          for (const [lon, lat] of path.coords) {
            const w = toGround(lat, lon, 0.8);
            if (!w) { prev = null; continue; }
            if (prev) verts.push(prev.x, prev.y, prev.z, w.x, w.y, w.z);
            prev = w;
          }
          if (!verts.length) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
          const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(path.color || st.color || '#7a8aa0'), transparent: true, opacity: 0.85 });
          customGroup.add(new THREE.LineSegments(geo, mat));
        }
      } else if (spec.type === 'network') {
        const nodeById = new Map(spec.data.nodes.map((n) => [n.id, n]));
        const verts = [];
        for (const e of spec.data.edges) {
          const a = nodeById.get(e.from);
          const b = nodeById.get(e.to);
          if (!a || !b) continue;
          const wa = toGround(a.lat, a.lon, 0.8);
          const wb = toGround(b.lat, b.lon, 0.8);
          if (!wa || !wb) continue;
          verts.push(wa.x, wa.y, wa.z, wb.x, wb.y, wb.z);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(st.edgeColor || '#7a8aa0'), transparent: true, opacity: 0.8 });
        customGroup.add(new THREE.LineSegments(geo, mat));
        const nodeGeo = new THREE.SphereGeometry(st.nodeRadius3d ?? 1.0, 8, 8);
        const nodeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(st.nodeColor || '#e8c468') });
        for (const n of spec.data.nodes) {
          const w = toGround(n.lat, n.lon);
          if (!w) continue;
          const m = new THREE.Mesh(nodeGeo, nodeMat);
          m.position.set(w.x, w.y, w.z);
          m.userData = { layerId: spec.id, feature: n };
          customGroup.add(m);
        }
      } else if (spec.type === 'extrusion') {
        const maxV = spec.data.points.reduce((m, p) => Math.max(m, p.value || 0), 0) || 1;
        for (const p of spec.data.points) {
          const w = toGround(p.lat, p.lon, 0);
          if (!w) continue;
          const h = 2 + ((p.value || 0) * (st.heightScale3d ?? (50 / maxV)));
          const geo = new THREE.CylinderGeometry(st.radius3d ?? 2.2, st.radius3d ?? 2.2, h, 10);
          const color = p.color || st.color || rampColor((p.value || 0) / maxV);
          const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.85 });
          const cyl = new THREE.Mesh(geo, mat);
          cyl.position.set(w.x, elevWorld(w.x, w.z) + h / 2, w.z);
          cyl.userData = { layerId: spec.id, feature: p };
          customGroup.add(cyl);
        }
      } else if (spec.type === 'markers') {
        for (const p of spec.data.points) {
          const w = toGround(p.lat, p.lon, st.lift3d ?? 3);
          if (!w) continue;
          const sp = makeTextSprite(p.icon || '📍', st.iconSize3d ?? 6);
          sp.position.set(w.x, w.y, w.z);
          sp.userData = { layerId: spec.id, feature: p };
          customGroup.add(sp);
        }
      }
    }
  }

  // movers: token ごとにスプライトを保ち、terrain3d の tickHooks で毎フレーム位置更新。
  const moverSprites = new Map(); // `${layerId}|${tokenId}` -> sprite
  function rebuildMovers() {
    clearGroup(moverGroup);
    moverSprites.clear();
    for (const spec of registry.list()) {
      if (spec.type !== 'movers' || !spec.visible) continue;
      for (const tk of spec.data.tokens) {
        const sp = makeTextSprite(tk.icon || '🚄', spec.style.iconSize3d ?? 7);
        sp.userData = { layerId: spec.id, feature: tk };
        moverGroup.add(sp);
        moverSprites.set(`${spec.id}|${tk.id}`, sp);
      }
    }
  }
  viewer.tickHooks.push(() => {
    if (!moverSprites.size) return;
    const t = clock.now();
    for (const spec of registry.list()) {
      if (spec.type !== 'movers' || !spec.visible) continue;
      for (const tk of spec.data.tokens) {
        const sp = moverSprites.get(`${spec.id}|${tk.id}`);
        if (!sp) continue;
        const pos = moverPosition(tk, t);
        const w = toGround(pos.lat, pos.lon, spec.style.lift3d ?? 3);
        if (w) sp.position.set(w.x, w.y, w.z);
      }
    }
  });

  // focusOn: tickHooks でカメラ/注視点をイーズ移動(terrain3dのOrbitControlsを使う)。
  let focusAnim = null;
  viewer.tickHooks.push((dt) => {
    if (!focusAnim || !viewer.controls) return;
    focusAnim.t += dt / focusAnim.duration;
    const u = Math.min(1, focusAnim.t);
    const e = u * u * (3 - 2 * u); // smoothstep
    viewer.controls.target.lerpVectors(focusAnim.fromTarget, focusAnim.toTarget, e);
    camera.position.lerpVectors(focusAnim.fromCam, focusAnim.toCam, e);
    if (u >= 1) focusAnim = null;
  });

  function refresh() { buildPoints(); buildGrid(); buildChoropleth(); buildCustomLayers(); rebuildMovers(); }
  refresh();

  // --- pick: raycast on click (drag と区別) ---
  const raycaster = new THREE.Raycaster();
  let downX = 0;
  let downY = 0;
  function onDown(e) { downX = e.clientX; downY = e.clientY; }
  function onUp(e) {
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    // まず汎用レイヤー(pickable なもの)を当てる → spec.onPick(レイヤー単位)
    const customHits = raycaster.intersectObjects([...customGroup.children, ...moverGroup.children], false);
    for (const hit of customHits) {
      const ud = hit.object.userData || {};
      const spec = ud.layerId ? registry.get(ud.layerId) : null;
      if (spec && spec.pickable && spec.onPick) {
        spec.onPick(ud.feature ?? null, { layerId: spec.id, x: e.clientX, y: e.clientY });
        return;
      }
    }
    if (!onPick) return;
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

  const wipe = createWipe(canvas.parentElement || canvas);
  if (canvas.parentElement && getComputedStyle(canvas.parentElement).position === 'static') {
    canvas.parentElement.style.position = 'relative';
  }

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

    // --- 汎用レイヤーAPI(issue #1) ---
    addLayer(spec) { const s = registry.add(spec); buildCustomLayers(); rebuildMovers(); return s; },
    removeLayer(id) { const r = registry.remove(id); buildCustomLayers(); rebuildMovers(); return r; },
    setLayerVisible(id, v) { const r = registry.setVisible(id, v); buildCustomLayers(); rebuildMovers(); return r; },
    updateLayerData(id, data) { const r = registry.updateData(id, data); buildCustomLayers(); rebuildMovers(); return r; },
    reorderLayers(ids) { registry.reorder(ids); buildCustomLayers(); rebuildMovers(); },
    supportsLayerType(t) { return t !== 'tiles3d' && LAYER_TYPES.includes(t); },   // 3D TilesはGL専用
    getLayers() { return registry.toJSON(); },

    // --- カメラ演出・表示モード ---
    projectToScreen(lat, lon) {
      const w = toGround(lat, lon, 0);
      if (!w) return null;
      const v = new THREE.Vector3(w.x, w.y, w.z).project(camera);
      const rect = canvas.getBoundingClientRect();
      return { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height };
    },
    focusOn({ lat, lon, distance = 60, duration = 800 } = {}) {
      const w = toGround(lat, lon, 0);
      if (!w || !viewer.controls) return;
      const toTarget = new THREE.Vector3(w.x, w.y, w.z);
      const dir = camera.position.clone().sub(viewer.controls.target).normalize();
      focusAnim = {
        t: 0, duration: duration / 1000,
        fromTarget: viewer.controls.target.clone(), toTarget,
        fromCam: camera.position.clone(), toCam: toTarget.clone().add(dir.multiplyScalar(distance)),
      };
    },
    wipe,
    setViewMode() { /* 3D はOrbitControls自由回転のためnorth-up/heading-upの区別なし */ },
    supportsViewMode(m) { return m === 'north-up'; },
    addInset() { throw new Error('renderer-3d は inset 未対応(renderer-deck を使う)'); },
    removeInset() { return false; },
    maxInsets() { return 0; },

    destroy() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      wipe.destroy();
      clearGroup(pointGroup);
      clearGroup(gridGroup);
      clearGroup(choroGroup);
      clearGroup(customGroup);
      clearGroup(moverGroup);
      try { viewer.renderer.dispose(); } catch (_) { /* noop */ }
    },
  };
}
