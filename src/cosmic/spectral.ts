import { f01, roll } from '../core/rng.ts';
import type { Hsl } from '../render/color.ts';

/**
 * Star classes. The weights are deliberately NOT astrophysical: G and K are boosted far above their
 * real abundance because habitable systems are where all the content lives. This is an art-direction
 * decision, stated openly rather than smuggled in.
 */
export interface SpectralClass {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly hue: number;
  readonly sat: number;
  /** Perceived brightness 0-1, used to scale how hard the star tints everything below it. */
  readonly rel: number;
  /** Luminosity in solar units, for the habitable-zone calculation. */
  readonly lum: number;
  /** Multiplier on the drawn disc radius. */
  readonly discScale: number;
  readonly note?: string;
}

export const SPECTRAL: readonly SpectralClass[] = [
  { key: 'M', label: 'red dwarf', weight: 0.34, hue: 18, sat: 0.85, rel: 0.42, lum: 0.04, discScale: 0.55 },
  { key: 'K', label: 'orange dwarf', weight: 0.19, hue: 33, sat: 0.7, rel: 0.62, lum: 0.3, discScale: 0.78 },
  { key: 'G', label: 'yellow star', weight: 0.16, hue: 48, sat: 0.55, rel: 0.82, lum: 1, discScale: 1 },
  { key: 'F', label: 'white star', weight: 0.08, hue: 54, sat: 0.22, rel: 0.93, lum: 4, discScale: 1.15 },
  { key: 'A', label: 'blue-white star', weight: 0.05, hue: 222, sat: 0.35, rel: 1, lum: 25, discScale: 1.35 },
  { key: 'B', label: 'blue giant', weight: 0.016, hue: 218, sat: 0.55, rel: 1, lum: 1000, discScale: 1.8 },
  { key: 'O', label: 'blue supergiant', weight: 0.004, hue: 224, sat: 0.68, rel: 1, lum: 30000, discScale: 2.3 },
  { key: 'WD', label: 'white dwarf', weight: 0.055, hue: 210, sat: 0.12, rel: 0.9, lum: 0.005, discScale: 0.18, note: 'collapsed' },
  { key: 'RG', label: 'red giant', weight: 0.038, hue: 10, sat: 0.8, rel: 0.6, lum: 200, discScale: 2.6, note: 'swollen' },
  { key: 'C', label: 'carbon star', weight: 0.009, hue: 6, sat: 0.9, rel: 0.5, lum: 60, discScale: 1.9, note: 'sooty' },
  { key: 'NS', label: 'pulsar', weight: 0.004, hue: 196, sat: 0.3, rel: 1, lum: 0.0001, discScale: 0.07, note: 'blinking' },
  { key: 'BD', label: 'brown dwarf', weight: 0.008, hue: 14, sat: 0.55, rel: 0.14, lum: 0.0004, discScale: 0.4, note: 'barely a star' },
];

const TOTAL_WEIGHT = SPECTRAL.reduce((a, c) => a + c.weight, 0);

/**
 * Index into SPECTRAL rather than the class itself. The renderer batches a galaxy's stars by class so
 * it can emit one path per colour instead of one per star, and an index is what a bucket array wants.
 */
export function spectralIndexOf(nodeId: number): number {
  const r = f01(roll(nodeId, 'spectralClass')) * TOTAL_WEIGHT;
  let acc = 0;
  for (let i = 0; i < SPECTRAL.length; i++) {
    acc += SPECTRAL[i]!.weight;
    if (r <= acc) return i;
  }
  return 0;
}

export function spectralOf(nodeId: number): SpectralClass {
  return SPECTRAL[spectralIndexOf(nodeId)]!;
}

export interface StarLight {
  readonly cls: SpectralClass;
  readonly colour: Hsl;
  /** Hue that shadows rotate towards: the complement of sunlight. Warm sun, cool shadows. */
  readonly shadowHue: number;
  /** Direction light arrives from, in radians. Every shadow on every plate below points this way. */
  readonly azimuth: number;
}

export function starLightOf(nodeId: number): StarLight {
  const cls = spectralOf(nodeId);
  return {
    cls,
    colour: { h: cls.hue, s: cls.sat, l: 0.5 + cls.rel * 0.28 },
    shadowHue: (cls.hue + 180) % 360,
    azimuth: f01(roll(nodeId, 'azimuth')) * Math.PI * 2,
  };
}

/** Habitable zone in AU, from luminosity. Used to decide which planets get names and cultures. */
export function habitableZone(cls: SpectralClass): [number, number] {
  const s = Math.sqrt(cls.lum);
  return [0.85 * s, 1.7 * s];
}
