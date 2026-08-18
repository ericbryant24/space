import { mantissaHeadroom, metresPerPixel, pxPerUnit, type Camera } from '../camera/camera.ts';
import { LEVELS, formatDistance } from '../universe/schema.ts';
import type { RenderStats } from '../render/renderer.ts';

/**
 * The debug overlay. This is the most valuable piece of infrastructure in the project: R and the
 * mantissa headroom are the two numbers that tell you instantly whether the precision invariant is
 * still holding, and a regression in either is invisible in a screenshot.
 */
export function createHud(root: HTMLElement): {
  update(cam: Camera, stats: RenderStats, fps: number, frameMs: number): void;
} {
  const el = document.createElement('div');
  el.className = 'hud';
  root.appendChild(el);

  const scale = document.createElement('div');
  scale.className = 'scalebar';
  root.appendChild(scale);

  return {
    update(cam, stats, fps, frameMs) {
      const r = pxPerUnit(cam);
      const headroom = mantissaHeadroom(cam);
      const ladder = ['field', ...cam.node.path.map((_, i) => kindAtDepth(i + 1))];
      const inWindow = r >= 64 && r <= 1024;

      el.innerHTML = `
        <div class="row"><b>${LEVELS[cam.node.kind].label}</b> <span class="dim">depth ${cam.node.path.length}</span></div>
        <div class="row trail">${ladder.map((k, i) => `<span class="${i === ladder.length - 1 ? 'on' : ''}">${k}</span>`).join('<span class="sep">/</span>')}</div>
        <div class="row"><span class="dim">R</span> <span class="${inWindow ? 'good' : 'bad'}">${r.toFixed(1)} px</span> <span class="dim">[64, 1024]</span></div>
        <div class="row"><span class="dim">mantissa</span> <span class="${headroom > 30 ? 'good' : 'bad'}">${headroom.toFixed(1)} bits</span></div>
        <div class="row"><span class="dim">z</span> ${cam.z.toFixed(3)} <span class="dim">k</span> ${cam.k}</div>
        <div class="row"><span class="dim">cell</span> ${cam.cx}, ${cam.cy}</div>
        <div class="row"><span class="dim">offset</span> ${cam.fx.toFixed(4)}, ${cam.fy.toFixed(4)}</div>
        <div class="row"><span class="dim">top</span> ${stats.topKind} <span class="dim">draws</span> ${stats.draws}${stats.budgetHit ? ' <span class="bad">capped</span>' : ''}</div>
        <div class="row"><span class="dim">cells</span> ${stats.cells} <span class="dim">fps</span> ${fps.toFixed(0)} <span class="dim">ms</span> ${frameMs.toFixed(1)}</div>
      `;

      // A real scale bar in real units. Cheap, and it grounds the whole descent.
      const mpp = metresPerPixel(cam);
      const target = 140;
      const raw = mpp * target;
      const pow = 10 ** Math.floor(Math.log10(raw));
      const nice = [1, 2, 5, 10].map((m) => m * pow).reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
      scale.innerHTML = `<span class="bar" style="width:${(nice / mpp).toFixed(1)}px"></span><span class="len">${formatDistance(nice)}</span>`;
    },
  };
}

function kindAtDepth(depth: number): string {
  const order = ['field', 'cluster', 'galaxy', 'system', 'planet', 'region', 'settlement', 'building'];
  return order[Math.min(depth, order.length - 1)]!;
}
