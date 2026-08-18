import { f01, hash3, hash4 } from '../core/rng.ts';
import type { PlanetTraits } from '../universe/gen/planet.ts';

/**
 * ONE TERRAIN FIELD PER PLANET, sampled by every level below it.
 *
 * The promise this keeps: the coastline you see from orbit is the coastline you land on. Before this file,
 * a planet's continents were six wobbly blobs drawn straight to the canvas and its regions were featureless
 * washes -- so the land had no existence outside the one painter that drew it, and nothing below could
 * agree with it. A blob is not a place.
 *
 * `elevationAt` is the single source of truth. The planet's disc traces its zero crossing; a region samples
 * the same function over its own patch; a settlement asks it which way the ground falls. There is no second
 * definition of where the land is, so there is nothing to keep in sync.
 *
 * Coordinates are PLANET UNITS throughout: the disc is the unit circle, x and y run over [-1, 1], and the
 * planet has one set face (see draw/planet.ts), so this is a flat map and not a projection of a sphere.
 */

/**
 * Value noise on a power-of-two lattice, one octave.
 *
 * Lattice rather than viewport-derived, for the same reason the galaxy's glow is (see scaleLevels in
 * draw/galaxy.ts): a feature's position must depend on where it is, never on how you are looking at it.
 * Descending adds finer octaves between the coarse ones instead of rescaling the whole field, so the
 * coastline gains detail as you approach rather than moving.
 */
function octave(seed: number, x: number, y: number, level: number): number {
  const f = 2 ** level;
  const px = x * f;
  const py = y * f;
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

/**
 * The coarsest and finest octaves the field ever uses.
 *
 * COARSE fixes the size of a continent: level 2 means features about half a planet across. FINEST is capped
 * because the lattice is indexed in absolute planet units, and past 2^50 an integer index stops being exact
 * in float64 -- the same wall the sky ran into, documented at MAX_SKY_DETAIL_LEVEL. Level 22 puts the finest
 * ripple at 8.4e6 / 2^22 metres, about two metres, which is finer than a building.
 */
const COARSE_LEVEL = 2;
export const FINEST_LEVEL = 22;

/**
 * The detail level every PLACEMENT decision uses, regardless of zoom.
 *
 * Placement has to be a pure function of address. Taking the level from the current view would mean a
 * settlement near the waterline appearing and disappearing as you approached it, and every permalink to one
 * being a coin toss. Fixed at a level whose cells are about two kilometres, which is finer than a settlement
 * and coarse enough that a building inherits the same answer as the town around it.
 */
export const PLACEMENT_DETAIL = 12;

/** Amplitude falls by this factor per octave, so coarse shapes dominate and fine detail only textures. */
const PERSISTENCE = 0.52;

/**
 * The raw landform, before the sea is poured in. Positive is high ground, negative is low.
 *
 * `detail` is the finest octave to include, and it is the whole trick: pass a low number when the planet is
 * a disc on screen and a high one when a region fills it, and the coarse terms are bit-identical between the
 * two. The shape agrees; only the roughness differs. A coastline gains detail as you approach it, which is
 * what coastlines do -- it does not move, which is what a rescaled field would do.
 */
export function reliefAt(planetId: number, x: number, y: number, detail: number): number {
  const top = Math.min(FINEST_LEVEL, Math.max(COARSE_LEVEL, Math.round(detail)));

  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let level = COARSE_LEVEL; level <= top; level++) {
    sum += octave(planetId ^ 0x7e44a1, x, y, level) * amp;
    norm += amp;
    amp *= PERSISTENCE;
  }

  /**
   * The rim is drowned outright, so a planet's edge is ocean rather than a continent sliced off by the disc.
   * SUBTRACTED rather than multiplied in: scaling the relief towards zero at the rim flips the sign of
   * anything already below sea level, which put land in a ring around the outside of the world. Two and a
   * half is far below the field's range, so past the rim there is no doubt.
   */
  const rim = 2.5 * Math.max(0, (Math.hypot(x, y) - 0.8) / 0.2) ** 2;
  return sum / norm - rim;
}

/**
 * Height above sea level. Negative is under water.
 *
 * Sea level is CALIBRATED, not assumed. `waterFraction` is a fraction of the surface, and the landform is a
 * sum of octaves whose values pile up near zero rather than spreading evenly over [-1, 1] -- so treating the
 * fraction as a height put every world entirely above or entirely below the water. A planet with no coastline
 * at all drew as one flat colour, which is what sent me looking.
 */
export function elevationAt(
  planetId: number,
  traits: PlanetTraits,
  x: number,
  y: number,
  detail: number,
): number {
  return reliefAt(planetId, x, y, detail) - seaLevelOf(planetId, traits);
}

/** Whether there is land at a point. Convenience, and the thing every caller actually wants. */
export function isLand(planetId: number, traits: PlanetTraits, x: number, y: number, detail: number): boolean {
  return elevationAt(planetId, traits, x, y, detail) > 0;
}

/**
 * Detail level to ask for, given how many pixels one planet unit covers.
 *
 * One lattice cell at level n is 2^-n planet units. Asking for cells about eight pixels across gives a
 * coastline with visible wiggle and nothing finer than the eye can use.
 */
export function detailForScale(pxPerPlanetUnit: number): number {
  return Math.log2(Math.max(1, pxPerPlanetUnit) / 8);
}

/**
 * How high the ground gets on this world, as a fraction of the field's range.
 *
 * A drowned world's few islands are barely above the water; a dry one's land is mostly high. Used to band
 * the elevation into contours without every world looking like the same map.
 */
export function reliefCeiling(traits: PlanetTraits): number {
  return Math.max(0.12, 1 - traits.waterFraction);
}

// --- The coastline, as a path ------------------------------------------------------------------------

/**
 * Marching squares over the field, returning closed rings in planet units.
 *
 * The disc used to draw its continents as six blob paths, which is why nothing below it could agree with
 * them. Tracing the field's zero crossing instead costs one grid sweep per planet -- cached, because the
 * field does not change -- and gives islands, bays and inland seas for free, since they are simply what the
 * field does. It is also the same zero crossing a region finds when it samples the field directly, so the
 * two cannot disagree about where the water is.
 */
export interface Coastline {
  /** Closed rings of [x, y] points in planet units. */
  readonly rings: readonly (readonly number[])[];
  /** The detail level the rings were traced at. */
  readonly detail: number;
  /** Fraction of the disc above water. With no rings, this says which single colour the world is. */
  readonly landFraction: number;
}

const RESOLUTION = 128;
/** Detail the coastline is traced at. Coarse enough for one sweep, fine enough to show bays. */
const TRACE_DETAIL = COARSE_LEVEL + 5;

/**
 * The height at which this world's water sits, so that `waterFraction` of the disc is under it.
 *
 * Found by sampling the landform over the disc and taking the quantile directly. Exact by construction for
 * any shape of field, and it is why a world can legitimately come out all ocean or all desert -- the extremes
 * are quantiles too, and single-biome worlds are a feature rather than a degenerate case.
 */
function computeSeaLevel(planetId: number, traits: PlanetTraits): number {
  const n = 96;
  const values: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -1 + (2 * i) / n;
      const y = -1 + (2 * j) / n;
      if (x * x + y * y > 1) continue;
      values.push(reliefAt(planetId, x, y, TRACE_DETAIL));
    }
  }
  values.sort((a, b) => a - b);
  const q = Math.min(1, Math.max(0, traits.waterFraction));
  // Nudged outside the data at the extremes, so an all-water or all-land world has no coastline rather than a
  // single degenerate one clinging to the last sample.
  if (q <= 0) return values[0]! - 1;
  if (q >= 1) return values[values.length - 1]! + 1;
  return values[Math.min(values.length - 1, Math.floor(q * values.length))]!;
}

/**
 * Keyed by the water fraction as well as the id, and not for the app's sake -- there, a planet's traits are a
 * pure function of its address, so the id alone would do. It is so the cache cannot lie to a caller that
 * hands over modified traits, which a test does deliberately and which silently returned a wet world's
 * coastline for a dry one until the key was widened.
 */
const seaCache = new Map<string, number>();

export function seaLevelOf(planetId: number, traits: PlanetTraits): number {
  const key = `${planetId}:${traits.waterFraction}`;
  let v = seaCache.get(key);
  if (v === undefined) {
    v = computeSeaLevel(planetId, traits);
    if (seaCache.size > 64) seaCache.clear();
    seaCache.set(key, v);
  }
  return v;
}

/**
 * A sampled square of the field, and the thing every contour is traced from.
 *
 * SAMPLED ONCE, TRACED MANY TIMES. A region plate wants seven level sets -- a shore, three contours above it
 * and three below -- and tracing each one straight from the field meant seven sweeps of thirty-six thousand
 * samples, each walking a dozen octaves. That cost fifty milliseconds every time you entered a region or
 * crossed a detail bucket: one dropped frame, repeatedly, while zooming. Every threshold comes off the same
 * grid now, so the field is evaluated five thousand times instead of two hundred and fifty thousand.
 */
export interface Grid {
  readonly v: Float64Array;
  readonly n: number;
  readonly extent: number;
}

export function sampleGrid(fn: (x: number, y: number) => number, n: number, extent: number): Grid {
  const v = new Float64Array((n + 1) * (n + 1));
  const step = (2 * extent) / n;
  for (let j = 0; j <= n; j++) {
    const y = -extent + j * step;
    for (let i = 0; i <= n; i++) v[j * (n + 1) + i] = fn(-extent + i * step, y);
  }
  return { v, n, extent };
}

/**
 * A copy of a grid drowned outside `edge`, so that every contour traced on it closes and outside every ring is
 * water.
 *
 * The slope is STEEP -- a hundred, not ten -- so the drowning always bites at `edge` and never earlier. At a
 * gentle slope the window undercuts the terrain wherever the ground is high, which put a false shore inside the
 * drawn disc: an all-land region came out ringed in coastline ink at 98% of its radius.
 */
export function windowed(grid: Grid, edge: number): Grid {
  const { v, n, extent } = grid;
  const out = new Float64Array(v.length);
  const step = (2 * extent) / n;
  for (let j = 0; j <= n; j++) {
    const y = -extent + j * step;
    for (let i = 0; i <= n; i++) {
      const x = -extent + i * step;
      const k = j * (n + 1) + i;
      out[k] = Math.min(v[k]!, (edge - Math.hypot(x, y)) * 100);
    }
  }
  return { v: out, n, extent };
}

/** A grid with every value negated, so a "deeper than" contour is a "higher than" contour on it. */
export function negated(grid: Grid): Grid {
  const v = new Float64Array(grid.v.length);
  for (let i = 0; i < v.length; i++) v[i] = -grid.v[i]!;
  return { v, n: grid.n, extent: grid.extent };
}

/**
 * Marching squares over a sampled grid, returning closed rings in the grid's coordinates.
 *
 * Shared by the planet's coastline and by every contour a region draws, because they are the same operation on
 * the same field at different scales -- which is the point of the field existing at all.
 */
export function traceGrid(grid: Grid, threshold = 0): number[][] {
  const { v, n, extent } = grid;
  const step = (2 * extent) / n;
  const at = (i: number, j: number) => v[j * (n + 1) + i]! - threshold;

  const segments: [number, number, number, number][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -extent + i * step;
      const y0 = -extent + j * step;
      const c = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      let mask = 0;
      for (let k = 0; k < 4; k++) if (c[k]! > 0) mask |= 1 << k;
      if (mask === 0 || mask === 15) continue;

      // Edge crossings, linearly interpolated so the line lands where the field actually crosses the threshold.
      const edge = (k: number): [number, number] => {
        const a = c[k]!;
        const b = c[(k + 1) % 4]!;
        const t = a / (a - b);
        switch (k) {
          case 0: return [x0 + t * step, y0];
          case 1: return [x0 + step, y0 + t * step];
          case 2: return [x0 + step - t * step, y0 + step];
          default: return [x0, y0 + step - t * step];
        }
      };
      const crossing: number[] = [];
      for (let k = 0; k < 4; k++) {
        if (((mask >> k) & 1) !== ((mask >> ((k + 1) % 4)) & 1)) crossing.push(k);
      }
      // Two crossings is a single line; four is a saddle, and connecting them in order is fine at this
      // resolution -- the alternative pairing differs by one cell of contour.
      for (let q = 0; q + 1 < crossing.length; q += 2) {
        const a = edge(crossing[q]!);
        const b = edge(crossing[q + 1]!);
        segments.push([a[0], a[1], b[0], b[1]]);
      }
    }
  }
  return chain(segments, step);
}

/** Sample and trace in one go, for callers that want a single level set. */
export function traceRings(
  fn: (x: number, y: number) => number,
  resolution: number,
  extent: number,
): number[][] {
  return traceGrid(sampleGrid(fn, resolution, extent));
}

export function traceCoastline(planetId: number, traits: PlanetTraits): Coastline {
  const detail = TRACE_DETAIL;
  /**
   * Drowned just outside the disc, exactly as a region plate windows its own patch.
   *
   * Two things fall out of it. Rings always close, so nothing fills as a straight chord. And OUTSIDE EVERY
   * RING IS ALWAYS WATER, which is what lets a painter fill the disc with sea and then even-odd fill the
   * rings as land, with no special case: a world with no water gets one ring hugging the rim and comes out
   * entirely land, and a world with no land gets no rings at all and stays entirely sea. Without the window
   * the sweep also found four spurious rings in the corners of the square, out where the rim penalty finally
   * bites -- harmless, since they are clipped, but they made "no water means no shore" false.
   */
  const extent = 1.06;
  const raw = sampleGrid((x, y) => elevationAt(planetId, traits, x, y, detail), RESOLUTION, extent);
  const rings = traceGrid(windowed(raw, 1.03));

  // Land fraction over the disc, for the worlds that come out all ocean or all desert and have no coastline
  // at all: with no rings, this is the only thing that says which single colour the world is.
  let land = 0;
  let inside = 0;
  const n = 64;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -1 + (2 * i) / n;
      const y = -1 + (2 * j) / n;
      if (x * x + y * y > 1) continue;
      inside++;
      if (elevationAt(planetId, traits, x, y, detail) > 0) land++;
    }
  }
  return { rings, detail, landFraction: inside > 0 ? land / inside : 0 };
}

/**
 * Join loose segments into closed rings, ignoring which way round each one runs.
 *
 * UNDIRECTED on purpose. Marching squares as emitted here does not give consistently oriented segments -- a
 * cell and its complement produce the same pair of edges in the same order, when they should run opposite
 * ways -- so following end-to-start broke every chain at the first cell that disagreed, and the leftover open
 * runs closed themselves with a straight chord. That drew as continents with one ruler-straight diagonal
 * edge, which is what sent me back here. Linking by either endpoint sidesteps orientation entirely, and the
 * even-odd fill the rings are used with does not care about direction.
 */
function chain(segments: readonly [number, number, number, number][], step: number): number[][] {
  const key = (x: number, y: number) => `${Math.round((x / step) * 64)},${Math.round((y / step) * 64)}`;
  // Point -> the segments touching it, as (index * 2 + whichEnd).
  const ends = new Map<string, number[]>();
  const add = (k: string, slot: number) => {
    const list = ends.get(k);
    if (list) list.push(slot);
    else ends.set(k, [slot]);
  };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    add(key(s[0], s[1]), i * 2);
    add(key(s[2], s[3]), i * 2 + 1);
  }

  const used = new Uint8Array(segments.length);
  const rings: number[][] = [];
  for (let seed = 0; seed < segments.length; seed++) {
    if (used[seed]) continue;
    const ring: number[] = [];
    let at = seed;
    let fromEnd = 0;
    for (let guard = 0; guard <= segments.length; guard++) {
      used[at] = 1;
      const s = segments[at]!;
      // Enter at `fromEnd`, leave by the other end.
      const ax = fromEnd === 0 ? s[0] : s[2];
      const ay = fromEnd === 0 ? s[1] : s[3];
      const bx = fromEnd === 0 ? s[2] : s[0];
      const by = fromEnd === 0 ? s[3] : s[1];
      if (ring.length === 0) ring.push(ax, ay);
      ring.push(bx, by);

      const next = (ends.get(key(bx, by)) ?? []).find((slot) => !used[slot >> 1]);
      if (next === undefined) break;
      at = next >> 1;
      fromEnd = next & 1;
    }
    if (ring.length >= 8) rings.push(ring);
  }
  return rings;
}

const coastCache = new Map<string, Coastline>();

/** The traced coastline for a planet, computed once. Keyed like `seaLevelOf`, and for the same reason. */
export function coastlineOf(planetId: number, traits: PlanetTraits): Coastline {
  const key = `${planetId}:${traits.waterFraction}`;
  let c = coastCache.get(key);
  if (!c) {
    c = traceCoastline(planetId, traits);
    // Only a handful of planets are ever on screen, and each trace is a few thousand numbers.
    if (coastCache.size > 6) coastCache.clear();
    coastCache.set(key, c);
  }
  return c;
}
