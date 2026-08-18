import { mantissaHeadroom, metresPerPixel, pxPerUnit, type Camera } from '../camera/camera.ts';
import { displayName } from '../render/renderer.ts';
import { KIND_ORDER, formatDistance } from '../universe/schema.ts';
import type { Tree } from '../universe/tree.ts';
import type { RenderStats } from '../render/renderer.ts';

export interface Hud {
  update(cam: Camera, stats: RenderStats, fps: number, frameMs: number): void;
  /** Show or hide the numbers. Bound to the backtick key; off unless someone asks for it. */
  setDebug(on: boolean): void;
  debugVisible(): boolean;
}

/**
 * NO WORDS. The chrome is one wordless thing: a ladder of eight rungs saying how deep you are.
 *
 * What used to be here was a place card with a name and a line of lore, a breadcrumb trail of level names, and a
 * scale bar reading "4.2 AU" -- all of it true, all of it a readout of the thing on screen, and all of it an
 * admission about the drawing. A picture that needs a caption has not been drawn well enough, and the caption is
 * what you end up reading instead of looking. So the words are gone, and what replaced the one job they did
 * honestly -- holding on to a place you found -- is bookmarking, in src/ui/bookmarks.ts.
 *
 * The rungs keep the breadcrumb's function. Eight pips, the one you are on filled, the ones above it clickable:
 * that is the whole of "where am I and how do I get back out", with nothing to read.
 *
 * The numbers stay, behind the backtick key. R and the mantissa headroom are the two that say whether the
 * precision invariant still holds, and a regression in either is invisible in a screenshot -- keeping them
 * reachable has been the most useful piece of infrastructure in the project.
 */
export function createHud(root: HTMLElement, tree: Tree, onCrumb: (depth: number) => void): Hud {
  const rungs = document.createElement('nav');
  rungs.className = 'rungs';
  for (let d = 0; d < KIND_ORDER.length; d++) {
    const pip = document.createElement('button');
    pip.className = 'pip';
    pip.setAttribute('data-depth', String(d));
    // The one concession to anyone who cannot see the pips: a tooltip, which is not on the screen.
    pip.title = KIND_ORDER[d]!;
    rungs.appendChild(pip);
  }
  root.appendChild(rungs);

  const panel = document.createElement('div');
  panel.className = 'hud';
  root.appendChild(panel);

  rungs.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-depth]');
    if (!target) return;
    onCrumb(Number(target.getAttribute('data-depth')));
  });

  const pips = [...rungs.querySelectorAll<HTMLElement>('.pip')];
  let lastDepth = -1;
  let debug = false;

  return {
    setDebug(on) {
      debug = on;
      panel.classList.toggle('measuring', on);
      if (!on) panel.innerHTML = '';
    },
    debugVisible() {
      return debug;
    },
    update(cam, stats, fps, frameMs) {
      const depth = cam.node.path.length;
      if (depth !== lastDepth) {
        lastDepth = depth;
        pips.forEach((pip, d) => {
          pip.classList.toggle('on', d === depth);
          pip.classList.toggle('past', d < depth);
          // Rungs you have not reached are not places you can go to yet.
          (pip as HTMLButtonElement).disabled = d >= depth;
        });
      }
      if (!debug) return;

      const r = pxPerUnit(cam);
      const headroom = mantissaHeadroom(cam);
      const inWindow = r >= 64 && r <= 1024;
      const mpp = metresPerPixel(cam);
      const raw = mpp * 140;
      const pow = 10 ** Math.floor(Math.log10(raw));
      const nice = [1, 2, 5, 10]
        .map((m) => m * pow)
        .reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));

      panel.innerHTML =
        `<div class="rows">
          <div>${escapeHtml(displayName(cam.node, tree))}</div>
          <div><span class="dim">R</span> <span class="${inWindow ? 'good' : 'bad'}">${r.toFixed(1)} px</span> <span class="dim">[64, 1024]</span></div>
          <div><span class="dim">mantissa</span> <span class="${headroom > 30 ? 'good' : 'bad'}">${headroom.toFixed(1)} bits</span></div>
          <div><span class="dim">z</span> ${cam.z.toFixed(3)} <span class="dim">k</span> ${cam.k} <span class="dim">cell</span> ${cam.cx}, ${cam.cy}</div>
          <div><span class="dim">offset</span> ${cam.fx.toFixed(4)}, ${cam.fy.toFixed(4)}</div>
          <div><span class="dim">draws</span> ${stats.draws}${stats.budgetHit ? ' <span class="bad">capped</span>' : ''} <span class="dim">fps</span> ${fps.toFixed(0)} <span class="dim">ms</span> ${frameMs.toFixed(1)}</div>
          <div><span class="dim">scale</span> ${formatDistance(nice)} <span class="dim">build</span> ${escapeHtml(__BUILD__)}</div>
        </div>`;
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
