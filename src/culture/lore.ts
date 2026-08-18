import { formatDistance } from '../universe/schema.ts';
import type { PlanetCulture } from '../universe/gen/culture.ts';
import type { PlanetTraits } from '../universe/gen/planet.ts';
import { f01, hash2, pick } from '../core/rng.ts';

/**
 * The Almanac's voice.
 *
 * Declarative, present tense, concrete numbers, one fact per clause. Names of things, not moods. Every
 * slot is filled from TRAITS, never from a free roll, so each line is true of the thing on screen --
 * which is the whole reason the prose is worth having rather than decorative.
 *
 * The banned-word list is enforced by a test over ten thousand generated lines. "Mysterious" and
 * "ancient" are how procedural text announces that it has nothing to say.
 */
export const BANNED_WORDS: readonly string[] = [
  'mysterious', 'ancient', 'eerie', 'endless', 'forgotten', 'whisper', 'secret',
  'unknown', 'cosmic', 'majestic', 'shimmering', 'alien',
];

export function planetFacts(traits: PlanetTraits, culture: PlanetCulture, starName: string): string[] {
  const out: string[] = [];
  const celsius = Math.round(traits.meanTemp - 273.15);
  out.push(`${traits.label}, ${celsius > 0 ? `${celsius}°C` : `${celsius}°C`} on average`);
  out.push(`${Math.round(traits.waterFraction * 100)}% water, ${traits.orbitAu.toFixed(2)} AU from ${starName}`);
  out.push(`lit ${lightWord(traits)} by a ${traits.starLight.cls.label}`);
  if (traits.hasRings) out.push('It has rings, and they are ice.');
  if (traits.moonCount === 1) out.push('One moon.');
  else if (traits.moonCount > 1) out.push(`${traits.moonCount} moons.`);
  if (traits.snowIndex > 0.55) out.push(`Winter lasts a third of the year. Everything here is roofed steeply.`);
  if (traits.aridity > 0.7) out.push('It does not rain here.');
  if (traits.axialTilt > 45) out.push(`The axis leans ${Math.round(traits.axialTilt)} degrees, so the seasons are violent.`);
  if (culture.inhabited) {
    out.push(`${formatPopulation(culture.population)} people live here.`);
  } else {
    out.push('Nobody lives here.');
  }
  return out;
}

/** One line, chosen deterministically from the true facts about this place. */
export function planetLine(traits: PlanetTraits, culture: PlanetCulture, starName: string, id: number): string {
  const facts = planetFacts(traits, culture, starName);
  const lead = `${traits.label}, ${Math.round(traits.waterFraction * 100)}% water, lit ${lightWord(traits)} by ${starName}.`;
  const extra = facts.filter((f) => f.endsWith('.'));
  if (!extra.length) return lead;
  return `${lead} ${pick(hash2(id, 0x7e1), extra)}`;
}

export function settlementLine(culture: PlanetCulture, traits: PlanetTraits, id: number, name: string): string {
  const trades = ['fish', 'cut reed', 'fire clay', 'quarry stone', 'keep bees', 'salt the flats', 'mend nets', 'burn lime'];
  const pop = Math.max(40, Math.round((culture.population / 900) * (0.4 + f01(hash2(id, 0x7f1)) * 2.2)));
  const roof = architectureClause(traits);
  return `${name}, a town of ${formatPopulation(pop)}, ${roof}. Most of them ${pick(hash2(id, 0x7f2), trades)}.`;
}

/**
 * How this world builds, in one clause.
 *
 * Keyed off the planet CLASS first, then the indices. Keying off snowIndex alone described a tundra
 * world as "tiled, and set close together": the classifier calls anything under 265 K tundra, while the
 * snow index only rises meaningfully below about 250 K, so the two disagreed about the same planet. The
 * class is the summary of the climate, so it is what the sentence should follow.
 */
export function architectureClause(traits: PlanetTraits): string {
  const cold: PlanetTraits['cls'][] = ['tundra', 'ice', 'frozenRock', 'iceGiant'];
  if (cold.includes(traits.cls) || traits.snowIndex > 0.35) {
    return 'roofed steeply against the snow, with a chimney on every house';
  }
  if (traits.cls === 'desert' || traits.aridity > 0.65) return 'flat-roofed, and walled against the sun';
  if (traits.cls === 'jungle' || traits.cloudCover > 0.6) return 'deep-eaved, because it rains most days';
  if (traits.cls === 'ocean') return 'built on stilts, with a boat under every house';
  return 'tiled, and set close together';
}

function lightWord(traits: PlanetTraits): string {
  const h = traits.starLight.cls.hue;
  if (h < 25) return 'red';
  if (h < 45) return 'amber';
  if (h < 60) return 'yellow-white';
  return 'blue-white';
}

export function formatPopulation(n: number): string {
  // Rounding to thousands and then appending ",000" produced "8.3,000". Group the real number instead.
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.0', '')} million`;
  if (n >= 1e4) return `${(Math.round(n / 100) * 100).toLocaleString('en-US')}`;
  if (n >= 1e3) return `${(Math.round(n / 10) * 10).toLocaleString('en-US')}`;
  return `${Math.round(n / 10) * 10}`;
}

export { formatDistance };
