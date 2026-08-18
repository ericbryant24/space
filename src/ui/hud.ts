import { mantissaHeadroom, metresPerPixel, pxPerUnit, type Camera } from '../camera/camera.ts';
import { catalogName } from '../cosmic/catalog.ts';
import { KIND_ORDER, LEVELS, formatDistance } from '../universe/schema.ts';
import type { RenderStats } from '../render/renderer.ts';

export interface Hud {
  update(cam: Camera, stats: RenderStats, fps: number, frameMs: number): void;
}

/**
 * Chrome, plus the debug overlay.
 *
 * R and the mantissa headroom are the two numbers that say whether the precision invariant still
 * holds, and a regression in either is completely invisible in a screenshot. Keeping them on screen
 * has been the single most useful piece of infrastructure in the project.
 */
export function createHud(root: HTMLElement, onCrumb: (depth: number) => void): Hud {
  const trail = document.createElement('nav');
  trail.className = 'trail';
  root.appendChild(trail);

  const panel = document.createElement('div');
  panel.className = 'hud';
  root.appendChild(panel);

  const scale = document.createElement('div');
  scale.className = 'scalebar';
  root.appendChild(scale);

  trail.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-depth]');
    if (!target) return;
    onCrumb(Number(target.getAttribute('data-depth')));
  });

  let lastTrailKey = '';

  return {
    update(cam, stats, fps, frameMs) {
      const r = pxPerUnit(cam);
      const headroom = mantissaHeadroom(cam);
      const inWindow = r >= 64 && r <= 1024;
      const depth = cam.node.path.length;

      // Rebuild the breadcrumb only when the lineage changes, so clicks are not eaten by a DOM swap
      // happening underneath the pointer every frame.
      const trailKey = cam.node.path.map((c) => `${c.cx}.${c.cy}`).join('/');
      if (trailKey !== lastTrailKey) {
        lastTrailKey = trailKey;
        const crumbs: string[] = [];
        for (let d = 0; d <= depth; d++) {
          const kind = KIND_ORDER[Math.min(d, KIND_ORDER.length - 1)]!;
          const here = d === depth;
          crumbs.push(
            `<button class="crumb${here ? ' on' : ''}" data-depth="${d}"${here ? ' disabled' : ''}>` +
              `<span class="kind">${LEVELS[kind].label}</span></button>`,
          );
        }
        trail.innerHTML = crumbs.join('<span class="sep">/</span>');
      }

      const last = cam.node.path[depth - 1];
      const name = catalogName(cam.node.kind, cam.node.id, last ? last.cx + last.cy : 0);

      panel.innerHTML = `
        <div class="name">${escapeHtml(name)}</div>
        <div class="sub">${LEVELS[cam.node.kind].label} &middot; depth ${depth}</div>
        <div class="rows">
          <div><span class="dim">R</span> <span class="${inWindow ? 'good' : 'bad'}">${r.toFixed(1)} px</span> <span class="dim">[64, 1024]</span></div>
          <div><span class="dim">mantissa</span> <span class="${headroom > 30 ? 'good' : 'bad'}">${headroom.toFixed(1)} bits</span></div>
          <div><span class="dim">z</span> ${cam.z.toFixed(3)} <span class="dim">k</span> ${cam.k} <span class="dim">cell</span> ${cam.cx}, ${cam.cy}</div>
          <div><span class="dim">offset</span> ${cam.fx.toFixed(4)}, ${cam.fy.toFixed(4)}</div>
          <div><span class="dim">draws</span> ${stats.draws}${stats.budgetHit ? ' <span class="bad">capped</span>' : ''} <span class="dim">fps</span> ${fps.toFixed(0)} <span class="dim">ms</span> ${frameMs.toFixed(1)}</div>
        </div>
      `;

      // A real scale bar in real units. Cheap, and it grounds the whole descent.
      const mpp = metresPerPixel(cam);
      const raw = mpp * 140;
      const pow = 10 ** Math.floor(Math.log10(raw));
      const nice = [1, 2, 5, 10]
        .map((m) => m * pow)
        .reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
      scale.innerHTML =
        `<span class="bar" style="width:${(nice / mpp).toFixed(1)}px"></span>` +
        `<span class="len">${formatDistance(nice)}</span>`;
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
