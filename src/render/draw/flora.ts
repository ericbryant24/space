import { f01, hash2, hash3 } from '../../core/rng.ts';
import { biosphereOf, standingIn, type Biosphere, type Crown } from '../../culture/biosphere.ts';
import type { LocalClimate } from '../../culture/climate.ts';
import { angleAtOffset, groundHeightAt, type Ground } from '../../universe/node.ts';
import { atLuminance, css, luminanceOf, solveL, type Hsl } from '../color.ts';
import { daylight, type Sky } from './sky.ts';

/**
 * WHAT GROWS HERE.
 *
 * Five parameters on the planet decide it (see src/culture/biosphere.ts) and the biome decides how they are
 * expressed, so every stretch of one world reads as the same living place while its deserts and its jungles
 * still look nothing alike. A world with blue foliage has blue forests everywhere, and that one fact does more
 * to make a hundred thousand planets feel like different planets than any amount of terrain tuning.
 *
 * TREES SIT ON A FIXED ANGULAR LATTICE, which is the same discipline the terrain field uses and for the same
 * reason: a tree's position must be a property of where it is, never of how you are looking at it. The lattice
 * index is derived from the absolute angle round the planet, so a tree does not slide, shimmer or renumber as
 * the camera moves, and the same tree is in the same place on every visit forever.
 *
 * Two representations, crossfaded. Below about seven pixels a tree is a smudge, so what is drawn instead is the
 * CANOPY BAND -- a scalloped strip of foliage along the ground line, which is exactly how a cartoon map shows
 * forest and is one path instead of two hundred. Both are the same height in metres and the same colour, so the
 * handover has nothing to morph.
 */

/** Tree height in pixels at which individual trees start to resolve out of the canopy band. */
const TREE_IN = 6;
const TREE_FULL = 13;
/** Below this the canopy band itself is not worth a path. */
const CANOPY_MIN_PX = 0.7;
/** Never place more than this many trees in one plate, however wide the view. */
const TREE_BUDGET = 120;

/** Most groundcover marks drawn on one plate. Past this the lattice is strided rather than abandoned. */
const COVER_BUDGET = 900;

/** Foliage colour for a world, in one biome, at this time of day. */
export function leafColour(bio: Biosphere, tone: number, sky: Sky, shadowHue: number): Hsl {
  const base: Hsl = { h: bio.leafHue, s: bio.leafSat, l: 0.4 };
  return daylight(atLuminance(base, Math.min(0.7, 0.34 * tone)), sky, shadowHue);
}

/**
 * One crown, drawn at (x, y) with the given half-width and height, in the planet's own crown shape.
 *
 * Silhouettes rather than species. The outline is the whole of what reads at any size, which is why the shape
 * belongs to the planet and the size belongs to the individual: a field of fan crowns and a field of candelabra
 * crowns are unmistakably different worlds even as thumbnails.
 */
function crown(ctx: CanvasRenderingContext2D, shape: Crown, x: number, y: number, w: number, h: number): void {
  switch (shape) {
    case 'globe':
      ctx.beginPath();
      ctx.ellipse(x, y - h * 0.5, w, h * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'cone':
      ctx.beginPath();
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x - w, y);
      ctx.closePath();
      ctx.fill();
      return;
    case 'fan':
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, Math.max(w, h * 0.9), Math.PI * 1.15, Math.PI * 1.85);
      ctx.closePath();
      ctx.fill();
      return;
    case 'umbrella':
      ctx.beginPath();
      ctx.moveTo(x - w, y - h * 0.55);
      ctx.quadraticCurveTo(x, y - h * 1.25, x + w, y - h * 0.55);
      ctx.quadraticCurveTo(x, y - h * 0.35, x - w, y - h * 0.55);
      ctx.closePath();
      ctx.fill();
      return;
    case 'tuft':
      // Three blades from one point. The one crown that reads at two pixels.
      ctx.beginPath();
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + i * w * 0.9, y - h);
      }
      ctx.lineWidth = Math.max(0.8, w * 0.42);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.stroke();
      return;
    case 'candelabra':
      ctx.beginPath();
      for (let i = -1; i <= 1; i += 2) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - h * 0.55);
        ctx.lineTo(x + i * w, y - h * 0.6);
        ctx.lineTo(x + i * w, y - h);
      }
      ctx.lineWidth = Math.max(0.9, w * 0.4);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineJoin = 'round';
      ctx.stroke();
      return;
    case 'plate':
      // Stacked plates: three flat discs up a stem, which is a real growth habit and a very legible one.
      for (let i = 0; i < 3; i++) {
        const t = (i + 1) / 3;
        ctx.beginPath();
        ctx.ellipse(x, y - h * t, w * (1.05 - i * 0.22), h * 0.09, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    case 'wisp':
      ctx.beginPath();
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + i * w * 1.4, y - h * 0.6, x + i * w * 0.5, y - h);
      }
      ctx.lineWidth = Math.max(0.7, w * 0.24);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.stroke();
      return;
  }
}

function trunk(ctx: CanvasRenderingContext2D, bio: Biosphere, x: number, y: number, h: number, w: number, ink: string): void {
  if (bio.trunk === 'none' || h < 3) return;
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(0.8, w * 0.3);
  ctx.lineCap = 'round';
  ctx.beginPath();
  switch (bio.trunk) {
    case 'straight':
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - h);
      break;
    case 'curved':
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + w * 0.6, y - h * 0.6, x, y - h);
      break;
    case 'forked':
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - h * 0.55);
      ctx.moveTo(x, y - h * 0.55);
      ctx.lineTo(x - w * 0.7, y - h);
      ctx.moveTo(x, y - h * 0.55);
      ctx.lineTo(x + w * 0.7, y - h);
      break;
  }
  ctx.stroke();
}

/**
 * Everything growing on one plate.
 *
 * `metresPerUnit` is the plate's own radius in metres, which is what turns a biosphere's heights in metres into
 * local units -- so the same forest is the same forest at every zoom, resolving from a band into trunks rather
 * than being redrawn at a new size.
 *
 * `sea` is the water line in the same local units. NOTHING GROWS IN THE SEA, and it has to be said here rather
 * than left to the plate: a coastal plate's centre can be dry while a third of its stretch is under water, and
 * the forest ran straight out across the bay.
 */
export function drawFlora(
  ctx: CanvasRenderingContext2D,
  g: Ground,
  climate: LocalClimate,
  sky: Sky,
  cx: number,
  cy: number,
  r: number,
  detail: number,
  metresPerUnit: number,
  sea: number,
  from: number,
  to: number,
): void {
  const bio = biosphereOf(g.planetId);
  const stand = standingIn(bio, climate.biome);
  if (stand.heightM <= 0 || stand.density <= 0.01) return;

  const heightUnits = stand.heightM / metresPerUnit;
  const heightPx = heightUnits * r;
  // Ramped rather than cut: a forest that appears the instant it is a pixel tall appears all at once, over the
  // whole visible coast, which is about as loud as a pop gets.
  const present = smoothstep(CANOPY_MIN_PX * 0.5, CANOPY_MIN_PX * 1.8, heightPx);
  if (present < 0.02) return;

  const toX = (u: number) => cx + u * r;
  const toY = (v: number) => cy - v * r;
  const shadowHue = g.traits.starLight.shadowHue;
  const leaf = leafColour(bio, stand.tone, sky, shadowHue);
  const ink = css(daylight(atLuminance(leaf, Math.max(0.03, luminanceOf(leaf) * 0.42)), sky, shadowHue));

  const trees = smoothstep(TREE_IN, TREE_FULL, heightPx);

  // 1. THE CANOPY BAND. A scalloped strip along the ground, at the same height the trees would be.
  if (trees < 0.999) {
    ctx.globalAlpha = (1 - trees) * present;
    ctx.fillStyle = css(leaf);
    const lobe = Math.max(1.2, heightPx * 0.42);
    const step = lobe * 1.35;
    const span = (to - from) * r;
    const n = Math.min(700, Math.max(2, Math.round(span / step)));
    const uAt = (i: number) => from + ((to - from) * i) / n;
    const ground = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) ground[i] = groundHeightAt(g, uAt(i), detail);
    // Density thins the band by lowering it rather than by breaking it up: a gappy band at three pixels reads as
    // noise, and a low one reads as scrub.
    const lift = (i: number) => heightUnits * (0.35 + 0.65 * stand.density) * (0.75 + 0.25 * Math.sin(i * 1.7));

    ctx.beginPath();
    let i = 0;
    while (i <= n) {
      if (ground[i]! <= sea) {
        i++;
        continue;
      }
      const a = i;
      while (i <= n && ground[i]! > sea) i++;
      const b = i - 1;
      ctx.moveTo(toX(uAt(a)), toY(ground[a]!));
      for (let j = a; j <= b; j++) ctx.lineTo(toX(uAt(j)), toY(ground[j]! + lift(j)));
      for (let j = b; j >= a; j--) ctx.lineTo(toX(uAt(j)), toY(ground[j]!));
      ctx.closePath();
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // 2. INDIVIDUAL TREES, on the absolute angular lattice.
  if (trees > 0.001) {
    /**
     * Spacing follows the growth: tall dense forest is closed, scrub is scattered. Measured in metres and
     * converted to an angle round the planet, so the lattice is a property of the world and not of the view.
     */
    const spacingM = Math.max(0.5, stand.heightM * (1.5 / Math.max(0.05, stand.density)));
    const planetR = metresPerUnit / g.span;
    const dTheta = spacingM / (planetR * Math.max(1e-9, g.baseRadius));
    const uPerTheta = (g.baseRadius / g.span) || 1;

    const theta0 = angleAtOffset(g, from);
    const theta1 = angleAtOffset(g, to);
    const i0 = Math.ceil(Math.min(theta0, theta1) / dTheta);
    const i1 = Math.floor(Math.max(theta0, theta1) / dTheta);
    const count = i1 - i0 + 1;
    // A budget rather than a smaller lattice: thinning by stride would make trees appear and vanish as the
    // view widened, and the lattice is the one thing that must never move.
    const stride = count > TREE_BUDGET ? Math.ceil(count / TREE_BUDGET) : 1;

    for (let i = i0; i <= i1; i += stride) {
      const h = hash2(g.planetId, i);
      if (f01(h) > stand.density * 0.85 + 0.1) continue;
      const u = (i * dTheta - g.theta) * uPerTheta;
      const v = groundHeightAt(g, u, detail);
      if (v <= sea) continue;
      const scale = 0.55 + f01(hash3(g.planetId, i, 7)) * 0.9 * (bio.spread / 2.6);
      const th = heightUnits * scale;
      const hp = th * r;
      // The smallest trees of a stand are the ones nearest the threshold, so they are also the ones that would
      // flicker one by one as the view moved. Fading each by its own height is the same rule as everywhere else.
      const a = trees * present * smoothstep(0.9, 2.4, hp);
      if (a < 0.03) continue;
      ctx.globalAlpha = a;
      const w = Math.max(0.7, hp * (0.24 + 0.2 * f01(hash3(g.planetId, i, 8))));
      const x = toX(u);
      const y = toY(v);
      const stemFrac = bio.trunk === 'none' ? 0 : 0.42;
      trunk(ctx, bio, x, y, hp * stemFrac, w, ink);
      ctx.fillStyle = css(leaf);
      crown(ctx, bio.crown, x, y - hp * stemFrac, w, hp * (1 - stemFrac));
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * Groundcover: the small marks between the big growth.
 *
 * Only worth drawing when a plant is a few pixels tall, which is settlement zoom and below. Above that it is
 * texture on texture, and the canopy band already says "things grow here".
 *
 * THE STRIDE IS A POWER OF TWO and the newcomers ramp in over the doubling before they are needed, which is the
 * same rule the buildings of a town follow. What used to be here was a flat `if (count > 900) return`, so every
 * blade of grass on screen vanished in one frame when the view widened past a threshold that had nothing to do
 * with anything you could see.
 */
export function drawGroundcover(
  ctx: CanvasRenderingContext2D,
  g: Ground,
  climate: LocalClimate,
  sky: Sky,
  cx: number,
  cy: number,
  r: number,
  detail: number,
  metresPerUnit: number,
  sea: number,
  from: number,
  to: number,
): void {
  const bio = biosphereOf(g.planetId);
  const stand = standingIn(bio, climate.biome);
  if (stand.groundcover === 'none') return;

  // Cover is knee height: half a metre, give or take.
  const hM = stand.groundcover === 'mat' ? 0.25 : 0.7;
  const hPx = (hM / metresPerUnit) * r;
  // In under a pixel and a half it is not a mark, and over about a screen of height it is a forest the canopy
  // band is already drawing. Both ends fade.
  const present = smoothstep(1, 2.2, hPx) * (1 - smoothstep(60, 110, hPx));
  if (present < 0.02) return;

  const leaf = leafColour(bio, stand.tone * 1.08, sky, g.traits.starLight.shadowHue);
  ctx.lineWidth = Math.max(0.7, hPx * 0.16);
  ctx.lineCap = 'round';

  const spacingM = hM * 1.9;
  const planetR = metresPerUnit / g.span;
  const dTheta = spacingM / (planetR * Math.max(1e-9, g.baseRadius));
  const uPerTheta = (g.baseRadius / g.span) || 1;
  const theta0 = angleAtOffset(g, from);
  const theta1 = angleAtOffset(g, to);
  const i0 = Math.ceil(Math.min(theta0, theta1) / dTheta);
  const i1 = Math.floor(Math.max(theta0, theta1) / dTheta);
  const count = i1 - i0 + 1;
  if (count <= 0) return;

  const lv = Math.log2(Math.max(1, count / COVER_BUDGET));
  const coarse = 2 ** Math.ceil(lv);
  const step = Math.max(1, coarse / 2);
  const newcomer = Math.ceil(lv) - lv;

  // Two batches rather than two hundred strokes: everything at full strength in one path, the half-resolved
  // lattice between them in another.
  const mark = (batch: number[], i: number): void => {
    const h = hash3(g.planetId, i, 0x9c);
    if (f01(h) > 0.62) return;
    const u = (i * dTheta - g.theta) * uPerTheta;
    const v = groundHeightAt(g, u, detail);
    if (v <= sea) return;
    batch.push(cx + u * r, cy - v * r, hPx * (0.6 + f01(hash2(h, 1)) * 0.8), f01(hash2(h, 2)));
  };
  const solid: number[] = [];
  const fading: number[] = [];
  for (let i = i0; i <= i1; i += step) mark(i % coarse === 0 ? solid : fading, i);

  const paint = (batch: number[], alpha: number): void => {
    if (batch.length === 0 || alpha < 0.02) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = css(leaf, 0.85);
    ctx.beginPath();
    for (let k = 0; k < batch.length; k += 4) {
      const x = batch[k]!;
      const y = batch[k + 1]!;
      const s = batch[k + 2]!;
      const j = batch[k + 3]!;
      switch (stand.groundcover) {
        case 'mat':
          ctx.moveTo(x - s, y);
          ctx.lineTo(x + s, y - s * 0.35);
          break;
        case 'spike':
          ctx.moveTo(x, y);
          ctx.lineTo(x + (j - 0.5) * s * 0.6, y - s);
          break;
        case 'tuft':
          ctx.moveTo(x, y);
          ctx.lineTo(x - s * 0.5, y - s);
          ctx.moveTo(x, y);
          ctx.lineTo(x + s * 0.5, y - s * 0.9);
          break;
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  paint(solid, present);
  paint(fading, present * newcomer);
}

const smoothstep = (a: number, b: number, x: number): number => {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
