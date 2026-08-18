import { metallicityOf, type MetallicityField } from '../../cosmic/metallicity.ts';
import { makePalette, type Palette } from '../../culture/palette.ts';
import { galaxyShape, type GalaxyShape } from './galaxyShape.ts';

export { armDensity, galaxyShape } from './galaxyShape.ts';
export type { GalaxyShape, Morphology } from './galaxyShape.ts';

/**
 * A galaxy's full description: its geometry plus the things only drawing needs. Physics and appearance
 * only -- language, architecture and biosphere belong to the PLANET, because a galaxy is a hundred
 * billion stars and nothing about life or building is uniform at that scale.
 */
export interface GalaxyTraits extends GalaxyShape {
  readonly palette: Palette;
  readonly metallicity: MetallicityField;
}

export function galaxyTraits(id: number): GalaxyTraits {
  return {
    ...galaxyShape(id),
    // Space mode wants a restrained palette: a glowing void reads as a screensaver.
    palette: makePalette(id, 'cosmicPalette', 'sober'),
    metallicity: metallicityOf(id),
  };
}
