import { metallicityOf, type MetallicityField } from '../../cosmic/metallicity.ts';
import { f01, roll } from '../../core/rng.ts';
import { makePalette, type Palette } from '../../culture/palette.ts';

/**
 * Galaxy traits: physics and appearance only. Language, architecture, biosphere and settlement logic
 * all belong to the PLANET -- a galaxy is a hundred billion stars, and nothing about life or building
 * is uniform at that scale. What legitimately spans a galaxy is its shape, its star population, and
 * its metallicity gradient.
 */
export type Morphology =
  | 'spiral'
  | 'barredSpiral'
  | 'elliptical'
  | 'dwarfBlob'
  | 'irregular'
  | 'lenticular'
  | 'flocculent'
  | 'ring'
  | 'interacting'
  | 'cartwheel';

const MORPHOLOGY_WEIGHTS: readonly (readonly [Morphology, number])[] = [
  ['spiral', 0.34],
  ['barredSpiral', 0.19],
  ['elliptical', 0.13],
  ['dwarfBlob', 0.11],
  ['irregular', 0.11],
  ['lenticular', 0.055],
  ['flocculent', 0.04],
  ['ring', 0.015],
  ['interacting', 0.008],
  ['cartwheel', 0.002],
];

export interface GalaxyTraits {
  readonly morphology: Morphology;
  readonly palette: Palette;
  readonly metallicity: MetallicityField;

  /** Spiral family. */
  readonly arms: number;
  /** Arm pitch in radians; tan(pitch) is the logarithmic spiral's growth rate. */
  readonly pitch: number;
  /** How many turns each arm sweeps through. */
  readonly sweep: number;
  readonly armWidth: number;
  readonly armTwist: number;

  /** Bulge and bar. */
  readonly coreRadius: number;
  readonly bulge: number;
  readonly barLength: number;
  readonly barWidth: number;

  /** Ellipticals and lenticulars. */
  readonly ellipticity: number;
  readonly bands: number;
  readonly tilt: number;
  readonly dustLanes: number;

  /** Blobby forms. */
  readonly blobs: number;
  readonly asymmetry: number;

  /** Rings. */
  readonly ringRadius: number;
  readonly ringKnots: number;

  /** Star population. */
  readonly starCount: number;
  readonly heroStars: number;
  readonly activeNucleus: boolean;
}

export function galaxyTraits(id: number): GalaxyTraits {
  const r = (name: string) => f01(roll(id, name));
  const morphology = weighted(r('morphology'), MORPHOLOGY_WEIGHTS);

  const flocculent = morphology === 'flocculent';
  return {
    morphology,
    // Space mode wants a restrained palette: a glowing void reads as a screensaver.
    palette: makePalette(id, 'cosmicPalette', 'sober'),
    metallicity: metallicityOf(id),

    arms: flocculent ? 6 + Math.floor(r('arms') * 4) : 2 + Math.floor(r('arms') * 4),
    pitch: ((flocculent ? 24 : 10) + r('pitch') * (flocculent ? 10 : 16)) * (Math.PI / 180),
    sweep: 1.2 + r('sweep') * 1.4,
    armWidth: 0.05 + r('armWidth') * 0.06,
    armTwist: r('armTwist') * Math.PI * 2,

    coreRadius: 0.05 + r('coreRadius') * 0.09,
    bulge: 0.4 + r('bulge') * 0.6,
    barLength: 0.18 + r('barLength') * 0.2,
    barWidth: 0.06 + r('barWidth') * 0.06,

    ellipticity: morphology === 'lenticular' ? 0.55 + r('ellip') * 0.25 : r('ellip') * 0.7,
    bands: 3 + Math.floor(r('bands') * 3),
    tilt: r('tilt') * Math.PI,
    dustLanes: Math.floor(r('dust') * 4),

    blobs: morphology === 'dwarfBlob' ? 2 + Math.floor(r('blobs') * 3) : 3 + Math.floor(r('blobs') * 5),
    asymmetry: 0.3 + r('asym') * 0.6,

    ringRadius: 0.6 + r('ringR') * 0.25,
    ringKnots: 1 + Math.floor(r('knots') * 3),

    starCount: Math.round(900 + r('starCount') * 3100),
    heroStars: Math.round(30 + r('heroStars') * 20),
    activeNucleus: r('agn') < 0.03,
  };
}

function weighted<T>(r: number, table: readonly (readonly [T, number])[]): T {
  const total = table.reduce((a, t) => a + t[1], 0);
  let acc = 0;
  const x = r * total;
  for (const [value, w] of table) {
    acc += w;
    if (x <= acc) return value;
  }
  return table[0]![0];
}

/**
 * Arm density at a point in galaxy units, 0-1. Stars are rejection-sampled against this, so the
 * blurred blob at wide zoom and the individual stars close up come from the same field and therefore
 * cross-fade without a seam.
 */
export function armDensity(t: GalaxyTraits, x: number, y: number): number {
  const radius = Math.hypot(x, y);
  if (radius > 1) return 0;

  const core = Math.exp(-((radius / t.coreRadius) ** 2)) * t.bulge;
  const halo = 0.06 * (1 - radius);

  switch (t.morphology) {
    case 'elliptical':
    case 'dwarfBlob':
    case 'lenticular':
      return Math.min(1, Math.exp(-2.4 * radius) * 0.9 + core * 0.5 + halo);
    case 'ring':
    case 'cartwheel': {
      const d = Math.abs(radius - t.ringRadius);
      return Math.min(1, Math.exp(-((d / 0.09) ** 2)) * 0.95 + core * 0.7 + halo * 0.5);
    }
    case 'irregular': {
      let v = 0;
      for (let i = 0; i < t.blobs; i++) {
        const a = (i / t.blobs) * Math.PI * 2 * t.asymmetry + t.armTwist;
        const rr = 0.25 + ((i * 0.37) % 1) * 0.55;
        const bx = Math.cos(a) * rr;
        const by = Math.sin(a) * rr;
        v += Math.exp(-(((x - bx) ** 2 + (y - by) ** 2) / 0.045));
      }
      return Math.min(1, v * 0.8 + core * 0.4 + halo);
    }
    default: {
      // Logarithmic spiral: r = coreRadius * e^(b*theta), so theta = ln(r / coreRadius) / b.
      if (radius < t.coreRadius * 0.6) return Math.min(1, core + halo);
      const b = Math.tan(t.pitch);
      const theta = Math.log(radius / t.coreRadius) / b;
      const angle = Math.atan2(y, x);
      let best = 0;
      for (let i = 0; i < t.arms; i++) {
        const armAngle = theta + t.armTwist + (i / t.arms) * Math.PI * 2;
        // Angular distance to this arm's ridge, wrapped to [-pi, pi].
        let d = ((angle - armAngle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        // Arms broaden outwards, matching the drawn ribbon width.
        const width = (t.armWidth * (0.35 + radius ** 0.6)) / Math.max(0.08, radius);
        best = Math.max(best, Math.exp(-((d / width) ** 2)));
      }
      const flocculentBreakup = t.morphology === 'flocculent' ? 0.55 : 1;
      return Math.min(1, best * 0.95 * flocculentBreakup + core + halo);
    }
  }
}
