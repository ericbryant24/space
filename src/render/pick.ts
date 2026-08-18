import { pxPerUnit, nodeToFrame, type Camera, type View } from '../camera/camera.ts';
import { appliedUp, unrotatePoint } from '../camera/orientation.ts';
import { PLACEMENT_DETAIL, groundAt } from '../culture/terrain.ts';
import { groundHeightAt, nearestRim, rimCellAt, rimChild, type ChildRef, type Node } from '../universe/node.ts';
import { LEVELS } from '../universe/schema.ts';
import type { Tree } from '../universe/tree.ts';
import { ANCESTOR_LIMIT_DIAGONALS, HIT_GRAB_PX, hitTest, scatterHitAt, type HitEntry } from './renderer.ts';

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
 * Minimum click radius, taken from the renderer's own so the two cannot drift apart.
 *
 * A rim child is often much smaller than this -- a region on a planet that fills the screen is about a
 * pixel across -- and a target you cannot hit is not a target. Enlarging it does not create ambiguity here
 * because there is exactly one slot under any given angle.
 */
const GRAB_PX = HIT_GRAB_PX;



export interface PickResult extends HitEntry {
  /**
   * The child's ref when this was derived from placement rather than read off the paint, and null when it
   * came from the renderer's hit list. Callers that want to place something in the child's own frame need
   * the ref; callers that only want somewhere to fly to do not.
   */
  ref: ChildRef | null;
}

/**
 * One rim node of the climb, with the aimed point already carried into that node's own units.
 *
 * The two questions asked of a rim below differ only in which slot counts as an answer; everything before
 * that -- the level check, the renderer's reach rule, and the complex divide that gets the point into node
 * units -- is the same for both, so it happens once, here.
 */
interface RimFrame {
  node: Node;
  view: View;
  /** Pixels per camera-frame unit, and the camera's own position in that frame. */
  r: number;
  fx: number;
  fy: number;
  /** This node's origin in camera-frame units. */
  cxF: number;
  cyF: number;
  /** Node units -> camera-frame units, as one complex number, and its modulus. */
  ax: number;
  ay: number;
  scale: number;
  /** The aimed point, in camera-frame units and then in this node's own units. */
  px: number;
  py: number;
  nx: number;
  ny: number;
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
  return climbRim(cam, tree, view, x, y, slotUnder);
}

/**
 * THE SLOT A POINT INSIDE A BODY BELONGS TO, however far from the rim it is.
 *
 * `rimHitAt` deliberately answers only NEAR a slot, because a reticle a third of a screen from the cursor is
 * a lie about what is being pointed at. That leaves the whole interior of a world unanswered -- and the
 * interior is most of the screen. Measured on a 1600x900 view at the moment a planet becomes the focus, a
 * seventh of its face is within grab range of the rim; two doublings later the rim is off the edge of the
 * screen and NOTHING on the screen answers. The disc goes on being a disc until it is several screen
 * diagonals across, so that is the state the camera is in for most of an arrival at a world.
 *
 * A ZOOM STILL HAS TO NAME SOMEWHERE. Scrolling with the cursor in a planet's mantle is not pointing at
 * nothing: rock has ground over it, and the ground on that bearing is a real place. Without this the camera
 * sat on a world's centre with no child to aim at, descended straight into the interior, and stopped dead
 * against `clampToGround` a few thousand pixels in -- inside a planet, with the only thing worth looking at
 * off the edge of the screen and no gesture able to bring it back.
 *
 * The containment test is `clampToGround`'s own, and the two belong together: that one stops the zoom where
 * the body ends, this one names the destination for the zooms that are inside it. Empty sky is still no
 * answer -- aiming at air is aiming at nothing, and the clamp already deals with it.
 */
export function nearestRimAt(cam: Camera, tree: Tree, view: View, x: number, y: number): PickResult | null {
  return climbRim(cam, tree, view, x, y, slotBelow);
}

/**
 * The camera's node and then its ancestors, each offered to `answer` as a rim frame; the first answer wins.
 *
 * Deepest first, so the reply is the most specific one available, and the walk gives up once an ancestor's
 * frame is further off screen than the renderer is prepared to climb.
 */
function climbRim(
  cam: Camera,
  tree: Tree,
  view: View,
  x: number,
  y: number,
  answer: (f: RimFrame) => PickResult | null,
): PickResult | null {
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
    const frame = rimFrameOf(cam, node, view, r, diagonal, cxF, cyF, ax, ay, px, py);
    const hit = frame ? answer(frame) : null;
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

/** One node of the climb, or null if it has no rim or is nowhere near the screen. */
function rimFrameOf(
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
): RimFrame | null {
  const level = LEVELS[node.kind];
  if (level.placement !== 'rim' || !level.child) return null;

  const denom = ax * ax + ay * ay;
  if (denom === 0) return null;
  const scale = ay === 0 ? Math.abs(ax) : Math.hypot(ax, ay);

  /**
   * On screen, using the renderer's own reach rule for a rim parent: its children straddle its
   * circumference and each plate paints a screen diagonal of ground either side of itself, so a planet
   * whose disc misses the viewport is still the planet you are standing on.
   */
  const nodeX = view.w / 2 + (cxF - cam.fx) * r;
  const nodeY = view.h / 2 + (cyF - cam.fy) * r;
  const reach = scale * r + diagonal;
  if (nodeX + reach < 0 || nodeY + reach < 0 || nodeX - reach > view.w || nodeY - reach > view.h) return null;

  // The point in this node's own units: undo the offset, then divide by the complex scale-and-turn.
  const dx = px - cxF;
  const dy = py - cyF;
  return {
    node,
    view,
    r,
    fx: cam.fx,
    fy: cam.fy,
    cxF,
    cyF,
    ax,
    ay,
    scale,
    px,
    py,
    nx: (dx * ax + dy * ay) / denom,
    ny: (dy * ax - dx * ay) / denom,
  };
}

/** The slot the point is in AND close to. The strict answer -- what a reticle, a click or a lock resolves to. */
function slotUnder(f: RimFrame): PickResult | null {
  /**
   * Below a planet the surface coordinate is the local horizontal and the frame has two real ends, so a
   * point past either of them belongs to a SIBLING and has to be left to the parent to answer for.
   * `rimCellAt` clamps rather than failing -- which is right for the camera, which is always inside its own
   * frame -- so without this a cursor half a screen away would be answered with the end slot.
   */
  if (f.node.kind !== 'planet' && Math.abs(f.nx) > 1) return null;

  const ref = rimChild(f.node, rimCellAt(f.node, f.nx, f.ny));
  if (!ref) return null;
  const out = resultFor(f, ref);

  /**
   * The point still has to be NEAR the slot, not merely at its angle. Without this the whole face of a
   * planet would answer with whatever region lies out along that bearing, so pointing at the mantle -- which
   * is not a place anyone can go -- would put a reticle on a stretch of coast a third of a screen away.
   */
  const grab = Math.max(out.rPx, GRAB_PX);
  const offX = (f.px - f.fx) * f.r + f.view.w / 2 - out.xPx;
  const offY = (f.py - f.fy) * f.r + f.view.h / 2 - out.yPx;
  if (offX * offX + offY * offY > grab * grab) return null;
  return out;
}

/** The nearest occupied slot to a point that is inside the body itself. The loose answer -- see `nearestRimAt`. */
function slotBelow(f: RimFrame): PickResult | null {
  if (!insideBody(f)) return null;
  // Outwards from the slot the bearing lands in, because that slot is often empty: below a planet, a stretch
  // of ground that has climbed clean out of its own frame is a cliff face and holds nothing. See `nearestRim`.
  const ref = nearestRim(f.node, f.nx, f.ny);
  return ref ? resultFor(f, ref) : null;
}

/**
 * Whether the point is in rock rather than in air, in this node's own units.
 *
 * Deliberately the two expressions `clampToGround` measures height with -- radius against the ground radius
 * on the planet, the local ground line below it -- both sampled at PLACEMENT_DETAIL, so the answer is a pure
 * function of address and the edge of a world does not move as you approach it.
 */
function insideBody(f: RimFrame): boolean {
  const g = f.node.ground;
  if (!g) return false;
  if (f.node.kind === 'planet') {
    const d = Math.hypot(f.nx, f.ny);
    // Dead centre there is no bearing to ask about, and every direction is equally far from the surface.
    const theta = d > 1e-9 ? Math.atan2(f.ny, f.nx) : 0;
    return d <= groundAt(g.planetId, g.traits, theta, PLACEMENT_DETAIL);
  }
  if (Math.abs(f.nx) > 1) return false;
  // Node space has y pointing DOWN, so the ground line sits at negative height and the rock is below it.
  return f.ny + groundHeightAt(g, f.nx, PLACEMENT_DETAIL) >= 0;
}

/** Where one of this node's slots lands on screen: the same composition `childFrame` does. */
function resultFor(f: RimFrame, ref: ChildRef): PickResult {
  const kx = f.cxF + f.ax * ref.ox - f.ay * ref.oy;
  const ky = f.cyF + f.ay * ref.ox + f.ax * ref.oy;
  const childRPx = ref.rel * f.scale * f.r;
  return {
    path: [...f.node.path, ref.cell],
    kind: ref.kind,
    xPx: f.view.w / 2 + (kx - f.fx) * f.r,
    yPx: f.view.h / 2 + (ky - f.fy) * f.r,
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
