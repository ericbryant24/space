import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { BANNED_WORDS, architectureClause, formatPopulation, planetLine, settlementLine } from '../src/culture/lore.ts';
import { cultureOf, buildingName, regionName, settlementName } from '../src/universe/gen/culture.ts';
import { planetTraits } from '../src/universe/gen/planet.ts';

const sample = (i: number) => {
  const systemId = i * 2654435761;
  const planetId = (systemId ^ 0x9e37) * 40503;
  const traits = planetTraits(planetId, systemId, i % 7, 7);
  return { traits, culture: cultureOf(planetId, traits), planetId };
};

test('no generated line uses a banned word', () => {
  // "Mysterious" and "ancient" are how procedural text announces that it has nothing to say.
  let checked = 0;
  for (let i = 0; i < 10000; i++) {
    const { traits, culture, planetId } = sample(i);
    const lines = [
      planetLine(traits, culture, 'Ember 2214', planetId),
      settlementLine(culture, traits, planetId, 'Somewhere'),
    ];
    for (const line of lines) {
      const lower = line.toLowerCase();
      for (const banned of BANNED_WORDS) {
        assert.ok(!lower.includes(banned), `"${line}" contains "${banned}"`);
      }
      checked++;
    }
  }
  assert.equal(checked, 20000);
});

test('every line carries at least one number', () => {
  // A fact without a number is a mood. The voice is meant to be a readout.
  for (let i = 0; i < 3000; i++) {
    const { traits, culture, planetId } = sample(i);
    const line = planetLine(traits, culture, 'Ember 2214', planetId);
    assert.ok(/\d/.test(line), `no number in "${line}"`);
  }
});

test('lines are the right shape for a card', () => {
  for (let i = 0; i < 2000; i++) {
    const { traits, culture, planetId } = sample(i);
    const line = planetLine(traits, culture, 'Ember 2214', planetId);
    assert.ok(line.length > 24 && line.length < 220, `bad length ${line.length}: "${line}"`);
    assert.ok(line.endsWith('.'), `"${line}" does not end in a full stop`);
    assert.ok(!/\s\s/.test(line), `"${line}" has doubled spaces`);
    assert.ok(!line.includes('undefined') && !line.includes('NaN'), `"${line}" leaked a value`);
  }
});

test('facts agree with the traits they describe', () => {
  // The point of generating from traits rather than from a free roll.
  for (let i = 0; i < 4000; i++) {
    const { traits, culture, planetId } = sample(i);
    const line = planetLine(traits, culture, 'Ember 2214', planetId);
    assert.ok(line.includes(traits.label), `"${line}" does not name its own class (${traits.label})`);
    const stated = /(\d+)% water/.exec(line);
    assert.ok(stated, `"${line}" states no water fraction`);
    assert.equal(Number(stated[1]), Math.round(traits.waterFraction * 100));
    if (line.includes('It does not rain here')) {
      assert.ok(traits.aridity > 0.7, `claimed no rain on a world with aridity ${traits.aridity.toFixed(2)}`);
    }
    if (line.includes('Nobody lives here')) {
      assert.equal(culture.inhabited, false, 'claimed nobody lives on an inhabited world');
    }
    if (line.includes('rings')) assert.ok(traits.hasRings, 'claimed rings on a world without any');
  }
});

test('how a world builds agrees with what kind of world it is', () => {
  // The bug this guards: a tundra world described as "tiled, and set close together", because the
  // clause read snowIndex while the classifier read temperature and the two disagreed.
  let coldChecked = 0;
  let dryChecked = 0;
  for (let i = 0; i < 6000; i++) {
    const { traits } = sample(i);
    const clause = architectureClause(traits);
    if (traits.cls === 'tundra' || traits.cls === 'ice' || traits.cls === 'frozenRock') {
      assert.ok(clause.includes('snow'), `${traits.cls} world does not build for snow: "${clause}"`);
      coldChecked++;
    }
    if (traits.cls === 'desert') {
      assert.ok(clause.includes('sun'), `desert world does not build for sun: "${clause}"`);
      dryChecked++;
    }
  }
  assert.ok(coldChecked > 50, `only ${coldChecked} cold worlds sampled`);
  assert.ok(dryChecked > 20, `only ${dryChecked} desert worlds sampled`);
});

test('an inhabited world always has people and an uninhabited one never does', () => {
  let inhabited = 0;
  for (let i = 0; i < 4000; i++) {
    const { culture } = sample(i);
    if (culture.inhabited) {
      assert.ok(culture.population > 0, 'inhabited world with no population');
      inhabited++;
    } else {
      assert.equal(culture.population, 0, 'uninhabited world with a population');
    }
  }
  const fraction = inhabited / 4000;
  console.log(`      ${(fraction * 100).toFixed(1)}% of sampled planets are inhabited`);
  assert.ok(fraction > 0.02 && fraction < 0.5, `inhabited fraction ${(fraction * 100).toFixed(1)}% is implausible`);
});

test('names below a planet are stable and distinct', () => {
  const { culture } = sample(3);
  assert.equal(regionName(culture, 99), regionName(culture, 99));
  const regions = new Set(Array.from({ length: 40 }, (_, i) => regionName(culture, i * 7919)));
  const towns = new Set(Array.from({ length: 40 }, (_, i) => settlementName(culture, i * 7919)));
  assert.ok(regions.size > 30, `only ${regions.size} distinct region names`);
  assert.ok(towns.size > 25, `only ${towns.size} distinct settlement names`);
});

test('a building carries both a functional name and a local one', () => {
  // If the deepest, most detailed level were named only in an invented language it would be the least
  // readable thing in the project.
  const { culture } = sample(4);
  for (let i = 0; i < 50; i++) {
    const b = buildingName(culture, i * 104729);
    assert.ok(/^[A-Z]/.test(b.functional), `"${b.functional}" is not an English name`);
    assert.ok(/[a-z]/i.test(b.local) && b.local.length >= 2, `"${b.local}" is not a local name`);
  }
});

test('populations read as populations', () => {
  assert.equal(formatPopulation(40), '40');
  assert.equal(formatPopulation(4200), '4,200');
  assert.equal(formatPopulation(83_400), '83,400');
  assert.equal(formatPopulation(2_400_000), '2.4 million');
  assert.equal(formatPopulation(5_000_000), '5 million');
  // The bug this replaces produced "8.3,000".
  for (const n of [1000, 4200, 8300, 12_345, 99_999]) {
    assert.ok(!/\d\.\d,/.test(formatPopulation(n)), `malformed population "${formatPopulation(n)}"`);
  }
  for (const n of [0, 1, 99, 1000, 9999, 10000, 999999, 1e6, 1e8]) {
    const s = formatPopulation(n);
    assert.ok(!s.includes('NaN') && !s.includes('undefined'), `bad population "${s}" for ${n}`);
  }
});

test('no name contains a tripled letter', () => {
  const seen: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const { culture } = sample(i);
    seen.push(culture.localName, regionName(culture, i), settlementName(culture, i));
  }
  for (const n of seen) {
    assert.equal(/(.)\1\1/.test(n), false, `"${n}" has a tripled letter`);
  }
});

test('three worked place cards, printed for inspection', () => {
  let shown = 0;
  for (let i = 0; i < 4000 && shown < 3; i++) {
    const { traits, culture, planetId } = sample(i);
    if (!culture.inhabited) continue;
    shown++;
    console.log(`      ${culture.localName} (${traits.label}, ${culture.motif} motif)`);
    console.log(`        ${planetLine(traits, culture, 'Ember 2214', planetId)}`);
    console.log(`        ${settlementLine(culture, traits, planetId, settlementName(culture, planetId))}`);
  }
  assert.equal(shown, 3);
});
