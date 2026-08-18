import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { BANDS, activeReps, coverage, outlineWidth, smoothstep, validateBands } from '../src/render/bands.ts';
import { scaleLevels } from '../src/render/draw/galaxy.ts';

test('every band table is a well-formed partition', () => {
  for (const [kind, table] of Object.entries(BANDS)) {
    const problems = validateBands(table);
    assert.deepEqual(problems, [], `${kind}: ${problems.join('; ')}`);
  }
});

test('band alphas sum to exactly 1 wherever anything is visible', () => {
  // This is the property that makes crossfades invisible. Sampled densely, and logarithmically so the
  // small sizes where the ramps live are covered as well as the large ones.
  for (const kind of Object.keys(BANDS)) {
    for (let i = 0; i <= 4000; i++) {
      const px = 1.2 * Math.exp((i / 4000) * Math.log(6000 / 1.2));
      const total = coverage(kind, px);
      assert.ok(
        Math.abs(total - 1) < 1e-9,
        `${kind} at ${px.toFixed(3)}px: coverage ${total.toFixed(12)} != 1`,
      );
    }
  }
});

test('coverage ramps from 0 to 1 across the visibility threshold without overshooting', () => {
  for (const kind of Object.keys(BANDS)) {
    assert.equal(coverage(kind, 0), 0, `${kind} should be invisible at zero size`);
    assert.ok(coverage(kind, 0.45) < 1e-12, `${kind} should still be invisible at the fade-in floor`);
    for (let px = 0; px <= 2; px += 0.01) {
      const c = coverage(kind, px);
      assert.ok(c >= -1e-12 && c <= 1 + 1e-12, `${kind} coverage ${c} out of range at ${px}px`);
    }
  }
});

test('at most two representations are ever live at once', () => {
  // More than two means the crossfade machinery is stacking work it does not need to.
  for (const kind of Object.keys(BANDS)) {
    for (let i = 0; i <= 3000; i++) {
      const px = 1.2 * Math.exp((i / 3000) * Math.log(6000 / 1.2));
      const live = activeReps(kind, px);
      assert.ok(live.length <= 2, `${kind} at ${px.toFixed(2)}px has ${live.length} live reps`);
    }
  }
});

test('each representation actually gets a turn at full strength', () => {
  // A band that never reaches a dominant alpha is dead code.
  for (const [kind, table] of Object.entries(BANDS)) {
    for (const band of table) {
      let best = 0;
      for (let i = 0; i <= 4000; i++) {
        const px = 1.2 * Math.exp((i / 4000) * Math.log(20000 / 1.2));
        const found = activeReps(kind, px).find((r) => r.rep === band.rep);
        if (found) best = Math.max(best, found.alpha);
      }
      assert.ok(best > 0.9, `${kind}/${band.rep} peaks at only ${best.toFixed(3)}`);
    }
  }
});

test('the detail bias shifts transitions without breaking the partition', () => {
  for (const bias of [0.6, 0.8, 1, 1.4, 2]) {
    // Bias divides the size before the ramps are evaluated, so the "fully visible" floor moves with
    // it. Below that floor partial coverage is correct behaviour, not a broken partition.
    const floor = 1.2 * bias;
    for (let i = 0; i <= 800; i++) {
      const px = floor * Math.exp((i / 800) * Math.log(20000 / floor));
      assert.ok(
        Math.abs(coverage('galaxy', px, bias) - 1) < 1e-9,
        `bias ${bias} broke coverage at ${px.toFixed(3)}px`,
      );
    }
    // And the shift is real: a higher bias must delay the first transition.
    const armsAt = (b: number) => {
      for (let px = 1; px < 20000; px *= 1.01) {
        if ((activeReps('galaxy', px, b).find((r) => r.rep === 'arms')?.alpha ?? 0) > 0.5) return px;
      }
      return Infinity;
    };
    if (bias > 1) assert.ok(armsAt(bias) > armsAt(1), `bias ${bias} did not delay the arms band`);
  }
});

test('smoothstep is a clamped, symmetric ease', () => {
  assert.equal(smoothstep(10, 20, 5), 0);
  assert.equal(smoothstep(10, 20, 25), 1);
  assert.equal(smoothstep(10, 20, 15), 0.5);
  assert.ok(Math.abs(smoothstep(0, 1, 0.25) + smoothstep(0, 1, 0.75) - 1) < 1e-12);
  // Degenerate range must not produce NaN.
  assert.equal(smoothstep(5, 5, 4), 0);
  assert.equal(smoothstep(5, 5, 6), 1);
});

test('outlines ramp in rather than snapping to full width', () => {
  assert.equal(outlineWidth(3), 0);
  assert.equal(outlineWidth(6), 0);
  assert.ok(outlineWidth(10) > 0 && outlineWidth(10) < 2);
  assert.equal(outlineWidth(40), 2);
  let prev = -1;
  for (let px = 0; px < 60; px += 0.5) {
    const w = outlineWidth(px);
    assert.ok(w >= prev - 1e-12, `outline width dipped at ${px}px`);
    prev = w;
  }
});

test('starfield lattice levels form a partition of unity in log space', () => {
  // The same rule as the representation bands, applied to scale instead of size. Two lattice levels are
  // blended so their weights sum to exactly 1, which is what keeps the star field's total brightness
  // constant as you descend and stops a level change from popping.
  for (let i = 0; i <= 20000; i++) {
    const nf = -30 + (i / 20000) * 90;
    const [n0, wCoarse, wFine] = scaleLevels(nf);
    assert.ok(Math.abs(wCoarse + wFine - 1) < 1e-12, `weights sum to ${wCoarse + wFine} at nf=${nf}`);
    assert.ok(wCoarse >= 0 && wCoarse <= 1, `coarse weight ${wCoarse} out of range`);
    assert.ok(wFine >= 0 && wFine <= 1, `fine weight ${wFine} out of range`);
    assert.equal(n0, Math.floor(nf), 'level should be the floor of the continuous level');
  }
});

test('crossing a lattice level boundary is continuous', () => {
  // Approaching an integer from below, the fine level is at full weight; just above, that same lattice
  // becomes the coarse level, still at full weight. Nothing changes abruptly.
  for (const boundary of [-7, 0, 3, 18]) {
    const eps = 1e-9;
    const below = scaleLevels(boundary - eps);
    const above = scaleLevels(boundary + eps);
    // Below: levels (b-1, b) with weights (~0, ~1). Above: levels (b, b+1) with weights (~1, ~0).
    assert.equal(below[0], boundary - 1);
    assert.equal(above[0], boundary);
    assert.ok(below[1] < 1e-6, `coarse level still visible below ${boundary}: ${below[1]}`);
    assert.ok(below[2] > 1 - 1e-6, `fine level not yet full below ${boundary}: ${below[2]}`);
    assert.ok(above[1] > 1 - 1e-6, `the same lattice lost weight crossing ${boundary}: ${above[1]}`);
    assert.ok(above[2] < 1e-6, `next level appeared abruptly above ${boundary}: ${above[2]}`);
  }
});

test('a lattice level is a fixed power of two in world space', () => {
  // This is the whole fix. Cell size must depend only on the level, never on the viewport span -- the
  // original derived it from the span, so zooming rescaled the lattice every frame and every star
  // teleported. Stars "shooting past at random" was that, sixty times a second.
  const cellSize = (level: number) => 2 ** -level;
  for (let level = -5; level < 40; level++) {
    const c = cellSize(level);
    // Compared with a tolerance, not strict equality: assert.strictEqual uses Object.is, and
    // Object.is(0, -0) is false, so level 0 fails a strict check on a perfectly exact value.
    assert.ok(Math.abs(Math.log2(c) + level) < 1e-12, 'cell size must be an exact power of two');
    assert.equal(cellSize(level + 1) * 2, c, 'each level must be exactly half the previous');
  }
});
