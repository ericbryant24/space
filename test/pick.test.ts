import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  Z_MAX,
  createCamera,
  frameToNode,
  nodeToFrame,
  pxPerNodeUnit,
  pxPerUnit,
  zoomAt,
  type Camera,
  type View,
} from '../src/camera/camera.ts';
import { updateFocus } from '../src/camera/rebase.ts';
import { Z_MIN, clampZ, createInput, flingBy, stepInput } from '../src/input/pointer.ts';
import { nearestRimAt, pickAt, rimHitAt } from '../src/render/pick.ts';
import { childNear, rimCellAt, rimChildren } from '../src/universe/node.ts';
import { LEVELS, ROOT_KIND } from '../src/universe/schema.ts';
import { Tree } from '../src/universe/tree.ts';

const VIEW: View = { w: 1600, h: 900 };
const Z0 = 8 - LEVELS[ROOT_KIND].logSpan;

function fresh(seed = 0x51ace) {
  const tree = new Tree(seed);
  const cam = createCamera(tree.root, Z0);
  updateFocus(cam, tree, VIEW);
  return { tree, cam };
}

/**
 * Zoom until a planet is the focus node, steering at the nearest child on the way.
 *
 * Diving into empty space is legitimate and never arrives anywhere, which is exactly why the debug hooks
 * in main.ts aim before they zoom; the same trick gets a test onto a world.
 */
function diveToPlanet(tree: Tree, cam: Camera): boolean {
  for (let i = 0; i < 600 && cam.node.kind !== 'planet'; i++) {
    const [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
    const ref = childNear(cam.node, nx, ny);
    if (ref) {
      const [fx, fy] = nodeToFrame(cam, ref.ox, ref.oy);
      cam.fx = fx;
      cam.fy = fy;
    }
    zoomAt(cam, VIEW.w / 2, VIEW.h / 2, 0.5, VIEW);
    updateFocus(cam, tree, VIEW);
  }
  return cam.node.kind === 'planet';
}

/** A point in the focus node's own units, in screen pixels. */
function screenOf(cam: Camera, nx: number, ny: number): { x: number; y: number } {
  const r = pxPerUnit(cam);
  const [fx, fy] = nodeToFrame(cam, nx, ny);
  return { x: VIEW.w / 2 + (fx - cam.fx) * r, y: VIEW.h / 2 + (fy - cam.fy) * r };
}

test('a planet drawn as a disc is still made of places you can point at', () => {
  /**
   * The renderer records what it DRAWS, and while a planet is a disc its rim slots are deliberately not
   * drawn -- so for the whole stretch between entering a planet and its regions taking over the painting,
   * the hit list held nothing on the planet's face at all. Nothing was hoverable, clickable or lockable,
   * and a scroll at the surface had no child to aim at and ran to the bottom of the ladder instead.
   */
  const { tree, cam } = fresh();
  assert.ok(diveToPlanet(tree, cam), 'never reached a planet');

  const refs = rimChildren(cam.node);
  assert.ok(refs.length > 0, 'a planet with no regions');

  let tested = 0;
  for (const ref of refs) {
    const at = screenOf(cam, ref.ox, ref.oy);
    if (at.x < 0 || at.y < 0 || at.x > VIEW.w || at.y > VIEW.h) continue;
    const hit = rimHitAt(cam, tree, VIEW, at.x, at.y);
    assert.ok(hit, `no hit at region slot ${ref.cell.cx}`);
    assert.equal(hit.path.length, cam.node.path.length + 1);
    assert.deepEqual(hit.path[hit.path.length - 1], ref.cell);
    assert.equal(hit.kind, 'region');
    // The circle it reports has to be where the thing actually is, or the reticle lands somewhere else.
    assert.ok(Math.hypot(hit.xPx - at.x, hit.yPx - at.y) < 1e-6, 'reported centre is not the slot centre');
    assert.ok(hit.rPx > 0);
    // And it must be a place, not just an address: the flight machinery has to be able to resolve it.
    assert.ok(tree.resolve(hit.path), 'picked a region that does not exist');
    tested++;
  }
  assert.ok(tested > 4, `only ${tested} of ${refs.length} slots were on screen; the probe proved little`);
});

test('the answer is the slot the point is actually over', () => {
  const { tree, cam } = fresh();
  assert.ok(diveToPlanet(tree, cam), 'never reached a planet');

  // Round the rim in eighths, comparing the pick against the placement maths it has to stay in step with.
  for (let i = 0; i < 8; i++) {
    const theta = (i / 8) * Math.PI * 2;
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const at = screenOf(cam, nx, ny);
    if (at.x < 0 || at.y < 0 || at.x > VIEW.w || at.y > VIEW.h) continue;
    const hit = rimHitAt(cam, tree, VIEW, at.x, at.y);
    if (!hit) continue;
    assert.equal(hit.path[hit.path.length - 1]!.cx, rimCellAt(cam.node, nx, ny));
  }
});

test('the mantle is not a place, and does not answer for the coast', () => {
  // Without the distance test the whole face of a planet would answer with whatever region lay out along
  // that bearing, so pointing at the middle of a world put a reticle a third of a screen away.
  const { tree, cam } = fresh();
  assert.ok(diveToPlanet(tree, cam), 'never reached a planet');
  const centre = screenOf(cam, 0, 0);
  // pxPerNodeUnit, not pxPerUnit: a node unit is 2**k frame units, so scaling the wrong way makes this
  // 4**k too small and silently skips the only assertion in the test at every k above zero.
  const rPx = pxPerNodeUnit(cam);
  if (rPx > 60 && centre.x > 0 && centre.x < VIEW.w && centre.y > 0 && centre.y < VIEW.h) {
    assert.equal(rimHitAt(cam, tree, VIEW, centre.x, centre.y), null);
  }
});

test('a point inside a world still names the ground on its bearing', () => {
  /**
   * The strict pick answers only within grab range of a slot, which on a planet is a thin ring at the rim --
   * and once the disc is wider than the viewport that ring is off screen and NOTHING on the screen answers.
   * A zoom still has to name somewhere, so a point in the rock falls through to the ground above it.
   */
  const { tree, cam } = fresh();
  assert.ok(diveToPlanet(tree, cam), 'never reached a planet');
  // Four notches past arrival: the disc is now four times the viewport's height and the rim has left it.
  for (let i = 0; i < 4; i++) {
    zoomAt(cam, VIEW.w / 2, VIEW.h / 2, 0.5, VIEW);
    updateFocus(cam, tree, VIEW);
  }
  assert.equal(cam.node.kind, 'planet', 'the dive left the planet before the disc got wide');
  const disc = screenOf(cam, 0, 0);
  const corners = [[0, 0], [VIEW.w, 0], [0, VIEW.h], [VIEW.w, VIEW.h]];
  const inside = corners.every(([cx, cy]) => Math.hypot(cx! - disc.x, cy! - disc.y) < pxPerNodeUnit(cam));
  assert.ok(inside, 'the rim has not left the screen yet, so nothing is proved');

  const mid = { x: VIEW.w / 2, y: VIEW.h / 2 };
  assert.equal(rimHitAt(cam, tree, VIEW, mid.x, mid.y), null, 'the strict pick answered inside the mantle');

  const ground = nearestRimAt(cam, tree, VIEW, mid.x, mid.y);
  assert.ok(ground, 'nothing under a point inside a world');
  assert.equal(ground.path.length, cam.node.path.length + 1);
  assert.equal(ground.kind, 'region');
  assert.ok(tree.resolve(ground.path), 'named a region that does not exist');
  // Every slot of a planet's rim is occupied, so the answer is the bearing's own slot rather than a search.
  const [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
  assert.equal(ground.path[ground.path.length - 1]!.cx, rimCellAt(cam.node, nx, ny));
});

test('aiming at the sky beside a world is still aiming at nothing', () => {
  // The loose answer is for points in rock. Air has nothing in it at any magnification, and the ground
  // clamp already stops a zoom that heads into it -- naming a destination there would be inventing one.
  const { tree, cam } = fresh();
  assert.ok(diveToPlanet(tree, cam), 'never reached a planet');
  const centre = screenOf(cam, 0, 0);
  const rPx = pxPerNodeUnit(cam);
  assert.ok(Math.hypot(centre.x, centre.y) > rPx * 1.5, 'the corner of the view is inside the disc');
  assert.equal(nearestRimAt(cam, tree, VIEW, 0, 0), null);
});

test('a scroll aimed at a world arrives at its ground', () => {
  /**
   * The whole point of the loose answer. `enterChild` parks the camera on a planet's centre, so a plain
   * centred scroll from there used to have no child to aim at: it descended straight into the interior and
   * stopped dead against the ground clamp, inside a world with its surface off the edge of the screen.
   * Aiming at what the zoom names is what main.ts does with it -- see `onZoomIntent` and `followTracked`.
   */
  const { tree, cam } = fresh();
  assert.ok(diveToPlanet(tree, cam), 'never reached a planet');
  const startZ = cam.z;

  let arrived = false;
  for (let i = 0; i < 60 && !arrived; i++) {
    const ground = nearestRimAt(cam, tree, VIEW, VIEW.w / 2, VIEW.h / 2);
    if (ground?.ref && ground.path.length === cam.node.path.length + 1) {
      const [fx, fy] = nodeToFrame(cam, ground.ref.ox, ground.ref.oy);
      cam.fx = fx;
      cam.fy = fy;
    }
    zoomAt(cam, VIEW.w / 2, VIEW.h / 2, 0.5, VIEW);
    updateFocus(cam, tree, VIEW);
    arrived = cam.node.kind !== 'planet';
  }
  assert.ok(arrived, `still inside the planet after 60 notches, at z ${cam.z} (started at ${startZ})`);

  // And the control: without something to aim at, the same scroll runs into the clamp and stays there.
  const stuck = fresh();
  assert.ok(diveToPlanet(stuck.tree, stuck.cam), 'never reached a planet');
  for (let i = 0; i < 60; i++) {
    zoomAt(stuck.cam, VIEW.w / 2, VIEW.h / 2, 0.5, VIEW);
    updateFocus(stuck.cam, stuck.tree, VIEW);
  }
  assert.equal(stuck.cam.node.kind, 'planet', 'the control reached the ground on its own; the test proves nothing');
});

test('pick falls back to the drawn list, and prefers the deeper answer', () => {
  const { tree, cam } = fresh();
  assert.ok(diveToPlanet(tree, cam), 'never reached a planet');
  const ref = rimChildren(cam.node).find((c) => {
    const at = screenOf(cam, c.ox, c.oy);
    return at.x > 0 && at.x < VIEW.w && at.y > 0 && at.y < VIEW.h;
  });
  assert.ok(ref, 'no region on screen');
  const at = screenOf(cam, ref.ox, ref.oy);

  // An empty hit list is exactly the situation on a planet disc: the rim answer is all there is.
  const fromEmpty = pickAt(cam, tree, VIEW, [], at.x, at.y);
  assert.ok(fromEmpty && fromEmpty.path.length === cam.node.path.length + 1);

  // A shallower drawn mark at the same point must not beat it: deeper is more specific.
  const shallow = {
    path: cam.node.path,
    kind: cam.node.kind,
    xPx: at.x,
    yPx: at.y,
    rPx: 40,
    trueRPx: 40,
  } as const;
  const contested = pickAt(cam, tree, VIEW, [shallow], at.x, at.y);
  assert.ok(contested && contested.path.length === cam.node.path.length + 1);
});

test('the zoom target cannot be walked past either end of the ladder', () => {
  // An unreachable target is a spring that never closes its gap, which is a rAF loop that never sleeps.
  assert.equal(clampZ(Z_MAX + 40), Z_MAX);
  assert.equal(clampZ(Z_MIN - 40), Z_MIN);
  assert.ok(Z_MIN < Z0 && Z0 < Z_MAX, 'the initial view is meant to be inside the range, not on its edge');

  const { cam } = fresh();
  const input = createInput(cam);
  for (let i = 0; i < 400; i++) input.zoomBy(1);
  assert.equal(input.zTarget, Z_MAX);
  for (let i = 0; i < 400; i++) input.zoomBy(-1);
  assert.equal(input.zTarget, Z_MIN);
});

test('the zoom spring settles against a limit instead of chasing it forever', () => {
  for (const dz of [1, -1]) {
    const { tree, cam } = fresh();
    const input = createInput(cam);
    for (let i = 0; i < 400; i++) input.zoomBy(dz);
    input.anchorX = VIEW.w / 2;
    input.anchorY = VIEW.h / 2;

    let steps = 0;
    while (stepInput(cam, input, VIEW, 1 / 60)) {
      updateFocus(cam, tree, VIEW);
      if (++steps > 4000) break;
    }
    assert.ok(steps <= 4000, `the spring never settled at the ${dz > 0 ? 'bottom' : 'top'} of the ladder`);
    assert.ok(Math.abs(cam.z - (dz > 0 ? Z_MAX : Z_MIN)) < 1e-6, `parked at ${cam.z}`);
  }
});

test('a fling travels the same distance whatever the frame rate', () => {
  // The velocity used to be per FRAME, so the same flick threw the view twice as far on a 60 Hz display
  // as on a 120 Hz one. Nobody can see the frame rate; they can see the view going somewhere else.
  const travelled = (dt: number): number => {
    const { cam } = fresh();
    const input = createInput(cam);
    const r = pxPerUnit(cam);
    const startX = cam.fx;
    flingBy(input, 300, 0);
    for (let i = 0; i < 2000 && stepInput(cam, input, VIEW, dt); i++) {
      /* run the fling out */
    }
    return Math.abs(cam.fx - startX) * r;
  };
  const slow = travelled(1 / 60);
  const fast = travelled(1 / 120);
  // A few percent apart is the discrete integration; the per-frame version was a factor of two apart.
  assert.ok(Math.abs(slow - 300) < 20, `a 300 px fling travelled ${slow.toFixed(1)} px at 60 Hz`);
  assert.ok(Math.abs(slow - fast) / slow < 0.05, `60 Hz threw ${slow.toFixed(1)} px, 120 Hz ${fast.toFixed(1)}`);
});
