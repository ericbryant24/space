import { hash2, f01 } from '../../core/rng.ts';
import { RELIEF } from '../../culture/terrain.ts';
import { climateAt, type Biome } from '../../culture/climate.ts';
import { smoothstep } from '../bands.ts';
import { atLuminance, hueDelta, luminanceOf, solveL, type Hsl } from '../color.ts';
import type { PlanetTraits } from '../../universe/gen/planet.ts';
import type { Surface } from './planet.ts';

/**
 * WHAT THE GROUND IS MADE OF, IN ONE PLACE, SO THE DISC AND THE PLATES CANNOT DISAGREE.
 *
 * A planet is painted two entirely different ways over the course of one descent. Far out it is a disc of rock
 * and its surface is the disc's edge, drawn as one closed curve. Close in the disc is off the screen in every
 * direction and its regions paint the ground edge on, a plate at a time. There is exactly one moment where the
 * painting changes hands -- see PLANET_MAX_DIAGONALS in renderer.ts -- and at that moment the two pictures have
 * to be the same picture, or the world changes colour as you arrive.
 *
 * It was not. The plates had grown a surface: snow above a height, sand at the waterline, bare rock on the
 * steeps, biome-coloured soil everywhere else. The disc had never learned any of it and filled one flat green
 * rind with a cyan circle ruled straight across the dry land. So this file owns the surface, in PLANET UNITS,
 * and both painters ask it the same questions.
 *
 * Planet units are the only frame the two share. A plate's own units are 2^-k of a region of a settlement of a
 * planet, and there is no arithmetic that turns one plate's opinion of "two metres down" into its parent's
 * without going through the planet. Everything here is therefore a radius, an angle, or a depth measured from
 * the planet's centre, and each caller converts once on the way in.
 */

/** What the top few metres of ground are made of. `bed` is the floor of the sea. */
export type Material = 'snow' | 'rock' | 'sand' | 'soil' | 'bed';

export interface SkinRun {
  readonly material: Material;
  readonly biome: Biome;
  /** Inclusive sample indices into the array the caller classified. Runs share an index, so they touch. */
  readonly from: number;
  readonly to: number;
}

/**
 * How deep soil goes, in metres.
 *
 * A real number about a real thing, and it has to be, because it is the one quantity in this file that a
 * building stands in. Measured in frame radii instead -- which is what the plates did -- the living layer was
 * a hundred metres deep at region zoom and three centimetres deep at building zoom, and the step between them
 * landed exactly on the handover from one rung to the next.
 */
export const SOIL_M = 2.5;

/**
 * The thinnest the skin is ever drawn, in SCREEN pixels.
 *
 * An honest two and a half metres of soil is a hundredth of a pixel from a hundred kilometres up, so without a
 * floor the surface would simply not be there until you were nearly standing on it, and a forest coast would
 * read as bare rock from orbit. The floor is not a fudge of the depth, it is the statement that a surface is at
 * least a line thick -- and being measured in pixels it is scale-free, so it cannot snap at a handover the way
 * anything measured in frame radii must.
 */
const SKIN_FLOOR_PX = 2;

/** Slope, as a dimensionless gradient, past which nothing holds and bare rock shows. */
const SKIN_STEEP = 0.55;

/** Freezing, in kelvin. Above the height where the local mean falls below it, the ground is white. */
const SNOW_LINE_K = 271;

/** How many tidal ranges up the shore the sand reaches. Spring tides, storm throw, and a bit of dune. */
const BEACH_TIDES = 3;

/**
 * The depth of the skin in LOCAL units, given the local frame's scale.
 *
 * `pxPerUnit` is one local radius in screen pixels; `metresPerUnit` is one local radius in metres. Both terms
 * are continuous in the camera's z, and the max between them crosses over smoothly, so the skin thickens as
 * you approach without ever jumping.
 */
export function skinDepth(pxPerUnit: number, metresPerUnit: number): number {
  return Math.max(SKIN_FLOOR_PX / Math.max(1e-9, pxPerUnit), SOIL_M / Math.max(1e-9, metresPerUnit));
}

/**
 * The tidal range of a world, in metres.
 *
 * Moons raise tides and mass resists them, so a heavy moonless world has almost no shore and a light world
 * with four moons has a beach you could lose a town on. Not a hash draw: both numbers are already traits, and
 * the beach is the one piece of coastal geography that follows from them directly.
 */
export function tidalRangeM(traits: PlanetTraits): number {
  return 0.4 + (traits.moonCount * 1.9) / Math.max(0.35, traits.massClass);
}

/** How far above the water line sand reaches, in LOCAL units. Floored on screen for the same reason the skin is. */
export function beachDepth(traits: PlanetTraits, pxPerUnit: number, metresPerUnit: number): number {
  return Math.max(
    (SKIN_FLOOR_PX * 1.5) / Math.max(1e-9, pxPerUnit),
    (tidalRangeM(traits) * BEACH_TIDES) / Math.max(1e-9, metresPerUnit),
  );
}

/**
 * Classify a stretch of rim, sample by sample, and merge the result into runs.
 *
 * The caller supplies the geometry as two lookups in PLANET units -- the angle of sample `i` and the radius the
 * ground reaches there -- so a disc can pass its own polar curve and a plate can pass its ground line converted
 * on the way in, and neither has to know how the other is drawn.
 *
 * THE BIOME IS ASKED PER SAMPLE, not once per stretch, and it is worth the terrain queries. Asked once, two
 * neighbouring plates with different biomes met at a dead straight vertical line down the screen -- a seam that
 * was not a rendering artefact but a modelling one, because a coast does not change from jungle to steppe along
 * a ruler. Per sample, the transition lands wherever the climate field actually puts it.
 *
 * Everything else is arithmetic on numbers already in hand. Slope is the dimensionless gradient dr / (r dtheta),
 * which is the same number whether it is measured across a whole planet or across one doorstep -- which is the
 * property that lets the disc and a building agree about what counts as a cliff.
 */
export function classifySkin(
  planetId: number,
  traits: PlanetTraits,
  seaR: number,
  n: number,
  thetaAt: (i: number) => number,
  radiusAt: (i: number) => number,
  beachPlanet: number,
): SkinRun[] {
  const out: SkinRun[] = [];
  let start = 0;
  let current: Material | null = null;
  let currentBiome: Biome = 'ocean';
  let prevTheta = thetaAt(0);
  let prevRadius = radiusAt(0);
  for (let i = 0; i < n; i++) {
    const theta = thetaAt(i);
    const radius = radiusAt(i);
    let m: Material;
    if (radius <= seaR) {
      m = 'bed';
    } else {
      const dTheta = i === 0 ? thetaAt(Math.min(n - 1, 1)) - theta : theta - prevTheta;
      const dR = i === 0 ? radiusAt(Math.min(n - 1, 1)) - radius : radius - prevRadius;
      const slope = Math.abs(dR / Math.max(1e-12, radius * dTheta));
      if (climateAt(planetId, traits, theta).temp < SNOW_LINE_K) m = 'snow';
      else if (slope > SKIN_STEEP) m = 'rock';
      else if (radius - seaR < beachPlanet) m = 'sand';
      else m = 'soil';
    }
    // Only soil carries a biome into the picture; snow is white, rock is rock, and sand is ground-up rock.
    // Splitting the other materials on biome too would cut runs at boundaries that make no visible difference.
    const biome: Biome = m === 'soil' ? climateAt(planetId, traits, theta).biome : currentBiome;
    if (m !== current || (m === 'soil' && biome !== currentBiome)) {
      if (current !== null) out.push({ material: current, biome: currentBiome, from: start, to: i });
      current = m;
      currentBiome = biome;
      start = i;
    }
    prevTheta = theta;
    prevRadius = radius;
  }
  if (current !== null) out.push({ material: current, biome: currentBiome, from: start, to: n - 1 });
  return out;
}

/** What each material looks like on this world, before the time of day is applied. */
export function materialTone(m: Material, biome: Biome, s: Surface, traits: PlanetTraits): Hsl {
  switch (m) {
    case 'bed':
      return atLuminance(s.land, Math.max(0.04, luminanceOf(s.land) * 0.66));
    case 'snow':
      return { h: traits.atmHue, s: 0.07, l: solveL(traits.atmHue, 0.07, 0.9) };
    case 'rock':
      return atLuminance({ ...s.land, s: s.land.s * 0.45 }, Math.max(0.06, luminanceOf(s.land) * 0.78));
    case 'sand':
      // Sand is ground-up rock, so it takes the land's own value rather than a fixed beach yellow: on a world
      // whose rock is dark the sand is dark too.
      return atLuminance({ h: 44, s: 0.3, l: 0.7 }, Math.min(0.82, luminanceOf(s.land) + 0.26));
    case 'soil':
      return biomeTone(biome, s, traits);
  }
}

/**
 * Ground colour per biome.
 *
 * Built from the world's own land colour rather than from a fixed table, so a world's tundra and its forest are
 * recognisably the same world's -- and a red-rock planet's grassland is red-rock grassland. The biome moves the
 * hue and the value; it does not replace them.
 */
export function biomeTone(biome: Biome, s: Surface, traits: PlanetTraits): Hsl {
  const base = s.land;
  const y = luminanceOf(base);
  const toward = (hue: number, amount: number, dy: number, ds = 1): Hsl => {
    const h = base.h + hueDelta(base.h, hue) * amount;
    const sat = Math.min(0.9, base.s * ds);
    return { h, s: sat, l: solveL(h, sat, Math.min(0.9, Math.max(0.04, y + dy))) };
  };
  switch (biome) {
    case 'ice':
      return toward(traits.atmHue, 0.8, 0.34, 0.3);
    case 'tundra':
      return toward(58, 0.4, 0.08, 0.7);
    case 'taiga':
      return toward(150, 0.55, -0.1, 1.05);
    case 'forest':
      return toward(126, 0.6, -0.04, 1.1);
    case 'jungle':
      return toward(138, 0.7, -0.09, 1.25);
    case 'grass':
      return toward(96, 0.5, 0.05, 1);
    case 'steppe':
      return toward(70, 0.45, 0.1, 0.85);
    case 'desert':
      return toward(40, 0.6, 0.2, 0.9);
    case 'saltpan':
      return toward(48, 0.5, 0.32, 0.25);
    case 'marsh':
      return toward(110, 0.45, -0.06, 0.8);
    case 'scorched':
      return toward(16, 0.7, -0.02, 1.2);
    case 'ocean':
      return base;
  }
}

/**
 * A bed of rock: how deep it lies, in planet units, and how strongly it shows.
 *
 * `index` is the bed's permanent name. Bed 4 is bed 4 whether you are looking at the whole planet or at one
 * doorstep, which is what lets it be drawn at all -- see `strataFor`.
 */
export interface Stratum {
  readonly index: number;
  /** Depth below the ground line, in PLANET units. */
  readonly depth: number;
  readonly alpha: number;
}

/**
 * A bed stops being readable as a line under this many pixels of separation from the one above.
 *
 * Twelve, because two lines closer than that read as one thick line, and a stack of them reads as a smear.
 */
const STRATA_MIN_PX = 12;

/** The coarsest bed lies one whole relief of the world beneath the surface. */
const STRATA_TOP = RELIEF;

/** Deepest bed the family bothers to name. Past forty doublings the beds are thinner than a coat of paint. */
const STRATA_MAX_INDEX = 44;

/**
 * WHICH BEDS OF ROCK ARE VISIBLE AT THIS ZOOM.
 *
 * The strata used to be two fixed depths in FRAME radii -- a quarter and a half of the way down whatever frame
 * was being painted. That is scale-free, which was the point, but it means the beds are not beds: they are a
 * decoration attached to the viewport, so at every handover from one rung to the next they slid off the screen
 * and a fresh pair snapped in somewhere else. You could watch the ground restratify itself as you approached.
 *
 * A world's beds are instead a geometric family fixed in planet units, `d_j = RELIEF * 2^-j`, and the zoom only
 * decides which of them you can see. Bed 3 is always bed 3, always at the same depth, always the same colour;
 * descending simply resolves the finer beds between the ones already on screen while the coarse ones slide
 * calmly out of the bottom of the picture. That is what strata do in a cliff face, and it is the one thing the
 * inside of a two-dimensional world has to say for itself.
 *
 * Geometric rather than evenly spaced because the ladder is geometric: between any two rungs the visible depth
 * range changes by a constant factor, so a constant factor between beds keeps the same handful on screen at
 * every zoom -- about five of them, everywhere from a whole planet to a doorstep.
 *
 * `reachPlanet` is how deep the caller can paint, in planet units. Both ends fade rather than clip.
 */
export function strataFor(pxPerPlanetUnit: number, reachPlanet: number): Stratum[] {
  const out: Stratum[] = [];
  if (!(reachPlanet > 0) || !(pxPerPlanetUnit > 0)) return out;
  for (let j = 0; j <= STRATA_MAX_INDEX; j++) {
    const depth = STRATA_TOP * 2 ** -j;
    const px = depth * pxPerPlanetUnit;
    // Beds are listed coarse first, so once one is too shallow to separate from the surface every deeper
    // index is too, and there is nothing left to find.
    if (px < STRATA_MIN_PX) break;
    if (depth > reachPlanet) continue;
    const alpha =
      smoothstep(STRATA_MIN_PX, STRATA_MIN_PX * 2.2, px) * (1 - smoothstep(reachPlanet * 0.62, reachPlanet, depth));
    if (alpha > 0.004) out.push({ index: j, depth, alpha });
  }
  return out;
}

/**
 * The colour of one bed.
 *
 * Drawn from the world's own hash rather than alternated light and dark, because a bed is a bed: chalk, shale,
 * iron sand. Keyed on the bed's index, so the same bed is the same colour at every zoom and on every visit, and
 * a cliff face you photographed once looks the same the next time you come back to it.
 */
export function stratumTone(rock: Hsl, planetId: number, index: number): Hsl {
  const u = f01(hash2(planetId ^ 0x5747a3, index));
  const v = f01(hash2(planetId ^ 0x22b19f, index));
  const y = luminanceOf(rock);
  return atLuminance({ ...rock, s: Math.min(0.85, rock.s * (0.6 + v * 0.9)) }, Math.max(0.02, y * (0.55 + u * 0.85)));
}
