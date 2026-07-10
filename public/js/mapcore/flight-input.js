// mapcore/flight-input.js — フライトモードの操縦入力(Gamepad API + キーボード代替)。
//
// flight.js は step(dt, input) の純物理なので、入力はここで一元的に作って渡す。
// poll(dt) が {pitch, roll, yaw, throttle, boost, level} を返す。
//
// ゲームパッド(standardマッピング / Xbox配列):
//   左スティック上下 = エレベータ(下に倒す=機首上げ、実機と同じ引き操作)
//   左スティック左右 = エルロン(バンク)
//   右スティック左右 = ラダー(ヨー)
//   RT/LT            = スロットル 増/減(アナログ)
//   A                = アフターバーナー
//   B                = 水平に戻す
// キーボード: ↑↓=エレベータ / ←→=エルロン / Q,E=ラダー / W,S=スロットル / Space=AB / X=水平

const DEAD = 0.12;

/** スティックのデッドゾーン処理(外側を0..1へ引き伸ばす)。 */
function dz(v) {
  if (Math.abs(v) < DEAD) return 0;
  return (v - Math.sign(v) * DEAD) / (1 - DEAD);
}

function firstPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) if (p && p.connected) return p;
  return null;
}

/**
 * @param opts { throttleRate:1秒あたりのスロットル変化量, initialThrottle }
 * @returns { poll(dt), dispose(), hasPad() }
 */
export function createFlightInput(opts = {}) {
  // レバーの動く速さ(1秒あたり)。スロットルは等比なので、0.1なら1秒押して速度が約1.66倍。
  // 0から全開まで10秒 — 速すぎると押した瞬間にマッハ10へ飛んでいってしまう
  const throttleRate = opts.throttleRate ?? 0.1;
  let throttle = opts.initialThrottle ?? 0.35;
  const keys = new Set();

  const down = (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    keys.add(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };
  const up = (e) => keys.delete(e.code);
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);

  function poll(dt) {
    const pad = firstPad();
    let pitch = 0; let roll = 0; let yaw = 0; let boost = false; let level = false;
    let dThrottle = 0;

    if (pad) {
      const ax = pad.axes || [];
      roll = dz(ax[0] || 0);
      pitch = dz(ax[1] || 0);      // 手前に引く(+1)=機首上げ。ax[1]は下が+なのでそのまま
      yaw = dz(ax[2] || 0);
      const btn = (i) => (pad.buttons && pad.buttons[i] ? pad.buttons[i].value : 0);
      dThrottle = (btn(7) - btn(6)) * throttleRate;   // RT - LT
      boost = !!(pad.buttons && pad.buttons[0] && pad.buttons[0].pressed);
      level = !!(pad.buttons && pad.buttons[1] && pad.buttons[1].pressed);
    }

    // キーボードは加算(パッドと併用可)
    if (keys.has('ArrowUp')) pitch += 1;
    if (keys.has('ArrowDown')) pitch -= 1;
    if (keys.has('ArrowRight')) roll += 1;
    if (keys.has('ArrowLeft')) roll -= 1;
    if (keys.has('KeyE')) yaw += 1;
    if (keys.has('KeyQ')) yaw -= 1;
    if (keys.has('KeyW')) dThrottle += throttleRate;
    if (keys.has('KeyS')) dThrottle -= throttleRate;
    if (keys.has('Space')) boost = true;
    if (keys.has('KeyX')) level = true;

    throttle = Math.min(1, Math.max(0, throttle + dThrottle * dt));

    return {
      pitch: Math.max(-1, Math.min(1, pitch)),
      roll: level ? 0 : Math.max(-1, Math.min(1, roll)),
      yaw: Math.max(-1, Math.min(1, yaw)),
      throttle, boost, level,
    };
  }

  function dispose() {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    keys.clear();
  }

  return { poll, dispose, hasPad: () => !!firstPad(), setThrottle: (v) => { throttle = v; } };
}
