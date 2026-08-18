import { frameToNode, nodeToFrame, pxPerUnit, type Camera, type View } from '../camera/camera.ts';
import { childAt, makeChild, type Cell, type Node } from '../universe/node.ts';
import { LEVELS, anchorLevel, type Kind } from '../universe/schema.ts';
import type { Tree } from '../universe/tree.ts';

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
const MAX_DEPTH = 5;
const DRAW_BUDGET = 12000;
const CELL_BUDGET = 24000;
const LABEL_BUDGET = 90;
const LABEL_MIN_PX = 26;
const HIT_MIN_PX = 6;

export interface HitEntry {
  path: readonly Cell[];
  kind: Kind;
  xPx: number;
  yPx: number;
  rPx: number;
}

export interface RenderStats {
  draws: number;
  cells: number;
  labels: number;
  budgetHit: boolean;
  topKind: Kind;
  hits: HitEntry[];
}

/** Placeholder palette for M0. Real palettes arrive with the cosmic/surface split in M2 and M6. */
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
  stats: RenderStats;
}

export function render(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  tree: Tree,
  view: View,
): RenderStats {
  const r = pxPerUnit(cam);
  const stats: RenderStats = {
    draws: 0,
    cells: 0,
    labels: 0,
    budgetHit: false,
    topKind: cam.node.kind,
    hits: [],
  };
  const diagonal = Math.hypot(view.w, view.h);
  const frame: Frame = { ctx, cam, tree, view, r, diagonal, stats };

  ctx.fillStyle = '#080a12';
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

  paint(frame, node, centreX, centreY, scale, 0);
  return stats;
}

function paint(frame: Frame, node: Node, cxF: number, cyF: number, scale: number, depth: number): void {
  const { ctx, cam, view, r, stats } = frame;
  const rPx = scale * r;
  if (rPx < MIN_DRAW_PX) return;
  if (stats.draws >= DRAW_BUDGET) {
    stats.budgetHit = true;
    return;
  }

  const sx = view.w / 2 + (cxF - cam.fx) * r;
  const sy = view.h / 2 + (cyF - cam.fy) * r;
  if (sx + rPx < 0 || sy + rPx < 0 || sx - rPx > view.w || sy - rPx > view.h) return;

  const selfVisible = rPx <= MAX_SELF_DRAW_DIAGONALS * frame.diagonal;
  if (selfVisible) {
    drawDisc(frame, node, sx, sy, rPx);
    stats.draws++;

    if (rPx >= HIT_MIN_PX && stats.hits.length < 600) {
      stats.hits.push({ path: node.path, kind: node.kind, xPx: sx, yPx: sy, rPx });
    }
    if (rPx >= LABEL_MIN_PX && stats.labels < LABEL_BUDGET) {
      drawLabel(ctx, node, sx, sy, rPx);
      stats.labels++;
    }
  }

  const level = LEVELS[node.kind];
  if (!level.child || depth >= MAX_DEPTH) return;

  // Nominal child size decides whether iterating the anchor grid is worth anything at all. This is
  // what keeps traversal structurally bounded: at wide zooms we never touch the grid.
  const nominalRel = 2 ** (LEVELS[level.child].logSpan - node.logSpan);
  if (nominalRel * scale * r < MIN_CHILD_PX) return;

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

function drawDisc(frame: Frame, node: Node, sx: number, sy: number, rPx: number): void {
  const { ctx } = frame;
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

function drawLabel(ctx: CanvasRenderingContext2D, node: Node, sx: number, sy: number, rPx: number): void {
  const text = `${LEVELS[node.kind].label} ${node.path.map((c) => `${c.cx}.${c.cy}`).slice(-1).join('') || 'root'}`;
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
export function hitTest(hits: readonly HitEntry[], sx: number, sy: number): HitEntry | null {
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]!;
    const dx = sx - h.xPx;
    const dy = sy - h.yPx;
    if (dx * dx + dy * dy <= h.rPx * h.rPx) return h;
  }
  return null;
}

export { frameToNode };
