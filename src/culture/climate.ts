import { f01, hash3 } from '../core/rng.ts';
import type { PlanetTraits } from '../universe/gen/planet.ts';
import { RELIEF, groundAt, seaRadiusOf } from './terrain.ts';

/**
 * CLIMATE ON A WORLD WITH NO LATITUDE.
 *
 * A two-dimensional planet is a disc, so there are no poles and no tropics -- the one coordinate a place has
 * is its angle round the rim. That removes the usual lat/long climate matrix and, awkwardly, removes the
 * usual reason for one stretch of coast to differ from another. A world where every region has the same
 * weather is a world with one biome, and that is the single most boring outcome available.
 *
 * So climate here comes from the three things that genuinely do vary round a circle:
 *
 *  1. ALTITUDE. The terrain field already says how high the ground stands, and height cools air. This is
 *     what puts snow on the tops and leaves the valleys green, on the same world, at the same instant.
 *
 *  2. DISTANCE FROM THE SEA. Coasts are wet and continental interiors are dry, which is most of why
 *     deserts are where they are. Measured properly, along the rim, from the sea the terrain field puts
 *     there -- so a world's deserts sit behind its widest landmasses rather than wherever a hash says.
 *
 *  3. TIDAL LOCKING. A slow rotator has a permanent day side, and that IS a longitude effect: one face
 *     bakes and the far side freezes. `dayLength` decides how much of this a world gets, so a fast spinner
 *     comes out even and a locked one comes out as a scorched hemisphere facing an ice cap.
 *
 * All three are functions of the address alone, evaluated at a FIXED detail level, so a settlement's biome
 * is the same on every visit and does not shift as you approach it.
 */

/** Biomes, coarse enough to be legible as colour and specific enough to imply what grows. */
export type Biome =
  | 'ocean'
  | 'ice'
  | 'tundra'
  | 'taiga'
  | 'grass'
  | 'forest'
  | 'jungle'
  | 'steppe'
  | 'desert'
  | 'saltpan'
  | 'marsh'
  | 'scorched';

export interface LocalClimate {
  /** Mean temperature in kelvin at this spot. */
  readonly temp: number;
  /** 0 = arid, 1 = saturated. */
  readonly moisture: number;
  /** Height above the water line, in units of the world's whole relief: 0 at the shore, ~0.5 on the tops. */
  readonly rise: number;
  /** How far the sea is, as a fraction of a quarter turn of the rim. 0 at the shore, 1 deep inland. */
  readonly inland: number;
  readonly biome: Biome;
  /** True where the ground stands above the water line. */
  readonly land: boolean;
}

/**
 * Detail level every climate decision uses.
 *
 * Coarser than PLACEMENT_DETAIL on purpose: climate is a fact about a stretch of country, not about a
 * doorstep, and taking it from a fine octave would put a desert and a marsh either side of a garden wall.
 */
export const CLIMATE_DETAIL = 12;

/** Samples round the rim used to measure how far inland a place is. A quarter of a degree apiece. */
const COAST_SAMPLES = 1024;

/**
 * Kelvin lost between the shoreline and the highest ground on a world.
 *
 * NOT a real lapse rate, and it must not be one. RELIEF makes a planet's relief a tenth of its radius --
 * six hundred kilometres of mountain on an Earth-sized world -- because a tenth is what reads as bumpy at
 * planet zoom while still reading as a circle. Multiplying that cartoon by 6.5 K per real kilometre cooled
 * every upland by a hundred and forty kelvin and turned fifty-two percent of every world into ice. The
 * honest move is to pick the temperature range directly and let the geometry stay a cartoon: thirty kelvin
 * from beach to summit is roughly Earth's, and it is what puts snow on the tops of a green world.
 */
const LAPSE_K = 58;

/** How much of a world's temperature range tidal locking can command, in kelvin. */
const LOCK_SWING = 90;

/**
 * How slow a rotation has to be before one face of the world starts to bake, in hours.
 *
 * Earth's day is 24 hours and Earth is not locked at all; Mercury's is 1400 and it very much is. The ramp
 * between is where the interesting worlds live.
 */
const LOCK_FAST_H = 60;
const LOCK_SLOW_H = 900;

interface Climate {
  /** For each of COAST_SAMPLES angles: distance to the nearest sea, in samples. */
  readonly inland: Float32Array;
  readonly seaR: number;
  /** 0 = spins freely, 1 = one face always toward the star. */
  readonly lock: number;
  /** Angle of the substellar point on a locked world. Arbitrary, and the planet's frame is arbitrary too. */
  readonly hotAngle: number;
  /** Low-frequency wind: shifts moisture round the rim so coasts are not uniformly wet. */
  readonly windPhase: number;
  readonly windStrength: number;
}

const cache = new Map<string, Climate>();

function build(planetId: number, traits: PlanetTraits): Climate {
  const seaR = seaRadiusOf(planetId, traits);
  const wet = new Uint8Array(COAST_SAMPLES);
  let anyWet = false;
  let anyDry = false;
  for (let i = 0; i < COAST_SAMPLES; i++) {
    const under = groundAt(planetId, traits, (i / COAST_SAMPLES) * Math.PI * 2, CLIMATE_DETAIL) <= seaR;
    wet[i] = under ? 1 : 0;
    if (under) anyWet = true;
    else anyDry = true;
  }

  /**
   * Distance to the nearest sea, by a two-pass sweep round the ring.
   *
   * The ring wraps, so each pass runs one and a half times round: the extra half turn is what lets a
   * distance found late in the sweep propagate back past the seam. A world with no sea at all is infinitely
   * inland everywhere, which is exactly right -- it has no coasts to be near.
   */
  const inland = new Float32Array(COAST_SAMPLES);
  const far = COAST_SAMPLES;
  inland.fill(far);
  if (anyWet) {
    for (let pass = 0; pass < 2; pass++) {
      const forward = pass === 0;
      let d = far;
      for (let step = 0; step < COAST_SAMPLES * 1.5; step++) {
        const i = forward
          ? step % COAST_SAMPLES
          : ((COAST_SAMPLES - 1 - (step % COAST_SAMPLES)) + COAST_SAMPLES) % COAST_SAMPLES;
        d = wet[i] ? 0 : d + 1;
        if (d < inland[i]!) inland[i] = d;
      }
    }
  }
  if (!anyDry) inland.fill(0);

  const h = traits.dayLength;
  const lock = Math.min(1, Math.max(0, (h - LOCK_FAST_H) / (LOCK_SLOW_H - LOCK_FAST_H)));
  return {
    inland,
    seaR,
    lock,
    hotAngle: f01(hash3(planetId, 0xc11a, 1)) * Math.PI * 2,
    windPhase: f01(hash3(planetId, 0xc11a, 2)) * Math.PI * 2,
    windStrength: 0.2 + f01(hash3(planetId, 0xc11a, 3)) * 0.5,
  };
}

function climateOf(planetId: number, traits: PlanetTraits): Climate {
  // Keyed on the traits that move the answer, not on the id alone, so a caller handing over modified traits
  // cannot be told about a different world -- which the tests do deliberately.
  const key = `${planetId}:${traits.waterFraction}:${traits.meanTemp}:${traits.dayLength}`;
  let c = cache.get(key);
  if (!c) {
    c = build(planetId, traits);
    if (cache.size > 64) cache.clear();
    cache.set(key, c);
  }
  return c;
}

const TAU = Math.PI * 2;

/** Smooth ring interpolation of a per-sample array. */
function ringAt(values: Float32Array, theta: number): number {
  const n = values.length;
  const t = ((theta / TAU) % 1 + 1) % 1;
  const x = t * n;
  const i0 = Math.floor(x) % n;
  const i1 = (i0 + 1) % n;
  const f = x - Math.floor(x);
  return values[i0]! + (values[i1]! - values[i0]!) * f;
}

/**
 * The climate at an angle on a planet. Pure in the address: no zoom, no clock, no order of evaluation.
 */
export function climateAt(planetId: number, traits: PlanetTraits, theta: number): LocalClimate {
  const c = climateOf(planetId, traits);
  const ground = groundAt(planetId, traits, theta, CLIMATE_DETAIL);
  const land = ground > c.seaR;
  // Altitude in planet units, rescaled so a full RELIEF of mountain is 1. Cheap, and it makes LAPSE_K read
  // as "kelvin across the whole height range of a world".
  const rise = (ground - c.seaR) / Math.max(1e-9, RELIEF);

  let temp = traits.meanTemp - Math.max(0, rise) * LAPSE_K;
  if (c.lock > 0.01) {
    // One face toward the star. The cosine is the substellar geometry itself, not a stand-in for it.
    temp += c.lock * LOCK_SWING * Math.cos(theta - c.hotAngle) * 0.5;
  }

  /**
   * Moisture: wet at the shore, drying inland, modulated by a slow wind round the rim.
   *
   * The inland distance is measured in samples, and a quarter turn is the scale at which "far from any sea"
   * stops meaning anything -- beyond that a place is simply continental.
   */
  const quarter = COAST_SAMPLES / 4;
  const inland = Math.min(1, ringAt(c.inland, theta) / quarter);
  const wind = Math.cos(theta * 2 + c.windPhase) * c.windStrength;
  // The exponent bends the falloff so the first stretch inland stays damp and the deep interior goes properly
  // dry, rather than everything within sight of water pinning at saturation and losing all its variation.
  const wetness = 0.1 + (1 - inland) ** 1.35 * 0.74 + wind * 0.28;
  // A world's own aridity sets the ceiling: a desert planet has dry coasts too.
  const moisture = Math.min(1, Math.max(0, wetness * (1 - traits.aridity * 0.75)));

  return {
    temp,
    moisture,
    rise: Math.max(0, rise),
    inland,
    land,
    biome: classify(temp, moisture, land, inland, rise, traits),
  };
}

/**
 * The biome matrix, read as temperature against moisture.
 *
 * Ordered so the extremes are checked first: a frozen world is frozen whatever its rainfall, and molten rock
 * has no biome to speak of. Everything between is the ordinary matrix, and it produces single-biome worlds at
 * the climate extremes without a special case -- an ice world comes out ice from rim to rim, which is a
 * feature and one of the better ones.
 */
function classify(
  temp: number,
  moisture: number,
  land: boolean,
  inland: number,
  rise: number,
  traits: PlanetTraits,
): Biome {
  // The sea is not a biome of the land, and calling it one made every ocean read as a marsh -- twenty-two
  // percent of every world. It gets its own two: frozen, or not.
  if (!land) return temp < 271 ? 'ice' : 'ocean';
  if (temp > 420) return 'scorched';
  if (temp < 250) return 'ice';
  if (temp < 268) return moisture > 0.45 ? 'taiga' : 'tundra';
  // A salt pan is what is left when a sea dries out: dry, hot, and low. The altitude test is what keeps
  // them in basins rather than on ridges.
  if (moisture < 0.12 && temp > 290 && rise < 0.25) return 'saltpan';
  if (moisture < 0.24) return 'desert';
  if (moisture < 0.42) return temp > 300 ? 'steppe' : 'grass';
  if (temp > 300 && moisture > 0.68) return 'jungle';
  // Marsh only within reach of the sea; a bog on a mountain top is a different kind of place.
  if (moisture > 0.8 && inland < 0.12 && traits.snowIndex < 0.5) return 'marsh';
  return moisture > 0.55 ? 'forest' : 'grass';
}

/** What fraction of a world's rim each biome covers. For tests and for judging the generator's range. */
export function biomeCensus(planetId: number, traits: PlanetTraits, samples = 512): Map<Biome, number> {
  const out = new Map<Biome, number>();
  for (let i = 0; i < samples; i++) {
    const b = climateAt(planetId, traits, (i / samples) * TAU).biome;
    out.set(b, (out.get(b) ?? 0) + 1 / samples);
  }
  return out;
}

/**
 * LOCAL TIME OF DAY, which on a flat world is a fact about where you are standing.
 *
 * The planet turns, so the substellar angle sweeps round the rim; at any instant half the circumference is
 * in daylight and half is in night, and the terminator moves at the rotation rate. That falls straight out of
 * the geometry rather than being a lighting effect anyone chose, which is the same reason the cross-section
 * view exists at all.
 *
 * Returns the sine of the star's elevation above the local horizon: 1 with the star overhead, 0 at sunrise
 * and sunset, negative at night. `azimuth` is where along the horizon it sits, -1 to 1, so a painter can put
 * the star in the sky and throw shadows the other way.
 */
export function sunAt(
  planetId: number,
  traits: PlanetTraits,
  theta: number,
  seconds: number,
): { elevation: number; azimuth: number } {
  const c = climateOf(planetId, traits);
  // dayLength is in hours. Retrograde worlds turn the other way, and their sun rises in the west.
  const turns = (seconds / (traits.dayLength * 3600)) * (traits.retrograde ? -1 : 1);
  const sub = c.lock > 0.97 ? c.hotAngle : c.hotAngle + turns * TAU;
  const delta = theta - sub;
  return { elevation: Math.cos(delta), azimuth: Math.sin(delta) };
}
