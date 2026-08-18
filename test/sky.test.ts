import { strict as assert } from 'node:assert';
import test from 'node:test';
import { MAX_SKY_DETAIL_LEVEL, skyBounds, skyDetailLevel, skyFreeze } from '../src/render/draw/galaxy.ts';

/**
 * These guard the worst bug the project has had: a hard browser lock-up, reachable by ordinary use.
 *
 * The sky is sampled in absolute GALAXY units -- the one quantity in the whole renderer that is not
 * expressed relative to a focus frame. A galaxy is 2^69 metres across, so its detail level grows without
 * bound as you descend, and by planet depth a cell index came out around 2^57. Float64 holds integers
 * exactly only to 2^53; past that, adjacent doubles are 4 or more apart, so `i++` leaves `i` unchanged.
 * The point starfield that used to count through those cells spun forever, so zooming in on a planet
 * anywhere except the exact galactic centre froze the tab -- and it went unnoticed for a while, because
 * the screenshot harness descended straight through a galaxy's core, where the indices are still exact.
 *
 * There are no points any more, but the glow's interpolated noise degenerates on the same boundary (it
 * reads cell `i` and cell `i + 1`, which become the same cell), so the cap it relies on is still
 * load-bearing and still worth pinning down.
 */
test('the sky never samples an integer float64 cannot hold', () => {
  // Every zoom from "a galaxy is a speck" to "standing next to a building", which is the whole ladder.
  for (let e = 0; e <= 80; e += 0.25) {
    const galaxyRadiusPx = 2 ** e;
    const level = skyDetailLevel(galaxyRadiusPx);
    assert.ok(level <= MAX_SKY_DETAIL_LEVEL, `level ${level} at 2^${e} px exceeds the cap`);

    // The glow samples `level` and `level + 1`, and each reads the cell one past its own.
    const worstIndex = 2 ** Math.max(0, level + 1) + 1;
    assert.ok(Number.isSafeInteger(worstIndex), `index ${worstIndex} at 2^${e} px is past 2^53`);
    // The actual failure mode, asserted directly rather than via a bound.
    assert.notEqual(worstIndex + 1, worstIndex, `i + 1 is a no-op at index ${worstIndex}`);
  }
});

/**
 * The second half of the same bug, and the one that survived the first fix.
 *
 * `drawGalaxyInterior` used to take two viewport EDGES in galaxy units. At region depth the half-extent
 * is about 2^-54, so `nx - halfW` and `nx + halfW` are the same double and `x1 - x0` is exactly zero.
 * Scale derived from that zero came out at 1e303; the freeze factor was computed from it and then
 * multiplied by a zero width, so nothing widened -- detail level 1001, cell indices near 2e300, and the
 * hang was back four rungs further down. The scale has to come from the half-extent itself.
 */
test('the sky survives a viewport whose two edges are the same double', () => {
  const viewW = 1440;
  for (let e = 0; e <= 300; e += 3) {
    const halfW = 2 ** -e;
    for (const nx of [0, 0.0963516805, 0.5, -0.7331, 0.999]) {
      const b = skyBounds(nx, nx * 0.6, halfW, halfW * 0.62, viewW);
      assert.ok(b.x1 > b.x0, `edges collapsed at halfW 2^-${e}, nx ${nx}`);
      assert.ok(Number.isFinite(b.pxPerUnit) && b.pxPerUnit > 0, `bad scale at halfW 2^-${e}`);

      const level = skyDetailLevel(b.rawPxPerUnit);
      assert.ok(level <= MAX_SKY_DETAIL_LEVEL, `level ${level} at halfW 2^-${e} exceeds the cap`);
      for (const l of [level, level + 1]) {
        const i0 = Math.floor(b.x0 / 2 ** -l);
        assert.ok(Number.isSafeInteger(i0), `index ${i0} at halfW 2^-${e} is past 2^53`);
        assert.notEqual(i0 + 1, i0, `i + 1 is a no-op at index ${i0}`);
      }
    }
  }
});

test('freezing only kicks in below the cap, and is continuous across it', () => {
  const frozenAt = 300 * 2 ** MAX_SKY_DETAIL_LEVEL;
  assert.equal(skyFreeze(1), 1);
  assert.equal(skyFreeze(frozenAt * 0.5), 1);
  assert.equal(skyFreeze(frozenAt), 1);
  // Just past the threshold the widening is barely more than 1: no pop as the sky freezes.
  assert.ok(Math.abs(skyFreeze(frozenAt * 1.001) - 1.001) < 1e-9);
  // And it tracks the zoom exactly, which is what holds the sky still on screen.
  assert.ok(Math.abs(skyFreeze(frozenAt * 4096) - 4096) < 1e-6);
});
