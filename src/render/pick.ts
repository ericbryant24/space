import { pxPerUnit, nodeToFrame, type Camera, type View } from '../camera/camera.ts';
import { appliedUp, unrotatePoint } from '../camera/orientation.ts';
import { rimCellAt, rimChild, type ChildRef, type Node } from '../universe/node.ts';
import { LEVELS } from '../universe/schema.ts';
import type { Tree } from '../universe/tree.ts';
import { hitTest, scatterHitAt, type HitEntry } from './renderer.ts';

/**
 * WHAT IS UNDER A SCREEN POINT, INDEPENDENTLY OF WHAT WAS DRAWN.
 *
 * The renderer's hit list is a by-product of painting: it records the things it actually put on the screen.
 * That is exactly right for a galaxy full of stars and exactly wrong for a planet, because of the handover in
 * `paint` -- while a planet is drawn as a DISC its rim children are deliberately not drawn at all, and a
 * planet is a disc for the whole stretch from where it becomes the focus (220 px) to where it is six screen
 * diagonals across. Through all of that the only entry in the hit list covering the planet's face is the
 * planet itself, which is the camera's own node and therefore not a target: nothing on a world was
 * hoverable, clickable or lockable, and scrolling at one just drilled through the surface into the mantle
 * and ran to the bottom of the ladder because there was no child to aim at.
 *
 * So rim slots are worked out analytically here rather than read back from the paint. Placement is a pure
 * function of address -- see `rimChild` -- so the slot under a point can be derived at any zoom, whether or
 * not anyone drew it. Everything else still comes from the paint, which is the honest source for it.
 *
 * Pure: nothing here touches the DOM beyond the View rectangle it is handed, so it can be tested.
 */

/**
 * Minimum click radius, mirroring HIT_GRAB_PX in renderer.ts (not exported there).
 *
 * A rim child is often much smaller than this -- a region on a planet that fills the screen is about a
 * pixel across -- and a target you cannot hit is not a target. Enlarging it does not create ambiguity here
 * because there is exactly one slot under any given angle.
 */
const GRAB_PX = 15;

/**
 * How far up the tree to climb, in screen diagonals, mirroring ANCESTOR_LIMIT_DIAGONALS in renderer.ts.
 *
 * The two must stay in step: this walk exists to answer for the same nodes the renderer walks, and an
 * ancestor it has given up on is one whose rim is nowhere near the screen.
 */
const ANCESTOR_LIMIT_DIAGONALS = 64;

export interface PickResult extends HitEntry {
  /**
   * The child's ref when this was derived from placement rather than read off the paint, and null when it
   * came from the renderer's hit list. Callers that want to place something in the child's own frame need
   * the ref; callers that only want somewhere to fly to do not.
   */
  ref: ChildRef | null;
}

/**
 * The rim slot under a screen point, or null.
 *
 * Walks the same frame chain the renderer's climb walks -- the camera's node, then its ancestors, each as a
 * complex scale-and-turn from that node's units into camera-frame units -- and asks each rim node along it
 * which of its slots the point falls in. The camera's own node is tested first, so the answer is the
 * deepest, most specific one available.
 */
export function rimHitAt(cam: Camera, tree: Tree, view: View, x: number, y: number): PickResult | null {
  const r = pxPerUnit(cam);
  const diagonal = Math.hypot(view.w, view.h);
  /**
   * TURN THE POINTER BACK FIRST.
   *
   * Through the arrival at a world the whole scene is rotated so that the direction away from the planet's
   * centre points up the screen -- see src/camera/orientation.ts. The renderer's own hit list comes out already
   * turned, because the rotation goes into the screen mapping rather than onto the canvas, so everything read
   * off the paint needs no adjustment. This does: it works the geometry out from the camera, in the camera's own
   * unturned frame, so the point has to be brought into that frame on the way in and the answer taken back out
   * of it on the way out. Zero every frame the scene is not turned, which is most of them.
   */
  const up = appliedUp();
  const flat = unrotatePoint(x, y, up, view.w, view.h);
  // The screen point in camera-frame units, which is the space the whole climb is expressed in.
  const px = cam.fx + (flat.x - view.w / 2) / r;
  const py = cam.fy + (flat.y - view.h / 2) / r;

  const [originX, originY] = nodeToFrame(cam, 0, 0);
  let node: Node = cam.node;
  let cxF = originX;
  let cyF = originY;
  // The map from this node's units into camera-frame units, as one complex number -- see renderer.ts.
  let ax = 2 ** cam.k;
  let ay = 0;

  for (let i = 0; i < 12; i++) {
    const hit = slotAt(cam, node, view, r, diagonal, cxF, cyF, ax, ay, px, py);
    if (hit) return up === 0 ? hit : turned(hit, up, view);

    const ref = tree.refOf(node);
    const parent = tree.parentOf(node);
    if (!ref || !parent) return null;
    // Divide by rel * e^(i*spin): the inverse of descending into this child, same as the renderer's climb.
    const c = ref.spin === 0 ? 1 : Math.cos(ref.spin);
    const sn = ref.spin === 0 ? 0 : Math.sin(ref.spin);
    const pax = (ax * c + ay * sn) / ref.rel;
    const pay = (ay * c - ax * sn) / ref.rel;
    if (Math.hypot(pax, pay) * r > ANCESTOR_LIMIT_DIAGONALS * diagonal) return null;
    cxF -= pax * ref.ox - pay * ref.oy;
    cyF -= pay * ref.ox + pax * ref.oy;
    ax = pax;
    ay = pay;
    node = parent;
  }
  return null;
}

/** A result found in the camera's unturned frame, put back into the screen space the caller sees. */
function turned(hit: PickResult, up: number, view: View): PickResult {
  const p = unrotatePoint(hit.xPx, hit.yPx, -up, view.w, view.h);
  return { ...hit, xPx: p.x, yPx: p.y };
}

/** One node of the climb: the slot of ITS rim under the point, if it has a rim and the point is on it. */
function slotAt(
  cam: Camera,
  node: Node,
  view: View,
  r: number,
  diagonal: number,
  cxF: number,
  cyF: number,
  ax: number,
  ay: number,
  px: number,
  py: number,
): PickResult | null {
  const level = LEVELS[node.kind];
  if (level.placement !== 'rim' || !level.child) return null;

  const denom = ax * ax + ay * ay;
  if (denom === 0) return null;
  const scale = ay === 0 ? Math.abs(ax) : Math.hypot(ax, ay);
  const rPx = scale * r;

  /**
   * On screen, using the renderer's own reach rule for a rim parent: its children straddle its
   * circumference and each plate paints a screen diagonal of ground either side of itself, so a planet
   * whose disc misses the viewport is still the planet you are standing on.
   */
  const nodeX = view.w / 2 + (cxF - cam.fx) * r;
  const nodeY = view.h / 2 + (cyF - cam.fy) * r;
  const reach = rPx + diagonal;
  if (nodeX + reach < 0 || nodeY + reach < 0 || nodeX - reach > view.w || nodeY - reach > view.h) return null;

  // The point in this node's own units: undo the offset, then divide by the complex scale-and-turn.
  const dx = px - cxF;
  const dy = py - cyF;
  const nx = (dx * ax + dy * ay) / denom;
  const ny = (dy * ax - dx * ay) / denom;

  /**
   * Below a planet the surface coordinate is the local horizontal and the frame has two real ends, so a
   * point past either of them belongs to a SIBLING and has to be left to the parent to answer for.
   * `rimCellAt` clamps rather than failing -- which is right for the camera, which is always inside its own
   * frame -- so without this a cursor half a screen away would be answered with the end slot.
   */
  if (node.kind !== 'planet' && Math.abs(nx) > 1) return null;

  const ref = rimChild(node, rimCellAt(node, nx, ny));
  if (!ref) return null;

  // The child's origin in camera-frame units, then in pixels: the same composition `childFrame` does.
  const kx = cxF + ax * ref.ox - ay * ref.oy;
  const ky = cyF + ay * ref.ox + ax * ref.oy;
  const sx = view.w / 2 + (kx - cam.fx) * r;
  const sy = view.h / 2 + (ky - cam.fy) * r;
  const childRPx = ref.rel * scale * r;

  /**
   * The point still has to be NEAR the slot, not merely at its angle. Without this the whole face of a
   * planet would answer with whatever region lies out along that bearing, so pointing at the mantle -- which
   * is not a place anyone can go -- would put a reticle on a stretch of coast a third of a screen away.
   */
  const grab = Math.max(childRPx, GRAB_PX);
  const offX = (px - cam.fx) * r + view.w / 2 - sx;
  const offY = (py - cam.fy) * r + view.h / 2 - sy;
  if (offX * offX + offY * offY > grab * grab) return null;

  return {
    path: [...node.path, ref.cell],
    kind: ref.kind,
    xPx: sx,
    yPx: sy,
    // A rim child is never drawn at a floor size -- plates tile at true scale -- so the two radii agree.
    rPx: childRPx,
    trueRPx: childRPx,
    ref,
  };
}

/**
 * THE ONE ENTRY POINT: what a click at a screen point resolves to.
 *
 * Three sources, because the three placements record themselves in three different ways. A galaxy's
 * catalogued stars are found analytically because there are thousands of them on screen and recording them
 * all would either blow the hit cap or allocate per frame. Cells and orbits come from the paint, which is
 * the truthful account of what is actually visible. Rim slots come from placement, because the disc that
 * covers them is drawn instead of them.
 *
 * The deeper answer wins, because it is the more specific one; a tie goes to what was actually drawn, since
 * a mark on the screen is a stronger claim than a slot nobody painted.
 */
export function pickAt(
  cam: Camera,
  tree: Tree,
  view: View,
  hits: readonly HitEntry[],
  x: number,
  y: number,
): PickResult | null {
  const star = scatterHitAt(cam, view, x, y);
  const drawn = star ?? hitTest(hits, x, y);
  const rim = rimHitAt(cam, tree, view, x, y);
  if (!drawn) return rim;
  if (!rim) return { ...drawn, ref: null };
  if (rim.path.length > drawn.path.length) return rim;
  return { ...drawn, ref: null };
}
