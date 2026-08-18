import { f01, fSym, pick, roll } from '../core/rng.ts';
import type { Biome } from './climate.ts';

/**
 * A PLANET'S TREE OF LIFE.
 *
 * Five parameters, and they are the cheapest large win available in this project: every region of a world
 * reads as the same living place while its biomes still vary, and two worlds look like different biologies
 * rather than the same forest recoloured. A world whose leaves are two hundred degrees round the wheel has
 * BLUE forests, and every forest on it is blue, because the offset belongs to the planet and not to the tree.
 *
 * The planet owns this, not the galaxy. A galaxy is a hundred billion stars and nothing about life is uniform
 * at that scale; a planet is one biosphere, which is both more believable and a much tighter loop for anyone
 * looking -- the plant by a door is three levels from the world it tells you about, not six.
 */

/** Crown shapes. Silhouettes, not species: the outline is the whole of what reads at any size. */
export type Crown = 'fan' | 'globe' | 'cone' | 'umbrella' | 'tuft' | 'candelabra' | 'plate' | 'wisp';

export type Trunk = 'straight' | 'forked' | 'curved' | 'none';

/** What covers the ground between the big growth. */
export type Groundcover = 'tuft' | 'spike' | 'mat' | 'none';

export interface Biosphere {
  readonly crown: Crown;
  readonly trunk: Trunk;
  /**
   * Degrees to rotate every leaf colour by, away from the green a star-lit world would default to.
   *
   * The one parameter that does the most work. Kept away from zero on purpose: a world whose foliage is
   * ordinary green is a world you have seen, and the point of a hundred thousand planets is that they are
   * not all Earth with the furniture moved.
   */
  readonly leafHue: number;
  readonly leafSat: number;
  readonly groundcover: Groundcover;
  /** Typical height of the tallest growth, in metres, before biome filtering. */
  readonly heightM: number;
  /** How much taller the biggest gets than the smallest, as a ratio. */
  readonly spread: number;
  /** 0 = sparse scrub, 1 = closed canopy, before biome filtering. */
  readonly density: number;
}

const CROWNS: readonly Crown[] = ['fan', 'globe', 'cone', 'umbrella', 'tuft', 'candelabra', 'plate', 'wisp'];
const TRUNKS: readonly Trunk[] = ['straight', 'straight', 'forked', 'curved', 'none'];
const COVERS: readonly Groundcover[] = ['tuft', 'tuft', 'spike', 'mat', 'none'];

const cache = new Map<number, Biosphere>();

export function biosphereOf(planetId: number): Biosphere {
  let b = cache.get(planetId);
  if (!b) {
    /**
     * The hue offset avoids the 40 degrees either side of green.
     *
     * Rolled as a signed value and then pushed out of the middle, rather than rejected and re-rolled: the
     * distribution matters less than never landing on ordinary chlorophyll, and a rejection loop here would
     * make the value depend on how many attempts it took, which is exactly the kind of order dependence the
     * named-stream rule exists to forbid.
     */
    const raw = fSym(roll(planetId, 'leafHue'));
    const offset = Math.sign(raw || 1) * (40 + Math.abs(raw) * 140);
    b = {
      crown: pick(roll(planetId, 'crown'), CROWNS),
      trunk: pick(roll(planetId, 'trunk'), TRUNKS),
      leafHue: (120 + offset + 360) % 360,
      leafSat: 0.35 + f01(roll(planetId, 'leafSat')) * 0.45,
      groundcover: pick(roll(planetId, 'groundcover'), COVERS),
      // Skewed low: most worlds are scrub and grass, and a forest of hundred-metre giants should be rare
      // enough to be worth finding.
      heightM: 1.2 + f01(roll(planetId, 'canopyHeight')) ** 2.4 * 46,
      spread: 1.6 + f01(roll(planetId, 'canopySpread')) * 2.4,
      density: 0.25 + f01(roll(planetId, 'canopyDensity')) * 0.7,
    };
    if (cache.size > 256) cache.clear();
    cache.set(planetId, b);
  }
  return b;
}

/**
 * How the planet's own tree of life is EXPRESSED in one biome.
 *
 * The crown shape persists everywhere -- that is what makes a world recognisable from its scrubland to its
 * jungle -- and only the scale, the density and the ground cover change. Same biology, differently expressed,
 * which is the relationship a planet should have with its own regions.
 */
export interface Standing {
  readonly heightM: number;
  readonly density: number;
  readonly groundcover: Groundcover;
  /** Multiplier on the leaf colour's lightness: parched growth is paler, rainforest darker. */
  readonly tone: number;
}

export function standingIn(bio: Biosphere, biome: Biome): Standing {
  switch (biome) {
    case 'ocean':
    case 'ice':
    case 'scorched':
      return { heightM: 0, density: 0, groundcover: 'none', tone: 1 };
    case 'saltpan':
      return { heightM: 0, density: 0, groundcover: 'none', tone: 1.25 };
    case 'tundra':
      return { heightM: bio.heightM * 0.1, density: bio.density * 0.3, groundcover: 'mat', tone: 0.9 };
    case 'taiga':
      return { heightM: bio.heightM * 0.6, density: bio.density * 0.75, groundcover: 'mat', tone: 0.72 };
    case 'desert':
      return { heightM: bio.heightM * 0.14, density: bio.density * 0.12, groundcover: 'spike', tone: 1.2 };
    case 'steppe':
      return { heightM: bio.heightM * 0.22, density: bio.density * 0.22, groundcover: 'spike', tone: 1.1 };
    case 'grass':
      return { heightM: bio.heightM * 0.45, density: bio.density * 0.4, groundcover: bio.groundcover, tone: 1 };
    case 'forest':
      return { heightM: bio.heightM, density: bio.density, groundcover: bio.groundcover, tone: 0.85 };
    case 'jungle':
      return { heightM: bio.heightM * 1.35, density: Math.min(1, bio.density * 1.4), groundcover: 'mat', tone: 0.7 };
    case 'marsh':
      return { heightM: bio.heightM * 0.3, density: bio.density * 0.5, groundcover: 'tuft', tone: 0.95 };
  }
}

/** One line of English about a world's biology, for the debug readout. Never shown in the default view. */
export function describeBiosphere(bio: Biosphere): string {
  const hue =
    bio.leafHue < 40 || bio.leafHue > 330
      ? 'red'
      : bio.leafHue < 75
        ? 'amber'
        : bio.leafHue < 165
          ? 'green'
          : bio.leafHue < 200
            ? 'teal'
            : bio.leafHue < 260
              ? 'blue'
              : 'violet';
  return `${hue} ${bio.crown} crowns to ${bio.heightM.toFixed(0)} m on ${bio.trunk} trunks`;
}
