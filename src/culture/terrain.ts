import { f01, hash4 } from '../core/rng.ts';
import type { PlanetTraits } from '../universe/gen/planet.ts';

/**
 * A 2D PLANET'S SURFACE IS ITS CIRCUMFERENCE.
 *
 * This file used to be a two-dimensional height field over the planet's disc, which is to say a map projection
 * of a sphere -- flat art of a round world. That is not a two-dimensional planet. In a world with two
 * dimensions a planet is a disc, its interior is rock, and everything that lives does so on the
 * one-dimensional surface around the edge. Nothing lives in the middle of a planet.
 *
 * So terrain is a function of ONE variable: the angle around the circle. `groundAt(theta)` is the radius the
 * ground reaches, in planet units where the nominal radius is 1. Water fills every dip below `seaRadiusOf`.
 * Regions are arcs of that circumference; settlements and buildings sit along the arcs, standing outward.
 *
 * The good properties of the old field survive the change intact: octaves on a fixed lattice, so a feature's
 * position depends on where it is and never on how you are looking at it; a `detail` parameter whose coarse
 * terms are bit-identical at every zoom, so approaching a coastline REFINES it rather than moving it; and a sea
 * level calibrated against the field rather than assumed, so `waterFraction` means what it says.
 */

/**
 * Value noise sampled along the unit circle, one octave.
 *
 * Sampled in two dimensions at (cos, sin) rather than on a 1D lattice of the angle, which costs nothing and
 * buys seamlessness: there is no wrap point to line up, because the circle closes on itself in the lattice.
 */
function octave(seed: number, theta: number, level: number): number {
  const f = 2 ** level;
  const px = Math.cos(theta) * f;
  const py = Math.sin(theta) * f;
  const xi = Math.floor(px);
  const yi = Math.floor(py);
  const fx = px - xi;
  const fy = py - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (i: number, j: number) => f01(hash4(seed, i, j, level)) * 2 - 1;
  const a = at(xi, yi);
  const b = at(xi + 1, yi);
  const c = at(xi, yi + 1);
  const d = at(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Coarsest octave: level 1 means features about a third of the way round the planet. */
const COARSE_LEVEL = 1;

/**
 * Finest octave the field will ever evaluate.
 *
 * Capped because the lattice is indexed in absolute units, and past 2^50 an integer index stops being exact in
 * float64 -- the same wall the sky ran into, recorded at MAX_SKY_DETAIL_LEVEL. Level 30 puts the finest ripple
 * at a few centimetres, which is finer than a doorstep.
 */
export const FINEST_LEVEL = 30;

/**
 * How fast the octaves fall off, and the number the whole rim design lives or dies by.
 *
 * At exactly 0.5 the amplitude halves as the wavelength halves, which makes the field self-similar in the one
 * sense that matters here: the relief across a frame, measured in that frame's OWN units, is the same at every
 * level of the ladder. A region, a settlement and a building all show ground with about a fifth of a radius of
 * bumpiness in it. Measured, not assumed -- median 0.22 / 0.27 / 0.31 local radii, p95 under 1.0.
 *
 * Both sides of that are load-bearing. At 0.68 -- which this was, chosen to keep the old two-dimensional field
 * from looking flat -- slope grows as 1.36 per octave, so by building zoom the ground swung five to forty local
 * radii and the surface was simply not in the picture. Below 0.5 it converges instead, and a street is a ruled
 * line. 0.5 is the only value that holds across 2^19 of descent, which is why it is not a taste knob.
 */
const PERSISTENCE = 0.5;

/**
 * Peak-to-peak relief, in planet units.
 *
 * Sets both how lumpy a planet's outline is (about 11% of its radius) and, because the field is self-similar,
 * how bumpy the ground is at every level below it. One number, two jobs, and it can be tuned by looking at
 * either -- see tools/relief for the measurement.
 */
export const RELIEF = 0.1;

/**
 * The detail level every PLACEMENT decision uses, whatever the zoom.
 *
 * Placement has to be a pure function of address. Taking the level from the current view would mean a
 * settlement near the waterline appearing and disappearing as you approached it, and every permalink to one
 * being a coin toss.
 */
export const PLACEMENT_DETAIL = 16;

/** Detail for the coarse geography -- the shape of the shore as seen from orbit. */
export const COAST_DETAIL = 9;

/**
 * The radius the ground reaches at an angle, in planet units.
 *
 * `detail` is the finest octave to include. The coarse terms do not depend on it, so a mountain seen from orbit
 * is the same mountain seen from its foothills, with more of its texture resolved.
 */
export function groundAt(planetId: number, traits: PlanetTraits, theta: number, detail: number): number {
  const top = Math.min(FINEST_LEVEL, Math.max(COARSE_LEVEL, Math.round(detail)));

  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let level = COARSE_LEVEL; level <= top; level++) {
    sum += octave(planetId ^ 0x7e44a1, theta, level) * amp;
    norm += amp;
    amp *= PERSISTENCE;
  }
  /**
   * Shaped rather than used raw, so mountains have shoulders instead of being a sine wave. `massClass` stands
   * in for how vigorous the tectonics are: a heavy world gets sharper ridges and flatter plains between them.
   */
  const shaped = sum / norm;
  const ridge = Math.min(1.7, 0.55 + traits.massClass * 0.4);
  return 1 + RELIEF * Math.sign(shaped) * Math.abs(shaped) ** ridge;
}

/**
 * The radius the water reaches on this world.
 *
 * CALIBRATED, not assumed. The field's values pile up near the middle of its range rather than spreading evenly
 * over it, so treating `waterFraction` as a height drowns or dries every world -- the mistake the previous
 * field made, and worth not making twice. Sampling the circumference and taking the quantile is exact for any
 * shape of field, and it is why an all-ocean and an all-desert world both fall out as honest extremes.
 */
function computeSeaRadius(planetId: number, traits: PlanetTraits): number {
  const n = 2048;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    values[i] = groundAt(planetId, traits, (i / n) * Math.PI * 2, COAST_DETAIL);
  }
  values.sort();
  const q = Math.min(1, Math.max(0, traits.waterFraction));
  // Nudged outside the data at the extremes, so a world with no water has no shoreline at all rather than one
  // clinging to its single lowest sample.
  if (q <= 0) return values[0]! - RELIEF;
  if (q >= 1) return values[n - 1]! + RELIEF;
  return values[Math.min(n - 1, Math.floor(q * n))]!;
}

const seaCache = new Map<string, number>();

/**
 * Keyed by the water fraction as well as the id, and not for the app's sake -- there a planet's traits are a
 * pure function of its address, so the id alone would do. It is so the cache cannot lie to a caller that hands
 * over modified traits, which a test does deliberately.
 */
export function seaRadiusOf(planetId: number, traits: PlanetTraits): number {
  const key = `${planetId}:${traits.waterFraction}`;
  let v = seaCache.get(key);
  if (v === undefined) {
    v = computeSeaRadius(planetId, traits);
    if (seaCache.size > 128) seaCache.clear();
    seaCache.set(key, v);
  }
  return v;
}

/** Whether the ground at an angle stands above the water. What every placement decision actually asks. */
export function isLandAt(planetId: number, traits: PlanetTraits, theta: number, detail: number): boolean {
  return groundAt(planetId, traits, theta, detail) > seaRadiusOf(planetId, traits);
}

/** Fraction of the circumference above water. Says which single thing a world is when it has no shoreline. */
export function landFractionOf(planetId: number, traits: PlanetTraits): number {
  const n = 512;
  let land = 0;
  for (let i = 0; i < n; i++) {
    if (isLandAt(planetId, traits, (i / n) * Math.PI * 2, COAST_DETAIL)) land++;
  }
  return land / n;
}

/**
 * Detail to ask for, given how many pixels one planet unit covers.
 *
 * An octave at level n has features about 2^-n of the CIRCUMFERENCE, so their size in pixels is 2*pi*px/2^n.
 * Setting that to the target and solving gives log2(px * 2*pi / target) -- and the earlier `log2(px / 8)` quietly
 * dropped the 2*pi, asking for a level whose features were about fifty pixels rather than eight. The ground came
 * out visibly smoother than the field can actually draw it.
 */
export function detailForScale(pxPerPlanetUnit: number, targetPx = 7): number {
  return Math.max(0, Math.log2((Math.max(1, pxPerPlanetUnit) * Math.PI * 2) / targetPx));
}
