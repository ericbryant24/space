import { languageOf, placeName, word, type Language, type Morpheme } from '../../culture/language.ts';
import { motifOf, type Motif } from '../../culture/motif.ts';
import { f01, hash2, hash3, pick, roll } from '../../core/rng.ts';
import type { Node } from '../node.ts';
import type { Tree } from '../tree.ts';
import { HABITABLE_THRESHOLD, type PlanetTraits } from './planet.ts';

/**
 * A planet's culture.
 *
 * THE PLANET IS THE ROOT OF CULTURE. Not the galaxy: a galaxy is a hundred billion stars, and nothing
 * about language, architecture or life is uniform at that scale. Everything here belongs to one world,
 * and its regions and settlements inherit it.
 */
export { HABITABLE_THRESHOLD };

export interface PlanetCulture {
  readonly inhabited: boolean;
  readonly language: Language;
  readonly motif: Motif;
  /** The world's own name for itself, as opposed to the Almanac's catalogue designation. */
  readonly localName: string;
  readonly population: number;
}


const cache = new Map<number, PlanetCulture>();

export function cultureOf(planetId: number, traits: PlanetTraits): PlanetCulture {
  let c = cache.get(planetId);
  if (!c) {
    const language = languageOf(planetId);
    const inhabited = traits.habitability >= HABITABLE_THRESHOLD;
    c = {
      inhabited,
      language,
      motif: motifOf(planetId),
      localName: word(language, hash2(planetId, 0x9a1)),
      // Skewed hard towards small: most inhabited worlds are thinly settled.
      population: inhabited
        ? Math.round(2e4 * (1 + f01(roll(planetId, 'population')) ** 3 * 400) * (0.4 + traits.habitability))
        : 0,
    };
    if (cache.size > 512) cache.clear();
    cache.set(planetId, c);
  }
  return c;
}

/** Walk up to the enclosing planet, if the camera is on or below one. */
export function enclosingPlanet(node: Node, tree: Tree): Node | null {
  let current: Node | null = node;
  for (let i = 0; i < 10 && current; i++) {
    if (current.kind === 'planet') return current;
    current = tree.parentOf(current);
  }
  return null;
}

const REGION_NOUNS = ['Shelf', 'Pan', 'Reach', 'Flats', 'Downs', 'Barrens', 'Sound', 'Basin', 'Coast', 'Divide'] as const;
const SETTLEMENT_MORPHEMES: readonly Morpheme[] = ['city', 'water', 'mountain', 'gate', 'deep'];
const BUILDING_FUNCTIONS = [
  'Ferry House', 'Kiln Row', 'The Lamp House', 'Salt Store', 'Net Loft', 'Weighbridge',
  'The Harbourmaster', 'Rope Walk', 'Grain Vault', 'Smithy', 'Bell Tower', 'Wash House',
  'Boat Shed', 'The Long Barn', 'Toll House', 'Ice Store',
] as const;

/**
 * Names below the planet come from that world's own language.
 *
 * Regions pair an English geographic noun with a local element, exactly as a real atlas does -- the
 * Almanac Office translates common nouns and preserves proper ones. Buildings get functional English
 * with their local name alongside, because if the deepest and most detailed level were named entirely
 * in an invented language it would be the least readable thing in the project.
 */
export function regionName(culture: PlanetCulture, id: number): string {
  return `${placeName(culture.language, hash2(id, 0x2e1), 'mountain')} ${pick(hash2(id, 0x2e2), REGION_NOUNS)}`;
}

export function settlementName(culture: PlanetCulture, id: number): string {
  const morpheme = SETTLEMENT_MORPHEMES[(hash2(id, 0x3f1) >>> 8) % SETTLEMENT_MORPHEMES.length]!;
  return placeName(culture.language, hash2(id, 0x3f2), morpheme);
}

export function buildingName(culture: PlanetCulture, id: number): { functional: string; local: string } {
  return {
    functional: pick(hash2(id, 0x4c1), BUILDING_FUNCTIONS),
    local: word(culture.language, hash3(id, 0x4c2, 1), [1, 2]),
  };
}

export function planetCultureFor(
  node: Node,
  tree: Tree,
): { planet: Node; culture: PlanetCulture; traits: PlanetTraits } | null {
  const planet = enclosingPlanet(node, tree);
  if (!planet) return null;
  const traits = planet.ground?.traits;
  if (!traits) return null;
  return { planet, culture: cultureOf(planet.id, traits), traits };
}
