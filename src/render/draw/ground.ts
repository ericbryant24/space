import { detailForScale, elevationAt, negated, sampleGrid, traceGrid, windowed } from '../../culture/terrain.ts';
import { atLuminance, css, luminanceOf, type Hsl } from '../color.ts';
import { outlineWidth } from '../bands.ts';
import type { Ground, Node } from '../../universe/node.ts';
import { surfaceColours, type Surface } from './planet.ts';

/**
 * The ground: what a region looks like when it fills the screen.
 *
 * A region used to be a coloured wash with nothing in it, which is the level the whole descent was building
 * towards and the emptiest thing in the project. What it draws now is a map of ITS OWN PATCH OF ITS OWN
 * PLANET -- the same `elevationAt` the planet's disc traces its coastline from, sampled over the small square
 * this region occupies, with the finer octaves that were invisible from orbit now switched on.
 *
 * So the promise holds in both directions: an ocean region is under water, an inland region is dry, and a
 * region that straddles a coast has the coast running through it in the right place and at the right angle.
 * Nothing is re-rolled locally, because there is nothing to re-roll -- there is one field.
 */

/** Grid resolution for a plate's contours. Enough for a ragged coast, cheap enough to trace every frame. */
const RESOLUTION = 72;
/**
 * Where the plate's own edge is, in local units.
 *
 * The field does not stop at a region's boundary -- land simply continues -- so tracing it over a bare square
 * leaves rings hanging open at the edge, and an even-odd fill of open rings paints the wrong half. Drowning
 * everything past 1.03 closes every ring just outside the disc that gets drawn, where the artificial
 * coastline is clipped away and never seen.
 */
const EDGE = 1.03;

/**
 * Contour steps, as fractions of the relief PRESENT IN THIS PLATE -- not of the planet's absolute height.
 *
 * Absolute was the obvious reading and it drew nothing. The field is fractal, so the amplitude of the octaves
 * fine enough to vary across a thirty-kilometre patch is about a thousandth of the planet's full range: an
 * inland region sits at elevation 0.5 and varies by 0.001 across its whole width, so contours placed at a
 * third and two thirds of 0.5 fell nowhere near it and every region came out one flat colour. Banding the
 * local range is also what a topographic map does -- flat country still gets contours, they just stand for
 * smaller steps.
 */
const BANDS = [0.3, 0.55, 0.8] as const;

interface Plate {
  readonly coast: readonly (readonly number[])[];
  /** Contours above the water, innermost last. */
  readonly bands: readonly (readonly (readonly number[])[])[];
  /** Contours below it, deepest last. An open-ocean plate is a bathymetric chart, not a blue disc. */
  readonly deeps: readonly (readonly (readonly number[])[])[];
  /** Land as a fraction of the plate, for the all-land and all-sea cases where there is no coast to draw. */
  readonly landFraction: number;
}

/**
 * Traced once per (node, zoom bucket) rather than every frame.
 *
 * Three marching-squares sweeps at 72x72 is about fifteen thousand field samples, each of which walks up to
 * twenty octaves. That is affordable once and not sixty times a second. The key includes the detail level, so
 * descending re-traces with finer octaves exactly when the extra detail becomes visible.
 */
const plateCache = new Map<string, Plate>();

function plateOf(node: Node, frame: Ground, detail: number): Plate {
  const key = `${node.id}:${detail}`;
  const hit = plateCache.get(key);
  if (hit) return hit;

  const elev = (u: number, v: number) =>
    elevationAt(frame.planetId, frame.traits, frame.x + u * frame.span, frame.y + v * frame.span, detail);
  /**
   * The field as it is, and then a drowned copy for tracing.
   *
   * Kept separate because the relief STATISTICS have to come from the untouched field. Reading them off the
   * windowed grid meant the artificial low values ringing the edge counted as the lowest ground in the plate,
   * which dragged the contour thresholds below the real terrain and left the topmost band covering everything --
   * an all-land region drew as a single flat colour.
   */
  const raw = sampleGrid(elev, RESOLUTION, EDGE * 1.03);
  const up = windowed(raw, EDGE);
  /**
   * The same field upside down, so "deeper than" is just another "higher than" and needs no second sweep.
   *
   * NEGATE FIRST, THEN WINDOW. Windowing the up-grid and negating that flips the drowned edge into a raised
   * one, which puts the exterior on the wrong side of every threshold and inverts the parity: the deepest band
   * then enclosed almost the whole plate and an ocean region went uniformly dark.
   */
  const down = windowed(negated(raw), EDGE);

  // The relief actually present in this plate, above and below the water, read off the grid we already have.
  let lo = Infinity;
  let hi = -Infinity;
  let deepest = Infinity;
  let shallow = -Infinity;
  let land = 0;
  let inside = 0;
  const n = raw.n;
  const stride = n + 1;
  const cellStep = (2 * raw.extent) / n;
  const originOffset = raw.extent;
  for (let j = 0; j <= n; j++) {
    const v = -originOffset + j * cellStep;
    for (let i = 0; i <= n; i++) {
      const u = -originOffset + i * cellStep;
      if (u * u + v * v > 1) continue;
      inside++;
      const e = raw.v[j * stride + i]!;
      if (e <= 0) {
        if (e < deepest) deepest = e;
        if (e > shallow) shallow = e;
        continue;
      }
      land++;
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
  }
  // Contours start at the shore where there is one, so the lowest band is the coastal strip.
  const base = land > 0 && land < inside ? 0 : Math.max(0, lo);
  const range = land > 0 ? hi - base : 0;
  /**
   * Depth is measured over the range PRESENT HERE, from the shallowest water in view to the deepest -- the same
   * local-range argument the land contours needed, and I got it wrong here first: banding at fractions of the
   * absolute depth put every threshold far below a patch of sea floor that varies by a thousandth, so the
   * deepest band swallowed the whole plate and an ocean region drew as one flat colour again, only darker.
   */
  const seaBase = land < inside ? shallow : 0;
  const depth = land < inside ? seaBase - deepest : 0;

  const plate: Plate = {
    coast: traceGrid(up),
    bands: range > 1e-12 ? BANDS.map((f) => traceGrid(up, base + range * f)) : [],
    // Negated grid, negated threshold: the level set is the same curve, and the parity now anchors on deep
    // water outside every ring rather than on shallow.
    deeps: depth > 1e-12 ? BANDS.map((f) => traceGrid(down, -(seaBase - depth * f))) : [],
    landFraction: inside > 0 ? land / inside : 0,
  };
  if (plateCache.size > 24) plateCache.clear();
  plateCache.set(key, plate);
  return plate;
}

function fillRings(
  ctx: CanvasRenderingContext2D,
  rings: readonly (readonly number[])[],
  cx: number,
  cy: number,
  r: number,
): boolean {
  if (rings.length === 0) return false;
  ctx.beginPath();
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const px = cx + ring[i]! * r;
      const py = cy + ring[i + 1]! * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  return true;
}

/**
 * A region, as a top-down plate.
 *
 * Flat contour bands, never a gradient heightmap: three steps of one colour ramp read as height instantly and
 * stay in the house style, where a smooth ramp would read as a render that did not quite work.
 */
export function drawRegion(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  node: Node,
): void {
  const frame = node.ground;
  if (!frame) return;
  const s = surfaceColours(frame.traits);
  const detail = Math.round(detailForScale(r / frame.span));
  const plate = plateOf(node, frame, detail);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  // Water first, always. The plate is windowed so that outside every ring is water, which makes this the base
  // in every case -- all-land plates get one ring around the whole thing, all-sea plates get none.
  ctx.fillStyle = css(s.sea);
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  /**
   * Bathymetry, before anything else, because it sits under the shore.
   *
   * Water used to get no contours at all, which meant a region out in open ocean -- and plenty are -- drew as
   * one flat blue disc with nothing in it. The sea floor has relief for the same reason the land does; it is
   * the same field.
   */
  const seaFloor = Math.max(0.03, luminanceOf(s.sea) - 0.16);
  for (let b = 0; b < plate.deeps.length; b++) {
    if (!fillRings(ctx, plate.deeps[b]!, cx, cy, r)) continue;
    const t = (b + 1) / plate.deeps.length;
    ctx.fillStyle = css(atLuminance(s.sea, luminanceOf(s.sea) + (seaFloor - luminanceOf(s.sea)) * t));
    ctx.fill('evenodd');
  }

  // Land, then each contour step a little lighter, so height reads without a single gradient.
  if (fillRings(ctx, plate.coast, cx, cy, r)) {
    ctx.fillStyle = css(s.land);
    ctx.fill('evenodd');
  }
  /**
   * A wide ramp, not a polite one. Three steps over a tenth of a luminance is invisible on a saturated hue --
   * the first version of this was yellow-on-yellow and read as one flat colour with some stray ink on it.
   * High ground also loses saturation towards bare rock, which is both what happens and what makes the top
   * band separate from the bottom at a glance.
   */
  const lowest = Math.max(0.06, luminanceOf(s.land) - 0.08);
  const highest = Math.min(0.9, luminanceOf(s.land) + 0.42);
  for (let b = 0; b < plate.bands.length; b++) {
    const rings = plate.bands[b]!;
    if (!fillRings(ctx, rings, cx, cy, r)) continue;
    const t = (b + 1) / plate.bands.length;
    ctx.fillStyle = css(step(s.land, lowest + (highest - lowest) * t, 1 - t * 0.45));
    ctx.fill('evenodd');
  }

  // The coast in ink. Heavier than the contours, because it is the one line that separates two materials
  // rather than two heights.
  const w = outlineWidth(r, 2.4);
  if (w > 0 && plate.coast.length > 0) {
    fillRings(ctx, plate.coast, cx, cy, r);
    ctx.lineWidth = w;
    ctx.strokeStyle = css(s.coast, 0.9);
    ctx.stroke();
    // Contours at half weight: present, and plainly subordinate to the coastline.
    ctx.lineWidth = w * 0.5;
    ctx.strokeStyle = css(s.coast, 0.4);
    for (const rings of plate.bands) {
      if (fillRings(ctx, rings, cx, cy, r)) ctx.stroke();
    }
  }
  // Depth contours are inked even with no shore in view, which is the whole point for an ocean plate.
  if (w > 0 && plate.deeps.length > 0) {
    ctx.lineWidth = w * 0.45;
    ctx.strokeStyle = css(s.coast, 0.3);
    for (const rings of plate.deeps) {
      if (fillRings(ctx, rings, cx, cy, r)) ctx.stroke();
    }
  }

  ctx.restore();
}

/** A tone at a given luminance, with saturation scaled -- high ground reads as rock rather than bright paint. */
function step(base: Hsl, targetLuminance: number, saturation: number): Hsl {
  return atLuminance({ ...base, s: base.s * saturation }, targetLuminance);
}

export type { Surface };
