import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Z_MAX, createCamera, pxPerNodeUnit, setNodeCoords, type Camera, type View } from '../src/camera/camera.ts';
import { updateFocus } from '../src/camera/rebase.ts';
import { Tree } from '../src/universe/tree.ts';
import { LEVELS, ROOT_KIND } from '../src/universe/schema.ts';
import { groundAt, PLACEMENT_DETAIL } from '../src/culture/terrain.ts';
import {
  childrenNear,
  makeChild,
  orbitalChildren,
  rimChildren,
  scatterChildren,
  type ChildRef,
  type Node,
} from '../src/universe/node.ts';

const VIEW: View = { w: 1600, h: 900 };
const DIAGONAL = Math.hypot(VIEW.w, VIEW.h);

function childrenOf(node: Node): ChildRef[] {
  switch (LEVELS[node.kind].placement) {
    case 'cells':
      return childrenNear(node, 0, 0, 64);
    case 'scatter':
      return scatterChildren(node);
    case 'orbits':
      return orbitalChildren(node);
    case 'rim':
      return rimChildren(node);
  }
}

/** Walk down to some planet, the way the camera would. Not every system has one, so this searches. */
function aPlanet(tree: Tree): Node {
  const find = (node: Node, depth: number): Node | null => {
    if (node.kind === 'planet') return node;
    if (depth > 5) return null;
    const refs = childrenOf(node);
    for (const ref of refs) {
      const hit = find(makeChild(node, ref), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  const planet = find(tree.root, 0);
  assert.ok(planet, 'no planet anywhere under the root');
  assert.ok(planet.ground, 'a planet must carry its own ground frame');
  return planet;
}

function cameraOn(node: Node, nx: number, ny: number, z: number): Camera {
  const cam = createCamera(node, z);
  setNodeCoords(cam, nx, ny);
  return cam;
}

/**
 * The one place the ladder can run out from under you.
 *
 * Every other level is filled by its children, so wherever you aim there is eventually something to enter. A rim
 * level is not: its children are all on one line, and aiming at the middle of a planet -- which is what you do by
 * default, because that is where the planet is -- used to descend for ever through solid rock with the disc long
 * since handed over and every region a rim away, off the edge of the window in every direction.
 */
test('zooming at the middle of a world stops while the world is still in the picture', () => {
  const tree = new Tree(0x51ace);
  const planet = aPlanet(tree);
  const cam = cameraOn(planet, 0, 0, Z_MAX);
  updateFocus(cam, tree, VIEW);
  assert.equal(cam.node.kind, 'planet', 'nothing at the centre of a world is enterable');
  const planetPx = pxPerNodeUnit(cam);
  assert.ok(planetPx < 4 * DIAGONAL, `planet is ${(planetPx / DIAGONAL).toFixed(1)} screens across`);
  assert.ok(planetPx > 0.5 * DIAGONAL, 'and it is still worth looking at');
});

/** Aiming a little above a coastline was the same bug with the sky instead of the rock. */
test('zooming at empty sky stops before the ground leaves the picture', () => {
  const tree = new Tree(0x51ace);
  const planet = aPlanet(tree);
  const theta = 0.6;
  const ground = groundAt(planet.id, planet.ground!.traits, theta, PLACEMENT_DETAIL);
  // A tenth of a planet radius up: well inside the atmosphere by the look of it, and utterly empty.
  const d = ground + 0.1;
  const cam = cameraOn(planet, Math.cos(theta) * d, Math.sin(theta) * d, Z_MAX);
  updateFocus(cam, tree, VIEW);
  const gapPx = 0.1 * pxPerNodeUnit(cam) * 2 ** -0;
  assert.ok(gapPx < 4 * DIAGONAL, `ground is ${(gapPx / DIAGONAL).toFixed(1)} screens away`);
});

/** And the clamp must not touch a camera that is actually on the ground, or the descent would stop early. */
test('standing on the ground, nothing is clamped', () => {
  const tree = new Tree(0x51ace);
  const planet = aPlanet(tree);
  const refs = rimChildren(planet);
  assert.ok(refs.length > 0);
  const ref = refs[Math.floor(refs.length / 2)]!;
  const cam = cameraOn(planet, ref.ox, ref.oy, Z_MAX);
  updateFocus(cam, tree, VIEW);
  // Standing on a region, the camera should have descended well below the planet.
  assert.notEqual(cam.node.kind, 'planet');
  assert.ok(
    ['region', 'settlement', 'building'].includes(cam.node.kind),
    `landed on a ${cam.node.kind} instead of the surface`,
  );
});

/**
 * Arriving from the air has to work, because that is how anyone arrives.
 *
 * The old containment test was a disc, which couples height to horizontal position: directly over a slot's centre
 * you could be a full radius up, but over its edge you had to be practically on the ground, so the corners of
 * every slot were unreachable from above. What matters is whether you are over the stretch of ground the child
 * owns; how high you are is how high you are.
 *
 * The frame offset is checked too, because it is the thing that bounds this: entering a child from outside its own
 * frame lands the camera in a subdivision cell outside the node, where the offset grows with the subdivision level
 * instead of staying small, and the precision invariant depends on it staying small.
 */
test('a camera in the air near the edge of a slot still descends into it', () => {
  const tree = new Tree(0x51ace);
  const planet = aPlanet(tree);
  const refs = rimChildren(planet);
  const ref = refs[Math.floor(refs.length / 3)]!;
  // Three quarters of the way along the slot and three quarters of a slot up: outside the old disc, over the
  // ground either way.
  const theta = ref.theta + (ref.rel / ref.baseRadius) * 0.75;
  const d = ref.baseRadius + ref.rel * 0.75;
  const cam = cameraOn(planet, Math.cos(theta) * d, Math.sin(theta) * d, Z_MAX);
  updateFocus(cam, tree, VIEW);
  assert.notEqual(cam.node.kind, 'planet', 'should have entered the region it is over');
  assert.ok(Math.abs(cam.fx) < 10 && Math.abs(cam.fy) < 10, `frame offset ${cam.fx}, ${cam.fy} is unbounded`);
});

/** Nothing above a planet is a rim level, so nothing above one is affected. */
test('the clamp does not touch anything above a planet', () => {
  const tree = new Tree(0x77123);
  const cam = createCamera(tree.root, 8 - LEVELS[ROOT_KIND].logSpan);
  updateFocus(cam, tree, VIEW);
  assert.ok(['field', 'cluster', 'galaxy', 'system', 'planet'].includes(cam.node.kind));
});

/**
 * A camera restored from a permalink is placed before the canvas has been measured.
 *
 * So the first call arrives with a viewport of zero by zero, and a limit of zero screens is a limit of minus
 * infinity on z -- which is not a clamp, it is a wrecked camera. Everything downstream went to NaN, the focus
 * walked up the ladder on its own, and the renderer spent nine seconds a frame on it: opening a deep link took
 * thirty-six seconds.
 */
test('a viewport with no size cannot move the camera', () => {
  const tree = new Tree(0x51ace);
  const planet = aPlanet(tree);
  for (const [w, h] of [
    [0, 0],
    [0, 900],
    [1600, 0],
  ] as const) {
    const cam = cameraOn(planet, 0, 0, -15);
    const z = cam.z;
    updateFocus(cam, tree, { w, h });
    assert.ok(Number.isFinite(cam.z), `z went to ${cam.z} at ${w}x${h}`);
    assert.ok(Number.isFinite(cam.fx) && Number.isFinite(cam.fy), 'and the offset stayed finite');
    assert.equal(cam.z, z, 'nothing may be clamped against a viewport that has not been measured');
  }
});
