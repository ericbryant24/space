import { Z_MAX, mantissaHeadroom, metresPerPixel, pxPerUnit, type Camera } from '../camera/camera.ts';
import { R_ASCEND } from '../camera/rebase.ts';
import { archOf, describeArch } from '../culture/arch.ts';
import { biosphereOf, describeBiosphere } from '../culture/biosphere.ts';
import { climateAt, sunAt } from '../culture/climate.ts';
import { languageOf } from '../culture/language.ts';
import { motifOf } from '../culture/motif.ts';
import { describeScript, scriptOf } from '../culture/script.ts';
import { simTime } from '../core/clock.ts';
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
 * The ladder's own scale: the z at which each level is exactly R_ASCEND across, which is the zoom at
 * which a node of that level stops being small enough for its parent to own and takes the focus.
 *
 * The first entry is Z_MIN over in src/input/pointer.ts, reached by the same derivation from the
 * other side -- zoom-out stops with the root parked at R_ASCEND -- so the dot arrives at the first
 * pip exactly when the wheel stops giving, and the last segment runs out at Z_MAX for the same
 * reason at the other end.
 */
const RUNG_Z: readonly number[] = KIND_ORDER.map((kind) => Math.log2(R_ASCEND) - LEVELS[kind].logSpan);

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
 * that is the whole of "where am I and how do I get back out", with nothing to read. The pips carry `aria-label`s
 * because without them the ladder is eight unlabelled buttons to a screen reader -- attributes are not on the
 * screen, so the view stays wordless either way.
 *
 * The numbers stay, behind the backtick key. R and the mantissa headroom are the two that say whether the
 * precision invariant still holds, and a regression in either is invisible in a screenshot -- keeping them
 * reachable has been the most useful piece of infrastructure in the project.
 */
export function createHud(root: HTMLElement, tree: Tree, onCrumb: (depth: number) => void): Hud {
  const rungs = document.createElement('nav');
  rungs.className = 'rungs';
  rungs.setAttribute('aria-label', 'Depth');
  for (let d = 0; d < KIND_ORDER.length; d++) {
    const pip = document.createElement('button');
    pip.type = 'button';
    pip.className = 'pip';
    pip.setAttribute('data-depth', String(d));
    pip.setAttribute('aria-label', LEVELS[KIND_ORDER[d]!].label);
    rungs.appendChild(pip);
  }

  const trace = document.createElement('span');
  trace.className = 'trace';
  // The pips already say which rung is current; a second announcement of the same fact is noise.
  trace.setAttribute('aria-hidden', 'true');
  rungs.appendChild(trace);
  root.appendChild(rungs);

  const panel = document.createElement('div');
  panel.className = 'hud';
  // Off by default, and `hidden` rather than a class so it is out of the tab order and out of innerText too.
  panel.hidden = true;
  root.appendChild(panel);

  rungs.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-depth]');
    if (!target) return;
    onCrumb(Number(target.getAttribute('data-depth')));
  });

  const pips = [...rungs.querySelectorAll<HTMLElement>('.pip')];

  /**
   * Pip centres, in the pill's own coordinates, measured rather than assumed.
   *
   * The layout is fixed by the stylesheet, so this is measured once and then only again when the
   * window resizes -- but it is measured, because a hard-coded pitch here and a changed padding in
   * index.html would put the progress dot quietly out of step with the pips it refers to.
   */
  let centres: number[] = [];
  const measure = (): void => {
    centres = pips.map((pip) => pip.offsetLeft + pip.offsetWidth / 2);
  };
  window.addEventListener('resize', measure);

  let lastDepth = -1;
  let lastTraceX = Number.NaN;
  let debug = false;

  // Measured now rather than on the first frame, so the dot's first appearance is already on the
  // ladder instead of half off the end of the pill.
  measure();
  trace.style.transform = `translateX(${(centres[0] ?? 0).toFixed(2)}px)`;

  return {
    setDebug(on) {
      debug = on;
      panel.hidden = !on;
      if (!on) panel.replaceChildren();
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
          if (d === depth) pip.setAttribute('aria-current', 'true');
          else pip.removeAttribute('aria-current');
        });
      }

      // First frame, or a resize that has not been measured yet. Zero widths mean the pill is not laid out.
      if (centres.length !== pips.length || centres[1] === centres[0]) measure();
      // Note that this asks z where it is, not `depth`. The dot is a picture of the zoom; the fill is
      // the picture of the node.
      const ladder = ladderAt(cam.z);
      const from = centres[ladder.rung];
      if (from !== undefined) {
        // Below the last rung there is no next pip, so the final segment runs into the pill's end
        // cap -- which the stylesheet makes exactly half a pitch, the same half step the pill opens with.
        const pitch = (centres[1] ?? 0) - (centres[0] ?? 0);
        const to = centres[ladder.rung + 1] ?? from + pitch / 2;
        const x = from + (to - from) * ladder.f;
        // Sub-quarter-pixel moves are invisible and still cost a style recalculation every frame.
        if (!(Math.abs(x - lastTraceX) < 0.25)) {
          lastTraceX = x;
          trace.style.transform = `translateX(${x.toFixed(2)}px)`;
        }
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
          <div><span class="dim">rung</span> ${(ladder.f * 100).toFixed(1)}%</div>
          <div><span class="dim">draws</span> ${stats.draws}${stats.budgetHit ? ' <span class="bad">capped</span>' : ''} <span class="dim">fps</span> ${fps.toFixed(0)} <span class="dim">ms</span> ${frameMs.toFixed(1)}</div>
          <div><span class="dim">scale</span> ${formatDistance(nice)} <span class="dim">build</span> ${escapeHtml(__BUILD__)}</div>
          ${world(cam)}
        </div>`;
    },
  };
}

/**
 * Where a zoom falls on the ladder: which segment of it, and how far along that segment, in [0, 1].
 * This is what the progress dot rides.
 *
 * THE ONE THING IT MUST NOT DO IS JUMP, and that is why it is a function of z and of nothing else. z
 * is the only quantity a rebase never touches: `enterChild`, `ascend`, `descendHalf` and `ascendHalf`
 * all rebuild the frame around the same zoom and leave z exactly where it was, so a position derived
 * from z alone is continuous across every one of them by construction rather than by arithmetic that
 * happens to cancel. Anything drawn from `node.logSpan` or from the path length is not: those step at
 * a semantic crossing, the crossing happens at the child's own jittered radius rather than at the
 * nominal one, and it happens at a different radius on the way back out -- so the dot moved without
 * the camera moving, and moved by a different amount in each direction.
 *
 * The consequence is that the dot and the filled pip can disagree for a few tenths of a rung, and
 * that is the right way round. Which node has the focus is decided by that node's real size on
 * screen; where the zoom sits on a ladder of eight nominal scales is a different fact, and it is the
 * one that has to move smoothly because it is the only thing on the chrome that moves at all. When
 * the pip catches up, a fill changes. Nothing slides.
 */
function ladderAt(z: number): { rung: number; f: number } {
  const last = RUNG_Z.length - 1;
  let rung = 0;
  while (rung < last && z >= RUNG_Z[rung + 1]!) rung++;
  const lo = RUNG_Z[rung]!;
  // Past the deepest rung there is no next level to hand over to, so the segment runs to the bottom
  // of the zoom itself.
  const hi = rung < last ? RUNG_Z[rung + 1]! : Z_MAX;
  const f = hi > lo ? (z - lo) / (hi - lo) : 0;
  // The clamp can only engage outside [Z_MIN, Z_MAX], which the input layer already forbids -- it is
  // here so that a bookmark written by an older build cannot push the dot off the end of the pill.
  return { rung, f: f < 0 ? 0 : f > 1 ? 1 : f };
}

/**
 * What world you are standing on, in the debug readout only.
 *
 * Six generators feed the surface and none of them says anything in the default view -- which is the point, and
 * also why a bug in one of them is invisible. This is how you check that the biome under your feet is the biome the
 * ground is painted as, that the local hour matches the sun in the sky, and that the buildings are built the way
 * the world's grammar says. It has earned itself several times over already.
 */
function world(cam: Camera): string {
  const g = cam.node.ground;
  if (!g) return '';
  const t = g.traits;
  const c = climateAt(g.planetId, t, g.theta);
  const sun = sunAt(g.planetId, t, g.theta, simTime());
  const arch = archOf(g.planetId, t, motifOf(g.planetId));
  const hour = ((simTime() / (t.dayLength * 3600)) % 1) * 24;
  return (
    `<div><span class="dim">world</span> ${escapeHtml(t.label)} ` +
    `<span class="dim">hab</span> ${t.habitability.toFixed(2)} ` +
    `<span class="dim">day</span> ${t.dayLength.toFixed(0)}h</div>` +
    `<div><span class="dim">here</span> ${escapeHtml(c.biome)} ` +
    `${c.temp.toFixed(0)}K wet ${c.moisture.toFixed(2)} inland ${c.inland.toFixed(2)}</div>` +
    `<div><span class="dim">sun</span> ${sun.elevation > 0 ? 'up' : 'down'} ` +
    `elev ${sun.elevation.toFixed(2)} at ${hour.toFixed(1)}h</div>` +
    `<div><span class="dim">life</span> ${escapeHtml(describeBiosphere(biosphereOf(g.planetId)))}</div>` +
    `<div><span class="dim">built</span> ${escapeHtml(describeArch(arch))}</div>` +
    `<div><span class="dim">writes</span> ${escapeHtml(describeScript(scriptOf(g.planetId, languageOf(g.planetId))))}</div>`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
