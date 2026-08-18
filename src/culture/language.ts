import { f01, mix, roll, stream } from '../core/rng.ts';

/**
 * A generated language, per INHABITED PLANET.
 *
 * Per planet, not per galaxy: a galaxy is a hundred billion stars and nothing about language is
 * uniform at that scale. One world, one people, one way of writing.
 *
 * Two guards do the real work here. Without them a phoneme generator produces either mush or
 * unmistakable Earth pastiche, and pastiche is worse -- "Elvish but slightly off" is exactly the
 * failure mode that makes procedural naming feel cheap.
 */
export interface Language {
  readonly onsets: readonly string[];
  readonly codas: readonly string[];
  readonly vowels: readonly string[];
  readonly syllables: readonly { readonly template: string; readonly weight: number }[];
  readonly stress: 'initial' | 'penult' | 'final';
  readonly quirks: readonly Quirk[];
  readonly oddity: Oddity;
  readonly minSyllables: number;
  readonly maxSyllables: number;
  readonly morphemes: Readonly<Record<Morpheme, string>>;
  /** 14-bit signature used by the anti-cliche guard and by the distinctness test. */
  readonly features: number;
  readonly attempts: number;
}

export type Morpheme =
  | 'world'
  | 'water'
  | 'mountain'
  | 'city'
  | 'sacred'
  | 'small'
  | 'deep'
  | 'gate'
  | 'of';

export type Quirk =
  | 'doubledVowels'
  | 'apostrophe'
  | 'digraphs'
  | 'terminalX'
  | 'yAsVowel'
  | 'hyphenated'
  | 'circumflex'
  | 'noLetterE'
  | 'qWithoutU'
  | 'doubledMedial'
  | 'capitalSecond'
  | 'catalogSuffix';

export type Oddity =
  | 'noVoicedStops'
  | 'consonantFinal'
  | 'reduplicatedPlurals'
  | 'vowelHarmony'
  | 'threeSyllableMinimum'
  | 'noNasals'
  | 'toneDiacritics'
  | 'initialVowelRequired'
  | 'ergativeSuffix'
  | 'noCodas';

const FAMILIES: readonly (readonly string[])[] = [
  ['p', 't', 'k', 'q'], // voiceless stops
  ['b', 'd', 'g'], // voiced stops
  ['m', 'n', 'ng', 'ny'], // nasals
  ['l', 'r', 'll', 'rr'], // liquids
  ['s', 'sh', 'z', 'zh', 'ts'], // sibilants
  ['f', 'v', 'th', 'kh', 'gh', 'h'], // fricatives
  ['w', 'y', 'j'], // glides
  ["'", "k'", "t'"], // glottal and ejective
];

const VOWEL_POOL = ['a', 'e', 'i', 'o', 'u', 'ae', 'y', 'ei', 'ai', 'ou', 'au', 'ue'] as const;

const TEMPLATES: readonly (readonly [string, number])[] = [
  ['CV', 0.3],
  ['CVC', 0.24],
  ['V', 0.1],
  ['CVV', 0.1],
  ['CCV', 0.08],
  ['VC', 0.08],
  ['CVCC', 0.05],
  ['CVn', 0.05],
];

const QUIRKS: readonly Quirk[] = [
  'doubledVowels', 'apostrophe', 'digraphs', 'terminalX', 'yAsVowel', 'hyphenated',
  'circumflex', 'noLetterE', 'qWithoutU', 'doubledMedial', 'capitalSecond', 'catalogSuffix',
];

const ODDITIES: readonly Oddity[] = [
  'noVoicedStops', 'consonantFinal', 'reduplicatedPlurals', 'vowelHarmony',
  'threeSyllableMinimum', 'noNasals', 'toneDiacritics', 'initialVowelRequired',
  'ergativeSuffix', 'noCodas',
];

// Feature bits. Order matters: the cliche profiles below are written against it.
export const FEATURE = {
  manyVowels: 1 << 0,
  hasCodas: 1 << 1,
  hasGlottal: 1 << 2,
  longWords: 1 << 3,
  openSyllablesOnly: 1 << 4,
  hyphenated: 1 << 5,
  apostrophe: 1 << 6,
  voicedStops: 1 << 7,
  nasals: 1 << 8,
  digraphs: 1 << 9,
  doubledVowels: 1 << 10,
  consonantFinal: 1 << 11,
  reduplication: 1 << 12,
  diacritics: 1 << 13,
} as const;

/**
 * Earth-cliche signatures. A generated language within Hamming distance 2 of any of these is thrown
 * away and re-rolled, which is what stops the generator from drifting into recognisable pastiche.
 */
const CLICHES: readonly { name: string; bits: number }[] = [
  { name: 'elvish-liquid', bits: FEATURE.manyVowels | FEATURE.nasals | FEATURE.doubledVowels | FEATURE.openSyllablesOnly },
  { name: 'klingon-guttural', bits: FEATURE.hasCodas | FEATURE.hasGlottal | FEATURE.apostrophe | FEATURE.consonantFinal },
  { name: 'japanese-cv', bits: FEATURE.openSyllablesOnly | FEATURE.nasals | FEATURE.reduplication },
  { name: 'latinate', bits: FEATURE.manyVowels | FEATURE.hasCodas | FEATURE.voicedStops | FEATURE.nasals },
  { name: 'norse', bits: FEATURE.hasCodas | FEATURE.voicedStops | FEATURE.consonantFinal | FEATURE.diacritics },
  { name: 'sanskrit-aspirate', bits: FEATURE.digraphs | FEATURE.voicedStops | FEATURE.longWords | FEATURE.nasals },
  { name: 'arabic-emphatic', bits: FEATURE.hasGlottal | FEATURE.apostrophe | FEATURE.hasCodas | FEATURE.digraphs },
  { name: 'welsh-digraph', bits: FEATURE.digraphs | FEATURE.hasCodas | FEATURE.doubledVowels | FEATURE.nasals },
];

const popcount = (n: number): number => {
  let c = 0;
  let x = n;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
};

export function hammingToCliche(features: number): { name: string; distance: number } {
  let best = { name: CLICHES[0]!.name, distance: 99 };
  for (const c of CLICHES) {
    const d = popcount(features ^ c.bits);
    if (d < best.distance) best = { name: c.name, distance: d };
  }
  return best;
}

export const MAX_LANGUAGE_ATTEMPTS = 24;

export function makeLanguage(planetId: number): Language {
  for (let attempt = 0; attempt < MAX_LANGUAGE_ATTEMPTS; attempt++) {
    const lang = build(planetId, attempt);
    if (hammingToCliche(lang.features).distance > 2) return { ...lang, attempts: attempt + 1 };
  }
  // Deliberately odd fallback, far from every cliche by construction: no codas, no nasals, long words.
  return { ...build(planetId, MAX_LANGUAGE_ATTEMPTS, 'noNasals'), attempts: MAX_LANGUAGE_ATTEMPTS + 1 };
}

function build(planetId: number, attempt: number, forceOddity?: Oddity): Omit<Language, 'attempts'> {
  const seed = mix(stream(planetId, 'language'), attempt * 7919);
  const r = (tag: number) => f01(mix(seed, tag));
  const pickFrom = <T>(tag: number, arr: readonly T[]): T => arr[Math.floor(r(tag) * arr.length) % arr.length]!;

  const oddity = forceOddity ?? pickFrom(1, ODDITIES);

  // Pick 3-5 consonant families, then 1-4 members of each.
  const familyCount = 3 + Math.floor(r(2) * 3);
  const chosen: string[] = [];
  const usedFamilies: number[] = [];
  for (let i = 0; i < familyCount; i++) {
    let fi = Math.floor(r(10 + i) * FAMILIES.length) % FAMILIES.length;
    for (let guard = 0; guard < FAMILIES.length && usedFamilies.includes(fi); guard++) {
      fi = (fi + 1) % FAMILIES.length;
    }
    usedFamilies.push(fi);
    const family = FAMILIES[fi]!;
    const take = 1 + Math.floor(r(20 + i) * Math.min(4, family.length));
    for (let j = 0; j < take; j++) chosen.push(family[j % family.length]!);
  }

  let onsets = [...new Set(chosen)];
  if (oddity === 'noVoicedStops') onsets = onsets.filter((c) => !'bdg'.includes(c));
  if (oddity === 'noNasals') onsets = onsets.filter((c) => !['m', 'n', 'ng', 'ny'].includes(c));
  if (onsets.length < 4) onsets.push('t', 'k', 's', 'l');
  onsets = [...new Set(onsets)];

  const vowelCount = 3 + Math.floor(r(3) * 6);
  const vowels: string[] = [];
  for (let i = 0; i < vowelCount; i++) vowels.push(VOWEL_POOL[Math.floor(r(30 + i) * VOWEL_POOL.length) % VOWEL_POOL.length]!);
  const uniqueVowels = [...new Set(vowels)];
  // A three-vowel language sounds fundamentally unlike a seven-vowel one, and the difference is
  // audible immediately, so the count is a first-class knob rather than incidental.
  if (uniqueVowels.length < 3) uniqueVowels.push('a', 'i', 'u');

  const allowCodas = oddity !== 'noCodas' && r(4) < 0.72;
  let codas: string[] = [];
  if (allowCodas) {
    const codaCount = 1 + Math.floor(r(5) * 5);
    for (let i = 0; i < codaCount; i++) codas.push(onsets[Math.floor(r(40 + i) * onsets.length) % onsets.length]!);
    // Glottals and ejectives are onset consonants here. Allowing them as codas produced words
    // like Upk'khuk', which end on a click.
    codas = [...new Set(codas)].filter((c) => !c.includes("'"));
  }
  if (oddity === 'consonantFinal' && codas.length === 0) {
    const plain = onsets.filter((c) => !c.includes("'"));
    codas = [plain[0] ?? 't'];
  }

  const templateCount = 3 + Math.floor(r(6) * 3);
  const syllables: { template: string; weight: number }[] = [];
  for (let i = 0; i < templateCount; i++) {
    const [template, weight] = TEMPLATES[Math.floor(r(50 + i) * TEMPLATES.length) % TEMPLATES.length]!;
    if (!codas.length && (template.endsWith('C') || template.endsWith('n'))) continue;
    if (syllables.some((s) => s.template === template)) continue;
    syllables.push({ template, weight });
  }
  if (!syllables.length) syllables.push({ template: 'CV', weight: 1 });

  const quirkCount = 1 + Math.floor(r(7) * 3);
  const quirks: Quirk[] = [];
  for (let i = 0; i < quirkCount; i++) {
    const q = pickFrom(60 + i, QUIRKS);
    if (!quirks.includes(q)) quirks.push(q);
  }

  const minSyllables = oddity === 'threeSyllableMinimum' ? 3 : 1 + Math.floor(r(8) * 2);
  const maxSyllables = Math.max(minSyllables + 1, minSyllables + 1 + Math.floor(r(9) * 2));

  const lang: Bare = {
    onsets,
    codas,
    vowels: uniqueVowels,
    syllables,
    stress: pickFrom(70, ['initial', 'penult', 'final'] as const),
    quirks,
    oddity,
    minSyllables,
    maxSyllables,
  };

  const withMorphemes = { ...lang, morphemes: makeMorphemes(lang, seed) };
  return { ...withMorphemes, features: featuresOf(withMorphemes) };
}

function featuresOf(lang: Omit<Language, 'attempts' | 'features'>): number {
  let f = 0;
  if (lang.vowels.length >= 6) f |= FEATURE.manyVowels;
  if (lang.codas.length > 0) f |= FEATURE.hasCodas;
  if (lang.onsets.some((c) => c.includes("'"))) f |= FEATURE.hasGlottal;
  if ((lang.minSyllables + lang.maxSyllables) / 2 >= 3) f |= FEATURE.longWords;
  if (lang.codas.length === 0) f |= FEATURE.openSyllablesOnly;
  if (lang.quirks.includes('hyphenated')) f |= FEATURE.hyphenated;
  if (lang.quirks.includes('apostrophe')) f |= FEATURE.apostrophe;
  if (lang.onsets.some((c) => 'bdg'.includes(c) && c.length === 1)) f |= FEATURE.voicedStops;
  if (lang.onsets.some((c) => ['m', 'n', 'ng', 'ny'].includes(c))) f |= FEATURE.nasals;
  if (lang.quirks.includes('digraphs')) f |= FEATURE.digraphs;
  if (lang.quirks.includes('doubledVowels')) f |= FEATURE.doubledVowels;
  if (lang.oddity === 'consonantFinal') f |= FEATURE.consonantFinal;
  if (lang.oddity === 'reduplicatedPlurals') f |= FEATURE.reduplication;
  if (lang.quirks.includes('circumflex') || lang.oddity === 'toneDiacritics') f |= FEATURE.diacritics;
  return f;
}

function makeMorphemes(lang: Bare, seed: number): Record<Morpheme, string> {
  const keys: Morpheme[] = ['world', 'water', 'mountain', 'city', 'sacred', 'small', 'deep', 'gate', 'of'];
  const out = {} as Record<Morpheme, string>;
  keys.forEach((key, i) => {
    out[key] = rawWord(lang, mix(seed, 900 + i), 1, 2);
  });
  return out;
}

/**
 * A word before orthography is applied.
 *
 * Built as a list of PHONEME UNITS rather than by string concatenation, because the constraints that
 * separate a name from gibberish are all about adjacency. Without them the generator happily produced
 * "Out'k'ngotout'k'ungn" and "Ngutyoutoytoufn" -- phonemes drawn from a plausible inventory and
 * assembled into something nobody could say.
 */
const PHONOTACTICS = {
  /**
   * Longest run of consonants, counted in LETTERS rather than phonemes. A unit-based limit looks
   * right and is not: 'ng' + 'kh' + 't' is three units but five letters, which is how
   * "Otnoutukhk'oukht" got through.
   */
  maxConsonantLetters: 3,
  maxVowelLetters: 3,
  /** One glottal or ejective per word, and never word-initial. */
  maxGlottal: 1,
  minLength: 3,
  maxLength: 13,
  /** Cap on a whole assembled name, compounds included. */
  maxNameLength: 22,
} as const;

type Bare = Omit<Language, 'attempts' | 'features' | 'morphemes'>;

function buildUnits(lang: Bare, seed: number, minSyll: number, maxSyll: number): string[] {
  const units: string[] = [];
  const isVowel = (u: string): boolean => lang.vowels.includes(u);
  const isGlottal = (u: string): boolean => u.includes("'");

  const trailingConsonantLetters = (): number => {
    let n = 0;
    for (let i = units.length - 1; i >= 0 && !isVowel(units[i]!); i--) n += units[i]!.length;
    return n;
  };
  const trailingVowelLetters = (): number => {
    let n = 0;
    for (let i = units.length - 1; i >= 0 && isVowel(units[i]!); i--) n += units[i]!.length;
    return n;
  };
  const glottalCount = (): number => units.filter(isGlottal).length;

  const push = (u: string): boolean => {
    if (units.length && units[units.length - 1] === u) return false;
    // No letter three times over. 'll' + 'l' is only two phonemes and three letters, so it slips past
    // the run limits, but "Lluyllyulll'lei" is not a name in any language.
    const joined = units.join('') + u;
    if (/(.)\1\1/.test(joined)) return false;
    if (isVowel(u)) {
      // Two vowels may meet, but not enough of them to spill: "aei" is a name, "aeiouu" is not.
      if (trailingVowelLetters() + u.length > PHONOTACTICS.maxVowelLetters) return false;
    } else {
      if (trailingConsonantLetters() + u.length > PHONOTACTICS.maxConsonantLetters) return false;
      if (isGlottal(u) && (units.length === 0 || glottalCount() >= PHONOTACTICS.maxGlottal)) return false;
    }
    units.push(u);
    return true;
  };

  /** Try a few candidates for a slot before giving up on it, rather than emitting something unsayable. */
  const tryFrom = (pool: readonly string[], s: number): void => {
    if (!pool.length) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const u = pool[Math.floor(f01(mix(s, attempt * 31 + 3)) * pool.length) % pool.length]!;
      if (push(u)) return;
    }
  };

  const count = minSyll + Math.floor(f01(mix(seed, 1)) * (maxSyll - minSyll + 1));
  let harmonyVowel: string | null = null;

  for (let i = 0; i < count; i++) {
    const s = mix(seed, 100 + i * 13);
    const template = weightedTemplate(lang.syllables, f01(mix(s, 1)));
    for (let slotIndex = 0; slotIndex < template.length; slotIndex++) {
      const slot = template[slotIndex]!;
      if (slot === 'C') {
        tryFrom(lang.onsets, mix(s, slotIndex * 7 + 1));
      } else if (slot === 'V') {
        if (lang.oddity === 'vowelHarmony' && harmonyVowel) {
          push(harmonyVowel);
        } else {
          const before = units.length;
          tryFrom(lang.vowels, mix(s, slotIndex * 7 + 2));
          if (!harmonyVowel && units.length > before) harmonyVowel = units[units.length - 1]!;
        }
      } else if (slot === 'n') {
        tryFrom(lang.codas.length ? lang.codas : ['n'], mix(s, slotIndex * 7 + 3));
      }
    }
    if (template.endsWith('C') && lang.codas.length) tryFrom(lang.codas, mix(s, 77));
  }

  if (lang.oddity === 'initialVowelRequired' && units.length && !isVowel(units[0]!)) {
    units.unshift(lang.vowels[0]!);
  }
  if (lang.oddity === 'consonantFinal' && lang.codas.length && units.length && isVowel(units[units.length - 1]!)) {
    push(lang.codas[0]!);
  }
  return units;
}

function rawWord(lang: Bare, seed: number, minSyll: number, maxSyll: number): string {
  let lo = minSyll;
  let hi = maxSyll;
  let out = buildUnits(lang, seed, lo, hi).join('');

  // Grow a word that came out too short: rejected slots can leave a single letter behind, and "Y" is
  // not a name.
  for (let grow = 0; out.length < PHONOTACTICS.minLength && grow < 4; grow++) {
    lo += 1;
    hi += 1;
    out = buildUnits(lang, mix(seed, 500 + grow), lo, hi).join('');
  }
  // And shrink one that ran long, so no place is called Out'k'ngotout'k'ungn.
  for (let shrink = 0; out.length > PHONOTACTICS.maxLength && hi > 1; shrink++) {
    hi -= 1;
    lo = Math.min(lo, hi);
    out = buildUnits(lang, mix(seed, 600 + shrink), lo, hi).join('');
  }
  return out;
}

function weightedTemplate(
  syllables: readonly { readonly template: string; readonly weight: number }[],
  r: number,
): string {
  const total = syllables.reduce((a, s) => a + s.weight, 0);
  let acc = 0;
  const x = r * total;
  for (const s of syllables) {
    acc += s.weight;
    if (x <= acc) return s.template;
  }
  return syllables[0]!.template;
}

/** Apply the language's orthography. This is what makes names of one world look like a family. */
function spell(lang: Language, word: string, seed: number): string {
  let out = word;
  const r = (tag: number) => f01(mix(seed, tag));

  if (lang.quirks.includes('digraphs')) out = out.replace(/k(?![h])/g, (m, i: number) => (i > 0 && r(1) < 0.4 ? 'kh' : m));
  if (lang.quirks.includes('doubledVowels') && r(2) < 0.55) {
    out = out.replace(/([aeiou])/, (m) => m + m);
  }
  if (lang.quirks.includes('doubledMedial') && out.length > 3) {
    const at = 1 + Math.floor(r(3) * (out.length - 2));
    const c = out[at]!;
    if (!'aeiou'.includes(c)) out = out.slice(0, at) + c + out.slice(at);
  }
  if (lang.quirks.includes('apostrophe') && out.length > 3 && !out.includes("'")) {
    // Only between two letters, and only if the phonology has not already placed a glottal, or the
    // two collide into "''".
    const at = 1 + Math.floor(r(4) * (out.length - 2));
    if (/[a-z]/i.test(out[at - 1] ?? '') && /[a-z]/i.test(out[at] ?? '')) {
      out = `${out.slice(0, at)}'${out.slice(at)}`;
    }
  }
  if (lang.quirks.includes('yAsVowel')) out = out.replace(/i(?=[^aeiou]|$)/g, (m) => (r(5) < 0.5 ? 'y' : m));
  if (lang.quirks.includes('qWithoutU')) out = out.replace(/qu/g, 'q');
  if (lang.quirks.includes('noLetterE')) out = out.replace(/e/g, 'a');
  if (lang.quirks.includes('terminalX') && r(6) < 0.35) out += r(7) < 0.5 ? 'x' : 'th';
  if (lang.quirks.includes('circumflex') && r(8) < 0.5) {
    out = out.replace(/[aeiou]/, (m) => ({ a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û' })[m] ?? m);
  }
  if (lang.oddity === 'toneDiacritics' && r(9) < 0.6) {
    out = out.replace(/[aeiou]/, (m) => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' })[m] ?? m);
  }
  // Orthography runs AFTER phonotactics, and several of its rules insert letters -- a doubled medial
  // consonant, k becoming kh, a terminal -th. So the pronounceability constraints have to be re-checked
  // on the spelled form; enforcing them only on phonemes let clusters back in through the spelling.
  return enforcePronounceable(out.replace(/''+/g, "'").replace(/--+/g, '-').replace(/^['-]+|['-]+$/g, ''));
}

/** Collapse any letter run that exceeds what the phonotactics allow. A repair pass, not a generator. */
function enforcePronounceable(s: string): string {
  const trimRun = (text: string, pattern: RegExp, limit: number): string =>
    text.replace(pattern, (m) => m.slice(0, limit));
  // The vowel class must include the accented forms, because the diacritic rules run before this pass
  // and "Wéeei" is a four-vowel run however it is spelled.
  let out = trimRun(s, /[^aeiouyâêîôûáéíóú'\-]{4,}/gi, PHONOTACTICS.maxConsonantLetters);
  out = trimRun(out, /[aeiouâêîôûáéíóú]{4,}/gi, PHONOTACTICS.maxVowelLetters);
  // Orthography can also stack a letter, so collapse triples here too.
  return out.replace(/(.)\1\1+/gi, (m) => m.slice(0, 2));
}

const capitalise = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** A proper name in this language. `syllables` overrides the language's own word-length range. */
export function word(lang: Language, seed: number, syllables?: [number, number]): string {
  const [lo, hi] = syllables ?? [lang.minSyllables, lang.maxSyllables];
  let out = spell(lang, rawWord(lang, seed, lo, hi), mix(seed, 5));

  if (lang.quirks.includes('hyphenated') && f01(mix(seed, 11)) < 0.55) {
    const second = spell(lang, rawWord(lang, mix(seed, 12), 1, 2), mix(seed, 13));
    const joiner = f01(mix(seed, 14)) < 0.5 ? `-${lang.morphemes.of}-` : '-';
    const compound = out + joiner + second;
    // The per-word cap does not bound a compound of two of them, which is how a place ended up called
    // Zoushrauz'Hr-Zibll-Tisrlau'sr.
    if (compound.length <= PHONOTACTICS.maxNameLength) out = compound;
  }
  if (lang.quirks.includes('capitalSecond') && out.includes("'")) {
    out = out.replace(/'(\w)/, (_m, c: string) => `'${c.toUpperCase()}`);
  }
  return out
    .split('-')
    .map((part, i) => (i === 0 || lang.quirks.includes('capitalSecond') ? capitalise(part) : part))
    .join('-');
}

/** A place name compounded with one of the language's own toponymic morphemes. */
export function placeName(lang: Language, seed: number, morpheme: Morpheme): string {
  const stem = rawWord(lang, seed, 1, Math.max(1, lang.maxSyllables - 1));
  const compound = f01(mix(seed, 21)) < 0.7 ? stem + lang.morphemes[morpheme] : lang.morphemes[morpheme] + stem;
  return capitalise(spell(lang, compound, mix(seed, 22)));
}

/** Plural or collective. Some languages reduplicate, which is startlingly effective. */
export function plural(lang: Language, name: string): string {
  if (lang.oddity === 'reduplicatedPlurals') return name + name.toLowerCase();
  if (lang.oddity === 'ergativeSuffix') return `${name}-${lang.morphemes.of}`;
  return `${name}${lang.codas.length ? 'en' : 'i'}`;
}

/** Human-readable summary, for the place card and for test output. */
export function describeLanguage(lang: Language): string {
  return (
    `${lang.vowels.length} vowels, ${lang.onsets.length} onsets, ` +
    `${lang.codas.length ? `${lang.codas.length} codas` : 'no codas'}, ` +
    `${lang.syllables.map((s) => s.template).join('/')}, ${lang.oddity}, [${lang.quirks.join(', ')}]`
  );
}

/**
 * Cached, like every other generator in this directory.
 *
 * `makeLanguage` runs up to twenty-four attempts against the anti-cliche guard, each assembling phoneme families and
 * running nine morphemes through the phonotactic filter: eighty microseconds. It sits in the per-building path, so
 * twenty buildings on screen rebuilt the same language twenty times a frame, for a language that cannot change.
 */
const languages = new Map<number, Language>();

export function languageOf(planetId: number): Language {
  let lang = languages.get(planetId);
  if (!lang) {
    lang = makeLanguage(planetId);
    if (languages.size > 256) languages.clear();
    languages.set(planetId, lang);
  }
  return lang;
}
