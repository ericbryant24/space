import { frameToNode, nodeToFrame, pxPerUnit, type Camera, type View } from '../camera/camera.ts';
import { childToParent } from '../camera/rebase.ts';
import { catalogName } from '../cosmic/catalog.ts';
import {
  childAt,
  makeChild,
  nearestScatter,
  orbitalChildren,
  rimChildren,
  scatterChildren,
  type Cell,
  type ChildRef,
  type Node,
} from '../universe/node.ts';
import { galaxyTraits, type GalaxyTraits } from '../universe/gen/galaxy.ts';
import { LEVELS, anchorLevel, type Kind } from '../universe/schema.ts';
import type { Tree } from '../universe/tree.ts';
import { activeReps, smoothstep } from './bands.ts';
import { beginSpriteFrame, spritesPending } from './sprites.ts';
import { cosmicPaletteOf, css, voidBackgroundFor } from './palettes.ts';
import { drawGalaxyInterior, drawGalaxyLive, drawGalaxySprite, drawGalaxyStandIn } from './draw/galaxy.ts';
import {
  beginStarBatch,
  clusterCensus,
  drawContainer,
  drawStar,
  flushStarBatch,
  queueSystemStar,
  starGlyphRadius,
  systemStarRadius,
} from './draw/containers.ts';
import { PLANET_ICON_MIN_PX, drawOrbitRings, drawPlanetIcon, skyTone } from './draw/planet.ts';
import { PLATE_RIND, beginGroundFrame, drawSurfacePlate } from './draw/ground.ts';
import { upAngleFor } from '../camera/orientation.ts';
import { beginStructureFrame } from './draw/structures.ts';
import { computeSky, paintSky, type Sky } from './draw/sky.ts';
import { metallicityAt, metallicityOf } from '../cosmic/metallicity.ts';
import { groundHeightAt } from '../universe/node.ts';
import { groundAt } from '../culture/terrain.ts';
import { simTime } from '../core/clock.ts';
import type { PlanetTraits } from '../universe/gen/planet.ts';
import { buildingName, planetCultureFor, regionName, settlementName } from '../universe/gen/culture.ts';

/** Objects smaller than this are not drawn at all; later their light folds into a baked wash tile. */
const MIN_DRAW_PX = 0.45;
/** Do not iterate a node's anchor grid until its children would be at least this big. */
const MIN_CHILD_PX = 1.1;
/**
 * Climb generously towards the root: an ancestor far larger than the screen still contributes the
 * SIBLINGS of our own lineage, which is what stops each level looking like one lonely disc. Cost is
 * bounded anyway, because each level's cell iteration is clamped to the viewport.
 */
export const ANCESTOR_LIMIT_DIAGONALS = 64;
/** Past this the node's own silhouette is off-screen anyway; iterate its children but skip its disc. */
export const MAX_SELF_DRAW_DIAGONALS = 2.5;
/**
 * A planet keeps drawing its own body long past the general limit, because that is what paints the ground until its
 * regions take over -- and the two have to meet exactly.
 *
 * The reciprocal of PLATE_RIND, and not a free number. A plate paints one screen diagonal of rock below its ground
 * line, so at the handover the disc must be `1 / PLATE_RIND` diagonals across for the rind it paints to be the same
 * depth as the rock the plates paint. Any other value shows a dark band of planet interior appearing or vanishing at
 * the moment the switch happens.
 *
 * There is a cost ceiling behind this too: the illustration used to be built from shapes measured in planet radii --
 * a terminator rect at 1.2r, ring ellipses out to 1.9r, a rim-light arc stroked at 0.045r -- and at forty thousand
 * pixels of radius those took the tab down with them. What is left is one closed curve and a few concentric arcs,
 * most of them off screen, which is affordable at any size.
 */
const PLANET_MAX_DIAGONALS = 1 / PLATE_RIND;
const MAX_DEPTH = 5;
const DRAW_BUDGET = 12000;
const CELL_BUDGET = 24000;
/**
 * Records scattered stars in the hit list, which normal frames deliberately do not do -- there can be a
 * couple of thousand on screen, and `scatterHitAt` finds them analytically instead.
 *
 * Only `tools/real-check.ts` turns this on. It needs the renderer's own account of what it drew and
 * where, so it can check that every mark on screen is a place you can travel to; recomputing the
 * positions itself would only prove that two copies of the same arithmetic agree.
 */
let recordAllHits = false;
export function setRecordAllHits(on: boolean): void {
  recordAllHits = on;
}
/** Anything at least this big on screen becomes a click target. */
const HIT_MIN_PX = 2.5;
/**
 * Minimum click radius. A galaxy seen from its cluster is about four pixels across, and a planet in a
 * system view is drawn at a four-pixel floor, so hit-testing against the drawn radius would make both
 * effectively unclickable -- and orbiting bodies are moving targets besides. Enlarging the target does
 * not create ambiguity: the hit list is walked backwards, and children are recorded after their parents,
 * so the deepest thing under the cursor still wins.
 */
export const HIT_GRAB_PX = 15;
/** Parent size at which scattered children start to resolve, and at which they reach full strength. */
const SCATTER_MIN_PARENT_PX = 110;
const SCATTER_FULL_PARENT_PX = 320;
/**
 * Parent size below which orbital children are not drawn at all.
 *
 * Schematic children are exempt from the true-size gate, which meant every one of the ~80 stars visible
 * at galaxy level also drew its planets as four-pixel icons on top of itself: a few hundred spurious
 * dots, the draw budget pinned at its ceiling, and hit-testing returning a planet when you pointed at a
 * star. A planet is only meaningful once its system is a frame you are looking into.
 */
const ORBIT_MIN_PARENT_PX = 70;
/**
 * Minimum on-screen size for a child of a given kind to be worth drawing at all.
 *
 * The global 1.1 px floor is right for stars and galaxies, which read fine as points. It is wrong for
 * a region: two thousand regions scattered over a planet's face as pinpricks read as dirt on the lens,
 * not as geography. A region only means anything once it is an area.
 */
const MIN_CHILD_PX_BY_KIND: Partial<Record<Kind, number>> = {
  /**
   * The rim floors have a hard constraint on them, not a taste: a parent stops drawing its own body at
   * PLANET_MAX_DIAGONALS / MAX_SELF_DRAW_DIAGONALS, so its children must already be above their floor by then or
   * there is a stretch of the descent with nothing painting the ground at all. A planet tiles its rim with about a
   * thousand regions and stops drawing itself at six diagonals, which puts the region floor at eight pixels.
   */
  region: 8,
  settlement: 8,
  /**
   * A galaxy has a stamp of its own below the size at which its arms are worth drawing -- see
   * GALAXY_ICON_MIN_PX -- so the floor here is the size at which a galaxy stops being a mark on the screen at
   * all. It has to be below where a cluster's swarm fades out, or a cluster between about thirty and seventy
   * pixels shows neither: its own contents have faded and its galaxies have not appeared. See
   * CLUSTER_SWARM_OUT_PX in draw/containers.ts, which is derived from the galaxy blob band's own fade-in.
   */
  galaxy: 0.45,
  // A building is a front elevation. Below a few pixels there is no elevation to read, only a tick mark.
  building: 5,
};

export interface HitEntry {
  path: readonly Cell[];
  kind: Kind;
  xPx: number;
  yPx: number;
  /** Radius as drawn, which for a schematic body is a floor rather than its real size. */
  rPx: number;
  /** Radius at true scale. A planet in a system view is a ten-thousandth of a pixel. */
  trueRPx: number;
}

export interface RenderStats {
  draws: number;
  cells: number;
  labels: number;
  budgetHit: boolean;
  /** Sprites still queued for baking; the loop keeps running until this clears. */
  spritesPending: boolean;
  topKind: Kind;
  /**
   * How far the scene was turned to put the ground the right way up -- see src/camera/orientation.ts.
   *
   * Reported because the pop detector's model of a zoom is a pure scale about the screen centre, and through the
   * arrival at a world that is not the whole transform: the picture also turns. Without knowing by how much, the
   * detector reads the turn as the biggest pop in the run.
   */
  up: number;
  hits: HitEntry[];
}

/** Placeholder styling for levels whose real art has not been built yet (planet and below). */
const KIND_STYLE: Record<Kind, { hue: number; sat: number; light: number }> = {
  field: { hue: 232, sat: 30, light: 26 },
  cluster: { hue: 268, sat: 46, light: 40 },
  galaxy: { hue: 205, sat: 72, light: 62 },
  system: { hue: 44, sat: 92, light: 66 },
  planet: { hue: 154, sat: 62, light: 52 },
  region: { hue: 96, sat: 48, light: 46 },
  settlement: { hue: 22, sat: 74, light: 58 },
  building: { hue: 8, sat: 68, light: 62 },
};

const INK = '#12141f';

interface Frame {
  ctx: CanvasRenderingContext2D;
  cam: Camera;
  tree: Tree;
  view: View;
  r: number;
  diagonal: number;
  detailBias: number;
  /** Radius the last painter actually drew, which may exceed the true size for schematic bodies. */
  lastDrawnRadius: number;
  /** Alpha for schematic children, used to fade resolved stars in as their galaxy grows. */
  childAlpha: number;
  /** On-screen radius of the node whose scattered children are being drawn. Sizes their symbols. */
  scatterParentPx: number;
  /**
   * The sky over the world the camera is standing on, or null out in space.
   *
   * Computed ONCE per frame, and it has to be: the star is at infinity, so every plate on screen must place it
   * at the same point or the sky gains a parallax that a star cannot have. Plates then paint it themselves,
   * because a plate is what knows where its own ground is -- which gets the horizon occluding a setting star
   * for nothing.
   */
  sky: Sky | null;
  /** The enclosing galaxy's ore chemistry, which is what a wall four levels down is made of. */
  ore: { hue: number; metallicity: number };
  /**
   * How far the whole scene is turned so that "away from the planet's centre" points up the screen.
   *
   * Zero everywhere except while the camera's focus is a planet it is already standing on -- see
   * src/camera/orientation.ts. Applied to the screen mapping rather than to the canvas, so `stats.hits` and every
   * other screen measurement come out in final screen space and nothing downstream has to know about it.
   */
  up: number;
  cosUp: number;
  sinUp: number;
  stats: RenderStats;
}

export function render(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  tree: Tree,
  view: View,
  detailBias = 1,
): RenderStats {
  const r = pxPerUnit(cam);
  const stats: RenderStats = {
    draws: 0,
    cells: 0,
    labels: 0,
    budgetHit: false,
    spritesPending: false,
    topKind: cam.node.kind,
    up: 0,
    hits: [],
  };
  beginSpriteFrame();
  beginStructureFrame();
  const diagonal = Math.hypot(view.w, view.h);
  const frame: Frame = {
    ctx,
    cam,
    tree,
    view,
    r,
    diagonal,
    detailBias,
    lastDrawnRadius: 0,
    childAlpha: 1,
    scatterParentPx: 0,
    sky: null,
    ore: oreFor(cam, tree),
    up: 0,
    cosUp: 1,
    sinUp: 0,
    stats,
  };

  ctx.fillStyle = css(voidBackgroundFor(cam.node, tree, 2 ** cam.k * r, diagonal));
  ctx.fillRect(0, 0, view.w, view.h);

  // A zoom changes every pixel on screen, so there is no dirty-rect path anywhere: full clear, full
  // redraw, and the loop sleeps when nothing is moving.
  const [cxF, cyF] = nodeToFrame(cam, 0, 0);
  let node: Node = cam.node;
  let centreX = cxF;
  let centreY = cyF;
  /**
   * The map from a node's own units into camera-frame units, as ONE COMPLEX NUMBER.
   *
   * `(ax, ay)` is a scale of `hypot(ax, ay)` combined with a rotation of `atan2(ay, ax)`. It was a bare scalar
   * until frames below a planet started carrying a rotation, and a complex number is the whole of the change:
   * composing a child is one complex multiply, and climbing to a parent is one complex divide. No matrices, and
   * the rotation-free path -- everything above a planet, where ay is exactly 0 -- costs the same as it did.
   */
  let ax = 2 ** cam.k;
  let ay = 0;

  // Climb towards the root so that siblings of the focus node are on screen too, stopping before an
  // ancestor grows so large that drawing it is pointless.
  const limit = ANCESTOR_LIMIT_DIAGONALS * diagonal;
  for (let i = 0; i < 12; i++) {
    const ref = tree.refOf(node);
    const parent = tree.parentOf(node);
    if (!ref || !parent) break;
    // Divide by rel * e^(i*spin): the inverse of what descending into this child does.
    const c = ref.spin === 0 ? 1 : Math.cos(ref.spin);
    const sn = ref.spin === 0 ? 0 : Math.sin(ref.spin);
    const px = (ax * c + ay * sn) / ref.rel;
    const py = (ay * c - ax * sn) / ref.rel;
    if (!worthClimbing(LEVELS[parent.kind].placement, Math.hypot(ax, ay) * r, Math.hypot(px, py) * r, limit, diagonal)) {
      break;
    }
    centreX -= px * ref.ox - py * ref.oy;
    centreY -= py * ref.ox + px * ref.oy;
    ax = px;
    ay = py;
    node = parent;
  }
  stats.topKind = node.kind;

  // The sky. Whenever the camera is inside a galaxy -- at ANY depth below it, right down to standing next
  // to a building -- the enclosing galaxy's diffuse glow is the backdrop, because the rest of the galaxy
  // does not stop existing when you descend into one corner of it. Without this, the long stretches where
  // the galaxy is bigger than the screen and its systems are still sub-pixel rendered as a blank screen.
  const sky = galaxyViewport(cam, tree, view);
  if (sky) {
    drawGalaxyInterior(ctx, galaxyTraitsCached(sky.id), sky.nx, sky.ny, sky.halfW, sky.halfH, view.w, view.h);
    stats.draws++;
  }
  /**
   * Standing on a world, the sky is not the galaxy: it is daylight, at whatever time of day it is where you
   * are. Painted over the glow rather than instead of it, so the handover is a crossfade rather than a switch.
   *
   * The sky is built here, once, because every plate has to agree about where the star is -- see Frame.sky.
   */
  frame.sky = buildSky(frame, cxF, cyF);
  if (drawGround(frame)) stats.draws++;

  /**
   * WHICH WAY IS UP, decided once for the whole scene.
   *
   * Fed the sky's own `groundAlpha` so the world comes upright over exactly the range the daylight arrives over.
   * The sky itself is painted above this line and stays in plain screen space: the whole point of the rotation is
   * that the ground ends up horizontal, so a sky drawn horizontally is a sky that agrees with it.
   */
  frame.up = upAngleFor(cam, frame.sky ? frame.sky.groundAlpha : 0);
  frame.cosUp = Math.cos(frame.up);
  frame.sinUp = Math.sin(frame.up);
  stats.up = frame.up;

  // The planet's own disc is reached through the space-mode painter, which has no sky or viewport argument to take
  // one, so it is handed the frame's here instead. See `beginGroundFrame`.
  beginGroundFrame(frame.sky, view.w, view.h, frame.up, frame.ore);

  paint(frame, node, centreX, centreY, ax, ay, 0);
  stats.spritesPending = spritesPending();
  return stats;
}

/**
 * A child's frame: where its origin sits in camera-frame units, and its own scale-and-rotation.
 *
 * One complex multiply. `origin' = origin + a * (ox, oy)` and `a' = a * rel * e^(i * spin)` -- exactly the
 * composition `enterChild` inverts, which is what keeps the picture and the camera in agreement.
 */
function childFrame(
  cxF: number,
  cyF: number,
  ax: number,
  ay: number,
  ref: ChildRef,
): [number, number, number, number] {
  const x = cxF + ax * ref.ox - ay * ref.oy;
  const y = cyF + ay * ref.ox + ax * ref.oy;
  if (ref.spin === 0) return [x, y, ax * ref.rel, ay * ref.rel];
  const c = Math.cos(ref.spin);
  const sn = Math.sin(ref.spin);
  return [x, y, (ax * c - ay * sn) * ref.rel, (ay * c + ax * sn) * ref.rel];
}

/**
 * `schematic` marks a body drawn at a floor size rather than its true size -- an orbital diagram, where
 * a planet is genuinely a ten-thousandth of a pixel. Without threading it through, the minimum-size
 * cull discards the very thing a system view exists to show.
 */
/**
 * Whether an ancestor is worth climbing to.
 *
 * For most of the ladder the question is about the ANCESTOR: past some size its own disc is off screen in every
 * direction and the only reason to keep it is the siblings it holds, which stop mattering eventually too.
 *
 * FOR A RIM PARENT THE QUESTION IS ABOUT THE CHILD, and getting that wrong was the worst bug in the surface
 * views. A rim parent stops drawing its own body early -- see PLANET_MAX_DIAGONALS -- so the ONLY thing painting
 * the ground is its children, and the moment the climb drops it, every plate but the one in focus disappears and
 * two thirds of the screen goes to bare sky. At region focus a planet works out at about sixty screen diagonals,
 * which is close enough to the general limit that whether your neighbours existed came down to how lumpy the
 * ground happened to be where you were standing.
 *
 * So a rim parent is kept for exactly as long as its children are smaller than the screen, which is exactly as
 * long as their siblings can be seen. Above that the child covers the window on its own and there is nothing
 * beside it to paint.
 */
function worthClimbing(
  placement: string,
  childPx: number,
  parentPx: number,
  limit: number,
  diagonal: number,
): boolean {
  if (placement === 'rim') return childPx < MAX_SELF_DRAW_DIAGONALS * diagonal;
  return parentPx <= limit;
}

/**
 * A point in camera-frame units, in final screen pixels.
 *
 * The scene rotation is applied HERE, to the offset from the camera, rather than to the canvas. That keeps every
 * screen quantity the renderer hands out -- the hit list, the culling tests, the plate centres -- in the same
 * space the pointer arrives in, so a rotated world is still a world you can click on without anyone downstream
 * knowing there was a rotation. What is left for the canvas is the orientation of each shape, which travels with
 * `spin`.
 */
function toScreen(frame: Frame, xF: number, yF: number): [number, number] {
  const { cam, view, r, cosUp, sinUp } = frame;
  const dx = (xF - cam.fx) * r;
  const dy = (yF - cam.fy) * r;
  return [view.w / 2 + dx * cosUp - dy * sinUp, view.h / 2 + dy * cosUp + dx * sinUp];
}

function paint(
  frame: Frame,
  node: Node,
  cxF: number,
  cyF: number,
  ax: number,
  ay: number,
  depth: number,
  schematic = false,
): void {
  const { ctx, cam, view, r, stats } = frame;
  const scale = ay === 0 ? Math.abs(ax) : Math.hypot(ax, ay);
  // How far this node's frame is turned from the screen's: its own turn within the camera's frame, plus however
  // far the camera's frame has itself been turned to put the ground the right way up. Non-zero only below or on a
  // planet, where a node's own "up" is the direction away from the planet's centre -- see ChildRef.spin.
  const spin = (ay === 0 ? 0 : Math.atan2(ay, ax)) + frame.up;
  const trueRPx = scale * r;
  const rPx = schematic ? Math.max(trueRPx, PLANET_ICON_MIN_PX) : trueRPx;
  if (rPx < MIN_DRAW_PX) return;
  if (stats.draws >= DRAW_BUDGET) {
    stats.budgetHit = true;
    return;
  }

  const [sx, sy] = toScreen(frame, cxF, cyF);
  const level = LEVELS[node.kind];
  /**
   * How far this node's CONTENT can reach beyond its own disc.
   *
   * For a grid, an orbit or a scatter the answer is nothing: children live inside their parent. A RIM parent is
   * different -- its children straddle its circumference, half of each one is sky, and each of their plates
   * paints a screen diagonal of ground either side of it. So a planet whose own circle happens to miss the
   * viewport by seven pixels is still the planet you are standing on.
   *
   * That was a real bug and a subtle one: the camera sits a little above the nominal radius when it is on high
   * ground, which can put the disc just off the bottom of the screen, and culling the parent culled the ground
   * with it. The screen went to bare sky, at one particular height, on one particular world.
   */
  const reach = level.placement === 'rim' ? rPx + frame.diagonal : rPx;
  if (sx + reach < 0 || sy + reach < 0 || sx - reach > view.w || sy - reach > view.h) return;

  // A planet holds on to its own surface far longer than anything else, because its regions do not appear
  // until they are big enough to be areas -- see PLANET_MAX_DIAGONALS for both halves of that trade.
  const selfLimit = node.kind === 'planet' ? PLANET_MAX_DIAGONALS : MAX_SELF_DRAW_DIAGONALS;
  const selfVisible = rPx <= selfLimit * frame.diagonal;
  if (selfVisible) {
    frame.lastDrawnRadius = rPx;
    /**
     * The rotation is applied to the CANVAS, not to the coordinates.
     *
     * `sx`/`sy` already have the rotation baked into them through `ax`/`ay`, so the hit list and every screen
     * measurement stay in plain unrotated screen space and nothing downstream has to know. What is left is the
     * orientation of the shape drawn at that point, which is the canvas's job -- and a pure rotation is the one
     * transform that leaves `lineWidth` in screen pixels, so the thick cartoon outlines survive it untouched.
     */
    drawDisc(frame, node, sx, sy, rPx, trueRPx, schematic, spin);
    stats.draws++;

    // Use the radius actually drawn, so a schematic planet is as clickable as it looks.
    const hitR = frame.lastDrawnRadius;
    // Scattered stars are deliberately absent from this list. There can be several thousand on screen,
    // so recording them would either blow the cap -- leaving most of the visible stars unclickable -- or
    // allocate thousands of objects every frame. `scatterHit` finds them analytically instead, which is
    // both exact and allocation-free.
    const recordable = recordAllHits || !(node.kind === 'system' && schematic);
    if (recordable && hitR >= HIT_MIN_PX && stats.hits.length < (recordAllHits ? 8000 : 600)) {
      stats.hits.push({ path: node.path, kind: node.kind, xPx: sx, yPx: sy, rPx: hitR, trueRPx });
    }
    /**
     * NO NAMES ON THE CANVAS.
     *
     * Every object used to carry its name here, and orbital bodies carried theirs at any size at all, on the
     * argument that an unlabelled four-pixel dot is the one thing on screen you can learn nothing from. The
     * argument was right and the conclusion was wrong: the answer is to draw the dot so it tells you something,
     * not to write a caption on it. What replaces the names is bookmarking -- a place you care about is a place
     * you keep, and a thumbnail of it says which place it is without a word. See src/ui/bookmarks.ts.
     */
  }

  if (!level.child || depth >= MAX_DEPTH) return;


  // Nominal child size decides whether iterating the anchor GRID is worth anything at all. This is what
  // keeps traversal structurally bounded: at wide zooms we never touch the grid.
  //
  // It applies to cell placement only. Orbital and scattered children are drawn at a schematic floor
  // size, so a true-size gate hides exactly what those views exist to show -- a planet is 2^-17 of its
  // system and a star 2^-29 of its galaxy, so both fail it by a wide margin at every useful zoom.
  if (level.placement === 'cells') {
    const nominalRel = 2 ** (LEVELS[level.child].logSpan - node.logSpan);
    const childFloor = MIN_CHILD_PX_BY_KIND[level.child] ?? MIN_CHILD_PX;
    if (nominalRel * scale * r < childFloor) return;
  }

  if (level.placement === 'orbits') {
    if (rPx < ORBIT_MIN_PARENT_PX) return;
    for (const ref of orbitalChildren(node)) {
      const [kx, ky, kax, kay] = childFrame(cxF, cyF, ax, ay, ref);
      paint(frame, makeChild(node, ref), kx, ky, kax, kay, depth + 1, true);
    }
    return;
  }

  if (level.placement === 'rim') {
    /**
     * THE HANDOVER: a rim parent paints its own body, or its children's plates, and never both.
     *
     * `selfVisible` is exactly the right switch, and using it removes a whole class of tuning. A plate paints a full
     * screen diagonal of rock below its ground line, so plates drawn while their parent is also drawn would bury
     * the parent's interior under a ring of soil -- and gating on a pixel floor instead left a stretch of the
     * descent where the parent had stopped drawing and the children had not started, which showed as a screen of
     * bare sky. Complementary conditions cannot leave a gap or an overlap. It is also why PLANET_MAX_DIAGONALS is
     * the reciprocal of PLATE_RIND: at the moment of the switch, the rind the disc paints and the rock a plate
     * paints have to be the same depth.
     */
    if (selfVisible) return;
    const floor = MIN_CHILD_PX_BY_KIND[level.child] ?? MIN_CHILD_PX;
    /**
     * Culled here, before `makeChild`, and not left to `paint`'s own bounds test.
     *
     * A planet tiles its rim with about a thousand regions and only a handful are ever on screen, but building
     * each one costs a terrain sample at placement detail -- sixteen octaves -- so handing all thousand to
     * `paint` and letting it reject them was the whole frame. The test below is the same one `paint` applies,
     * done on the ref instead of the node, which is arithmetic only.
     */
    for (const ref of rimChildren(node)) {
      const childR = ref.rel * scale * r;
      if (childR < floor) continue;
      const [kx, ky, kax, kay] = childFrame(cxF, cyF, ax, ay, ref);
      const [sx, sy] = toScreen(frame, kx, ky);
      if (sx + childR < 0 || sy + childR < 0 || sx - childR > view.w || sy - childR > view.h) continue;
      paint(frame, makeChild(node, ref), kx, ky, kax, kay, depth + 1);
      if (stats.draws >= DRAW_BUDGET) {
        stats.budgetHit = true;
        break;
      }
    }
    return;
  }

  if (level.placement === 'scatter') {
    // Only once the parent is big enough for its stars to be worth picking out. Below that the baked
    // galaxy sprite carries the look, and iterating a few thousand systems for each of a hundred
    // distant galaxies would be pure waste.
    if (rPx < SCATTER_MIN_PARENT_PX) return;
    // Fade in over the same range the galaxy's own arms do, so resolved stars replace the sprite's
    // unresolved ones instead of both being drawn at once.
    const alpha = smoothstep(SCATTER_MIN_PARENT_PX, SCATTER_FULL_PARENT_PX, rPx);
    frame.childAlpha = alpha;
    frame.scatterParentPx = rPx;
    // Each star only queues itself here; the whole population is emitted as one path per spectral class
    // once the loop finishes. Labels and hit records still happen per star inside `paint`.
    beginStarBatch();
    for (const ref of scatterChildren(node)) {
      const [kx, ky, kax, kay] = childFrame(cxF, cyF, ax, ay, ref);
      paint(frame, makeChild(node, ref), kx, ky, kax, kay, depth + 1, true);
      if (stats.draws >= DRAW_BUDGET) {
        stats.budgetHit = true;
        break;
      }
    }
    stats.draws += flushStarBatch(ctx, alpha);
    frame.childAlpha = 1;
    frame.scatterParentPx = 0;
    return;
  }

  const k = anchorLevel(node.kind);
  const n = 2 ** k;
  const span = 2 ** (1 - k);

  // Viewport bounds in this node's own units.
  const halfW = view.w / 2 / r / scale;
  const halfH = view.h / 2 / r / scale;
  const camNodeX = (cam.fx - cxF) / scale;
  const camNodeY = (cam.fy - cyF) / scale;
  const lo = (v: number) => Math.max(0, Math.floor((v + 1) / span));
  const hi = (v: number) => Math.min(n - 1, Math.floor((v + 1) / span));
  const cx0 = lo(camNodeX - halfW);
  const cx1 = hi(camNodeX + halfW);
  const cy0 = lo(camNodeY - halfH);
  const cy1 = hi(camNodeY + halfH);
  if (cx1 < cx0 || cy1 < cy0) return;

  const cellCount = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
  if (stats.cells + cellCount > CELL_BUDGET) {
    stats.budgetHit = true;
    return;
  }
  stats.cells += cellCount;

  const cell: { cx: number; cy: number } = { cx: 0, cy: 0 };
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      cell.cx = cx;
      cell.cy = cy;
      const ref = childAt(node, cell);
      if (!ref) continue;
      const [kx, ky, kax, kay] = childFrame(cxF, cyF, ax, ay, ref);
      paint(frame, makeChild(node, ref), kx, ky, kax, kay, depth + 1);
      if (stats.draws >= DRAW_BUDGET) {
        stats.budgetHit = true;
        return;
      }
    }
  }
}

/**
 * Which levels are containers rather than objects. Getting this wrong was the most visible art bug in
 * the first pass: an opaque cluster disc hid every galaxy inside it.
 */
const CONTAINER: Partial<Record<Kind, number>> = {
  field: 0.5,
  cluster: 0.85,
  // Interplanetary space is empty and dark. A strong wash here turned every system into a warm haze and
  // hid the galaxy behind it, so a system gets little more than its boundary and its orbits.
  system: 0.14,
};

function drawDisc(
  frame: Frame,
  node: Node,
  sx: number,
  sy: number,
  rPx: number,
  trueRPx: number,
  schematic: boolean,
  spin: number,
): void {
  const { ctx } = frame;

  if (spin !== 0) {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(spin);
    ctx.translate(-sx, -sy);
    drawDiscUpright(frame, node, sx, sy, rPx, trueRPx, schematic, spin);
    ctx.restore();
    return;
  }
  drawDiscUpright(frame, node, sx, sy, rPx, trueRPx, schematic, 0);
}

/**
 * The stretch of a plate that is actually inside the window, in the plate's own local units.
 *
 * A plate keeps drawing until it is two and a half screen diagonals in radius, so at the coarse end of every rung
 * most of it is off the edge of the window -- and the ground line, the tree lattice and the material runs were all
 * spread evenly over the whole of it, spending six sevenths of their budget where nobody could see it. Four corners
 * inverse-rotated into plate coordinates is ten flops and buys up to six times the resolution where you are looking.
 */
function visibleSpan(frame: Frame, sx: number, sy: number, rPx: number, spin: number): { from: number; to: number } {
  const { view } = frame;
  const cos = spin === 0 ? 1 : Math.cos(spin);
  const sin = spin === 0 ? 0 : Math.sin(spin);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, y] of CORNERS) {
    const dx = x * view.w - sx;
    const dy = y * view.h - sy;
    const u = (cos * dx + sin * dy) / rPx;
    if (u < lo) lo = u;
    if (u > hi) hi = u;
  }
  // A margin, so nothing thins out at the very edge of the window and every stroke's join has a neighbour.
  const pad = Math.max(0.02, 8 / rPx);
  return { from: lo - pad, to: hi + pad };
}

const CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/**
 * The body of `drawDisc`, with the canvas already turned to this node's own frame.
 *
 * `spin` is passed on as well as applied, because the surface painters need to UNDO it for anything at infinity:
 * a star must not rotate with the ground under it.
 */
function drawDiscUpright(
  frame: Frame,
  node: Node,
  sx: number,
  sy: number,
  rPx: number,
  trueRPx: number,
  schematic: boolean,
  spin: number,
): void {
  const { ctx } = frame;

  if (node.kind === 'galaxy') {
    drawGalaxy(frame, node, sx, sy, rPx);
    return;
  }

  /**
   * Everything below a planet is the surface seen edge on: rock below, sky above, the ground line running across.
   * A region, a settlement and a building differ in how much of the same ground they show, not in what kind of
   * picture they are, so they share one painter. It reaches a full screen diagonal above and below the ground,
   * which is what lets a single plate carry the whole view when it is the only thing drawing.
   */
  if (node.kind === 'region' || node.kind === 'settlement' || node.kind === 'building') {
    // No sky means no world to stand on, which can only happen above a planet -- and there are no plates there.
    if (frame.sky) {
      drawSurfacePlate(ctx, sx, sy, rPx, node, frame.diagonal, frame.sky, frame.ore, visibleSpan(frame, sx, sy, rPx, spin));
    }
    return;
  }

  if (node.kind === 'planet') {
    const traits = node.ground?.traits;
    if (!traits) return;
    // Returns the radius actually drawn, which may be the schematic floor rather than the true size.
    frame.lastDrawnRadius = drawPlanetIcon(ctx, sx, sy, rPx, node.id, traits, frame.ore);
    return;
  }


  if (node.kind === 'system' && schematic && frame.scatterParentPx > 0) {
    // The batch is flushed by the caller. The star still counts against the frame's draw budget, which
    // is what bounds how many of a galaxy's few thousand systems get considered at all.
    frame.lastDrawnRadius = queueSystemStar(sx, sy, trueRPx, frame.scatterParentPx, node.id);
    return;
  }

  const containerStrength = CONTAINER[node.kind];
  if (containerStrength !== undefined) {
    const style = KIND_STYLE[node.kind];
    const drift = ((node.id % 512) / 512 - 0.5) * 26;
    drawContainer(
      ctx,
      sx,
      sy,
      rPx,
      { h: style.hue + drift, s: style.sat / 100, l: style.light / 100 },
      containerStrength,
      // A cluster is drawn from its own galaxies -- how many there are, and what mix of shapes -- rather than as a
      // plain wash with a number attached, so the swarm you see at cluster zoom is the field the galaxies resolve
      // out of. Nothing else has a census: a field's children are clusters and a system's are its own planets.
      node.kind === 'cluster' ? clusterCensus(node) : null,
    );
    if (node.kind === 'system') {
      // Rings first, so bodies sit on top of their own orbits. Each ring takes the colour of the world on it, so a
      // system says which of its planets is which before any of them is big enough to resolve.
      drawOrbitRings(ctx, sx, sy, rPx, node, cosmicPaletteOf(node.id).LIGHT, frame.ore);
      // A system's content is its star, and the star is minute next to the system's own extent.
      drawStar(ctx, sx, sy, rPx, node.id);
    }
    return;
  }

  const style = KIND_STYLE[node.kind];
  // A little per-node hue drift so a field of siblings is not one flat colour.
  const drift = ((node.id % 512) / 512 - 0.5) * 26;
  ctx.fillStyle = `hsl(${style.hue + drift} ${style.sat}% ${style.light}%)`;

  if (rPx < 1.6) {
    // Never draw a small object as an arc(): a fillRect is several times cheaper and at this size
    // indistinguishable.
    const d = Math.max(1, rPx * 2);
    ctx.fillRect(sx - d / 2, sy - d / 2, d, d);
    return;
  }

  ctx.beginPath();
  ctx.arc(sx, sy, rPx, 0, Math.PI * 2);
  ctx.fill();

  // Outlines are screen-space constant width and fade out rather than snapping in.
  if (rPx > MIN_OUTLINE_PX) {
    const t = Math.min(1, (rPx - MIN_OUTLINE_PX) / 8);
    ctx.globalAlpha = t;
    ctx.lineWidth = Math.min(3, 1 + rPx * 0.02) * t;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

const MIN_OUTLINE_PX = 6;

/**
 * Galaxies cross-fade between three representations of the SAME density field: a blurred blob, a baked
 * wash sprite, and live arms with stipple. Because all three derive from `armDensity`, and because the
 * band alphas sum to exactly 1, the transitions have nothing to morph.
 */
function drawGalaxy(frame: Frame, node: Node, sx: number, sy: number, rPx: number): void {
  const { ctx, stats } = frame;
  const traits = galaxyTraitsCached(node.id);

  for (const { rep, alpha } of activeReps('galaxy', rPx, frame.detailBias)) {
    ctx.globalAlpha = alpha;
    switch (rep) {
      case 'blob':
        if (!drawGalaxySprite(ctx, sx, sy, rPx, node.id, traits, true)) {
          drawGalaxyStandIn(ctx, sx, sy, rPx, traits);
        }
        break;
      case 'wash':
        if (!drawGalaxySprite(ctx, sx, sy, rPx, node.id, traits, false)) {
          drawGalaxyStandIn(ctx, sx, sy, rPx, traits);
        }
        break;
      case 'arms':
        drawGalaxyLive(ctx, sx, sy, rPx, traits);
        stats.draws++;
        break;
      case 'deep':
        // Deliberately nothing. See the note on this band in bands.ts: the sky and the catalogued stars
        // are the picture from in here, and the arm ribbons would only be a flat fill over them.
        break;
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * The viewport expressed in the enclosing galaxy's coordinates -- as a centre and a half-extent -- or
 * null if the camera is above galaxy level. Walks the focus lineage upwards accumulating child-to-parent
 * scale factors, so it works identically whether the galaxy is the focus node or six levels above it.
 */
function galaxyViewport(
  cam: Camera,
  tree: Tree,
  view: View,
): { id: number; nx: number; ny: number; halfW: number; halfH: number } | null {
  let node: Node | null = cam.node;
  let [nx, ny] = frameToNode(cam, cam.fx, cam.fy);
  // One unit of the current node, measured in units of whatever node we have climbed to.
  let unitScale = 1;

  for (let i = 0; i < 10 && node; i++) {
    if (node.kind === 'galaxy') {
      // Centre and half-extent, NOT two edges. By region depth the half-extent is about 2^-54 galaxy
      // units, so both edges round to the same double and their difference is exactly zero -- which is
      // how the sky ended up with a detail level of 1001 and hung the tab.
      const halfW = ((view.w / 2) / pxPerUnit(cam)) * 2 ** -cam.k * unitScale;
      const halfH = ((view.h / 2) / pxPerUnit(cam)) * 2 ** -cam.k * unitScale;
      return { id: node.id, nx, ny, halfW, halfH };
    }
    const ref = tree.refOf(node);
    const parent: Node | null = tree.parentOf(node);
    if (!ref || !parent) return null;
    [nx, ny] = childToParent(ref, nx, ny);
    unitScale *= ref.rel;
    node = parent;
  }
  return null;
}

/**
 * Daylight, once the enclosing planet is larger than the screen.
 *
 * Above this the planet is a body in space and its own disc is the picture. Below it you are inside the
 * atmosphere, and what fills the frame is sky -- so the galaxy's own glow, correct out in the void, has
 * to go. It fades in over the same range the planet's disc fades out, which is also the range over which
 * regions become the map.
 *
 * Returns whether anything was drawn.
 */
function drawGround(frame: Frame): boolean {
  const { ctx, view, sky } = frame;
  if (!sky || sky.groundAlpha < 0.01) return false;
  ctx.globalAlpha = sky.groundAlpha;
  ctx.fillStyle = css(sky.colour);
  ctx.fillRect(0, 0, view.w, view.h);
  // Everything overhead, once, before any ground: the terrain and the rooftops drawn after it are what occlude it.
  paintSky(ctx, sky, 0, view.w);
  ctx.globalAlpha = 1;
  return true;
}

/**
 * The sky over the world the camera is standing on, or null out in space.
 *
 * Everything a surface view needs about the heavens, worked out once: the time of day at the camera's own
 * angle round the rim, where the star and the moons sit, what colour the air is, and the SCREEN Y OF THE
 * HORIZON, which is what the whole stylised dome is hung from. The horizon comes from the focus node's own
 * ground line rather than from the middle of the screen, so the sky stays put when the camera rises.
 */
function buildSky(frame: Frame, cxF: number, cyF: number): Sky | null {
  const { cam, tree, view, r, diagonal } = frame;
  let node: Node | null = cam.node;
  let unitScale = 1;
  for (let i = 0; i < 10 && node; i++) {
    if (node.kind === 'planet') break;
    const ref = tree.refOf(node);
    const parent: Node | null = tree.parentOf(node);
    if (!ref || !parent) return null;
    unitScale *= ref.rel;
    node = parent;
  }
  if (!node || node.kind !== 'planet' || !node.ground) return null;

  // The planet's own radius on screen. `pxPerUnit` is per frame unit, and a frame is 2^-k of the focus node,
  // which is itself `unitScale` of the planet.
  const planetPx = (pxPerUnit(cam) * 2 ** cam.k) / unitScale;
  const groundAlpha = smoothstep(1.1 * diagonal, 2.4 * diagonal, planetPx);
  if (groundAlpha < 0.005) return null;

  const focus = cam.node.ground;
  const focusR = 2 ** cam.k * r;
  const focusSy = view.h / 2 + (cyF - cam.fy) * r;

  let theta: number;
  let horizonY: number;
  if (focus && cam.node.kind !== 'planet') {
    // A plate in focus is drawn unturned with its ground line across it, so the horizon is that line.
    theta = focus.theta;
    horizonY = focusSy - groundHeightAt(focus, 0, 14) * focusR;
  } else {
    /**
     * FOCUSED ON THE PLANET ITSELF, which is where most of the arrival happens: the disc has stopped drawing at
     * six screens across and no region takes focus for another two doublings.
     *
     * The camera's own angle round the rim is what decides the time of day here -- it used to be hard-coded to
     * zero, so through that whole stretch the sun sat wherever noon-at-longitude-nothing put it and then jumped
     * when a region finally took over. And the horizon is where the ground under the camera actually is, which
     * the scene rotation has just put directly below it: the camera stands `d` planet radii out and the ground
     * reaches `ground`, so the difference is how far down the screen the surface lies.
     */
    const [x, y] = frameToNode(cam, cam.fx, cam.fy);
    const d = Math.hypot(x, y);
    theta = d > 1e-6 ? Math.atan2(y, x) : 0;
    const ground = groundAt(node.id, node.ground.traits, theta, 14);
    horizonY = d > 0.25 ? view.h / 2 + (d - ground) * planetPx : view.h * 0.62;
  }

  const built = computeSky(node.id, node.ground.traits, theta, simTime(), view.w, view.h, horizonY);
  return { ...built, groundAlpha };
}

/**
 * The chemistry of the enclosing galaxy, and where in it you are.
 *
 * Metallicity is the one trait that legitimately spans a hundred billion stars, because it is chemistry rather
 * than culture, and it reaches all the way down to the colour of a single wall: a metal-poor rim world builds
 * in pale chalk and a core world in dark iron-stained stone. The radius fraction comes from the system's own
 * position in its galaxy, which is exactly the number the arm-density field placed it with.
 */
function oreFor(cam: Camera, tree: Tree): { hue: number; metallicity: number } {
  let node: Node | null = cam.node;
  let radiusFraction = 0.5;
  for (let i = 0; i < 10 && node; i++) {
    const parent: Node | null = tree.parentOf(node);
    if (!parent) break;
    if (parent.kind === 'galaxy') {
      const ref = tree.refOf(node);
      if (ref) radiusFraction = Math.min(1, Math.hypot(ref.ox, ref.oy));
      const field = metallicityOf(parent.id);
      return { hue: field.oreHue, metallicity: metallicityAt(field, radiusFraction) };
    }
    node = parent;
  }
  // Above galaxy level nothing is made of anything yet; a neutral chalk keeps the icons legible.
  return { hue: 30, metallicity: 0.4 };
}

const traitCache = new Map<number, GalaxyTraits>();

function galaxyTraitsCached(id: number): GalaxyTraits {
  let t = traitCache.get(id);
  if (!t) {
    t = galaxyTraits(id);
    if (traitCache.size > 512) traitCache.clear();
    traitCache.set(id, t);
  }
  return t;
}

/**
 * Two naming tiers. Cosmic objects carry the Almanac Office's catalogue names, because nobody lives in
 * a galaxy to name one and a catalogue is supposed to be consistent. An inhabited planet and everything
 * below it is named in that world's own language.
 */
export function displayName(node: Node, tree: Tree): string {
  const last = node.path[node.path.length - 1];
  const fallback = () => catalogName(node.kind, node.id, last ? last.cx + last.cy : 0);
  if (node.kind === 'field' || node.kind === 'cluster' || node.kind === 'galaxy' || node.kind === 'system') {
    return fallback();
  }
  const found = planetCultureFor(node, tree);
  if (!found || !found.culture.inhabited) {
    // An uninhabited world is a rock with a catalogue number, and so are its regions.
    return node.kind === 'planet' ? fallback() : `${fallback()}`;
  }
  switch (node.kind) {
    case 'planet':
      return found.culture.localName;
    case 'region':
      return regionName(found.culture, node.id);
    case 'settlement':
      return settlementName(found.culture, node.id);
    case 'building':
      return buildingName(found.culture, node.id).functional;
    default:
      return fallback();
  }
}

/** Topmost object under a screen point, from the list the renderer just built. */
/**
 * What is under a screen point: the DEEPEST thing whose grab radius contains it, and among equals the
 * NEAREST.
 *
 * Both halves matter. Deepest first, because a building inside a settlement is the more specific answer to
 * "what is this". Nearest among equals, because the grab radius is 15 px and small things pack much closer
 * than that -- this used to walk the list backwards and return the first match, so with a hundred galaxies
 * four pixels across, pointing at one of them returned whichever neighbour happened to be drawn later.
 * Aiming at a thing has to get you that thing.
 */
export function hitTest(hits: readonly HitEntry[], sx: number, sy: number): HitEntry | null {
  let best: HitEntry | null = null;
  let bestDepth = -1;
  let bestDist = Infinity;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const grab = Math.max(h.rPx, HIT_GRAB_PX);
    const dx = sx - h.xPx;
    const dy = sy - h.yPx;
    const d2 = dx * dx + dy * dy;
    if (d2 > grab * grab) continue;
    const depth = h.path.length;
    if (depth < bestDepth) continue;
    if (depth === bestDepth && d2 >= bestDist) continue;
    best = h;
    bestDepth = depth;
    bestDist = d2;
  }
  return best;
}

export { frameToNode };

/**
 * Ring and label under the cursor.
 *
 * Without it there is no way to tell that anything is a target: a planet in a system view is a four-pixel
 * dot, and "click to fly" in the hint bar does not help if you cannot see what is clickable.
 */
/**
 * The lock marker: crosshair arms reaching in towards the thing the view is following.
 *
 * Distinct from the hover reticle on purpose. Hover is a ring that pulses AROUND something, meaning "this
 * is a target"; the lock is four arms pointing IN at something dead centre, meaning "the view is holding
 * on to this". Nothing says so in words, because the behaviour says it: the marker sits still while the
 * rest of the sky slides past it.
 */
export function drawLock(ctx: CanvasRenderingContext2D, hit: HitEntry): void {
  const r = Math.max(hit.rPx, 13) + 8;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 209, 102, 0.85)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(hit.xPx + cos * (r + 13), hit.yPx + sin * (r + 13));
    ctx.lineTo(hit.xPx + cos * r, hit.yPx + sin * r);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawHover(ctx: CanvasRenderingContext2D, hit: HitEntry, pulse: number): void {
  const r = Math.max(hit.rPx, 11) + 4 + Math.sin(pulse * 3.2) * 1.4;
  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(255, 209, 102, 0.9)';
  ctx.beginPath();
  ctx.arc(hit.xPx, hit.yPx, r, 0, Math.PI * 2);
  ctx.stroke();

  // Four ticks rather than a solid second ring: it reads as a reticle, not as part of the object.
  ctx.strokeStyle = 'rgba(255, 209, 102, 0.55)';
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(hit.xPx + Math.cos(a) * (r + 3), hit.yPx + Math.sin(a) * (r + 3));
    ctx.lineTo(hit.xPx + Math.cos(a) * (r + 8), hit.yPx + Math.sin(a) * (r + 8));
    ctx.stroke();
  }

  ctx.restore();
}


/**
 * The scattered star under a screen point, found analytically rather than from the frame's hit list.
 *
 * A galaxy draws a few thousand catalogued systems. Recording them all as hit entries would allocate
 * thousands of objects per frame, and capping the list left most of the stars you could see unclickable
 * -- which is the difference between a map and a picture of one.
 */
export function scatterHitAt(
  cam: Camera,
  view: View,
  sx: number,
  sy: number,
  grabPx = HIT_GRAB_PX,
): HitEntry | null {
  const level = LEVELS[cam.node.kind];
  if (!level.child || level.placement !== 'scatter') return null;

  const r = pxPerUnit(cam);
  const nodeScale = 2 ** cam.k; // one node unit in frame units
  if (nodeScale * r < SCATTER_MIN_PARENT_PX) return null;

  // Screen point -> frame units -> node units.
  const fx = cam.fx + (sx - view.w / 2) / r;
  const fy = cam.fy + (sy - view.h / 2) / r;
  const [nx, ny] = frameToNode(cam, fx, fy);

  const ref = nearestScatter(cam.node, nx, ny);
  if (!ref) return null;

  const trueRPx = ref.rel * nodeScale * r;
  const drawn = systemStarRadius(ref.id, trueRPx, nodeScale * r);
  // The whole GLYPH is the target, not just the core: a star is drawn with a halo and, past a threshold,
  // a four-point sparkle spanning several times the core radius, and clicking the part of a star you can
  // plainly see has to hit it. `starGlyphRadius` is the extent the painter actually covers.
  const grab = Math.max(starGlyphRadius(drawn), grabPx);
  // Compare in pixels, so the grab radius means the same thing at every depth.
  const dxPx = (nx - ref.ox) * nodeScale * r;
  const dyPx = (ny - ref.oy) * nodeScale * r;
  if (dxPx * dxPx + dyPx * dyPx > grab * grab) return null;

  return {
    path: [...cam.node.path, ref.cell],
    kind: ref.kind,
    xPx: sx - dxPx,
    yPx: sy - dyPx,
    rPx: drawn,
    trueRPx,
  };
}
