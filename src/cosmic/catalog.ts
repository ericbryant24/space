import { f01, pick, roll } from '../core/rng.ts';
import type { Kind } from '../universe/schema.ts';

/**
 * Names for cosmic objects, in the Almanac Office's own catalogue.
 *
 * Culture lives on planets, not galaxies, so galaxies and stars are not named in anybody's language:
 * nobody lives in a galaxy to name it. They get catalogue names instead, and universe-wide
 * consistency here is CORRECT rather than a shortcut, because a catalogue is supposed to be
 * consistent. Inhabited planets and everything below them are named in that world's own language.
 */

const ADJECTIVES = [
  'Ashen', 'Quiet', 'Bitter', 'Pale', 'Hollow', 'Amber', 'Salt', 'Slow', 'Bright', 'Drowned',
  'Folded', 'Cinder', 'Glass', 'Iron', 'Long', 'Lantern', 'Kettle', 'Thin', 'Wide', 'Old',
  'Nine-Fold', 'Sunken', 'Rimward', 'Coreward', 'Windward', 'Shattered', 'Patient', 'Frost',
  'Ochre', 'Vermilion', 'Indigo', 'Copper', 'Chalk', 'Ember', 'Tidal', 'Hushed',
] as const;

const CLUSTER_NOUNS = [
  'Reach', 'Shoal', 'Vault', 'Drift', 'Verge', 'Shelf', 'Span', 'Bight', 'Furrow', 'Sprawl',
  'Commons', 'Threshold', 'Expanse', 'Quarter', 'Marches', 'Basin', 'Weir', 'Terrace',
] as const;

const GALAXY_NOUNS = [
  'Spiral', 'Wheel', 'Coil', 'Whorl', 'Lantern', 'Cascade', 'Ribbon', 'Ellipse', 'Smear',
  'Pinwheel', 'Fleece', 'Anvil', 'Scatter', 'Knot', 'Veil', 'Millstone',
] as const;

const CREATURES = [
  'Coilfish', 'Lampfly', 'Hookmoth', 'Saltwren', 'Glasscrab', 'Stonehare', 'Kiteworm',
  'Ashcrow', 'Nettlefox', 'Bellhare', 'Reedmouse', 'Pitchowl',
] as const;

const STAR_STEMS = [
  'Ember', 'Kettle', 'Lantern', 'Anchor', 'Bellows', 'Cinder', 'Hearth', 'Tallow', 'Beacon',
  'Forge', 'Candle', 'Brazier', 'Wick', 'Flint', 'Kiln', 'Torch', 'Signal', 'Furnace',
] as const;

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'] as const;

/** A short designation like `IV-238-11`, used as the visible zoom address. */
export function designation(path: readonly { cx: number; cy: number }[]): string {
  if (path.length === 0) return 'PLATE I';
  const parts = path.map((c, i) => (i === 0 ? ROMAN[c.cx % ROMAN.length] : `${c.cx}.${c.cy}`));
  return `PLATE ${parts.join(' · ')}`;
}

export function catalogName(kind: Kind, id: number, indexHint = 0): string {
  const adj = () => pick(roll(id, 'nameAdj'), ADJECTIVES);
  switch (kind) {
    case 'field':
      return 'The Great Field';
    case 'cluster':
      return `The ${adj()} ${pick(roll(id, 'nameNoun'), CLUSTER_NOUNS)}`;
    case 'galaxy': {
      // Most galaxies get a descriptive name; small anonymous ones get a bare catalogue code, which
      // is how a real survey would treat them.
      if (f01(roll(id, 'nameStyle')) < 0.22) {
        const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        const a = letters[Math.floor(f01(roll(id, 'nameCode1')) * letters.length)] ?? 'X';
        const n = 100 + Math.floor(f01(roll(id, 'nameCode2')) * 8900);
        return `${a}${n}`;
      }
      if (f01(roll(id, 'nameCreature')) < 0.35) {
        return `${pick(roll(id, 'nameCr'), CREATURES)} ${pick(roll(id, 'nameNoun'), GALAXY_NOUNS)}`;
      }
      return `The ${adj()} ${pick(roll(id, 'nameNoun'), GALAXY_NOUNS)}`;
    }
    case 'system': {
      const stem = pick(roll(id, 'nameStem'), STAR_STEMS);
      const n = 100 + Math.floor(f01(roll(id, 'nameNum')) * 9900);
      return `${stem} ${n}`;
    }
    case 'planet':
      // The parent's name plus an ordinal. An inhabited planet also carries its own local name; that
      // arrives with the culture layer and is shown alongside this designation, not instead of it.
      return `${ROMAN[indexHint % ROMAN.length]}`;
    case 'region':
      return `${adj()} ${pick(roll(id, 'nameNoun'), ['Shelf', 'Pan', 'Reach', 'Flats', 'Downs', 'Barrens', 'Sound', 'Basin'] as const)}`;
    case 'settlement':
      return `${adj()} ${pick(roll(id, 'nameNoun'), ['Landing', 'Crossing', 'Wharf', 'Row', 'Yard', 'Halt', 'Camp', 'Works'] as const)}`;
    case 'building':
      return pick(roll(id, 'nameFn'), [
        'Ferry House', 'Kiln Row', 'The Lamp House', 'Salt Store', 'Net Loft', 'Coop',
        'Weighbridge', 'The Harbourmaster', 'Rope Walk', 'Grain Vault', 'Smithy', 'Bell Tower',
      ] as const);
  }
}
