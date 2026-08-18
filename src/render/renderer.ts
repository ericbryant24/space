import { frameToNode, nodeToFrame, pxPerUnit, type Camera, type View } from '../camera/camera.ts';
import { catalogName } from '../cosmic/catalog.ts';
import {
  childAt,
  makeChild,
  nearestScatter,
  orbitCount,
  orbitRadius,
  orbitalChildren,
  scatterChildren,
  type Cell,
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
  drawContainer,
  drawStar,
  flushStarBatch,
  queueSystemStar,
  starGlyphRadius,
  systemStarRadius,
} from './draw/containers.ts';
import { PLANET_ICON_MIN_PX, drawOrbitRing, drawPlanetIcon, skyTone } from './draw/planet.ts';
import { drawRegion } from './draw/ground.ts';
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
const ANCESTOR_LIMIT_DIAGONALS = 64;
/** Past this the node's own silhouette is off-screen anyway; iterate its children but skip its disc. */
const MAX_SELF_DRAW_DIAGONALS = 2.5;
/**
 * A planet keeps drawing its own surface long past the general limit, because its regions do not become
 * areas until it is several screens across, and dropping the disc at 2.5 diagonals left a stretch of
 * bare sky in between.
 *
 * But not without limit. The illustration is built from shapes measured in planet radii -- a terminator
 * rect at 1.2r, ring ellipses out to 1.9r, a rim-light arc stroked at 0.045r -- and at forty thousand
 * pixels of radius those cost enough to take the tab down with them; zooming into certain planets
 * crashed the renderer outright. Past this limit the disc is one flat colour over the whole viewport
 * anyway, which is exactly what `drawGround` paints instead.
 */
const PLANET_MAX_DIAGONALS = 6;
const MAX_DEPTH = 5;
const DRAW_BUDGET = 12000;
const CELL_BUDGET = 24000;
const LABEL_BUDGET = 90;
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
const LABEL_MIN_PX = 26;
/** Anything at least this big on screen becomes a click target. */
const HIT_MIN_PX = 2.5;
/**
 * Minimum click radius. A galaxy seen from its cluster is about four pixels across, and a planet in a
 * system view is drawn at a four-pixel floor, so hit-testing against the drawn radius would make both
 * effectively unclickable -- and orbiting bodies are moving targets besides. Enlarging the target does
 * not create ambiguity: the hit list is walked backwards, and children are recorded after their parents,
 * so the deepest thing under the cursor still wins.
 */
const HIT_GRAB_PX = 15;
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
  region: 20,
  settlement: 6,
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
    hits: [],
  };
  beginSpriteFrame();
  const diagonal = Math.hypot(view.w, view.h);
  const frame: Frame = { ctx, cam, tree, view, r, diagonal, detailBias, lastDrawnRadius: 0, childAlpha: 1, scatterParentPx: 0, stats };

  ctx.fillStyle = css(voidBackgroundFor(cam.node, tree));
  ctx.fillRect(0, 0, view.w, view.h);

  // A zoom changes every pixel on screen, so there is no dirty-rect path anywhere: full clear, full
  // redraw, and the loop sleeps when nothing is moving.
  const [cxF, cyF] = nodeToFrame(cam, 0, 0);
  let node: Node = cam.node;
  let centreX = cxF;
  let centreY = cyF;
  let scale = 2 ** cam.k;

  // Climb towards the root so that siblings of the focus node are on screen too, stopping before an
  // ancestor grows so large that drawing it is pointless.
  const limit = ANCESTOR_LIMIT_DIAGONALS * diagonal;
  for (let i = 0; i < 12; i++) {
    const ref = tree.refOf(node);
    const parent = tree.parentOf(node);
    if (!ref || !parent) break;
    const parentScale = scale / ref.rel;
    if (parentScale * r > limit) break;
    centreX -= ref.ox * parentScale;
    centreY -= ref.oy * parentScale;
    scale = parentScale;
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
  // Standing on a world, the sky is not the galaxy: it is daylight. Painted over the glow rather than
  // instead of it, so the handover is a crossfade rather than a switch.
  if (drawGround(frame)) stats.draws++;

  paint(frame, node, centreX, centreY, scale, 0);
  stats.spritesPending = spritesPending();
  return stats;
}

/**
 * `schematic` marks a body drawn at a floor size rather than its true size -- an orbital diagram, where
 * a planet is genuinely a ten-thousandth of a pixel. Without threading it through, the minimum-size
 * cull discards the very thing a system view exists to show.
 */
function paint(
  frame: Frame,
  node: Node,
  cxF: number,
  cyF: number,
  scale: number,
  depth: number,
  schematic = false,
): void {
  const { ctx, cam, view, r, stats } = frame;
  const trueRPx = scale * r;
  const rPx = schematic ? Math.max(trueRPx, PLANET_ICON_MIN_PX) : trueRPx;
  if (rPx < MIN_DRAW_PX) return;
  if (stats.draws >= DRAW_BUDGET) {
    stats.budgetHit = true;
    return;
  }

  const sx = view.w / 2 + (cxF - cam.fx) * r;
  const sy = view.h / 2 + (cyF - cam.fy) * r;
  if (sx + rPx < 0 || sy + rPx < 0 || sx - rPx > view.w || sy - rPx > view.h) return;

  // A planet holds on to its own surface far longer than anything else, because its regions do not appear
  // until they are big enough to be areas -- see PLANET_MAX_DIAGONALS for both halves of that trade.
  const selfLimit = node.kind === 'planet' ? PLANET_MAX_DIAGONALS : MAX_SELF_DRAW_DIAGONALS;
  const selfVisible = rPx <= selfLimit * frame.diagonal;
  if (selfVisible) {
    frame.lastDrawnRadius = rPx;
    drawDisc(frame, node, sx, sy, rPx, trueRPx, schematic);
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
     * Orbital bodies are named at ANY size. A system holds under ten planets drawn as four-pixel dots on a
     * chart, and an unlabelled dot is the one thing on screen you cannot tell anything about -- naming them
     * is the whole difference between an orbital diagram and a scatter of pixels. Scattered stars are
     * excluded by the same test: there are a couple of thousand of those, and a couple of thousand names is
     * not a chart.
     */
    const orbital = schematic && frame.scatterParentPx === 0;
    if ((orbital || hitR >= LABEL_MIN_PX) && stats.labels < LABEL_BUDGET) {
      drawLabel(frame, node, sx, sy, hitR);
      stats.labels++;
    }
  }

  const level = LEVELS[node.kind];
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
      paint(frame, makeChild(node, ref), cxF + ref.ox * scale, cyF + ref.oy * scale, ref.rel * scale, depth + 1, true);
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
      paint(frame, makeChild(node, ref), cxF + ref.ox * scale, cyF + ref.oy * scale, ref.rel * scale, depth + 1, true);
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
      paint(
        frame,
        makeChild(node, ref),
        cxF + ref.ox * scale,
        cyF + ref.oy * scale,
        ref.rel * scale,
        depth + 1,
      );
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
  settlement: 1,
};

function drawDisc(
  frame: Frame,
  node: Node,
  sx: number,
  sy: number,
  rPx: number,
  trueRPx: number,
  schematic: boolean,
): void {
  const { ctx } = frame;

  if (node.kind === 'galaxy') {
    drawGalaxy(frame, node, sx, sy, rPx);
    return;
  }

  if (node.kind === 'planet') {
    const traits = node.ground?.traits;
    if (!traits) return;
    // Returns the radius actually drawn, which may be the schematic floor rather than the true size.
    frame.lastDrawnRadius = drawPlanetIcon(ctx, sx, sy, rPx, node.id, traits);
    return;
  }

  if (node.kind === 'region') {
    drawRegion(ctx, sx, sy, rPx, node);
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
    );
    if (node.kind === 'system') {
      // Rings first, so bodies sit on top of their own orbits.
      const palette = cosmicPaletteOf(node.id);
      for (let i = 0; i < orbitCount(node); i++) {
        drawOrbitRing(ctx, sx, sy, orbitRadius(i, orbitCount(node)) * rPx, palette.LIGHT);
      }
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
    nx = ref.ox + nx * ref.rel;
    ny = ref.oy + ny * ref.rel;
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
  const { ctx, cam, tree, view, diagonal } = frame;
  let node: Node | null = cam.node;
  // One unit of the current node measured in units of whatever node we have climbed to.
  let unitScale = 1;
  for (let i = 0; i < 10 && node; i++) {
    if (node.kind === 'planet') break;
    const ref = tree.refOf(node);
    const parent: Node | null = tree.parentOf(node);
    if (!ref || !parent) return false;
    unitScale *= ref.rel;
    node = parent;
  }
  if (!node || node.kind !== 'planet' || !node.ground) return false;
  const traits = node.ground.traits;

  // The planet's own radius on screen. `pxPerUnit` is per frame unit, and a frame is 2^-k of the focus
  // node, which is itself `unitScale` of the planet.
  const rPx = (pxPerUnit(cam) * 2 ** cam.k) / unitScale;
  const alpha = smoothstep(1.1 * diagonal, 2.4 * diagonal, rPx);
  if (alpha < 0.01) return false;

  ctx.globalAlpha = alpha;
  ctx.fillStyle = css(skyTone(traits));
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.globalAlpha = 1;
  return true;
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

/**
 * Richer label for the hover reticle. `displayName` alone gives an uninhabited planet its catalogue
 * ordinal -- a bare "I" -- which tells the reader nothing about what they are pointing at.
 */
export function hoverLabel(node: Node, tree: Tree): string {
  const name = displayName(node, tree);
  if (node.kind === 'planet') {
    const found = planetCultureFor(node, tree);
    if (found && !found.culture.inhabited) return `${name} · ${found.traits.label}`;
    if (found) return `${name} · ${found.traits.label}`;
  }
  if (node.kind === 'field' || node.kind === 'cluster' || node.kind === 'galaxy' || node.kind === 'system') {
    return name;
  }
  return `${name} · ${LEVELS[node.kind].label.toLowerCase()}`;
}

function drawLabel(frame: Frame, node: Node, sx: number, sy: number, rPx: number): void {
  const { ctx } = frame;
  const text = displayName(node, frame.tree);
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const y = sy + Math.min(rPx + 14, 40);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(8,10,18,0.85)';
  ctx.strokeText(text, sx, y);
  ctx.fillStyle = 'rgba(240,244,255,0.92)';
  ctx.fillText(text, sx, y);
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
export function drawLock(ctx: CanvasRenderingContext2D, hit: HitEntry, name: string): void {
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
  // Clear of the top arm, which reaches to r + 13.
  drawNameTag(ctx, name, hit.xPx, hit.yPx - r - 37, 1);
  ctx.restore();
}

export function drawHover(
  ctx: CanvasRenderingContext2D,
  hit: HitEntry,
  name: string,
  pulse: number,
): void {
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

  drawNameTag(ctx, name, hit.xPx, hit.yPx - r - 26, 0.35);
  ctx.restore();
}

/** A name on a rounded plate. The one piece of text the pointer is allowed to put on the canvas. */
function drawNameTag(
  ctx: CanvasRenderingContext2D,
  label: string,
  cx: number,
  top: number,
  edge: number,
): void {
  ctx.font = '700 12.5px Nunito, ui-sans-serif, system-ui, sans-serif';
  const w = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(10, 13, 24, 0.82)';
  roundRect(ctx, cx - w / 2 - 7, top, w + 14, 20, 10);
  ctx.fill();
  ctx.strokeStyle = `rgba(255, 209, 102, ${edge})`;
  ctx.lineWidth = 1;
  roundRect(ctx, cx - w / 2 - 7, top, w + 14, 20, 10);
  ctx.stroke();
  ctx.fillStyle = '#ffd166';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, top + 10.5);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
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
