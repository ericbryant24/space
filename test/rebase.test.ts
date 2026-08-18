import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  Z_MAX,
  createCamera,
  mantissaHeadroom,
  pxPerUnit,
  zoomAt,
  type Camera,
  type View,
} from '../src/camera/camera.ts';
import {
  R_ASCEND,
  R_ENTER,
  R_LEAVE,
  R_SUBDIV,
  absolutePosition,
  ascendHalf,
  descendHalf,
  updateFocus,
} from '../src/camera/rebase.ts';
import { LEVELS, ROOT_KIND } from '../src/universe/schema.ts';
import { Tree } from '../src/universe/tree.ts';

const VIEW: View = { w: 1600, h: 900 };
const ROOT_LOG_SPAN = LEVELS[ROOT_KIND].logSpan;
/** z placing the root frame at R = 256 px, the centre of the invariant window. */
const Z0 = 8 - ROOT_LOG_SPAN;
/** The full ladder: field(80) down to building(4). */
const LADDER_DOUBLINGS = ROOT_LOG_SPAN - LEVELS.building.logSpan;

function fresh(seed = 0x51ace) {
  const tree = new Tree(seed);
  return { tree, cam: createCamera(tree.root, Z0) };
}

test('the ladder really is 76 doublings', () => {
  assert.equal(LADDER_DOUBLINGS, 76);
});

test('descendHalf / ascendHalf are bit-exact inverses', () => {
  // Not "close to" inverses: bit-identical. This is the property the whole design rests on.
  for (let i = 0; i < 2000; i++) {
    const { cam } = fresh();
    cam.fx = (i % 41) / 20 - 1;
    cam.fy = (i % 37) / 18 - 1;
    cam.k = 7;
    cam.cx = 91 + i;
    cam.cy = 44 + i;
    const before = { k: cam.k, cx: cam.cx, cy: cam.cy, fx: cam.fx, fy: cam.fy };
    descendHalf(cam);
    ascendHalf(cam);
    assert.equal(cam.k, before.k);
    assert.equal(cam.cx, before.cx);
    assert.equal(cam.cy, before.cy);
    assert.equal(cam.fx, before.fx, `fx drifted at i=${i}`);
    assert.equal(cam.fy, before.fy, `fy drifted at i=${i}`);
  }
});

test('a chain of 76 halvings and back introduces exactly zero error', () => {
  const { cam } = fresh();
  cam.fx = 0.3125;
  cam.fy = -0.75;
  const before = { fx: cam.fx, fy: cam.fy, cx: cam.cx, cy: cam.cy, k: cam.k };
  for (let i = 0; i < LADDER_DOUBLINGS; i++) descendHalf(cam);
  for (let i = 0; i < LADDER_DOUBLINGS; i++) ascendHalf(cam);
  assert.equal(cam.k, before.k);
  assert.equal(cam.cx, before.cx);
  assert.equal(cam.cy, before.cy);
  assert.equal(cam.fx, before.fx);
  assert.equal(cam.fy, before.fy);
});

test('full-range zoom round trip returns to the same place within 0.01 px', () => {
  for (const seed of [0x51ace, 1, 99, 0xbeef, 0x1234]) {
    const { tree, cam } = fresh(seed);
    updateFocus(cam, tree, VIEW);
    const start = absolutePosition(cam, tree);
    const startZ = cam.z;

    // Zoom in off-centre, so the test exercises the fx/fy path rather than only z.
    const ax = VIEW.w / 2 + 137;
    const ay = VIEW.h / 2 - 88;
    for (let i = 0; i < LADDER_DOUBLINGS; i++) {
      zoomAt(cam, ax, ay, 1, VIEW);
      updateFocus(cam, tree, VIEW);
    }
    for (let i = 0; i < LADDER_DOUBLINGS; i++) {
      zoomAt(cam, ax, ay, -1, VIEW);
      updateFocus(cam, tree, VIEW);
    }

    assert.equal(cam.z, startZ, `seed ${seed}: z did not return exactly`);
    assert.equal(cam.node.path.length, 0, `seed ${seed}: did not return to the root node`);

    const end = absolutePosition(cam, tree);
    // Convert root-unit error into pixels at the starting zoom.
    const pxPerRootUnit = 2 ** (startZ + ROOT_LOG_SPAN);
    const errPx = Math.hypot(end[0] - start[0], end[1] - start[1]) * pxPerRootUnit;
    assert.ok(errPx < 0.01, `seed ${seed}: round-trip error ${errPx.toExponential(3)} px`);
  }
});

test('the precision invariant and mantissa headroom hold at every step of the descent', () => {
  const { tree, cam } = fresh();
  updateFocus(cam, tree, VIEW);
  let minHeadroom = Infinity;
  const check = (where: string, c: Camera) => {
    const r = pxPerUnit(c);
    assert.ok(r >= R_ASCEND - 1e-9 && r <= R_SUBDIV + 1e-9, `${where}: R = ${r} left [64, 1024]`);
    minHeadroom = Math.min(minHeadroom, mantissaHeadroom(c));
  };
  for (let i = 0; i < LADDER_DOUBLINGS; i++) {
    zoomAt(cam, VIEW.w / 2 + 60, VIEW.h / 2 + 40, 1, VIEW);
    updateFocus(cam, tree, VIEW);
    check(`descend step ${i}`, cam);
  }
  for (let i = 0; i < LADDER_DOUBLINGS; i++) {
    zoomAt(cam, VIEW.w / 2 - 30, VIEW.h / 2 + 10, -1, VIEW);
    updateFocus(cam, tree, VIEW);
    check(`ascend step ${i}`, cam);
  }
  assert.ok(minHeadroom > 30, `mantissa headroom fell to ${minHeadroom.toFixed(1)} bits`);
});

test('zoom-to-cursor keeps the point under the cursor fixed at every depth', () => {
  const { tree, cam } = fresh();
  updateFocus(cam, tree, VIEW);
  const ax = 1210;
  const ay = 232;
  for (let i = 0; i < LADDER_DOUBLINGS; i++) {
    const before = absoluteAtScreen(cam, tree, ax, ay);
    zoomAt(cam, ax, ay, 1, VIEW);
    updateFocus(cam, tree, VIEW);
    const after = absoluteAtScreen(cam, tree, ax, ay);
    // Compare in pixels at the CURRENT zoom, which is the only scale a user could perceive.
    const pxPerRootUnit = 2 ** (cam.z + ROOT_LOG_SPAN);
    const driftPx = Math.hypot(after[0] - before[0], after[1] - before[1]) * pxPerRootUnit;
    assert.ok(driftPx < 0.01, `step ${i}: cursor anchor drifted ${driftPx.toExponential(3)} px`);
  }
});

test('hysteresis bands are wide enough to be meaningful', () => {
  assert.ok(R_SUBDIV / R_ASCEND >= 4, 'subdivision band must be at least 2 doublings wide');
  assert.ok(R_ENTER / R_LEAVE >= 2, 'semantic entry band must be at least one doubling wide');
});

test('crossing a threshold repeatedly does not thrash the focus stack', () => {
  const { tree, cam } = fresh();
  updateFocus(cam, tree, VIEW);
  for (let i = 0; i < 30; i++) {
    zoomAt(cam, VIEW.w / 2, VIEW.h / 2, 1, VIEW);
    updateFocus(cam, tree, VIEW);
  }

  const depth = () => cam.node.path.length * 1000 + cam.k;
  const wobble = (dz: number) => {
    zoomAt(cam, VIEW.w / 2, VIEW.h / 2, dz, VIEW);
    updateFocus(cam, tree, VIEW);
  };

  // The camera may be parked hard against a boundary, so allow exactly one settling move: a +/-0.2
  // wobble can legitimately cross a threshold once and then sit inside the band.
  let settling = 0;
  let prev = depth();
  for (let i = 0; i < 4; i++) {
    wobble(i % 2 === 0 ? 0.2 : -0.2);
    if (depth() !== prev) settling++;
    prev = depth();
  }
  assert.ok(settling <= 1, `focus moved ${settling} times while settling; expected at most one`);

  // Now the real assertion. Once settled, a wobble far smaller than the hysteresis band must never
  // move the stack again, however long it runs. Without hysteresis this oscillates every step.
  let changes = 0;
  for (let i = 0; i < 200; i++) {
    wobble(i % 2 === 0 ? 0.2 : -0.2);
    if (depth() !== prev) changes++;
    prev = depth();
  }
  assert.equal(changes, 0, `focus depth oscillated ${changes} times inside the hysteresis band`);
});

test('the zoom has a bottom as well as a top', () => {
  // Without this, scrolling into empty interplanetary space ran to z = +56 -- fifty doublings past the
  // smallest object that exists -- with the scale bar reading sub-atomic distances and nothing ever
  // coming into focus. The precision invariant held the whole time, which is why it went unnoticed.
  const { tree, cam } = fresh();
  updateFocus(cam, tree, VIEW);
  for (let i = 0; i < 400; i++) {
    zoomAt(cam, VIEW.w / 2 + 11, VIEW.h / 2 - 7, 1, VIEW);
    updateFocus(cam, tree, VIEW);
    assert.ok(cam.z <= Z_MAX + 1e-9, `z reached ${cam.z}, past the bottom of the ladder`);
  }
  assert.ok(Math.abs(cam.z - Z_MAX) < 1e-9, `expected to be parked at the floor, got ${cam.z}`);

  // And the invariant must still hold while parked against it.
  const r = pxPerUnit(cam);
  assert.ok(r >= 64 - 1e-9 && r <= 1024 + 1e-9, `R = ${r} left the window at the zoom floor`);
  assert.ok(mantissaHeadroom(cam) > 30, 'headroom collapsed at the zoom floor');
});

test('the zoom floor is deep enough to stand next to a building', () => {
  // A building has logSpan 4, so at Z_MAX its radius in pixels is 2^(Z_MAX + 4).
  const buildingRadiusPx = 2 ** (Z_MAX + LEVELS.building.logSpan);
  assert.ok(buildingRadiusPx > 1500, `a building only reaches ${buildingRadiusPx.toFixed(0)} px at full zoom`);
});

function absoluteAtScreen(cam: Camera, tree: Tree, sx: number, sy: number): [number, number] {
  const r = pxPerUnit(cam);
  const probe: Camera = { ...cam, fx: cam.fx + (sx - VIEW.w / 2) / r, fy: cam.fy + (sy - VIEW.h / 2) / r };
  return absolutePosition(probe, tree);
}
