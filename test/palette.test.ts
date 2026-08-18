import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { MAX_ATTEMPTS, makePalette, violations } from '../src/culture/palette.ts';
import { hslToRgb, luminance, luminanceOf, solveL } from '../src/render/color.ts';

test('solveL hits its luminance target across the whole hue wheel', () => {
  for (let h = 0; h < 360; h += 7) {
    for (const s of [0.1, 0.45, 0.8, 0.95]) {
      for (const target of [0.035, 0.1, 0.28, 0.45, 0.68, 0.86]) {
        const l = solveL(h, s, target);
        const [r, g, b] = hslToRgb(h, s, l);
        const got = luminance(r, g, b);
        // 8-bit quantisation limits how close we can land, especially at the dark end.
        assert.ok(
          Math.abs(got - target) < 0.012,
          `h=${h} s=${s} target=${target} landed at ${got.toFixed(4)}`,
        );
      }
    }
  }
});

test('solveL is why HSL lightness cannot be used directly', () => {
  // The premise of the whole module: equal L gives wildly unequal brightness.
  const yellow = luminanceOf({ h: 60, s: 0.9, l: 0.5 });
  const blue = luminanceOf({ h: 240, s: 0.9, l: 0.5 });
  assert.ok(yellow > blue * 3, `expected yellow to dwarf blue at equal L (${yellow} vs ${blue})`);

  // ...and equal luminance gives visibly different L values.
  const ly = solveL(60, 0.9, 0.45);
  const lb = solveL(240, 0.9, 0.45);
  assert.ok(Math.abs(ly - lb) > 0.15, 'equal-luminance L values should differ substantially');
});

test('10000 generated palettes all satisfy every constraint', () => {
  let worstAttempts = 0;
  const histogram = new Map<number, number>();
  for (let i = 0; i < 10000; i++) {
    const p = makePalette(i * 2654435761, 'cosmicPalette', i % 2 === 0 ? 'toybox' : 'sober');
    const bad = violations(p);
    assert.equal(bad.length, 0, `palette ${i} (${p.scheme}) violated: ${bad.join('; ')}`);
    worstAttempts = Math.max(worstAttempts, p.attempts);
    histogram.set(p.attempts, (histogram.get(p.attempts) ?? 0) + 1);
  }
  const firstTry = (histogram.get(1) ?? 0) / 10000;
  console.log(
    `      palette attempts: ${[...histogram.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, v]) => `${k}:${v}`)
      .join(' ')}`,
  );
  assert.ok(firstTry > 0.2, `only ${(firstTry * 100).toFixed(1)}% passed first try; generator is too lossy`);
  assert.ok(worstAttempts <= MAX_ATTEMPTS + 1, 'fallback should be the deepest path taken');
});

test('the violation checker is not vacuous', () => {
  // A deliberately terrible palette must be rejected, or the suite above proves nothing.
  const flat = {
    INK: { h: 200, s: 0.3, l: 0.5 },
    DEEP: { h: 200, s: 0.3, l: 0.5 },
    BODY: { h: 200, s: 0.3, l: 0.5 },
    MID: { h: 200, s: 0.3, l: 0.5 },
    LIGHT: { h: 200, s: 0.3, l: 0.5 },
    PAPER: { h: 200, s: 0.3, l: 0.5 },
    ACCENT: { h: 200, s: 0.3, l: 0.5 },
    shadowHue: 20,
    scheme: 'triad' as const,
  };
  assert.ok(violations(flat).length >= 4, 'a flat monochrome palette should fail several rules');

  const grey = { ...flat, MID: { h: 0, s: 0.0, l: 0.45 } };
  assert.ok(violations(grey).some((v) => v.includes('untinted grey')), 'pure grey must be caught');
});

test('the fallback palette is valid for every hue, not just usually', () => {
  // makePalette promises a valid palette after at most MAX_ATTEMPTS + 1. That promise is only real if
  // the final construction cannot fail, so check it directly all the way round the wheel.
  for (let bias = 0; bias < 360; bias += 3) {
    const p = makePalette(0xdead, 'cosmicPalette', 'toybox', bias);
    assert.equal(violations(p).length, 0, `fallback path failed at hue bias ${bias}`);
  }
});

test('the constraints are satisfiable but not trivially so', () => {
  // Guard against the opposite failure from test 4: constraints so lax that anything passes.
  let rejected = 0;
  for (let i = 0; i < 400; i++) {
    const h = (i * 37) % 360;
    const junk = {
      INK: { h, s: 0.3, l: 0.02 },
      DEEP: { h: h + 6, s: 0.6, l: 0.12 },
      BODY: { h: h + 10, s: 0.7, l: 0.2 },
      MID: { h: h + 14, s: 0.7, l: 0.28 },
      LIGHT: { h: h + 18, s: 0.6, l: 0.35 },
      PAPER: { h: h + 22, s: 0.2, l: 0.42 },
      ACCENT: { h: h + 26, s: 0.9, l: 0.3 },
      shadowHue: h + 180,
      scheme: 'analogous3' as const,
    };
    if (violations(junk).length > 0) rejected++;
  }
  assert.equal(rejected, 400, 'a squashed, hue-crowded palette should always be rejected');
});

test('palettes are deterministic and differ between nodes', () => {
  const a = makePalette(777, 'cosmicPalette', 'toybox');
  const b = makePalette(777, 'cosmicPalette', 'toybox');
  assert.deepEqual(a, b);
  const c = makePalette(778, 'cosmicPalette', 'toybox');
  assert.notDeepEqual(a.BODY, c.BODY);
});

test('cosmic and surface palettes on the same node are independent', () => {
  // They are different streams, so a galaxy's space colours must not dictate a planet's ground.
  let same = 0;
  for (let i = 0; i < 200; i++) {
    const cosmic = makePalette(i, 'cosmicPalette', 'sober');
    const surface = makePalette(i, 'surfacePalette', 'toybox');
    if (Math.abs(cosmic.BODY.h - surface.BODY.h) < 1) same++;
  }
  assert.ok(same < 10, `${same}/200 palettes coincided; streams are not independent`);
});

test('the luminance ramp is monotonic, which the Two-Ends Rule depends on', () => {
  const order = ['INK', 'DEEP', 'BODY', 'MID', 'LIGHT', 'PAPER'] as const;
  for (let i = 0; i < 500; i++) {
    const p = makePalette(i * 31337, 'cosmicPalette', 'toybox');
    for (let j = 1; j < order.length; j++) {
      assert.ok(
        luminanceOf(p[order[j]!]) > luminanceOf(p[order[j - 1]!]),
        `palette ${i}: ${order[j - 1]} is not darker than ${order[j]}`,
      );
    }
  }
});
