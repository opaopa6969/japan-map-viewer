// terrain3d.js — 本物の日本地形ジオラマ・ビューア（プロト）
//
// public/terrain/<name>.heightfield.json（地理院DEM由来の標高グリッド＋淡色地図テクスチャ）
// を読み込み、three.js で「癒しのミニチュア」3Dシーンを描く純粋なview層。
// ゲームロジックには一切触らない。演出用に Math.random / 適当な曲線を多用する。
//
// シーン構成:
//   1. 地形メッシュ … PlaneGeometry(grid×grid) の頂点Zを標高で変位 + 淡色地図をdrape
//   2. ミニチュア電車 … 箱の連結が尾根/谷を結ぶ Catmull-Rom 曲線をループ走行。煙パーティクル付き
//   3. 栄えた町 … 数クラスタの低ポリ建物（InstancedMesh）＋窓の点滅＋小ドット(車/人)のうにょうにょ巡回
//   4. カメラ … OrbitControls（回転/ズーム）＋ゆっくり自動周回トグル
//   5. 空気感 … 夕方寄りの方向光＋環境光＋空色フォグ＋地形に影。ジオラマ質感狙い

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FlyControls } from 'three/addons/controls/FlyControls.js';

// ---- 世界スケール（ミニチュア感を決める定数） --------------------------------
const WORLD = 200;            // 地形の一辺（ワールド単位）。-WORLD/2 .. +WORLD/2 に配置
const HEIGHT_EXAGG_DEFAULT = 0.0085;  // 標高m → ワールド高への誇張係数（マップ毎に hf.heightExagg で上書き可。広域は小さめ）
const WATER_Y = 0.008;        // 水面のワールド高(≒0.95m)。海抜0の海だけ覆う

// 状態（HUD のトグルから触る）
const state = {
  autoOrbit: true,
  orbitSpeed: 0.05,   // rad/s
  trainSpeed: 0.018,  // u (0..1) /s
};

export async function initTerrainViewer(canvas, opts = {}) {
  const heightfieldUrl = opts.heightfieldUrl || '/terrain/chubu.heightfield.json';
  // 観戦モード: 装飾の周回電車/煙を消し、ライブ観戦の駒(spectate.js)に主役を譲る。
  // 引数なしの既定挙動(鑑賞シーン)は維持し、spectate のときだけオプトインで間引く。
  const spectate = !!opts.spectate;

  // --- データ取得 -----------------------------------------------------------
  const hf = await fetch(heightfieldUrl).then((r) => {
    if (!r.ok) throw new Error(`heightfield fetch失敗: ${r.status}`);
    return r.json();
  });
  const GRID = hf.grid;
  const heights = hf.height;        // メートル, 海=0, 長さ GRID*GRID（北上・東右）
  const HEIGHT_EXAGG = hf.heightExagg || HEIGHT_EXAGG_DEFAULT;  // マップ毎の高さ誇張(広域は小さめ)
  const maxElev = hf.maxElev || 3000;
  const bounds = hf.bounds || null; // { lat0, lat1, lon0, lon1 } — 観戦の駅配置に使う

  // --- レンダラ / シーン / カメラ -------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.localClippingEnabled = true;   // 断面モードのクリップ面用

  const scene = new THREE.Scene();
  const skyColor = new THREE.Color(0xbcd6e8); // 淡い空色
  scene.background = skyColor.clone();
  // 空気遠近: 奥がふわっと霞むジオラマ感
  scene.fog = new THREE.Fog(skyColor.clone().lerp(new THREE.Color(0xffe9c7), 0.25), WORLD * 0.9, WORLD * 2.4);

  const camera = new THREE.PerspectiveCamera(38, canvas.clientWidth / canvas.clientHeight, 0.5, WORLD * 6);
  camera.position.set(WORLD * 0.62, WORLD * 0.5, WORLD * 0.62); // 斜め見下ろし
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = WORLD * 0.25;
  controls.maxDistance = WORLD * 2.2;
  controls.maxPolarAngle = Math.PI * 0.49; // 地面下に潜らない
  controls.target.set(0, WORLD * 0.04, 0);

  // --- ライティング（夕方寄り） ---------------------------------------------
  const ambient = new THREE.HemisphereLight(0xdfeeff, 0x6b5a44, 0.85);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xfff0d4, 1.55);
  sun.position.set(-WORLD * 0.5, WORLD * 0.7, WORLD * 0.35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.near = 1; sc.far = WORLD * 3;
  sc.left = -WORLD * 0.7; sc.right = WORLD * 0.7;
  sc.top = WORLD * 0.7; sc.bottom = -WORLD * 0.7;
  scene.add(sun);
  // 補助の弱い逆光で輪郭を立てる
  const rim = new THREE.DirectionalLight(0xaaccff, 0.35);
  rim.position.set(WORLD * 0.4, WORLD * 0.3, -WORLD * 0.5);
  scene.add(rim);

  // --- 地形メッシュ ---------------------------------------------------------
  // 標高をワールド高に変換するヘルパ（gx,gy はグリッド座標 0..GRID-1）
  // メッシュ(heights[iy*GRID+ix]=反転なし)と一致させる接地参照。これでテクスチャ・
  // 地形・電車・町が全部同じ南北で揃う(笛吹川が谷に戻り、富士の高さも正位置)。
  const idx = (X, Y) => Math.min(GRID - 1, Math.max(0, Y)) * GRID + Math.min(GRID - 1, Math.max(0, X));
  let vScale = 1;   // 標高スケール(HUDスライダーで変更)。接地・メッシュ・水面が同じ値で連動
  const elevAt = (gx, gy) => heights[idx(Math.round(gx), Math.round(gy))] * HEIGHT_EXAGG * vScale;
  // ワールド(x,z) → グリッド座標。x: 西→東(+), z: 北→南(+)
  const worldToGrid = (x, z) => ({
    gx: ((x + WORLD / 2) / WORLD) * (GRID - 1),
    gy: ((z + WORLD / 2) / WORLD) * (GRID - 1),
  });
  // バイリニア標高（電車/町の接地用、なめらか）
  const elevWorld = (x, z) => {
    const { gx, gy } = worldToGrid(x, z);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(GRID - 1, x0 + 1), y1 = Math.min(GRID - 1, y0 + 1);
    const fx = gx - x0, fy = gy - y0;
    const h = (X, Y) => heights[idx(X, Y)];   // メッシュと同じ南北反転で参照
    const top = h(x0, y0) * (1 - fx) + h(x1, y0) * fx;
    const bot = h(x0, y1) * (1 - fx) + h(x1, y1) * fx;
    return (top * (1 - fy) + bot * fy) * HEIGHT_EXAGG * vScale;
  };

  // テクスチャ(淡色地図)を先に読み込む。海/陸判定に色を使うのと、メッシュにdrapeする両用。
  const texLoader = new THREE.TextureLoader();
  const texUrl = hf.texture + (opts.cacheBust ? ('?v=' + opts.cacheBust) : '');
  const terrainTex = await new Promise((res) => texLoader.load(texUrl, res, undefined, () => res(null)));
  if (terrainTex) {
    terrainTex.colorSpace = THREE.SRGBColorSpace;
    terrainTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }

  // ゼロメートル地帯を陸に戻す。海も0m市街もDEM上は標高0で区別できないが、淡色地図では
  // 海が明確な青(rgb≈189,210,255 → B-R≈66)、陸は暖色/白(B-R≤0)。「低地 かつ 水色でない」
  // セルだけ水面より上へ持ち上げ、堤防内の0m市街(下町/江東/江戸川)を地上に出す。湾は青なので海のまま。
  if (terrainTex && terrainTex.image) {
    try {
      const cv = document.createElement('canvas');
      cv.width = GRID; cv.height = GRID;
      const cctx = cv.getContext('2d', { willReadFrequently: true });
      cctx.drawImage(terrainTex.image, 0, 0, GRID, GRID); // 地図上端=北=heights row0 と一致(反転不要)
      const px = cctx.getImageData(0, 0, GRID, GRID).data;
      const lowCutM = (WATER_Y / HEIGHT_EXAGG) + 0.5;   // ≒1.4m 以下を低地とみなす
      const floorM = (WATER_Y / HEIGHT_EXAGG) + 1.5;    // 陸へ持ち上げる高さ(水面より上≒2.7m)
      const seaFloorM = -((WATER_Y / HEIGHT_EXAGG) + 120); // 海セルの海底。水面と明確に離してZファイティング(ちらつき)を防ぐ
      let raised = 0, carved = 0;
      for (let i = 0; i < GRID * GRID; i++) {
        if (heights[i] > lowCutM) continue;
        const isSea = px[i * 4 + 2] - px[i * 4] > 30;   // B-R>30 なら海色
        if (isSea) { heights[i] = seaFloorM; carved++; }       // 海底を掘り下げ(水面板と分離)
        else { heights[i] = Math.max(heights[i], floorM); raised++; } // 0m市街は地上へ
      }
      if (raised || carved) console.log(`[terrain] 0m市街 ${raised}セルを地上へ・海底 ${carved}セルを掘り下げ`);
    } catch (e) { console.warn('[terrain] 海陸マスク失敗', e); }
  }

  const geo = new THREE.PlaneGeometry(WORLD, WORLD, GRID - 1, GRID - 1);
  geo.rotateX(-Math.PI / 2); // XZ平面に寝かせる（Y=上）
  const pos = geo.attributes.position;
  const aElev = new Float32Array(pos.count);   // 各頂点の標高(メートル)。標高図/等高線シェーダ用(vScale非依存)
  // 球面モード用の基底単位ベクトル(標高0時の球面上の向き)。実緯度経度→地球儀の球面に貼る。
  const hasGlobe = !!bounds;
  const u0x = new Float32Array(pos.count), u0y = new Float32Array(pos.count), u0z = new Float32Array(pos.count);
  const DEG = Math.PI / 180;
  const lonC = hasGlobe ? (bounds.lon0 + bounds.lon1) / 2 * DEG : 0;
  const latC = hasGlobe ? (bounds.lat0 + bounds.lat1) / 2 * DEG : 0;
  // 球半径。小さいほど玉が丸く見える(列島が乗った地球儀感)。WORLD基準の固定値にして、
  // 大きすぎて平らなキャップに見えるのを防ぐ。列島の patch は R×緯度スパンの弧長になる。
  let globeR = WORLD * 1.25;
  const rxC = Math.cos(latC - Math.PI / 2), rxS = Math.sin(latC - Math.PI / 2);
  // PlaneGeometry の頂点順: 行優先。row 0 が +z(=北), 列 0 が -x。標高グリッドは北上・東右。
  for (let i = 0; i < pos.count; i++) {
    const ix = i % GRID;
    const iy = Math.floor(i / GRID);
    // 標高グリッドは row0=北。PlaneGeometryの row0(iy=0,UV.y=1)はテクスチャ上端=北を
    // 指すので、高さも反転せず heights[iy*GRID+ix] にすると地形とテクスチャが一致する。
    const m = heights[iy * GRID + ix];
    aElev[i] = m;
    pos.setY(i, m * HEIGHT_EXAGG * vScale);
    if (hasGlobe) {
      const lon = (bounds.lon0 + (bounds.lon1 - bounds.lon0) * (ix / (GRID - 1))) * DEG;
      const lat = (bounds.lat1 + (bounds.lat0 - bounds.lat1) * (iy / (GRID - 1))) * DEG; // iy0=北=lat1
      const cl = Math.cos(lat);
      const gx = cl * Math.sin(lon - lonC), gy = Math.sin(lat), gz = cl * Math.cos(lon - lonC); // Ry(-lonC)込み
      u0x[i] = gx;                       // Rx(latC-90°): 中心を真上(+Y)へ
      u0y[i] = gy * rxC - gz * rxS;
      u0z[i] = gy * rxS + gz * rxC;
    }
  }
  geo.setAttribute('aElev', new THREE.BufferAttribute(aElev, 1));
  geo.computeVertexNormals();

  let globeMode = false;
  // 頂点を現在のモード(平面/球面)と vScale で配置し直す。接地elevWorldは平面前提なので
  // 装飾/駒は球面モードでは隠す(下の flatDecor)。
  function projectVerts() {
    for (let i = 0; i < pos.count; i++) {
      const e = aElev[i] * HEIGHT_EXAGG * vScale;
      if (globeMode && hasGlobe) {
        const rr = globeR + e;
        pos.setXYZ(i, u0x[i] * rr, u0y[i] * rr - globeR, u0z[i] * rr);
      } else {
        const ix = i % GRID, iy = Math.floor(i / GRID);
        pos.setXYZ(i, (ix / (GRID - 1)) * WORLD - WORLD / 2, e, (iy / (GRID - 1)) * WORLD - WORLD / 2);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    sea.position.y = WATER_Y * vScale;
  }

  // 標高スケール変更(スライダー)。メッシュ頂点・水面・接地(elevWorld)を同じ vScale で連動。
  function rescale(s) {
    vScale = Math.max(0, s);   // 0 で完全に平ら(2D地図状態)
    projectVerts();
    if (sliceState.on) refreshSlice();   // 断面ウォール/マーカーも高さ連動で再構築
  }

  // 標高図(hypsometric)＋等高線をシェーダに注入。uTint/uContour で切替、標高(aElev,メートル)
  // で着色するので vScale を変えても等高線の高度は不変。青(低)→緑→茶→赤(高)の段彩。
  const terrainUniforms = { uTint: { value: 0 }, uContour: { value: 0 }, uInterval: { value: 200 }, uWinter: { value: 0 } };
  const terrainMat = new THREE.MeshStandardMaterial({
    map: terrainTex || null,
    color: terrainTex ? 0xffffff : 0x8aa37b,
    roughness: 0.95,
    metalness: 0.0,
  });
  terrainMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTint = terrainUniforms.uTint;
    shader.uniforms.uContour = terrainUniforms.uContour;
    shader.uniforms.uInterval = terrainUniforms.uInterval;
    shader.uniforms.uWinter = terrainUniforms.uWinter;
    shader.vertexShader = 'attribute float aElev;\nvarying float vElevM;\n' + shader.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vElevM = aElev;');
    shader.fragmentShader = 'uniform float uTint;\nuniform float uContour;\nuniform float uInterval;\nuniform float uWinter;\nvarying float vElevM;\n'
      // 段彩: 青(低)→青緑→緑→黄褐→茶→黒っぽい茶(高)。赤や白は使わず濃く沈める。
      + 'vec3 hypsoRamp(float h){\n'
      + '  if(h < 0.0) return vec3(0.28,0.48,0.60);\n'                                                  // 海面下 青
      + '  else if(h < 80.0) return mix(vec3(0.40,0.62,0.66), vec3(0.43,0.65,0.45), h/80.0);\n'         // 青緑→緑(低地)
      + '  else if(h < 500.0) return mix(vec3(0.43,0.65,0.45), vec3(0.80,0.76,0.46), (h-80.0)/420.0);\n'  // 緑→黄褐
      + '  else if(h < 1400.0) return mix(vec3(0.80,0.76,0.46), vec3(0.60,0.42,0.26), (h-500.0)/900.0);\n' // 黄褐→茶
      + '  else if(h < 2500.0) return mix(vec3(0.60,0.42,0.26), vec3(0.40,0.27,0.18), (h-1400.0)/1100.0);\n' // 茶→濃茶
      + '  return mix(vec3(0.40,0.27,0.18), vec3(0.20,0.14,0.10), clamp((h-2500.0)/1300.0,0.0,1.0));\n'   // 濃茶→黒っぽい茶
      + '}\n'
      + shader.fragmentShader.replace('#include <map_fragment>',
          '#include <map_fragment>\n'
        + '  diffuseColor.rgb = mix(diffuseColor.rgb, hypsoRamp(vElevM), uTint);\n'
        + '  if(uContour > 0.5 && vElevM > 0.0){\n'
        + '    float f = vElevM / uInterval;\n'
        + '    float d = abs(fract(f - 0.5) - 0.5) / max(fwidth(f), 1e-4);\n'   // 最寄り等高線までの画素距離
        + '    float line = 1.0 - clamp(d - 0.5, 0.0, 1.0);\n'
        + '    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16,0.12,0.10), line * 0.6);\n'
        + '  }\n'
        // 冬モード: 雪線(≒1300m)以上をなだらかに白く。標高図でも通常マップでも冠雪する(白い富士山)。
        + '  float snow = smoothstep(1300.0, 2900.0, vElevM) * uWinter;\n'
        + '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95,0.96,1.0), snow);\n');
  };
  const terrain = new THREE.Mesh(geo, terrainMat);
  terrain.receiveShadow = true;
  terrain.castShadow = true;
  scene.add(terrain);

  // 海/低地のうっすら水面（標高0付近を覆う薄い面）
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD * 1.6, WORLD * 1.6),
    new THREE.MeshStandardMaterial({ color: 0x3f6f8a, roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.55, depthWrite: false })
  );
  sea.rotation.x = -Math.PI / 2;
  // 水面は WATER_Y(≒0.95m)。海と繋がる0m域だけ覆う。内陸の0m市街は上の reclaim で
  // 持ち上げ済みなので水没しない(海=縁から繋がる低地、で判定)。
  sea.position.y = WATER_Y;
  sea.receiveShadow = false;
  scene.add(sea);

  // 球面モードの海(地球儀の海)。単位球をスケールして使う(半径スライダーで安く変更)。標準は非表示。
  const ocean = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 64),
    new THREE.MeshStandardMaterial({ color: 0x2c5f82, roughness: 0.5, metalness: 0.15 })
  );
  ocean.visible = false;
  scene.add(ocean);
  const applyOcean = () => { ocean.scale.setScalar(globeR + WATER_Y); ocean.position.set(0, -globeR, 0); };
  applyOcean();

  // 球面モードで隠す平面前提の装飾(電車/線路/駅/町/煙)。接地が平面座標依存のため。
  const flatDecor = [];
  // --- ミニチュア電車（パス走行 + 連結 + 煙） -------------------------------
  // 観戦モードでは装飾電車・線路・駅マーカー・煙を作らず、ライブ駒に主役を譲る。
  // 適度に標高のある点を数駅選んで Catmull-Rom ループを引く。
  const stations = pickStations(heights, GRID, WORLD, 7);
  const curvePts = stations.map((s) => new THREE.Vector3(s.x, 0, s.z));
  const curve = new THREE.CatmullRomCurve3(curvePts, true, 'catmullrom', 0.5);

  // 線路（細い帯）を地形に沿わせて可視化
  const railSamples = 400;
  const railPts = [];
  for (let i = 0; i <= railSamples; i++) {
    const t = i / railSamples;
    const p = curve.getPoint(t);
    railPts.push(new THREE.Vector3(p.x, elevWorld(p.x, p.z) + 0.4, p.z));
  }
  const railGeo = new THREE.BufferGeometry().setFromPoints(railPts);
  const rail = new THREE.Line(railGeo, new THREE.LineBasicMaterial({ color: 0x4a3b2a }));
  if (!spectate) scene.add(rail);
  flatDecor.push(rail);

  // 駅マーカー（小さな白い箱）
  const stationMat = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.8 });
  if (!spectate) for (const s of stations) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 1.6), stationMat);
    m.position.set(s.x, elevWorld(s.x, s.z) + 0.5, s.z);
    m.castShadow = true;
    scene.add(m);
    flatDecor.push(m);
  }

  // 車両: 機関車 + 客車×3 を連結
  const train = new THREE.Group();
  const carColors = [0x2b2b33, 0x9c3b2e, 0x2e6b9c, 0x2f8a5b];
  const cars = [];
  for (let i = 0; i < 4; i++) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.1, 2.6),
      new THREE.MeshStandardMaterial({ color: carColors[i], roughness: 0.5, metalness: 0.2 })
    );
    body.castShadow = true;
    const car = new THREE.Group();
    car.add(body);
    if (i === 0) {
      // 機関車の煙突
      const stack = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.3, 0.7, 8),
        new THREE.MeshStandardMaterial({ color: 0x1a1a1f })
      );
      stack.position.set(0, 0.8, 0.9);
      car.add(stack);
    }
    // 窓っぽい明るい帯
    const win = new THREE.Mesh(
      new THREE.BoxGeometry(1.42, 0.4, 2.0),
      new THREE.MeshStandardMaterial({ color: 0xffe7a8, emissive: 0xffcf66, emissiveIntensity: 0.6 })
    );
    win.position.y = 0.15;
    car.add(win);
    train.add(car);
    cars.push(car);
  }
  if (!spectate) scene.add(train);
  flatDecor.push(train);
  const trainState = { t: 0, gap: 0.012 }; // 各車間の弧長パラメータ差

  // 煙パーティクル（簡易: 小さな半透明スプライト群を機関車から放出）
  const smokeTex = makeSmokeTexture();
  const smokeMat = new THREE.SpriteMaterial({ map: smokeTex, transparent: true, opacity: 0.0, depthWrite: false, color: 0xf2f2f2 });
  const smokes = [];
  if (!spectate) for (let i = 0; i < 24; i++) {
    const sp = new THREE.Sprite(smokeMat.clone());
    sp.visible = false;
    sp.userData = { life: 0, max: 0, vy: 0, drift: new THREE.Vector3() };
    scene.add(sp);
    smokes.push(sp);
    flatDecor.push(sp);
  }
  let smokeIdx = 0;

  // 外部(spectate.js)が毎フレーム駒を動かすためのフック。dt(秒)を受け取る。
  const tickHooks = [];

  // --- 栄えた町（InstancedMesh + 窓点滅 + 小ドット巡回） --------------------
  const towns = buildTowns(scene, heights, GRID, WORLD, elevWorld);
  for (const t of towns) flatDecor.push(t.group);

  // 球面(地球儀)モード: 地形を球面へ曲げ、海を球に、平面前提の装飾は隠す。
  function setGlobe(on) {
    if (on && !hasGlobe) return;
    globeMode = !!on;
    projectVerts();
    sea.visible = !globeMode;
    ocean.visible = globeMode;
    for (const o of flatDecor) if (o) o.visible = !globeMode;
    // 影は球面で破綻するため切る。ズーム範囲を球が収まるよう広げる。
    sun.castShadow = !globeMode;
    terrain.castShadow = !globeMode;
    // フォグ: 球面では玉が遠くまで延びるので霧を後退させる(近いと玉が溶ける)
    if (scene.fog) {
      scene.fog.near = globeMode ? globeR * 2.2 : WORLD * 0.9;
      scene.fog.far = globeMode ? globeR * 6 : WORLD * 2.4;
    }
    controls.minDistance = globeMode ? WORLD * 0.12 : WORLD * 0.25;
    controls.maxDistance = globeMode ? globeR * 4 : WORLD * 2.2;
    if (globeMode) {
      // 丸い玉が画面に収まる斜め見下ろし構図へ寄せる(列島が玉の上に乗って見える)
      camera.position.set(globeR * 0.9, globeR * 1.0, globeR * 1.2);
      controls.target.set(0, 0, 0);
    } else {
      controls.target.set(0, WORLD * 0.04, 0);
    }
    controls.update();
  }

  // ドローン飛行モード: OrbitControls を止めて FlyControls で自由飛行する。
  let fly = null, droneMode = false;
  function setDrone(on) {
    droneMode = !!on;
    if (droneMode) {
      controls.enabled = false;
      state.autoOrbit = false;
      // 列島の上空・斜め前向きから開始
      camera.position.set(0, WORLD * 0.18, WORLD * 0.55);
      camera.lookAt(0, 0, 0);
      fly = new FlyControls(camera, renderer.domElement);
      fly.movementSpeed = WORLD * 0.22;   // 飛行速度(u/秒)
      fly.rollSpeed = 0.5;                 // 視線回転
      fly.dragToLook = true;               // ドラッグ中だけ視線が回る(誤操作防止)
      fly.autoForward = false;
    } else {
      if (fly) { fly.dispose(); fly = null; }
      controls.enabled = true;
      controls.target.set(0, WORLD * 0.04, 0);
      controls.update();
    }
  }

  // ===== 断面(スライス)モード ============================================
  // クリップ面で地形の片側を切り、切断線に沿って標高で地層着色した「断面ウォール」を立てる。
  // 山の内部構造が見える地学的な断面表現。スライダーで断面位置、トグルで切る向きを変える。
  // axis/pos = 単純な東西・南北ライン(既定)。a,b = 地形クリックで取る任意2点。
  // lineMode: 'infinite'(2点を通る直線で地形を切る) / 'segment'(2点間だけの断面カーテン,地形は切らない)
  const sliceState = { on: false, axis: 'x', pos: 0.5, lineMode: 'infinite', a: null, b: null };
  const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  let sliceWall = null;
  const SECT_BASE_M = -400;   // 断面ウォールの底(海面下のロック層)
  // 2点A/Bのマーカー
  const mkMarker = (color) => { const m = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 12), new THREE.MeshBasicMaterial({ color })); m.visible = false; scene.add(m); return m; };
  const markerA = mkMarker(0xff4d4d), markerB = mkMarker(0x4da6ff);
  // 標高(m)→地層色。地下=暗い岩、海面下=濃青、地上=青緑→緑→黄褐→茶→雪。50m毎に地層線。
  function strataColor(m) {
    let r, g, b;
    if (m < 0) { const t = Math.max(0, 1 + m / 400); r = 0.18 + 0.12 * t; g = 0.13 + 0.09 * t; b = 0.11 + 0.08 * t; }
    else if (m < 50) { r = 0.30; g = 0.50; b = 0.60; }
    else if (m < 400) { const t = (m - 50) / 350; r = 0.36 + 0.20 * t; g = 0.58; b = 0.42 - 0.10 * t; }
    else if (m < 1200) { const t = (m - 400) / 800; r = 0.56 + 0.22 * t; g = 0.60 - 0.16 * t; b = 0.32 - 0.10 * t; }
    else if (m < 2400) { const t = (m - 1200) / 1200; r = 0.62 - 0.20 * t; g = 0.44 - 0.18 * t; b = 0.26 - 0.10 * t; }
    else { const t = Math.min(1, (m - 2400) / 1200); r = 0.42 + 0.5 * t; g = 0.30 + 0.6 * t; b = 0.18 + 0.7 * t; }
    if (m > 0 && (m % 250) < 12) { r *= 0.72; g *= 0.72; b *= 0.72; } // 地層線(250m毎)
    return [r, g, b];
  }
  // 無限直線 a+t·d を盤面 [-half,half]² にクリップ(Liang-Barsky)して両端を返す
  function clipLineToSquare(a, dx, dz, half) {
    let t0 = -Infinity, t1 = Infinity;
    const edge = (p, q) => { // p·t <= q
      if (Math.abs(p) < 1e-9) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    if (edge(-dx, a.x + half) && edge(dx, half - a.x) && edge(-dz, a.z + half) && edge(dz, half - a.z)) {
      return { p0: { x: a.x + t0 * dx, z: a.z + t0 * dz }, p1: { x: a.x + t1 * dx, z: a.z + t1 * dz } };
    }
    return { p0: a, p1: { x: a.x + dx, z: a.z + dz } };
  }
  // 現在の断面ライン: 両端 p0/p1 と、地形を切るか(clip)＋クリップ法線
  function sliceLine() {
    const half = WORLD / 2;
    if (sliceState.a && sliceState.b) {
      const a = sliceState.a, b = sliceState.b, dx = b.x - a.x, dz = b.z - a.z;
      if (sliceState.lineMode === 'segment') return { p0: a, p1: b, clip: false };
      const e = clipLineToSquare(a, dx, dz, half);
      return { p0: e.p0, p1: e.p1, clip: true, nx: dz, nz: -dx, px: a.x, pz: a.z };
    }
    const along = sliceState.pos * WORLD - half; // 軸ライン(東西/南北)
    return sliceState.axis === 'x'
      ? { p0: { x: along, z: -half }, p1: { x: along, z: half }, clip: true, nx: -1, nz: 0, px: along, pz: 0 }
      : { p0: { x: -half, z: along }, p1: { x: half, z: along }, clip: true, nx: 0, nz: -1, px: 0, pz: along };
  }
  function buildSliceWall() {
    if (sliceWall) { scene.remove(sliceWall); sliceWall.geometry.dispose(); sliceWall.material.dispose(); sliceWall = null; }
    if (!sliceState.on) return;
    const L = sliceLine();
    const N = 220, M = 28;                       // 断面方向Nサンプル × 縦M層
    const baseY = SECT_BASE_M * HEIGHT_EXAGG * vScale;
    const pos = new Float32Array(N * M * 3), col = new Float32Array(N * M * 3);
    for (let j = 0; j < N; j++) {
      const f = j / (N - 1);
      const wx = L.p0.x + (L.p1.x - L.p0.x) * f, wz = L.p0.z + (L.p1.z - L.p0.z) * f;
      const top = elevWorld(wx, wz);
      for (let i = 0; i < M; i++) {
        const y = baseY + (top - baseY) * (i / (M - 1));
        const k = (j * M + i) * 3;
        pos[k] = wx; pos[k + 1] = y; pos[k + 2] = wz;
        const c = strataColor(y / (HEIGHT_EXAGG * vScale));
        col[k] = c[0]; col[k + 1] = c[1]; col[k + 2] = c[2];
      }
    }
    const indices = [];
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < M - 1; i++) {
      const a = j * M + i, b = (j + 1) * M + i, c = j * M + i + 1, d = (j + 1) * M + i + 1;
      indices.push(a, b, c, c, b, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(indices); g.computeVertexNormals();
    sliceWall = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    scene.add(sliceWall);
  }
  function applyClip() {
    const L = sliceLine();
    let planes = [];
    if (sliceState.on && L.clip) {
      const len = Math.hypot(L.nx, L.nz) || 1;
      clipPlane.normal.set(L.nx / len, 0, L.nz / len);
      clipPlane.constant = -(clipPlane.normal.x * L.px + clipPlane.normal.z * L.pz);
      planes = [clipPlane];
    }
    terrainMat.clippingPlanes = planes; terrainMat.needsUpdate = true;
    sea.material.clippingPlanes = planes;
  }
  function updateSliceMarkers() {
    const a = sliceState.a, b = sliceState.b;
    markerA.visible = !!(sliceState.on && a); if (a) markerA.position.set(a.x, elevWorld(a.x, a.z) + 1.5, a.z);
    markerB.visible = !!(sliceState.on && b); if (b) markerB.position.set(b.x, elevWorld(b.x, b.z) + 1.5, b.z);
  }
  const refreshSlice = () => { applyClip(); buildSliceWall(); updateSliceMarkers(); };
  // 地形クリックで2点を取る(A→B→A…)。OrbitControlsと両立するためドラッグは除外。
  const sliceRay = new THREE.Raycaster();
  let downPt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downPt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!sliceState.on || !downPt) { downPt = null; return; }
    const moved = Math.hypot(e.clientX - downPt[0], e.clientY - downPt[1]); downPt = null;
    if (moved > 5) return; // ドラッグ(回転)はピックしない
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    sliceRay.setFromCamera(ndc, camera);
    const hit = sliceRay.intersectObject(terrain, false)[0];
    if (!hit) return;
    const p = { x: hit.point.x, z: hit.point.z };
    if (!sliceState.a || (sliceState.a && sliceState.b)) { sliceState.a = p; sliceState.b = null; } else { sliceState.b = p; }
    refreshSlice();
  });
  function setSlice(on) { sliceState.on = !!on; refreshSlice(); }
  function setSlicePos(p) { sliceState.pos = Math.max(0, Math.min(1, p)); if (!(sliceState.a && sliceState.b)) refreshSlice(); }
  function setSliceAxis(ax) { sliceState.axis = ax === 'z' ? 'z' : 'x'; if (!(sliceState.a && sliceState.b)) refreshSlice(); }
  function setSliceLineMode(seg) { sliceState.lineMode = seg ? 'segment' : 'infinite'; refreshSlice(); }
  function resetSliceLine() { sliceState.a = null; sliceState.b = null; refreshSlice(); }

  // 球の半径(丸み)をスライダーで変更。小さいほど丸い玉に見える。カメラは動かさない。
  function setGlobeRadius(mult) {
    globeR = WORLD * Math.max(0.4, mult);
    applyOcean();
    if (globeMode) {
      projectVerts();
      if (scene.fog) { scene.fog.near = globeR * 2.2; scene.fog.far = globeR * 6; }
      controls.maxDistance = globeR * 4;
    }
  }

  // --- HUD トグル結線 -------------------------------------------------------
  if (opts.hud) wireHud(opts.hud, state);

  // --- リサイズ -------------------------------------------------------------
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }
  window.addEventListener('resize', resize);

  // --- メインループ ---------------------------------------------------------
  const clock = new THREE.Clock();
  let orbitAngle = Math.atan2(camera.position.z, camera.position.x);

  function tick() {
    const dt = Math.min(0.05, clock.getDelta());

    if (droneMode && fly) {
      // ドローン飛行: FlyControls で自由飛行(WASD移動・ドラッグで視線・R/F上下)
      fly.update(dt);
    } else {
      // 自動周回
      if (state.autoOrbit) {
        orbitAngle += state.orbitSpeed * dt;
        const r = Math.hypot(camera.position.x, camera.position.z);
        camera.position.x = Math.cos(orbitAngle) * r;
        camera.position.z = Math.sin(orbitAngle) * r;
      } else {
        orbitAngle = Math.atan2(camera.position.z, camera.position.x);
      }
      controls.update();
    }

    // 電車走行：弧長で等速、各車を後ろにずらして連結。地形に沿って接地＋傾斜にピッチ。
    if (!spectate) {
    trainState.t = (trainState.t + state.trainSpeed * dt) % 1;
    const EPS = 0.008;          // 先読み量(車体長ぶん)
    const CLEAR = 0.85;         // 地形からの浮き(レール高)
    for (let i = 0; i < cars.length; i++) {
      const tt = (trainState.t - i * trainState.gap + 1) % 1;
      const p = curve.getPointAt(tt);
      const tan = curve.getTangentAt(tt);
      const ahead = curve.getPointAt((tt + EPS) % 1);
      const behind = curve.getPointAt((tt - EPS + 1) % 1);
      const hC = elevWorld(p.x, p.z), hA = elevWorld(ahead.x, ahead.z), hB = elevWorld(behind.x, behind.z);
      // 接地: 車体が跨ぐ地形の最大値＋クリアランス(凸尾根で潜らない)
      const y = Math.max(hC, hA, hB) + CLEAR;
      cars[i].position.set(p.x, y, p.z);
      // 向き: 進行方向にヨー＋斜面に沿ってピッチ(登りは鼻先を上げる)
      const horiz = Math.hypot(ahead.x - behind.x, ahead.z - behind.z) || 1e-3;
      const pitch = Math.atan2(hA - hB, horiz);
      cars[i].rotation.order = 'YXZ';
      cars[i].rotation.y = Math.atan2(tan.x, tan.z);
      cars[i].rotation.x = -pitch;   // 登坂で鼻上げ・降坂で鼻下げ
    }

    // 煙の放出（機関車先頭から）
    const head = cars[0];
    if (Math.random() < 0.4) {
      const sp = smokes[smokeIdx % smokes.length]; smokeIdx++;
      sp.visible = true;
      sp.position.copy(head.position).add(new THREE.Vector3(0, 1.3, 0));
      const sc2 = 0.6;
      sp.scale.set(sc2, sc2, sc2);
      sp.userData.life = 0;
      sp.userData.max = 1.6 + Math.random() * 0.8;
      sp.userData.vy = 2.2 + Math.random();
      sp.userData.drift.set((Math.random() - 0.5) * 1.5, 0, (Math.random() - 0.5) * 1.5);
      sp.material.opacity = 0.55;
    }
    for (const sp of smokes) {
      if (!sp.visible) continue;
      sp.userData.life += dt;
      const k = sp.userData.life / sp.userData.max;
      if (k >= 1) { sp.visible = false; continue; }
      sp.position.y += sp.userData.vy * dt;
      sp.position.addScaledVector(sp.userData.drift, dt);
      const s = 0.6 + k * 2.4;
      sp.scale.set(s, s, s);
      sp.material.opacity = 0.55 * (1 - k);
    }
    } // !spectate（装飾電車・煙）

    // 町のうにょうにょ
    animateTowns(towns, dt, performance.now() / 1000);

    // 観戦の駒など、外部フックを毎フレーム駆動
    for (const fn of tickHooks) { try { fn(dt); } catch (e) { /* 1つの駒のエラーで全体を止めない */ } }

    resize();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();

  // 緯度経度 → 地形ワールド(x,z)。heightfield.bounds の矩形を WORLD 正方形へ線形写像。
  // 地形の南北規約: grid row0=北=z最小(-WORLD/2)、東=x最大(+WORLD/2)。よって
  //   x: lon0(西)→-WORLD/2 .. lon1(東)→+WORLD/2
  //   z: lat1(北)→-WORLD/2 .. lat0(南)→+WORLD/2
  function latLonToWorld(lat, lon) {
    if (!bounds) return null;
    const u = (lon - bounds.lon0) / (bounds.lon1 - bounds.lon0);   // 0(西)..1(東)
    const v = (bounds.lat1 - lat) / (bounds.lat1 - bounds.lat0);   // 0(北)..1(南)
    const x = (u - 0.5) * WORLD;
    const z = (v - 0.5) * WORLD;
    return { x, z, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
  }

  return {
    THREE, scene, camera, renderer, controls, state,
    WORLD, bounds, elevWorld, latLonToWorld, tickHooks,
    // HUD用: 標高スケール / 標高図(段彩) / 等高線 の切替
    setVScale: (s) => rescale(s),
    setTint: (on) => { terrainUniforms.uTint.value = on ? 1 : 0; },
    setContour: (on) => { terrainUniforms.uContour.value = on ? 1 : 0; },
    setContourInterval: (m) => { terrainUniforms.uInterval.value = Math.max(20, m); },
    setWinter: (on) => { terrainUniforms.uWinter.value = on ? 1 : 0; },
    setGlobe: (on) => setGlobe(on),
    setGlobeRadius: (mult) => setGlobeRadius(mult),
    setDrone: (on) => setDrone(on),
    setSlice: (on) => setSlice(on),
    setSlicePos: (p) => setSlicePos(p),
    setSliceAxis: (ax) => setSliceAxis(ax),
    setSliceLineMode: (seg) => setSliceLineMode(seg),
    resetSliceLine: () => resetSliceLine(),
    hasGlobe,
    info: { grid: GRID, maxElev, stations: stations.length, towns: towns.length, heightExagg: HEIGHT_EXAGG },
  };
}

// === ヘルパ群 ===============================================================

// 標高の高めの点をグリッドから等間隔に選び、ワールド座標の駅リストを返す
function pickStations(heights, GRID, WORLD, n) {
  // グリッドを n 方向の円周上に配置し、その地点の標高に応じて少し中心寄せ。
  // 「尾根/谷を結ぶ適当ルート」感を出すため、角度ごとに半径を揺らす。
  const stations = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + 0.4;
    const rad = (0.18 + 0.14 * Math.sin(i * 1.7) + 0.1 * Math.cos(i * 0.9)); // 0.. ~0.42
    const x = Math.cos(ang) * WORLD * rad;
    const z = Math.sin(ang) * WORLD * rad;
    stations.push({ x, z });
  }
  return stations;
}

// 平地（標高が低めで陸地）な点を町クラスタの中心に選ぶ
function buildTowns(scene, heights, GRID, WORLD, elevWorld) {
  const HEIGHT_EXAGG = 0.0085;
  const towns = [];
  const nTowns = 5;
  // 候補: グリッドを粗くサンプルして「陸かつ低め」を集め、その中からばらけて選ぶ
  const candidates = [];
  for (let gy = 8; gy < GRID - 8; gy += 6) {
    for (let gx = 8; gx < GRID - 8; gx += 6) {
      // 配置時に cz=(GRID-1-gy)→world、elevWorld がそれを再反転して baseY を出すので、
      // この座標の実標高は heights[gy*GRID+gx]。低地選別はこの素の参照が正しい。
      const h = heights[gy * GRID + gx];
      if (h > 30 && h < 900) candidates.push({ gx, gy, h });
    }
  }
  candidates.sort(() => Math.random() - 0.5);
  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= nTowns) break;
    // 既存の町と離す
    if (chosen.every((o) => Math.hypot(o.gx - c.gx, o.gy - c.gy) > GRID * 0.16)) chosen.push(c);
  }

  const buildingGeo = new THREE.BoxGeometry(1, 1, 1);
  for (const c of chosen) {
    // グリッド→ワールド（反転なし: row0=北=iy0=world z最小、で地形と一致）
    const cx = (c.gx / (GRID - 1)) * WORLD - WORLD / 2;
    const cz = (c.gy / (GRID - 1)) * WORLD - WORLD / 2;
    const baseY = elevWorld(cx, cz);

    const town = new THREE.Group();
    town.position.set(cx, 0, cz);

    const count = 26 + Math.floor(Math.random() * 30);
    const inst = new THREE.InstancedMesh(
      buildingGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05, vertexColors: false }),
      count
    );
    inst.castShadow = true;
    inst.receiveShadow = true;
    const dummy = new THREE.Object3D();
    const winColors = new Float32Array(count * 3);
    const baseHeights = new Float32Array(count);
    const phases = new Float32Array(count);
    const spread = WORLD * 0.045;
    for (let i = 0; i < count; i++) {
      const ox = (Math.random() - 0.5) * 2 * spread;
      const oz = (Math.random() - 0.5) * 2 * spread;
      const bw = 0.8 + Math.random() * 1.0;
      const bh = 1.5 + Math.random() * Math.random() * 7.0; // 賑わうほど高い（たまに高層）
      const gy = elevWorld(cx + ox, cz + oz);
      dummy.position.set(ox, gy - baseY + bh / 2, oz);
      dummy.scale.set(bw, bh, bw);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      baseHeights[i] = bh;
      phases[i] = Math.random() * Math.PI * 2;
      // 落ち着いた町色（ベージュ〜灰）
      const tone = 0.55 + Math.random() * 0.3;
      inst.setColorAt(i, new THREE.Color(tone, tone * 0.96, tone * 0.88));
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    town.add(inst);

    // 窓灯り（夜っぽい点滅）を表す小さな発光板を上空に薄く
    const glow = new THREE.PointLight(0xffcf80, 0.0, spread * 3.5, 2);
    glow.position.set(0, 4, 0);
    town.add(glow);

    // 小ドット（車/人）がクラスタ内をうにょうにょ巡回
    const dots = new THREE.Group();
    const nDots = 14;
    const dotGeo = new THREE.SphereGeometry(0.28, 6, 6);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffeebb });
    const dotData = [];
    for (let i = 0; i < nDots; i++) {
      const d = new THREE.Mesh(dotGeo, dotMat.clone());
      d.material.color.setHSL(0.08 + Math.random() * 0.12, 0.6, 0.6);
      dots.add(d);
      dotData.push({
        r: spread * (0.3 + Math.random() * 0.7),
        a: Math.random() * Math.PI * 2,
        spd: (Math.random() < 0.5 ? 1 : -1) * (0.3 + Math.random() * 0.6),
        wob: Math.random() * 10,
      });
    }
    town.add(dots);

    scene.add(town);
    towns.push({ group: town, inst, baseHeights, phases, count, glow, dots, dotData, baseY, cx, cz, spread, elevWorld });
  }
  return towns;
}

function animateTowns(towns, dt, t) {
  for (const tw of towns) {
    // 窓灯りをゆっくり脈動（賑わいの呼吸）
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.6 + tw.cx * 0.01);
    tw.glow.intensity = 0.8 + 1.6 * pulse;

    // 小ドットの巡回（地形に接地しつつ円弧を描く）
    for (let i = 0; i < tw.dotData.length; i++) {
      const d = tw.dotData[i];
      d.a += d.spd * dt;
      const ox = Math.cos(d.a) * d.r + Math.sin(t * 0.7 + d.wob) * tw.spread * 0.12;
      const oz = Math.sin(d.a) * d.r + Math.cos(t * 0.5 + d.wob) * tw.spread * 0.12;
      const gy = tw.elevWorld(tw.cx + ox, tw.cz + oz);
      const dot = tw.dots.children[i];
      dot.position.set(ox, gy - tw.baseY + 0.4, oz);
    }
  }
}

// ふわっとした煙用の放射状アルファテクスチャを生成
function makeSmokeTexture() {
  const s = 64;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = s;
  const ctx = cvs.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(245,245,245,0.4)');
  g.addColorStop(1, 'rgba(240,240,240,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// HUD のチェックボックス/スライダを state に結線
function wireHud(hud, state) {
  const orbit = hud.querySelector('#autoOrbit');
  if (orbit) {
    orbit.checked = state.autoOrbit;
    orbit.addEventListener('change', () => { state.autoOrbit = orbit.checked; });
  }
  const tspd = hud.querySelector('#trainSpeed');
  if (tspd) {
    tspd.value = String(state.trainSpeed);
    tspd.addEventListener('input', () => { state.trainSpeed = Number(tspd.value); });
  }
}
