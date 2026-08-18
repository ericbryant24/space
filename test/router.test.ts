import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createCamera } from '../src/camera/camera.ts';
import { commonDepth } from '../src/camera/flyto.ts';
import { DEFAULT_SEED, decodeState, encodeState, type CameraState } from '../src/ui/router.ts';
import { LEVELS, ROOT_KIND } from '../src/universe/schema.ts';
import { Tree } from '../src/universe/tree.ts';

function sample(): CameraState {
  return {
    seed: 0x51ace,
    path: [
      { cx: 3, cy: 17 },
      { cx: 5, cy: 2 },
      { cx: 118237, cy: 4402 },
    ],
    k: 14,
    cx: 8231,
    cy: 2044,
    fx: 0.1324,
    fy: -0.4412,
    z: -33.281,
  };
}

test('camera state survives a URL round trip', () => {
  const state = sample();
  const back = decodeState(`#${encodeState(state)}`);
  assert.equal(back.seed, state.seed);
  assert.deepEqual(back.path, state.path);
  assert.equal(back.k, state.k);
  assert.equal(back.cx, state.cx);
  assert.equal(back.cy, state.cy);
  assert.equal(back.fx, state.fx);
  assert.equal(back.fy, state.fy);
  assert.equal(back.z, state.z);
});

test('offset quantisation is sub-pixel by the precision invariant', () => {
  // The frame is radius 1.0 and at most 1024 px across, so a 1e-4 offset error is at most ~0.1 px.
  const worstFrameRadiusPx = 1024;
  const quantum = 1e-4;
  assert.ok(quantum * worstFrameRadiusPx < 0.2, 'four decimals should stay well under a pixel');

  for (const fx of [0, 0.5, -0.99991, 1.23456789, -7.5]) {
    const state = { ...sample(), fx, fy: -fx };
    const back = decodeState(`#${encodeState(state)}`);
    const errPx = Math.abs((back.fx ?? 0) - fx) * worstFrameRadiusPx;
    assert.ok(errPx < 0.2, `fx ${fx} lost ${errPx.toFixed(3)} px`);
  }
});

test('the root has an empty path and still round-trips', () => {
  const tree = new Tree(1);
  const cam = createCamera(tree.root, 8 - LEVELS[ROOT_KIND].logSpan);
  const state: CameraState = { seed: 1, path: [], k: 0, cx: 0, cy: 0, fx: 0, fy: 0, z: cam.z };
  const back = decodeState(`#${encodeState(state)}`);
  assert.deepEqual(back.path, []);
  assert.equal(back.z, cam.z);
});

test('a deep path round-trips at full ladder depth', () => {
  const path = Array.from({ length: 7 }, (_, i) => ({ cx: i * 91 + 1, cy: i * 7 }));
  const back = decodeState(`#${encodeState({ ...sample(), path })}`);
  assert.deepEqual(back.path, path);
});

test('malformed URLs degrade instead of throwing', () => {
  // Anyone can paste anything into a fragment; a bad one must not take the page down.
  for (const hash of [
    '',
    '#',
    '#garbage',
    '#s=',
    '#s=!!!&p=zzz',
    '#p=1.2-oops.-3',
    '#k=-4&z=NaN',
    '#o=abc,def',
    '#c=..',
    '#p=1.2-',
    '#z=Infinity',
    '#s=1&s=2',
  ]) {
    const back = decodeState(hash);
    assert.ok(Number.isInteger(back.seed), `${hash} produced a non-integer seed`);
    if (back.path) {
      for (const c of back.path) {
        assert.ok(Number.isInteger(c.cx) && c.cx >= 0, `${hash} produced a bad cell`);
        assert.ok(Number.isInteger(c.cy) && c.cy >= 0, `${hash} produced a bad cell`);
      }
    }
    if (back.k !== undefined) assert.ok(Number.isInteger(back.k) && back.k >= 0);
    if (back.z !== undefined) assert.ok(Number.isFinite(back.z));
    if (back.fx !== undefined) assert.ok(Number.isFinite(back.fx));
  }
});

test('a missing seed falls back to the default universe', () => {
  assert.equal(decodeState('#z=-10').seed, DEFAULT_SEED);
  assert.equal(decodeState('').seed, DEFAULT_SEED);
});

test('different seeds encode differently', () => {
  const a = encodeState({ ...sample(), seed: 1 });
  const b = encodeState({ ...sample(), seed: 2 });
  assert.notEqual(a, b);
});

test('encoded URLs stay short enough to share', () => {
  // A permalink nobody can paste into a message is not a permalink.
  const path = Array.from({ length: 7 }, (_, i) => ({ cx: 134217727 - i, cy: 98765432 + i }));
  const encoded = encodeState({ ...sample(), path, cx: 1073741823, cy: 1073741823 });
  assert.ok(encoded.length < 160, `worst-case URL is ${encoded.length} chars`);
});

test('commonDepth finds the frame a flight should happen in', () => {
  const a = [{ cx: 1, cy: 1 }, { cx: 2, cy: 2 }, { cx: 3, cy: 3 }];
  const b = [{ cx: 1, cy: 1 }, { cx: 2, cy: 2 }, { cx: 9, cy: 9 }];
  assert.equal(commonDepth(a, b), 2);
  assert.equal(commonDepth(a, a), 3);
  assert.equal(commonDepth(a, []), 0);
  assert.equal(commonDepth([], []), 0);
  assert.equal(commonDepth(a, [{ cx: 9, cy: 9 }]), 0);
  // A prefix relationship means the ancestor itself is the common frame.
  assert.equal(commonDepth(a, a.slice(0, 2)), 2);
});
