import {
  anchorCellAt,
  childAt,
  groundHeightAt,
  makeChild,
  nearestRim,
  nearestScatter,
  orbitalChildren,
  type ChildRef,
} from '../universe/node.ts';
import { PLACEMENT_DETAIL, groundAt } from '../culture/terrain.ts';
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
 * How far above or below its own ground line a camera may be and still descend INTO a rim child, in child radii.
 *
 * A rim child owns a stretch of GROUND, so what should decide whether you are arriving at it is whether you are
 * over that stretch -- how high you are is how high you are. The plain containment test asks instead whether the
 * camera is inside the child's disc, which couples the two: directly over a slot's centre you may be a full radius
 * up, but over its edge you may be barely off the ground at all, and the corners of every slot were unreachable
 * from the air.
 *
 * One, and it cannot usefully be more: entering a child places the camera by its coordinates in that child's own
 * frame, and a camera outside the frame lands in a subdivision cell outside the node, where the offset grows with
 * the subdivision level instead of staying bounded. The precision invariant depends on that offset staying small
 * -- see Camera.fx. One child radius is the whole of the child's own frame, which is thirty kilometres of air
 * above a region and sixteen metres above a doorstep, and that is as far up as arriving can sensibly mean.
 * Further out than that, `clampToGround` stops the zoom rather than letting it descend through nothing.
 */
const RIM_ENTRY_REACH = 1;

/**
 * How far the ground may get before the zoom stops, in screen diagonals.
 *
 * Two numbers because they are two different situations. ABOVE the ground, once the surface is more than a screen
 * or so away the picture is empty air and there is nothing left to resolve: the camera would keep descending
 * through nothing to the bottom of the ladder, which is exactly what aiming a little above a coastline used to do.
 * BELOW it, the screen is full of rock and the world's interior is a real thing to look at -- concentric beds and
 * a core -- so there is further worth going, and the limit is set where the disc is about to hand over to its
 * regions anyway.
 *
 * Aiming at the middle of a planet and zooming in is the DEFAULT approach, not an edge case, and without this it
 * ended with a blank screen: the disc stops drawing at PLANET_MAX_DIAGONALS and every region is a rim away, off
 * the edge of the window in every direction.
 */
const REACH_ABOVE = 1.6;
const REACH_BELOW = 2.5;

/** Shortest signed way round the circle. */
function angleGap(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Where the camera stands relative to a rim node's ground: along it, and above it, both in NODE units.
 *
 * On the planet the surface is its circumference, so "along" is arc length round the rim and "above" is height
 * over the ground radius. Below the planet the frame straddles the ground line, so they are simply the local
 * horizontal and the height over that line. Null when the node has no ground to stand on.
 */
function groundOffset(cam: Camera, ref: ChildRef, nx: number, ny: number): { along: number; above: number } {
  if (cam.node.kind === 'planet') {
    const d = Math.hypot(nx, ny);
    const theta = Math.atan2(ny, nx);
    return { along: Math.abs(angleGap(theta, ref.theta)) * ref.baseRadius, above: d - ref.baseRadius };
  }
  // Node space has y pointing down, so a camera above the ground sits at a smaller y than the ground does.
  return { along: Math.abs(nx - ref.ox), above: ref.oy - ny };
}

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

/**
 * Cross into a semantic child, rebasing coordinates into its local space.
 *
 * A child's frame may be TURNED relative to its parent's -- see ChildRef.spin -- so this is the inverse of the
 * child-to-parent map in full: undo the offset, undo the rotation, undo the scale. The rotation is the only
 * step here that is not exact in float64, and it happens once per semantic descent at a frame radius of about
 * 220 px, so a full in-and-out round trip loses on the order of 1e-14 px. The budget is 0.01 px.
 */
export function enterChild(cam: Camera, ref: ChildRef): void {
  const [px, py] = frameToNode(cam, cam.fx, cam.fy);
  cam.node = makeChild(cam.node, ref);
  cam.k = 0;
  cam.cx = 0;
  cam.cy = 0;
  const dx = px - ref.ox;
  const dy = py - ref.oy;
  if (ref.spin === 0) {
    cam.fx = dx / ref.rel;
    cam.fy = dy / ref.rel;
    return;
  }
  const c = Math.cos(ref.spin);
  const sn = Math.sin(ref.spin);
  cam.fx = (c * dx + sn * dy) / ref.rel;
  cam.fy = (-sn * dx + c * dy) / ref.rel;
}

/** A point in a child's local units, expressed in its parent's: scale, then turn, then offset. */
export function childToParent(ref: ChildRef, lx: number, ly: number): [number, number] {
  const x = lx * ref.rel;
  const y = ly * ref.rel;
  if (ref.spin === 0) return [ref.ox + x, ref.oy + y];
  const c = Math.cos(ref.spin);
  const sn = Math.sin(ref.spin);
  return [ref.ox + c * x - sn * y, ref.oy + sn * x + c * y];
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
  const [nx, ny] = childToParent(ref, cam.fx, cam.fy);
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

  if (level.placement === 'scatter') {
    const ref = nearestScatter(cam.node, nx, ny);
    if (!ref) return null;
    if (ref.rel * scale < rEnter) return null;
    const dx = nx - ref.ox;
    const dy = ny - ref.oy;
    return dx * dx + dy * dy <= ref.rel * ref.rel ? ref : null;
  }

  if (level.placement === 'rim') {
    // Searching outwards from the slot under the camera, because the nearest slot is very often empty: half a
    // planet's rim can be ocean, and an ocean slot holds nothing to enter.
    const ref = nearestRim(cam.node, nx, ny);
    if (!ref) return null;
    if (ref.rel * scale < rEnter) return null;
    /**
     * OVER IT COUNTS, not just inside it. A rim child owns a stretch of ground, and what decides whether you are
     * arriving at that stretch is whether you are over it -- how high you are is how high you are. See
     * RIM_ENTRY_REACH.
     */
    const { along, above } = groundOffset(cam, ref, nx, ny);
    return along <= ref.rel && Math.abs(above) <= ref.rel * RIM_ENTRY_REACH ? ref : null;
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
export function updateFocus(cam: Camera, tree: Tree, view: View): void {
  // The bottom of the ladder. Symmetric with the root clamp below, which stops zoom-out.
  if (cam.z > Z_MAX) cam.z = Z_MAX;
  clampToGround(cam, view);

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

/**
 * THE GROUND IS NEVER MORE THAN A SCREEN OR TWO AWAY.
 *
 * The one place the ladder can run out from under you. Every other level is filled by its children -- a cluster of
 * galaxies, a galaxy of stars -- so wherever you aim there is eventually something to enter. A rim level is not:
 * its children are all on one line, and everything either side of that line is sky or rock, with nothing in it at
 * any magnification. Zoom at a point a little above a coastline, or at the middle of a planet, and the camera
 * descended for ever through emptiness while the only thing worth looking at receded out of the frame.
 *
 * So the zoom stops where the ground would leave the picture. Not a special case bolted on: it is the same
 * statement as Z_MAX -- there is nothing smaller than a building -- applied sideways, and like Z_MAX it is a
 * clamp on `z` rather than a rule about what to draw.
 *
 * Uses the true ground rather than the nominal radius, at the fixed detail placement uses, so where the zoom stops
 * over a mountain is where the mountain is.
 */
function clampToGround(cam: Camera, view: View): void {
  const level = LEVELS[cam.node.kind];
  if (level.placement !== 'rim') return;
  const g = cam.node.ground;
  const [nx, ny] = frameToNode(cam, cam.fx, cam.fy);

  let above: number;
  if (cam.node.kind === 'planet') {
    if (!g) return;
    const d = Math.hypot(nx, ny);
    // Dead centre there is no angle to ask about, and every direction is equally far from the surface.
    const theta = d > 1e-9 ? Math.atan2(ny, nx) : 0;
    above = d - groundAt(g.planetId, g.traits, theta, PLACEMENT_DETAIL);
  } else {
    if (!g) return;
    above = -(ny + groundHeightAt(g, nx, PLACEMENT_DETAIL));
  }

  const gap = Math.abs(above);
  if (gap < 1e-9) return;
  const diagonal = Math.hypot(view.w, view.h);
  const allowed = (above > 0 ? REACH_ABOVE : REACH_BELOW) * diagonal;
  // pxPerNodeUnit is 2^(z + logSpan), so the cap on it is a cap on z directly.
  const maxZ = Math.log2(allowed / gap) - cam.node.logSpan;
  if (cam.z > maxZ) cam.z = maxZ;
}

/** Absolute position in ROOT node units. Test-only: the ground truth a round trip is measured against. */
export function absolutePosition(cam: Camera, tree: Tree): [number, number] {
  let [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
  let node = cam.node;
  for (;;) {
    const ref = tree.refOf(node);
    const parent = tree.parentOf(node);
    if (!ref || !parent) break;
    [nx, ny] = childToParent(ref, nx, ny);
    node = parent;
  }
  return [nx, ny];
}
