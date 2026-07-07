// mapcore/fx.js — 画面演出(wipe等)の共通実装。データ描画には一切触れない表示専用層。
// 各レンダラが mount 要素を渡して使う。進行は rAF+実時計(カメラ/画面演出はブラウザ描画と
// 同期する必要があり、fake clock 対象は movers/追従のみ、という切り分け)。

/**
 * mount 要素に対する wipe 関数を作る。
 * wipe({ type:'circle'|'directional', center:{x,y}(0..1), duration, color,
 *        direction:'in'|'out'|'inout', onMid, onDone })
 * 進行中の wipe は新しい呼び出しで即置き換え(演出の割り込み — drama-engine の
 * interrupt セマンティクスに合わせる)。
 */
export function createWipe(mount) {
  let wipeEl = null;
  function wipe({ type = 'circle', center = { x: 0.5, y: 0.5 }, duration = 700, color = '#0e1116', direction = 'inout', onMid, onDone } = {}) {
    if (wipeEl) { wipeEl.remove(); wipeEl = null; }
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;inset:0;z-index:30;pointer-events:none;background:${color};`;
    mount.appendChild(el);
    wipeEl = el;
    const cx = center.x * 100;
    const cy = center.y * 100;
    const clip = (t) => (type === 'circle'
      ? `circle(${t * 150}% at ${cx}% ${cy}%)`
      : `inset(0 ${(1 - t) * 100}% 0 0)`);
    const start = performance.now();
    const half = direction === 'inout' ? duration / 2 : duration;
    let midFired = false;
    function frame(now) {
      if (el !== wipeEl) return; // 置き換えられた(割り込み)
      const e = now - start;
      let t;
      if (direction === 'in') t = Math.min(1, e / half);
      else if (direction === 'out') t = Math.max(0, 1 - e / half);
      else t = e < half ? e / half : Math.max(0, 1 - (e - half) / half); // inout
      el.style.clipPath = clip(t);
      if (direction === 'inout' && !midFired && e >= half) { midFired = true; if (onMid) onMid(); }
      const total = direction === 'inout' ? duration : half;
      if (e < total) requestAnimationFrame(frame);
      else { el.remove(); if (el === wipeEl) wipeEl = null; if (onDone) onDone(); }
    }
    requestAnimationFrame(frame);
  }
  wipe.destroy = () => { if (wipeEl) { wipeEl.remove(); wipeEl = null; } };
  return wipe;
}
