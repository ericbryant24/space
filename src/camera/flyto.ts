import type { Cell, Node } from '../universe/node.ts';
import type { Tree } from '../universe/tree.ts';
import { frameToNode, setNodeCoords, type Camera, type View } from './camera.ts';
import { updateFocus } from './rebase.ts';

/**
 * Eased travel between any two places in the universe.
 *
 * The elegant part is what is NOT here. The tween only ever drives a point in the lowest common
 * ancestor's coordinates plus a zoom level; `updateFocus` then walks the focus stack on its own. So a
 * flight from a building on one planet to a building in another galaxy needs no special-case code at
 * all -- it pops some sixty subdivision frames and five semantic frames on the way out and pushes
 * them again on the way in, automatically.
 */
export interface Flight {
  /** Depth of the lowest common ancestor; the frame the tween happens in. */
  readonly depth: number;
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  /** Zoom to pull back to at the midpoint when the endpoints are far apart. */
  readonly zOut: number;
  readonly targetPath: readonly Cell[];
  t: number;
  readonly duration: number;
}

/** On-screen radius, in px, that a flight aims to leave its target at. */
export const ARRIVAL_RADIUS_PX = 300;

/** Position expressed in the units of an ancestor at the given path depth. */
export function positionInAncestor(
  tree: Tree,
  node: Node,
  nx: number,
  ny: number,
  depth: number,
): { x: number; y: number; scale: number } | null {
  let current: Node = node;
  let x = nx;
  let y = ny;
  let scale = 1;
  let guard = 0;
  while (current.path.length > depth) {
    if (guard++ > 16) return null;
    const ref = tree.refOf(current);
    const parent = tree.parentOf(current);
    if (!ref || !parent) return null;
    x = ref.ox + x * ref.rel;
    y = ref.oy + y * ref.rel;
    scale *= ref.rel;
    current = parent;
  }
  return { x, y, scale };
}

export function commonDepth(a: readonly Cell[], b: readonly Cell[]): number {
  let i = 0;
  while (i < a.length && i < b.length) {
    const ca = a[i]!;
    const cb = b[i]!;
    if (ca.cx !== cb.cx || ca.cy !== cb.cy) break;
    i++;
  }
  return i;
}

export function planFlight(
  cam: Camera,
  tree: Tree,
  targetPath: readonly Cell[],
  view: View,
): Flight | null {
  const target = tree.resolve(targetPath);
  if (!target) return null;

  const depth = commonDepth(cam.node.path, targetPath);
  const [camX, camY] = frameToNode(cam, cam.fx, cam.fy);
  const from = positionInAncestor(tree, cam.node, camX, camY, depth);
  const to = positionInAncestor(tree, target, 0, 0, depth);
  if (!from || !to) return null;

  const az = cam.z;
  const bz = Math.log2(ARRIVAL_RADIUS_PX) - target.logSpan;

  // Van Wijk style: if the two places are much further apart than either view is wide, pull out,
  // translate, and push back in, rather than scrubbing sideways across an enormous distance.
  const lca = tree.resolve(targetPath.slice(0, depth));
  const lcaLogSpan = lca ? lca.logSpan : tree.root.logSpan;
  const separation = Math.hypot(to.x - from.x, to.y - from.y);
  const viewSpanAtStart = (view.w / 2) * 2 ** -(az + lcaLogSpan);
  const pullBack = separation > viewSpanAtStart * 1.2 ? Math.log2(separation / Math.max(1e-12, viewSpanAtStart)) : 0;
  const zOut = Math.min(az, bz) - Math.max(0, pullBack);

  const travel = Math.abs(bz - az) + Math.max(0, pullBack);
  return {
    depth,
    ax: from.x,
    ay: from.y,
    az,
    bx: to.x,
    by: to.y,
    bz,
    zOut,
    targetPath,
    t: 0,
    duration: Math.min(2.6, 0.5 + 0.055 * travel),
  };
}

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Advance a flight. Returns true when it has arrived. */
export function stepFlight(flight: Flight, cam: Camera, tree: Tree, view: View, dt: number): boolean {
  flight.t = Math.min(1, flight.t + dt / flight.duration);
  const e = easeInOutCubic(flight.t);

  const lca = tree.resolve(flight.targetPath.slice(0, flight.depth));
  if (!lca) return true;

  const x = flight.ax + (flight.bx - flight.ax) * e;
  const y = flight.ay + (flight.by - flight.ay) * e;
  // Triangular weight: full pull-back at the midpoint, none at either end.
  const arc = 1 - Math.abs(2 * e - 1);
  const zLine = flight.az + (flight.bz - flight.az) * e;
  const z = zLine - arc * (Math.min(flight.az, flight.bz) - flight.zOut);

  cam.node = lca;
  cam.z = z;
  setNodeCoords(cam, x, y);
  updateFocus(cam, tree, view);

  return flight.t >= 1;
}
