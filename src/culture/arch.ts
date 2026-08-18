import { f01, pick, roll } from '../core/rng.ts';
import type { PlanetTraits } from '../universe/gen/planet.ts';
import type { Motif } from './motif.ts';

/**
 * THE ARCHITECTURAL DNA OF ONE WORLD.
 *
 * Every building on a planet is built from this, and that is the whole point: the payoff sentence of the
 * project is "this building tells you about its planet", and it can only be true if the building's shape is
 * the planet's property rather than the building's. So a world has one roof it builds, one window it cuts,
 * one way of dividing a wall -- and a village of forty houses reads as forty houses of one people.
 *
 * What varies per building is deliberately thin: how many storeys, where the door sits, how many windows and
 * whether they are lit. Five of a building's visible attributes are inherited and at most three are free
 * rolls, which is the invariant that makes buildings from two worlds separable and buildings from two regions
 * of one world not. See THE TELL in the plan.
 *
 * CLIMATE FILTERS THE GRAMMAR, and this is what makes "a cold world builds like a cold world" legible rather
 * than merely statistical. A snowy world's roofs are steep because snow slides off steep roofs; a desert
 * world's windows are slits because a slit keeps the sun out. Neither is a colour swap.
 */

/** Roof shapes, as they read in a FRONT ELEVATION. A flat world only ever sees a building from the side. */
export type Roof = 'gable' | 'hip' | 'flat' | 'dome' | 'conical' | 'sawtooth' | 'mansard' | 'barrel' | 'stepped';

/** Window silhouettes. `motif` cuts the planet's own emblem into the wall, which lands hardest of all. */
export type Window = 'square' | 'tall' | 'round' | 'arched' | 'slit' | 'lancet' | 'motif' | 'roundel' | 'trapezoid';

export type WallDivision = 'none' | 'plinth' | 'banded' | 'timbered' | 'pilaster' | 'battened';

export type Rhythm = 'even' | 'paired' | 'grouped' | 'sparse' | 'irregular';

export type SignPlace = 'lintel' | 'fascia' | 'hanging' | 'pier' | 'none';

export interface Arch {
  /** The everyday roof, and the one a civic building gets instead. */
  readonly roof: Roof;
  readonly roofCivic: Roof;
  /** Rise over half-span, so 0.2 is nearly flat and 1.2 is an alpine pitch. */
  readonly pitch: number;
  /** Eave projection as a fraction of the building's half-width. */
  readonly eave: number;
  readonly window: Window;
  readonly windowCivic: Window;
  readonly rhythm: Rhythm;
  /** Fraction of the wall that is opening. Climate decides this almost entirely. */
  readonly windowArea: number;
  readonly wall: WallDivision;
  /** Storey height as a fraction of the building's width: tall and narrow, or low and wide. */
  readonly verticality: number;
  /** 0 = plain, 1 = every surface carved. */
  readonly ornament: number;
  readonly sign: SignPlace;
  /** A masonry plinth at the foot of the wall, as a fraction of storey height. Zero for none. */
  readonly plinth: number;
  /** Every dwelling gets a chimney below this temperature, and this world is below it. */
  readonly chimneys: boolean;
  /** A skirt of different material round the bottom of the wall, against lying snow. */
  readonly snowSkirt: boolean;
  /** 0 = timber and thatch, 1 = lattice and glass. Sets how regular and how tall building gets. */
  readonly era: number;
  /** How exposed the world is: thick air and hard seasons make for wind, and wind forbids gable ends. */
  readonly wind: number;
}

const ROOFS: readonly Roof[] = ['gable', 'hip', 'flat', 'dome', 'conical', 'sawtooth', 'mansard', 'barrel', 'stepped'];
const WINDOWS: readonly Window[] = ['square', 'tall', 'round', 'arched', 'slit', 'lancet', 'roundel', 'trapezoid'];
const WALLS: readonly WallDivision[] = ['none', 'plinth', 'banded', 'timbered', 'pilaster', 'battened'];
const RHYTHMS: readonly Rhythm[] = ['even', 'even', 'paired', 'grouped', 'sparse', 'irregular'];
const SIGNS: readonly SignPlace[] = ['lintel', 'fascia', 'fascia', 'hanging', 'pier', 'none'];

/** Roofs that shed nothing, and are therefore forbidden where snow lies. */
const FLAT_ISH: readonly Roof[] = ['flat', 'stepped'];
/** Roofs with a flat end facing the weather, which the wind takes off. */
const GABLE_ISH: readonly Roof[] = ['gable', 'sawtooth', 'mansard'];

const cache = new Map<number, Arch>();

export function archOf(planetId: number, traits: PlanetTraits, motif: Motif): Arch {
  let a = cache.get(planetId);
  if (a) return a;

  /**
   * Two derived indices the traits do not carry directly.
   *
   * `wind`: thick air moving over a world with hard seasons. Derived rather than rolled, because a windy
   * world should be windy for a reason you can see elsewhere in its weather.
   * `era`: how far this world's building has got. Habitability is the proxy -- a world that is easy to live
   * on supports the surplus that tall regular building needs -- with a per-world roll on top so two
   * comparable worlds are not at the same stage.
   */
  // atmDensity runs to about 4, so it is normalised before it is weighted; unnormalised it pinned `wind` near
  // one on half of all worlds and quietly converted every gable roof in the universe into a hip.
  const wind = Math.min(1, Math.min(1, traits.atmDensity / 3) * 0.5 + traits.seasonality * 0.5);
  const era = Math.min(1, Math.max(0, traits.habitability * 0.6 + f01(roll(planetId, 'techEra')) * 0.5));

  // Rain, as the complement of how arid the world is. PlanetTraits carries aridity rather than rainfall
  // because aridity is what the climate derivation actually computes.
  const rain = Math.min(1, Math.max(0, 1 - traits.aridity));

  let roof = pick(roll(planetId, 'roof'), ROOFS);
  let roofCivic = pick(roll(planetId, 'roofCivic'), ROOFS);
  let window = f01(roll(planetId, 'windowMotif')) < 0.18 ? 'motif' : pick(roll(planetId, 'window'), WINDOWS);
  const windowCivic = f01(roll(planetId, 'windowCivicMotif')) < 0.42 ? 'motif' : pick(roll(planetId, 'windowCivic'), WINDOWS);

  /**
   * HARD OVERRIDES. These are the difference between climate tinting a world and climate BUILDING it.
   *
   * Each one is a rule a builder on that world would actually follow, and each is visible in a silhouette
   * from across a street -- which is the test that matters, because the silhouette is all a flat world shows.
   */
  if (traits.snowIndex > 0.6 && era < 0.55 && FLAT_ISH.includes(roof)) {
    // Snow lies on a flat roof until the roof is underneath it.
    roof = traits.snowIndex > 0.85 ? 'conical' : 'gable';
  }
  if (traits.aridity > 0.7) {
    // Nothing to shed, everything to shade: a parapet is a terrace you can sleep on, and a slit keeps the
    // sun out of the room behind it.
    if (GABLE_ISH.includes(roof)) roof = f01(roll(planetId, 'aridRoof')) < 0.6 ? 'flat' : 'stepped';
    if (window !== 'motif') window = 'slit';
  }
  if (wind > 0.7 && GABLE_ISH.includes(roof)) {
    // A gable end is a sail. Hipped and conical roofs present no flat face to the weather.
    roof = f01(roll(planetId, 'windRoof')) < 0.5 ? 'hip' : 'conical';
  }
  if (roofCivic === roof) {
    // A civic building that looks exactly like a house is a wasted signal.
    roofCivic = ROOFS[(ROOFS.indexOf(roof) + 3 + (roll(planetId, 'civicShift') % 4)) % ROOFS.length]!;
  }

  a = {
    roof,
    roofCivic,
    /**
     * Pitch, in rise over half-span. Snow steepens it, aridity flattens it, rain steepens it a little.
     * Clamped to a range that stays buildable at both ends: nothing here is ever a spike or a plane.
     */
    pitch: Math.min(1.35, Math.max(0.12, 0.34 + 1.05 * traits.snowIndex - 0.4 * traits.aridity + 0.18 * rain)),
    // Rain wants an overhang; wind takes one away.
    eave: Math.min(0.4, Math.max(0.02, 0.1 + 0.22 * rain - 0.14 * wind)),
    window,
    windowCivic,
    rhythm: era > 0.7 ? 'even' : pick(roll(planetId, 'rhythm'), RHYTHMS),
    /**
     * Window area: biggest where the climate is mild, smallest where it is extreme in either direction.
     * A world at 291 K glazes generously; one at 240 K or 340 K does not, and neither does a windy one.
     */
    windowArea: Math.min(0.32, Math.max(0.03, 0.17 + 0.13 * (1 - Math.min(1, Math.abs(traits.meanTemp - 291) / 45)) - 0.07 * wind + 0.06 * era)),
    wall: era < 0.3 && f01(roll(planetId, 'wallTimber')) < 0.5 ? 'timbered' : pick(roll(planetId, 'wall'), WALLS),
    // A hard-seasoned world builds low and thick; a mild high-era one builds up.
    verticality: 0.55 + era * 0.75 - traits.seasonality * 0.2 + f01(roll(planetId, 'verticality')) * 0.35,
    ornament: Math.min(1, Math.max(0, 0.15 + f01(roll(planetId, 'ornament')) * 0.7 - traits.aridity * 0.15)),
    sign: pick(roll(planetId, 'signPlace'), SIGNS),
    plinth: f01(roll(planetId, 'plinth')) < 0.55 ? 0.1 + f01(roll(planetId, 'plinthDepth')) * 0.22 : 0,
    chimneys: traits.meanTemp < 262,
    snowSkirt: traits.snowIndex > 0.45,
    era,
    wind,
  };
  if (cache.size > 256) cache.clear();
  cache.set(planetId, a);
  return a;
}

/**
 * The twelve visible attributes of one building, five or more of which must be inherited.
 *
 * Split out as a named list because it is the thing the separability test measures: buildings from two
 * different PLANETS must be linearly separable on this vector at 95% or better (they are different peoples),
 * and buildings from two regions of ONE planet must not be (they are the same people, in different weather).
 * A design that passes both has leaked local randomness into an inherited field.
 */
export interface BuildingLook {
  /** Inherited from the planet. */
  readonly roof: Roof;
  readonly pitch: number;
  readonly eave: number;
  readonly window: Window;
  readonly rhythm: Rhythm;
  readonly wall: WallDivision;
  readonly ornament: number;
  readonly sign: SignPlace;
  readonly chimneys: boolean;
  /** Free per building. */
  readonly storeys: number;
  readonly doorRight: boolean;
  readonly bays: number;
}

export function lookOf(arch: Arch, buildingId: number, civic: boolean): BuildingLook {
  const storeys = 1 + Math.floor(f01(roll(buildingId, 'storeys')) * (1.2 + arch.era * 3.4));
  return {
    roof: civic ? arch.roofCivic : arch.roof,
    pitch: arch.pitch,
    eave: arch.eave,
    window: civic ? arch.windowCivic : arch.window,
    rhythm: arch.rhythm,
    wall: arch.wall,
    ornament: arch.ornament,
    sign: arch.sign,
    chimneys: arch.chimneys,
    storeys,
    doorRight: f01(roll(buildingId, 'doorAxis')) < 0.5,
    // Bays follow the rhythm, so a world that builds in pairs builds in pairs at every size.
    bays: arch.rhythm === 'sparse' ? 1 : arch.rhythm === 'paired' ? 2 : 1 + Math.floor(f01(roll(buildingId, 'bays')) * 3),
  };
}

/**
 * The pitch a builder uses on THIS stretch of ground, rather than on the world as a whole.
 *
 * `traits.snowIndex` is a planetary average, and on a world with a mean of 292 K it is zero -- while that same
 * world's uplands sit thirty kelvin colder and are under snow half the year. Earth solves this with latitude
 * and a flat world has none, so the local variation that remains is altitude, which is exactly what the
 * climate field already measures. Bounded deliberately: a village in the hills builds a steeper roof than the
 * one on the shore, and it is still recognisably the same people's roof.
 */
export function pitchAt(arch: Arch, localTemp: number): number {
  const localSnow = Math.min(1, Math.max(0, (270 - localTemp) / 42));
  return Math.min(1.35, arch.pitch + 0.55 * localSnow);
}

/** Whether a building on this stretch of ground needs a chimney, and a skirt against lying snow. */
export function needsHeating(localTemp: number): boolean {
  return localTemp < 274;
}

/** One line of English about how a world builds, for the debug readout. Never shown in the default view. */
export function describeArch(a: Arch): string {
  return (
    `${a.roof} roofs at ${(Math.atan(a.pitch) * (180 / Math.PI)).toFixed(0)} degrees, ` +
    `${a.window} windows over ${(a.windowArea * 100).toFixed(0)}% of the wall, ${a.wall} walls` +
    `${a.chimneys ? ', chimneys' : ''}${a.snowSkirt ? ', snow skirts' : ''}`
  );
}
