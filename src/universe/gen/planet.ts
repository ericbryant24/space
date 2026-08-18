import { habitableZone, starLightOf, type StarLight } from '../../cosmic/spectral.ts';
import { f01, roll } from '../../core/rng.ts';
import { orbitRadius } from '../orbits.ts';

/**
 * Planet traits. Physical only -- language, architecture and biosphere belong here too, but they are
 * the planet's CULTURE and come with the culture layer. What this file establishes is the climate that
 * culture will then be filtered through, which is what makes a cold world build like a cold world.
 */
export type PlanetClass =
  | 'molten'
  | 'scorched'
  | 'desert'
  | 'savanna'
  | 'terran'
  | 'ocean'
  | 'jungle'
  | 'tundra'
  | 'ice'
  | 'frozenRock'
  | 'greenhouse'
  | 'gasGiant'
  | 'iceGiant';

/**
 * Below this a world has no culture and nobody lives there -- it is a rock with a catalogue number.
 *
 * Lives here rather than beside the culture generator because PLACEMENT needs it: nothing is built on a
 * five-hundred-kelvin cinder, and `isInhabited` in universe/node.ts is where that is decided. Keeping the
 * constant next to the trait it tests also keeps node.ts from having to import the language generator.
 */
export const HABITABLE_THRESHOLD = 0.34;

export interface PlanetTraits {
  readonly cls: PlanetClass;
  readonly label: string;
  /** Radius in Earth radii. Presentational; the ladder's logSpan is what the camera uses. */
  readonly massClass: number;
  readonly axialTilt: number;
  readonly waterFraction: number;
  readonly iceFraction: number;
  readonly atmDensity: number;
  readonly atmHue: number;
  readonly cloudCover: number;
  readonly moonCount: number;
  readonly hasRings: boolean;
  readonly ringTilt: number;
  readonly ringWidth: number;
  /** Seconds of real time per planetary day. Drives the day/night terminator. */
  readonly dayLength: number;
  readonly retrograde: boolean;

  /** Derived climate, the payload the culture layer will read. */
  readonly insolation: number;
  readonly albedo: number;
  readonly meanTemp: number;
  readonly snowIndex: number;
  readonly aridity: number;
  readonly seasonality: number;
  readonly habitability: number;

  readonly starLight: StarLight;
  readonly orbitAu: number;
}

const LABELS: Record<PlanetClass, string> = {
  molten: 'molten world',
  scorched: 'scorched rock',
  desert: 'desert world',
  savanna: 'savanna world',
  terran: 'temperate world',
  ocean: 'ocean world',
  jungle: 'steam jungle',
  tundra: 'tundra world',
  ice: 'ice world',
  frozenRock: 'frozen rock',
  greenhouse: 'greenhouse world',
  gasGiant: 'gas giant',
  iceGiant: 'ice giant',
};

/**
 * `systemId` and `index` are needed as well as the planet's own id, because a planet's climate depends
 * on its star and on how far out it orbits -- the clearest case of inheritance in the whole design.
 */
export function planetTraits(id: number, systemId: number, index: number, count: number): PlanetTraits {
  const r = (name: string) => f01(roll(id, name));
  const starLight = starLightOf(systemId);

  // Map the orbital slot onto astronomical units via the star's habitable zone, so "third rock" means
  // something different around a red dwarf than around a blue giant.
  const [hzInner, hzOuter] = habitableZone(starLight.cls);
  const hzMid = (hzInner + hzOuter) / 2;
  const slot = orbitRadius(index, count);
  const orbitAu = Math.max(0.02, hzMid * (slot / 0.52) ** 1.6);

  const massClass = 0.3 * (14 / 0.3) ** r('mass');
  const axialTilt = r('tilt') ** 2 * 74;
  const waterFraction = r('water');
  const atmDensity = r('atm') ** 1.6 * 4;
  const cloudCover = Math.min(1, r('cloud') * (0.35 + atmDensity * 0.4));

  const insolation = starLight.cls.lum / (orbitAu * orbitAu);
  // Provisional ice fraction from a bare equilibrium temperature, then fed back into albedo.
  const bareTemp = 278.6 * Math.max(1e-6, insolation * 0.88) ** 0.25;
  const iceFraction = Math.min(1, Math.max(0, (265 - bareTemp) / 90)) * (0.3 + waterFraction * 0.7);
  const albedo = Math.min(0.85, 0.12 + 0.55 * iceFraction + 0.18 * cloudCover);
  const equilibrium = 278.6 * Math.max(1e-6, insolation * (1 - albedo)) ** 0.25;
  const greenhouse = 1 + waterFraction * 0.8 + cloudCover * 0.6;
  const meanTemp = equilibrium + 33 * Math.log(1 + atmDensity * greenhouse);

  const snowIndex = clamp01((268 - meanTemp) / 45);
  const aridity = clamp01(1 - waterFraction * 1.4 - 0.3 * cloudCover);
  const oceanInertia = waterFraction;
  const seasonality = Math.sin((axialTilt * Math.PI) / 180) * (1 - 0.6 * oceanInertia);

  const cls = classify(meanTemp, waterFraction, massClass, atmDensity, cloudCover, insolation);
  const habitability = habitabilityOf(cls, meanTemp, waterFraction);

  return {
    cls,
    label: LABELS[cls],
    massClass,
    axialTilt,
    waterFraction,
    iceFraction,
    atmDensity,
    atmHue: atmosphereHue(cls, r('atmHue')),
    cloudCover,
    moonCount: Math.floor(r('moons') * (1.2 + massClass * 0.35)),
    hasRings: massClass > 4 ? r('rings') < 0.55 : r('rings') < 0.06,
    ringTilt: 0.18 + r('ringTilt') * 0.5,
    ringWidth: 0.28 + r('ringWidth') * 0.35,
    // Real time per rotation. Long enough to notice, short enough to see happen.
    dayLength: 50 + r('day') * 190,
    retrograde: r('retro') < 0.12,
    insolation,
    albedo,
    meanTemp,
    snowIndex,
    aridity,
    seasonality,
    habitability,
    starLight,
    orbitAu,
  };
}

function classify(
  t: number,
  water: number,
  mass: number,
  atm: number,
  cloud: number,
  insolation: number,
): PlanetClass {
  if (mass > 6) return insolation < 0.02 ? 'iceGiant' : 'gasGiant';
  if (mass > 4 && insolation < 0.02) return 'iceGiant';
  if (t > 800) return 'molten';
  if (t > 450 && atm > 2) return 'greenhouse';
  if (t > 500) return 'scorched';
  if (t < 235) return water > 0.3 ? 'ice' : 'frozenRock';
  if (t < 265) return 'tundra';
  if (t > 295 && water > 0.5 && cloud > 0.6) return 'jungle';
  if (water > 0.75) return 'ocean';
  if (water < 0.15) return 'desert';
  if (water < 0.45) return 'savanna';
  return 'terran';
}

/** 0-1. Above ~0.4 a planet earns a name and, later, a culture. */
function habitabilityOf(cls: PlanetClass, t: number, water: number): number {
  const liveable: PlanetClass[] = ['terran', 'savanna', 'ocean', 'jungle', 'tundra', 'desert'];
  if (!liveable.includes(cls)) return 0;
  const warmth = 1 - Math.min(1, Math.abs(t - 291) / 45);
  const wet = 1 - Math.abs(water - 0.55) * 1.4;
  return clamp01(warmth * 0.65 + clamp01(wet) * 0.35);
}

function atmosphereHue(cls: PlanetClass, r: number): number {
  switch (cls) {
    case 'molten':
    case 'scorched':
      return 18 + r * 20;
    case 'greenhouse':
      return 42 + r * 24;
    case 'desert':
    case 'savanna':
      return 32 + r * 26;
    case 'jungle':
      return 96 + r * 40;
    case 'ice':
    case 'frozenRock':
    case 'tundra':
    case 'iceGiant':
      return 196 + r * 30;
    default:
      return 200 + r * 26;
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function isGiant(cls: PlanetClass): boolean {
  return cls === 'gasGiant' || cls === 'iceGiant';
}

/**
 * A planet's traits live on the planet NODE, attached when the node is built -- see `Ground` in node.ts.
 *
 * They used to be looked up through the tree, which meant this module imported `node.ts`. Reading them off the
 * node instead reverses that dependency, and reversing it is what lets `childAt` consult the terrain -- which
 * is what keeps a settlement out of the sea. The cache went with it: a node already holds its own traits, so
 * there is nothing left to cache and nothing left for two caches to disagree about.
 */
