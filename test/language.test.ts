import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  MAX_LANGUAGE_ATTEMPTS,
  describeLanguage,
  hammingToCliche,
  makeLanguage,
  placeName,
  plural,
  word,
} from '../src/culture/language.ts';

const lang = (id: number) => makeLanguage(id * 2654435761);

test('no generated language lands within Hamming distance 2 of an Earth cliche', () => {
  // The guard that stops the generator drifting into "Elvish but slightly off", which is a worse
  // outcome than mush because it reads as unoriginal rather than as unfamiliar.
  let worst = { distance: 99, name: '', id: -1 };
  const histogram = new Map<number, number>();
  for (let i = 0; i < 10000; i++) {
    const l = lang(i);
    const near = hammingToCliche(l.features);
    assert.ok(near.distance > 2, `language ${i} is ${near.distance} bits from ${near.name}`);
    if (near.distance < worst.distance) worst = { ...near, id: i };
    histogram.set(l.attempts, (histogram.get(l.attempts) ?? 0) + 1);
  }
  const firstTry = (histogram.get(1) ?? 0) / 10000;
  console.log(
    `      closest approach: ${worst.distance} bits from ${worst.name} (id ${worst.id}); ` +
      `first-try pass ${(firstTry * 100).toFixed(1)}%`,
  );
  assert.ok(firstTry > 0.15, `only ${(firstTry * 100).toFixed(1)}% passed first try`);
});

test('the cliche guard is not vacuous', () => {
  // If every possible signature were far from every cliche, the test above would prove nothing.
  let within = 0;
  for (let bits = 0; bits < 1 << 14; bits++) {
    if (hammingToCliche(bits).distance <= 2) within++;
  }
  const fraction = within / (1 << 14);
  console.log(`      ${(fraction * 100).toFixed(1)}% of all possible signatures are rejected as cliche`);
  assert.ok(fraction > 0.02, 'the guard rejects too little to be meaningful');
  assert.ok(fraction < 0.5, 'the guard rejects so much that generation would rarely succeed');
});

test('every language takes at least one deliberately odd feature', () => {
  for (let i = 0; i < 400; i++) {
    assert.ok(lang(i).oddity, `language ${i} has no oddity`);
  }
});

test('names from one world resemble each other more than names across worlds', () => {
  // The whole point: a planet's names must read as a family, and two planets must read as different
  // families. Measured with normalised edit distance.
  const worlds = [11, 22, 33, 44, 55, 66].map((id) => {
    const l = lang(id);
    return Array.from({ length: 14 }, (_, k) => word(l, id * 7919 + k * 104729).toLowerCase());
  });

  let intra = 0;
  let intraN = 0;
  for (const names of worlds) {
    for (let a = 0; a < names.length; a++) {
      for (let b = a + 1; b < names.length; b++) {
        intra += similarity(names[a]!, names[b]!);
        intraN++;
      }
    }
  }
  let inter = 0;
  let interN = 0;
  for (let i = 0; i < worlds.length; i++) {
    for (let j = i + 1; j < worlds.length; j++) {
      for (const a of worlds[i]!) {
        for (const b of worlds[j]!) {
          inter += similarity(a, b);
          interN++;
        }
      }
    }
  }
  const intraMean = intra / intraN;
  const interMean = inter / interN;
  const ratio = intraMean / interMean;
  console.log(`      intra-world similarity ${intraMean.toFixed(3)}, inter-world ${interMean.toFixed(3)}, ratio ${ratio.toFixed(2)}`);
  assert.ok(ratio > 1.25, `names are not family-resemblant enough (ratio ${ratio.toFixed(2)})`);
});

test('names are deterministic and vary within a world', () => {
  const l = lang(5);
  assert.equal(word(l, 42), word(l, 42));
  const names = new Set(Array.from({ length: 40 }, (_, i) => word(l, i * 7919)));
  assert.ok(names.size > 25, `only ${names.size} distinct names from 40 seeds`);
});

test('generated names look like names', () => {
  for (let i = 0; i < 300; i++) {
    const l = lang(i);
    for (let k = 0; k < 6; k++) {
      const n = word(l, i * 31 + k);
      assert.ok(n.length >= 2, `"${n}" is too short (language ${i})`);
      assert.ok(n.length <= 28, `"${n}" is too long (language ${i})`);
      assert.equal(n[0], n[0]!.toUpperCase(), `"${n}" is not capitalised`);
      assert.ok(!/\s/.test(n), `"${n}" contains whitespace`);
      assert.ok(!/--|''/.test(n), `"${n}" has doubled punctuation`);
      assert.ok(!/^[-']|[-']$/.test(n), `"${n}" starts or ends with punctuation`);
      assert.ok(/[a-zâêîôûáéíóú]/i.test(n), `"${n}" has no letters`);
    }
  }
});

test('a language honours its own stated oddity', () => {
  let checkedNoCodas = 0;
  let checkedThree = 0;
  for (let i = 0; i < 2000; i++) {
    const l = lang(i);
    if (l.oddity === 'noCodas') {
      assert.equal(l.codas.length, 0, `language ${i} claims noCodas but has codas`);
      checkedNoCodas++;
    }
    if (l.oddity === 'threeSyllableMinimum') {
      assert.ok(l.minSyllables >= 3, `language ${i} claims a three-syllable minimum but allows ${l.minSyllables}`);
      checkedThree++;
    }
    if (l.oddity === 'noVoicedStops') {
      assert.ok(!l.onsets.some((c) => c.length === 1 && 'bdg'.includes(c)), `language ${i} kept a voiced stop`);
    }
    if (l.oddity === 'noNasals') {
      assert.ok(!l.onsets.some((c) => ['m', 'n', 'ng', 'ny'].includes(c)), `language ${i} kept a nasal`);
    }
  }
  assert.ok(checkedNoCodas > 20 && checkedThree > 20, 'oddities are not being sampled often enough to test');
});

test('place names and plurals are well formed', () => {
  for (let i = 0; i < 200; i++) {
    const l = lang(i);
    const p = placeName(l, i * 13, 'city');
    assert.ok(p.length >= 2 && p[0] === p[0]!.toUpperCase(), `bad place name "${p}"`);
    const pl = plural(l, word(l, i));
    assert.ok(pl.length > 2, `bad plural "${pl}"`);
  }
});

test('no name contains an unpronounceable cluster', () => {
  // The constraint that separates a name from gibberish. Vowel and consonant runs are counted over
  // LETTERS here, deliberately independent of how the generator groups its phonemes.
  for (let i = 0; i < 1500; i++) {
    const l = lang(i);
    for (let k = 0; k < 4; k++) {
      const full = word(l, i * 977 + k);
      // A hyphen is a real boundary. Stripping it welds two legal runs into one illegal-looking one --
      // "Oui-ouioui" is pronounceable; "ouiouioui" is what you get by deleting the separator.
      for (const part of full.toLowerCase().split('-')) {
        const n = part.replace(/[^a-zâêîôûáéíóú']/g, '');
        const consRun = /[^aeiouyâêîôûáéíóú']{4,}/.exec(n);
        assert.equal(consRun, null, `"${full}" has a ${consRun?.[0].length}-consonant run (language ${i})`);
        const vowelRun = /[aeiouâêîôûáéíóú]{4,}/.exec(n);
        assert.equal(vowelRun, null, `"${full}" has a ${vowelRun?.[0].length}-vowel run (language ${i})`);
        assert.ok((n.match(/'/g) ?? []).length <= 1, `"${full}" has more than one glottal stop`);
      }
    }
  }
});

test('three worked languages, printed for inspection', () => {
  for (const id of [11, 22, 33]) {
    const l = lang(id);
    const names = Array.from({ length: 6 }, (_, k) => word(l, id * 7919 + k * 104729));
    const places = (['city', 'water', 'mountain'] as const).map((m) => placeName(l, id * 31 + m.length, m));
    console.log(`      world ${id}: ${describeLanguage(l)}`);
    console.log(`        names:  ${names.join(' · ')}`);
    console.log(`        places: ${places.join(' · ')}`);
  }
  assert.ok(true);
});

/** Normalised similarity, 1 = identical. Character-bigram overlap, which tracks "sounds related". */
function similarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}
