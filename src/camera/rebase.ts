import { anchorCellAt, childAt, makeChild, orbitalChildren, type ChildRef } from '../universe/node.ts';
import type { Tree } from '../universe/tree.ts';
import { LEVELS } from '../universe/schema.ts';
import {
  Z_MAX,
  frameToNode,
  pxPerNodeUnit,
  pxPerUnit,
  setNodeCoords,
  type Camera,
  type View,
} from './camera.ts';

/** Frame radius in px below which we pop a level. */
export const R_ASCEND = 64;
/** Frame radius in px above which we push a halving. 16x hysteresis band vs R_ASCEND. */
export const R_SUBDIV = 1024;
/** On-screen radius in px at which a semantic child becomes the new focus. */
export const R_ENTER = 220;
/** Below this a child would be released again; the 2.4x gap to R_ENTER prevents thrashing. */
export const R_LEAVE = 90;

/**
 * Descend by halving the frame. k -> k+1.
 *
 * THIS IS BIT-EXACT IN FLOAT64. Every operation is a multiply or divide by two plus an addition of
 * +/-1, so no rounding occurs at all. Roughly 76 of these happen across the full zoom range and
 * together they introduce exactly zero error -- which is why there is never anything to "pop".
 */
export function descendHalf(cam: Camera): void {
  const sx = cam.fx >= 0 ? 1 : 0;
  const sy = cam.fy >= 0 ? 1 : 0;
  cam.cx = cam.cx * 2 + sx;
  cam.cy = cam.cy * 2 + sy;
  cam.k += 1;
  cam.fx = cam.fx * 2 - (sx ? 1 : -1);
  cam.fy = cam.fy * 2 - (sy ? 1 : -1);
}

/** Ascend by doubling the frame. k -> k-1. Also bit-exact, and the exact inverse of descendHalf. */
export function ascendHalf(cam: Camera): void {
  const sx = cam.cx % 2;
  const sy = cam.cy % 2;
  cam.cx = Math.floor(cam.cx / 2);
  cam.cy = Math.floor(cam.cy / 2);
  cam.k -= 1;
  cam.fx = (cam.fx + (sx ? 1 : -1)) * 0.5;
  cam.fy = (cam.fy + (sy ? 1 : -1)) * 0.5;
}

/** Cross into a semantic child, rebasing coordinates into its local space. */
export function enterChild(cam: Camera, ref: ChildRef): void {
  const [px, py] = frameToNode(cam, cam.fx, cam.fy);
  cam.node = makeChild(cam.node, ref);
  cam.k = 0;
  cam.cx = 0;
  cam.cy = 0;
  cam.fx = (px - ref.ox) / ref.rel;
  cam.fy = (py - ref.oy) / ref.rel;
}

/**
 * Pop one level: halve-ascend if we are inside a subdivision, otherwise cross out to the parent
 * node. Returns false only at the root of the universe, which is where zoom-out stops.
 */
export function ascend(cam: Camera, tree: Tree): boolean {
  if (cam.k > 0) {
    ascendHalf(cam);
    return true;
  }
  const parent = tree.parentOf(cam.node);
  const ref = tree.refOf(cam.node);
  if (!parent || !ref) return false;
  // At k === 0 the frame IS the node, so fx/fy are already in node units.
  const nx = ref.ox + cam.fx * ref.rel;
  const ny = ref.oy + cam.fy * ref.rel;
  cam.node = parent;
  setNodeCoords(cam, nx, ny);
  return true;
}

/**
 * The child the camera is currently inside, if it is large enough to become the focus.
 *
 * O(1): children are anchored one per cell of a grid whose pitch is a fixed multiple of the child's
 * radius, so "what is under the camera" is a floor division rather than a search.
 */
export function pickEnterableChild(cam: Camera, rEnter: number): ChildRef | null {
  const level = LEVELS[cam.node.kind];
  if (!level.child) return null;
  const [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
  const scale = pxPerNodeUnit(cam);

  if (level.placement === 'orbits') {
    // At most nine bodies, so a scan is cheaper than any index would be.
    for (const ref of orbitalChildren(cam.node)) {
      if (ref.rel * scale < rEnter) continue;
      const dx = nx - ref.ox;
      const dy = ny - ref.oy;
      if (dx * dx + dy * dy <= ref.rel * ref.rel) return ref;
    }
    return null;
  }

  const ref = childAt(cam.node, anchorCellAt(cam.node, nx, ny));
  if (!ref) return null;
  if (ref.rel * scale < rEnter) return null;
  const dx = nx - ref.ox;
  const dy = ny - ref.oy;
  if (dx * dx + dy * dy > ref.rel * ref.rel) return null;
  return ref;
}

/**
 * Restore the precision invariant after any camera movement.
 *
 * Note what is NOT here: no special cases for particular levels, no loading, no interpolation
 * between representations. The renderer never learns that a rebase happened, because band alphas are
 * derived from R, which is continuous across every one of these operations.
 */
export function updateFocus(cam: Camera, tree: Tree, _view: View): void {
  // The bottom of the ladder. Symmetric with the root clamp below, which stops zoom-out.
  if (cam.z > Z_MAX) cam.z = Z_MAX;

  for (let guard = 0; guard < 96; guard++) {
    const r = pxPerUnit(cam);
    if (r < R_ASCEND) {
      if (ascend(cam, tree)) continue;
      // At the root with nothing left to pop: stop zooming out rather than drifting.
      cam.z += Math.log2(R_ASCEND / r);
      return;
    }
    if (r > R_SUBDIV) {
      descendHalf(cam);
      continue;
    }
    const child = pickEnterableChild(cam, R_ENTER);
    if (child) {
      enterChild(cam, child);
      continue;
    }
    return;
  }
}

/** Absolute position in ROOT node units. Test-only: the ground truth a round trip is measured against. */
export function absolutePosition(cam: Camera, tree: Tree): [number, number] {
  let [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
  let node = cam.node;
  for (;;) {
    const ref = tree.refOf(node);
    const parent = tree.parentOf(node);
    if (!ref || !parent) break;
    nx = ref.ox + nx * ref.rel;
    ny = ref.oy + ny * ref.rel;
    node = parent;
  }
  return [nx, ny];
}
