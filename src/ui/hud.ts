import { mantissaHeadroom, metresPerPixel, pxPerUnit, type Camera } from '../camera/camera.ts';
import { catalogName } from '../cosmic/catalog.ts';
import { describeLanguage } from '../culture/language.ts';
import { planetLine, settlementLine } from '../culture/lore.ts';
import { planetCultureFor } from '../universe/gen/culture.ts';
import { displayName } from '../render/renderer.ts';
import { KIND_ORDER, LEVELS, formatDistance } from '../universe/schema.ts';
import type { Tree } from '../universe/tree.ts';
import type { RenderStats } from '../render/renderer.ts';

export interface Hud {
  update(cam: Camera, stats: RenderStats, fps: number, frameMs: number): void;
  /** Show or hide the numbers. Bound to the backtick key; off unless someone asks for it. */
  setDebug(on: boolean): void;
  debugVisible(): boolean;
}

/**
 * Chrome: a name, a lineage, a scale bar. Plus the numbers, which are OFF BY DEFAULT.
 *
 * R and the mantissa headroom are the two numbers that say whether the precision invariant still holds,
 * and a regression in either is invisible in a screenshot -- keeping them on screen has been the most
 * useful piece of infrastructure in the project. They are also a wall of monospace telling you about the
 * renderer rather than about the universe, and a place that has to be explained in words has not been
 * drawn well enough. So they live behind the backtick key now.
 */
export function createHud(root: HTMLElement, tree: Tree, onCrumb: (depth: number) => void): Hud {
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
  let debug = false;

  return {
    setDebug(on) {
      debug = on;
      panel.classList.toggle('measuring', on);
    },
    debugVisible() {
      return debug;
    },
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

      const name = displayName(cam.node, tree);
      // A name and what kind of thing it is. Everything else about the place is on screen already, or is
      // not yet drawn well enough -- and a sentence explaining a picture is an admission about the picture.
      const card = placeCard(cam, tree);

      panel.innerHTML =
        `<div class="name">${escapeHtml(name)}</div>` +
        `<div class="sub">${escapeHtml(card.sub)}</div>` +
        (debug
          ? `<div class="rows">
          <div><span class="dim">R</span> <span class="${inWindow ? 'good' : 'bad'}">${r.toFixed(1)} px</span> <span class="dim">[64, 1024]</span></div>
          <div><span class="dim">mantissa</span> <span class="${headroom > 30 ? 'good' : 'bad'}">${headroom.toFixed(1)} bits</span></div>
          <div><span class="dim">z</span> ${cam.z.toFixed(3)} <span class="dim">k</span> ${cam.k} <span class="dim">cell</span> ${cam.cx}, ${cam.cy}</div>
          <div><span class="dim">offset</span> ${cam.fx.toFixed(4)}, ${cam.fy.toFixed(4)}</div>
          <div><span class="dim">draws</span> ${stats.draws}${stats.budgetHit ? ' <span class="bad">capped</span>' : ''} <span class="dim">fps</span> ${fps.toFixed(0)} <span class="dim">ms</span> ${frameMs.toFixed(1)}</div>
          <div><span class="dim">lore</span> ${escapeHtml(card.line)}</div>
        </div>`
          : '');

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

/**
 * The place card. Every slot is filled from the thing's actual traits, so the prose is a readout rather
 * than decoration -- which is the only reason it is worth having.
 */
function placeCard(cam: Camera, tree: Tree): { sub: string; line: string } {
  const kind = cam.node.kind;
  const label = LEVELS[kind].label;
  const found = planetCultureFor(cam.node, tree);

  if (kind === 'planet' && found) {
    const parent = tree.parentOf(cam.node);
    const starName = parent ? catalogName('system', parent.id, 0) : 'its star';
    const designation = catalogName('planet', cam.node.id, cam.node.path[cam.node.path.length - 1]?.cx ?? 0);
    const sub = found.culture.inhabited
      ? `${starName} ${designation} · called ${found.culture.localName} by the people who live there`
      : `${starName} ${designation} · ${found.traits.label}`;
    return { sub, line: planetLine(found.traits, found.culture, starName, cam.node.id) };
  }
  if (kind === 'settlement' && found?.culture.inhabited) {
    return {
      sub: `${label} · ${found.culture.motif} motif`,
      line: settlementLine(found.culture, found.traits, cam.node.id, displayName(cam.node, tree)),
    };
  }
  if ((kind === 'region' || kind === 'building') && found?.culture.inhabited) {
    return { sub: `${label} on ${found.culture.localName}`, line: describeLanguage(found.culture.language) };
  }
  return { sub: `${label} · depth ${cam.node.path.length}`, line: '' };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
