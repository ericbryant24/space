import { f01, roll } from '../core/rng.ts';

/**
 * Metallicity is the one trait that still legitimately spans a whole galaxy, because it is chemistry
 * rather than culture: metal-rich cores, metal-poor rims. It survives all the way down to the colour
 * of a single wall, because it sets the ORE HUE that masonry and roof tiles are tinted with.
 *
 * A galaxy's rim worlds get pale, chalky buildings; its core worlds get dark, iron-rich ones. Same
 * architecture, different chemistry, visibly, four levels apart.
 */
export interface MetallicityField {
  readonly core: number;
  readonly rim: number;
  /** Hue that ores tend towards in this galaxy: rusts and irons, or chalks and salts. */
  readonly oreHue: number;
}

export function metallicityOf(galaxyId: number): MetallicityField {
  return {
    core: 0.6 + f01(roll(galaxyId, 'metallicityCore')) * 0.4,
    rim: 0.15 + f01(roll(galaxyId, 'metallicityRim')) * 0.35,
    oreHue: 8 + f01(roll(galaxyId, 'oreHue')) * 42, // rust through ochre
  };
}

/** Metallicity at a fractional radius from the galactic centre. */
export function metallicityAt(field: MetallicityField, radiusFraction: number): number {
  const t = Math.min(1, Math.max(0, radiusFraction));
  return field.core + (field.rim - field.core) * t;
}

/** How dark and saturated stone reads at this metallicity. 0 = chalk, 1 = dark iron. */
export function oreDarkness(metallicity: number): number {
  return Math.min(1, Math.max(0, (metallicity - 0.1) / 0.9));
}
