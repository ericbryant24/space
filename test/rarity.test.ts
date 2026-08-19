import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { f01, hash2, hash3 } from '../src/core/rng.ts';
import { isRuin, ruinDecay, ruinYears, RUIN_ONE_IN } from '../src/universe/rarity.ts';
import { ruinOpenRight, wallPath } from '../src/render/draw/facade.ts';
import { slotIsSettled } from '../src/universe/node.ts';

/**
 * GOLDEN VALUES, for the same reason determinism.test.ts has them: a rare place is only worth finding if it is
 * in the same place forever. Changing a number here moves every ruin in the universe and invalidates every
 * bookmark of one, so treat a failure as "the stream was altered", never as "the expectation is stale".
 */
test('ruins are exactly where they have always been', () => {
  assert.equal(isRuin(121), true);
  assert.equal(ruinDecay(121), 0.9970862150192261);
  assert.equal(ruinYears(121), 108);
  assert.equal(isRuin(125), true);
  assert.equal(ruinDecay(125), 0.3526129066944122);
  assert.equal(ruinYears(125), 30);
  assert.equal(isRuin(0), false);
});

test('one settlement in a hundred and twenty stands empty', () => {
  let ruins = 0;
  const N = 400_000;
  // Ids taken the way real settlement ids are made, so the count is over the shape of address the hash sees.
  for (let i = 0; i < N; i++) if (isRuin(hash3(0x51ed, 0x21b0, i))) ruins++;
  const oneIn = N / ruins;
  assert.ok(
    Math.abs(oneIn - RUIN_ONE_IN) < RUIN_ONE_IN * 0.06,
    `expected about one in ${RUIN_ONE_IN}, measured one in ${oneIn.toFixed(1)}`,
  );
});

test('a town that stands empty is never indistinguishable from one that does not', () => {
  // A decay of zero would draw a ruin as an ordinary town, which is a rare place nobody can tell they found.
  let checked = 0;
  for (let i = 0; i < 200_000 && checked < 800; i++) {
    if (!isRuin(i)) {
      assert.equal(ruinDecay(i), 0, `a lived-in town must decay by exactly nothing (${i})`);
      assert.equal(ruinYears(i), 0);
      continue;
    }
    checked++;
    const d = ruinDecay(i);
    assert.ok(d >= 0.35 && d <= 1, `decay out of range at ${i}: ${d}`);
    assert.ok(ruinYears(i) >= 30, `an empty town has been empty for a while (${i})`);
  }
  assert.ok(checked > 500, 'not enough ruins in the sample to say anything');
});

test('asking twice, or in a different order, gives the same answer', () => {
  const ids = [1, 121, 125, 398, 99991, 0x7fffffff, -12345];
  const first = ids.map((id) => [isRuin(id), ruinDecay(id), ruinYears(id)]);
  const second = [...ids].reverse().map((id) => [isRuin(id), ruinDecay(id), ruinYears(id)]).reverse();
  assert.deepEqual(second, first);
});

test('whether a town is empty is independent of whether the slot was settled at all', () => {
  /**
   * The two decisions must not be the same coin. If they correlated, "empty" would stop being a fact about a
   * town and start being an artefact of the placement roll -- and every ruin would sit at the same kind of
   * address, which is exactly the pattern the named-stream rule exists to prevent.
   */
  let settledRuins = 0;
  let settled = 0;
  let ruins = 0;
  const N = 300_000;
  for (let i = 0; i < N; i++) {
    const id = hash3(0x9a11, 0x21b0, i);
    const s = slotIsSettled(id, 'region');
    const r = isRuin(id);
    if (s) settled++;
    if (r) ruins++;
    if (s && r) settledRuins++;
  }
  const expected = (settled / N) * (ruins / N) * N;
  assert.ok(
    Math.abs(settledRuins - expected) < expected * 0.16,
    `expected about ${expected.toFixed(0)} settled ruins, got ${settledRuins}`,
  );
});

/** Just enough of a 2D context to record a path. `wallPath` touches nothing else, deliberately. */
function recorder(): { pts: [number, number][]; ctx: CanvasRenderingContext2D } {
  const pts: [number, number][] = [];
  const ctx = {
    moveTo: (x: number, y: number) => void pts.push([x, y]),
    lineTo: (x: number, y: number) => void pts.push([x, y]),
  } as unknown as CanvasRenderingContext2D;
  return { pts, ctx };
}

test('a lived-in building traces exactly the rectangle it always did', () => {
  const { pts, ctx } = recorder();
  wallPath(ctx, 100, 200, 140, 20, 0, 7);
  assert.deepEqual(pts, [
    [80, 200],
    [80, 140],
    [120, 140],
    [120, 200],
  ]);
});

test('a ruin loses head, never gains any, and still stands on the ground', () => {
  /**
   * The block a building is drawn as under twenty-six pixels and the elevation it is drawn as above that are
   * CROSSFADED, and both take their silhouette from this one function -- so the only thing that has to hold is
   * that the head never rises above the eave and the feet never leave the ground. If it could, a ruin would grow
   * a roofline back as you approached it.
   */
  for (let id = 0; id < 400; id++) {
    for (const ruin of [0.35, 0.6, 0.99]) {
      const { pts, ctx } = recorder();
      wallPath(ctx, 100, 200, 140, 20, ruin, id);
      assert.equal(pts[0]![0], 80);
      assert.equal(pts[0]![1], 200);
      assert.equal(pts[pts.length - 1]![0], 120);
      assert.equal(pts[pts.length - 1]![1], 200);
      for (const [x, y] of pts) {
        assert.ok(x >= 80 - 1e-9 && x <= 120 + 1e-9, `left the footprint at ${x}`);
        assert.ok(y >= 140 - 1e-9 && y <= 200 + 1e-9, `left the wall at ${y}`);
      }
      // The head drops towards the end that lost its roof, and only towards it.
      const head = pts.slice(1, -1);
      const first = head[0]![1];
      const last = head[head.length - 1]![1];
      if (ruinOpenRight(id)) assert.ok(last > first, 'a right-open ruin must drop to the right');
      else assert.ok(last < first, 'a left-open ruin must drop to the left');
    }
  }
});

test('the end a roof failed at is settled once and read everywhere', () => {
  // Two readers of the same fact -- the wall head and the roof clip -- and one hash, so they cannot disagree.
  for (let id = 0; id < 200; id++) {
    assert.equal(ruinOpenRight(id), ruinOpenRight(id));
    assert.equal(ruinOpenRight(id), f01(hash2(id, 0x9a)) < 0.5);
  }
});
