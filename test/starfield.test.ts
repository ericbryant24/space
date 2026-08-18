import { strict as assert } from 'node:assert';
import test from 'node:test';
import { MAX_LATTICE_LEVEL, latticeFreeze, latticeLevel, skyBounds } from '../src/render/draw/galaxy.ts';

/**
 * The regression this guards is the worst bug the project has had: a hard browser lock-up, reachable by
 * ordinary use.
 *
 * The starfield indexed its lattice in absolute galaxy units. A galaxy is 2^69 metres and a lattice cell
 * near planet depth is under a metre, so a cell index needed about 57 bits. Float64 holds integers
 * exactly only to 2^53; past that, adjacent doubles are 4 or more apart, so `i++` leaves `i` unchanged
 * and `for (let i = i0; i <= i1; i++)` spins forever. Zooming in on a planet anywhere except the exact
 * galactic centre froze the tab -- and it went unnoticed because the harness happened to descend through
 * a galaxy's core, where the indices are small enough to be exact.
 */
test('the sky lattice never needs an integer float64 cannot hold', () => {
  // Every zoom from "a galaxy is a speck" to "standing next to a building", which is the whole ladder.
  for (let e = 0; e <= 80; e += 0.25) {
    const galaxyRadiusPx = 2 ** e;
    const level = latticeLevel(galaxyRadiusPx);
    assert.ok(level <= MAX_LATTICE_LEVEL, `level ${level} at 2^${e} px exceeds the cap`);

    // emitLevel also walks `level + 1`, and reads the cell one past the far edge. A negative level means
    // one cell is wider than the whole galaxy, so every index is 0 or -1.
    const worstIndex = 2 ** Math.max(0, level + 1) + 2;
    assert.ok(
      Number.isSafeInteger(worstIndex),
      `index ${worstIndex} at 2^${e} px is past 2^53 and cannot be counted through`,
    );
    // The actual failure mode, asserted directly rather than via a bound.
    assert.notEqual(worstIndex + 1, worstIndex, `i++ is a no-op at index ${worstIndex}`);
  }
});

test('freezing only kicks in below the cap, and is continuous across it', () => {
  const frozenAt = 38 * 2 ** MAX_LATTICE_LEVEL;
  assert.equal(latticeFreeze(1), 1);
  assert.equal(latticeFreeze(frozenAt * 0.5), 1);
  assert.equal(latticeFreeze(frozenAt), 1);
  // Just past the threshold the widening is barely more than 1: no pop as the sky freezes.
  assert.ok(Math.abs(latticeFreeze(frozenAt * 1.001) - 1.001) < 1e-9);
  // And it tracks the zoom exactly, which is what holds the field still on screen.
  assert.ok(Math.abs(latticeFreeze(frozenAt * 4096) - 4096) < 1e-6);
});

/**
 * The second half of the same bug, and the one that survived the first fix.
 *
 * `drawGalaxyInterior` used to take two viewport EDGES in galaxy units. At region depth the half-extent
 * is about 2^-54, so `nx - halfW` and `nx + halfW` are the same double and `x1 - x0` is exactly zero.
 * Scale derived from that zero came out at 1e303, the freeze factor was computed from it and then
 * multiplied by a zero width, so nothing widened -- lattice level 1001, cell indices near 2e300, and the
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

      const level = latticeLevel(b.rawPxPerUnit);
      assert.ok(level <= MAX_LATTICE_LEVEL, `level ${level} at halfW 2^-${e} exceeds the cap`);
      // The exact expression emitLevel counts through, at the coarser and finer level it draws.
      for (const l of [level, level + 1]) {
        const i0 = Math.floor(b.x0 / 2 ** -l);
        assert.ok(Number.isSafeInteger(i0), `index ${i0} at halfW 2^-${e} is past 2^53`);
        assert.notEqual(i0 + 1, i0, `i++ is a no-op at index ${i0}`);
      }
    }
  }
});
