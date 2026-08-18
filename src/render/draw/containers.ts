import { SPECTRAL, spectralIndexOf, starLightOf, type SpectralClass } from '../../cosmic/spectral.ts';
import { css, shade, type Hsl } from '../color.ts';
import { outlineWidth } from '../bands.ts';

/**
 * Some levels of the ladder are OBJECTS with a surface (a planet, a building) and some are REGIONS OF
 * SPACE that merely contain things (a field, a cluster, a star system). Drawing the second kind as an
 * opaque disc is a visible lie: it hides its own contents and implies a substance that is not there.
 *
 * So containers get a soft interior wash and a faint boundary, and their children are the content.
 */
export function drawContainer(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  colour: Hsl,
  strength = 1,
): void {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, css(colour, 0.5 * strength));
  g.addColorStop(0.62, css(colour, 0.26 * strength));
  g.addColorStop(1, css(colour, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // A boundary faint enough to read as a survey annotation rather than a wall.
  const w = outlineWidth(r, 1);
  if (w > 0) {
    ctx.lineWidth = w;
    ctx.strokeStyle = css(colour, 0.22 * strength);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * A star system is ~10 AU across but its star is a few million km, so the system's own extent is
 * almost entirely empty. Draw the star, not the extent -- and draw it in its spectral colour, which is
 * the cue that carries the star's identity all the way down to the shading of a single wall.
 */
export function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, systemRadiusPx: number, id: number): void {
  const light = starLightOf(id);
  const r = Math.max(0.8, systemRadiusPx * 0.055 * light.cls.discScale);

  // The second and last sanctioned gradient in the project: a star's bloom.
  // A tighter bloom. An expansive one turns interplanetary space into warm haze and hides the galaxy
  // that should be visible right through it.
  const bloom = r * (2.2 + light.cls.rel * 1.4);
  const g = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, bloom);
  g.addColorStop(0, css(light.colour, 0.34 * light.cls.rel));
  g.addColorStop(1, css(light.colour, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, bloom, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = css({ ...light.colour, l: Math.min(0.97, light.colour.l + 0.2) });
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  if (light.cls.key === 'RG' || light.cls.key === 'C') {
    // Swollen stars get a cooler rim so they read as bloated rather than merely large.
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.strokeStyle = css(shade(light.colour, light.shadowHue, 0.5), 0.7);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * A catalogued system drawn as a star, sized so it is visible and clickable from galaxy level.
 *
 * This is the thing that makes a galaxy read as a 2D map. Before it, every star on screen was decorative
 * and none corresponded to a place, so pointing at one and zooming did nothing -- the reported symptom
 * was "it's like they are not 2D and it is confusing", which is exactly right: a field of unreachable
 * points behaves like a 3D fly-through, not like a map you can zoom.
 */

/**
 * Radius a catalogued star is drawn at, as a fraction of its galaxy's on-screen radius.
 *
 * A star sits 29 doublings below its galaxy, so at its true size it is a 4e-7 px point at galaxy zoom
 * and still under two pixels four doublings later. Drawn that way it never grows: the arms around it
 * inflate, the star does not, and zooming toward one gives no sense of approach at all -- which is the
 * second half of "it's like they are not 2D". So a star is a CHART SYMBOL until its real disc catches
 * up: proportional to the galaxy that holds it, and therefore growing as you descend into it, capped so
 * that a handful of stars can never swallow the screen.
 *
 * Hit-testing calls this same function, so what you can click is exactly what you can see. The two
 * drifting apart is how you get a target that looks pickable and is not.
 */
/**
 * Growth is deliberately SUB-linear in the galaxy's size, at roughly the two-thirds power.
 *
 * Linear looks like the obvious choice -- hold each star at a fixed angular size and total ink stays
 * constant, since the number on screen falls as the square of the zoom. It does not, because a galaxy's
 * stars are not spread evenly: descending into one lands you in the arms and the bulge, where the local
 * density is several times the average, so the count falls far slower than the area does. Linear growth
 * turned two doublings past galaxy focus into overlapping confetti at forty percent screen coverage.
 * The exponent trades a little of the approach cue for a field that still reads as stars.
 */
const SYMBOL_EXP = 0.62;
const SYMBOL_K = 0.0873; // chosen so a mid-class star is ~2.5 px when its galaxy fills the viewport
const SYMBOL_MIN = 1.5;

/**
 * The cap is PER CLASS, not global. A single ceiling makes every star identical the moment the brightest
 * reach it, and a field of same-sized dots stops reading as a sky -- magnitude is most of what makes a
 * star chart legible.
 *
 * The ceiling is what actually governs how crowded the busiest view gets, because a few doublings past
 * galaxy focus every star has reached it while several hundred are still on screen. At 13 px that view
 * was overlapping confetti covering nearly forty percent of the screen; at 8 px it reads as a dense
 * cluster, which is what it is.
 */
function symbolCap(rel: number): number {
  return 2.6 + 5.4 * rel;
}

/**
 * How far a drawn star reaches, counting its halo and its sparkle -- the extent hit-testing has to cover,
 * because clicking a part of a star you can plainly see has to hit that star.
 */
export function starGlyphRadius(coreRadiusPx: number): number {
  if (coreRadiusPx >= SPARKLE_MIN_PX) return coreRadiusPx * SPARKLE_SCALE;
  if (coreRadiusPx >= HALO_MIN_PX) return coreRadiusPx * HALO_SCALE;
  return coreRadiusPx;
}

// One-entry memo: every star in a frame shares its parent's radius, and so does every hit test against
// them, so the power is computed once per frame rather than a few thousand times.
let lastParentPx = -1;
let lastParentBase = 0;

export function systemStarRadius(id: number, truePx: number, parentPx: number): number {
  if (parentPx !== lastParentPx) {
    lastParentPx = parentPx;
    lastParentBase = SYMBOL_K * parentPx ** SYMBOL_EXP;
  }
  // Brighter classes read larger, which is how a star chart shows magnitude.
  const rel = SPECTRAL[spectralIndexOf(id)]!.rel;
  const symbol = lastParentBase * (0.55 + 0.9 * rel);
  return Math.max(Math.min(symbolCap(rel), Math.max(SYMBOL_MIN, symbol)), truePx);
}

// --- Batched stars ------------------------------------------------------------------------------
//
// A galaxy puts a couple of thousand catalogued stars on screen at once. Drawn one at a time each needs
// its own `fillStyle` assignment and its own path, and that state churn costs far more than the fills
// themselves -- the identical pattern in the since-deleted decorative starfield produced a 210 ms stall.
// Stars are therefore queued by spectral class and emitted as ONE PATH PER CLASS: a dozen fills instead
// of two thousand, for a result that is pixel-for-pixel the same.

const CLASS_COUNT = SPECTRAL.length;
const BATCH_CAP = 4096;
/** Below this a star is a crisp square: cheaper than an arc, and sharper, which reads as "resolved". */
const SQUARE_MAX_PX = 2.6;
/**
 * Above this a star gets a flat halo and, past the second threshold, a four-point cartoon sparkle.
 *
 * Both are FLAT fills batched into the same paths as the cores, because the alternative -- a radial
 * gradient each -- is a per-star canvas object and the reason to batch in the first place. It is also
 * the house style: a big flat circle with no halo reads as confetti, which is exactly how a screenful
 * of capped-size stars looked before these existed.
 */
const HALO_MIN_PX = 2.9;
/** Halo radius, as a multiple of the core radius. */
const HALO_SCALE = 1.75;
/** Sparkle spike length, as a multiple of the core radius. */
const SPARKLE_SCALE = 2.7;
const SPARKLE_MIN_PX = 4.6;
/** Sparkles are four extra path segments each, so they are rationed to the brightest on screen. */
const SPARKLE_CAP = 220;

const batchX: Float32Array[] = [];
const batchY: Float32Array[] = [];
const batchR: Float32Array[] = [];
const batchN: number[] = [];
for (let i = 0; i < CLASS_COUNT; i++) {
  batchX.push(new Float32Array(BATCH_CAP));
  batchY.push(new Float32Array(BATCH_CAP));
  batchR.push(new Float32Array(BATCH_CAP));
  batchN.push(0);
}
let sparkleBudget = 0;

export function beginStarBatch(): void {
  for (let i = 0; i < CLASS_COUNT; i++) batchN[i] = 0;
  sparkleBudget = SPARKLE_CAP;
}

/**
 * Queue one catalogued star. Returns the radius it will be drawn at, which the caller needs before the
 * batch is flushed in order to size its hit record and decide whether it earns a label.
 */
export function queueSystemStar(
  cx: number,
  cy: number,
  truePx: number,
  parentPx: number,
  id: number,
): number {
  const ci = spectralIndexOf(id);
  const r = systemStarRadius(id, truePx, parentPx);
  const n = batchN[ci]!;
  if (n < BATCH_CAP) {
    batchX[ci]![n] = cx;
    batchY[ci]![n] = cy;
    batchR[ci]![n] = r;
    batchN[ci] = n + 1;
  }
  return r;
}

/** Emit every queued star. Returns the number of draw calls issued, for the frame budget. */
export function flushStarBatch(ctx: CanvasRenderingContext2D, alpha: number): number {
  let draws = 0;

  for (let ci = 0; ci < CLASS_COUNT; ci++) {
    const n = batchN[ci]!;
    if (n === 0) continue;
    const cls = SPECTRAL[ci]!;
    const colour = colourOf(cls);
    const xs = batchX[ci]!;
    const ys = batchY[ci]!;
    const rs = batchR[ci]!;

    // Pass 1: haloes, so every core lands on top of its own glow rather than under it.
    ctx.globalAlpha = alpha * 0.16;
    ctx.fillStyle = css(colour, 1);
    let haloes = 0;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r = rs[i]!;
      if (r < HALO_MIN_PX) continue;
      ctx.moveTo(xs[i]! + r * HALO_SCALE, ys[i]!);
      ctx.arc(xs[i]!, ys[i]!, r * HALO_SCALE, 0, Math.PI * 2);
      haloes++;
    }
    if (haloes > 0) {
      ctx.fill();
      draws++;
    }

    // Pass 2: four-point sparkles on the brightest, the one flourish that makes a star read as a star
    // rather than as a dot. Drawn under the core so the core caps the spikes cleanly.
    ctx.globalAlpha = alpha * 0.75;
    let spikes = 0;
    ctx.beginPath();
    for (let i = 0; i < n && sparkleBudget > 0; i++) {
      const r = rs[i]!;
      if (r < SPARKLE_MIN_PX) continue;
      const x = xs[i]!;
      const y = ys[i]!;
      const long = r * SPARKLE_SCALE;
      const wide = r * 0.42;
      ctx.moveTo(x - long, y);
      ctx.lineTo(x, y - wide);
      ctx.lineTo(x + long, y);
      ctx.lineTo(x, y + wide);
      ctx.closePath();
      ctx.moveTo(x, y - long);
      ctx.lineTo(x + wide, y);
      ctx.lineTo(x, y + long);
      ctx.lineTo(x - wide, y);
      ctx.closePath();
      sparkleBudget--;
      spikes++;
    }
    if (spikes > 0) {
      ctx.fill();
      draws++;
    }

    // Pass 3: the cores.
    ctx.globalAlpha = alpha;
    ctx.fillStyle = css({ ...colour, l: Math.min(0.97, colour.l + 0.18) });
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r = rs[i]!;
      if (r <= SQUARE_MAX_PX) {
        const d = Math.max(1, Math.round(r * 1.4));
        ctx.rect(xs[i]! - d / 2, ys[i]! - d / 2, d, d);
      } else {
        ctx.moveTo(xs[i]! + r, ys[i]!);
        ctx.arc(xs[i]!, ys[i]!, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    draws++;
  }

  ctx.globalAlpha = 1;
  return draws;
}

function colourOf(cls: SpectralClass): Hsl {
  return { h: cls.hue, s: cls.sat, l: 0.5 + cls.rel * 0.28 };
}
