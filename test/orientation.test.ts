import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createCamera, setNodeCoords, type Camera } from '../src/camera/camera.ts';
import { outwardAngle, unrotatePoint, upAngleFor } from '../src/camera/orientation.ts';
import { LEVELS } from '../src/universe/schema.ts';
import type { Node } from '../src/universe/node.ts';

const nodeOf = (kind: Node['kind']): Node => ({
  kind,
  id: 12345,
  parentId: 0,
  logSpan: LEVELS[kind].logSpan,
  path: [],
  ground: null,
});

const onRim = (kind: Node['kind'], theta: number, d = 1): Camera => {
  const cam = createCamera(nodeOf(kind), -10);
  setNodeCoords(cam, Math.cos(theta) * d, Math.sin(theta) * d);
  return cam;
};

/** Below the planet the frame chain already turns the ground the right way up; a second turn would undo it. */
test('only a planet in focus turns the scene', () => {
  for (const kind of ['field', 'cluster', 'galaxy', 'system', 'region', 'settlement', 'building'] as const) {
    assert.equal(outwardAngle(onRim(kind, 0.7)), null);
    assert.equal(upAngleFor(onRim(kind, 0.7), 1), 0);
  }
  assert.notEqual(outwardAngle(onRim('planet', 0.7)), null);
});

/** Standing anywhere on the rim, outward has to end up pointing up the screen. */
test('the outward direction ends up pointing up the screen', () => {
  for (let i = 0; i < 64; i++) {
    const theta = -Math.PI + (i / 64) * Math.PI * 2;
    const up = upAngleFor(onRim('planet', theta), 1);
    // A direction at screen angle `theta` (y down) becomes `theta + up`. Up the screen is -pi/2.
    const landed = Math.atan2(Math.sin(theta + up), Math.cos(theta + up));
    assert.ok(Math.abs(landed + Math.PI / 2) < 1e-9, `theta ${theta} landed at ${landed}`);
  }
});

/**
 * The one thing this has to get right: a continuous pan is a continuous turn.
 *
 * Angles are only defined up to a whole turn, and while the rotation is being ramped in a whole turn is NOT
 * invisible -- it is the scene spinning once round in a single frame. Panning past the far side of a world
 * crosses that branch, which is why `upAngleFor` unwraps against the angle it last handed out.
 */
test('panning right round a world never jerks the scene', () => {
  const steps = 2048;
  // Half-turned, so a branch cut would show at full strength instead of being multiplied away.
  const weight = 0.5;
  // A camera out in space clears the unwrap, so this sweep does not inherit another test's phase.
  upAngleFor(onRim('system', 0), 1);
  let prev = upAngleFor(onRim('planet', -Math.PI), weight);
  for (let i = 1; i <= steps * 3; i++) {
    const theta = -Math.PI + ((i / steps) * Math.PI * 2) % (Math.PI * 2);
    const up = upAngleFor(onRim('planet', theta), weight);
    assert.ok(Math.abs(up - prev) < 0.02, `step ${i}: ${prev} -> ${up}`);
    prev = up;
  }
});

/** Deep inside a planet there is no outward direction to find, and atan2 of noise would spin the world. */
test('the middle of a world has no up', () => {
  assert.equal(outwardAngle(onRim('planet', 1.1, 0.05)), null);
});

/** A pointer has to be able to get back to unrotated geometry, exactly. */
test('unrotating a rotated point returns it', () => {
  const w = 1600;
  const h = 900;
  for (const up of [0, 0.3, -1.9, Math.PI]) {
    for (const [x, y] of [
      [10, 20],
      [800, 450],
      [1590, 880],
    ] as const) {
      const dx = x - w / 2;
      const dy = y - h / 2;
      const c = Math.cos(up);
      const s = Math.sin(up);
      const rx = w / 2 + dx * c - dy * s;
      const ry = h / 2 + dy * c + dx * s;
      const back = unrotatePoint(rx, ry, up, w, h);
      assert.ok(Math.abs(back.x - x) < 1e-9 && Math.abs(back.y - y) < 1e-9);
    }
  }
});
