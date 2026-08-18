import { f01, fSym, hash } from '../core/rng.ts';
import { LEVELS, ROOT_KIND, anchorLevel, type Kind } from './schema.ts';

/** A child's address within its parent: the anchor-grid cell it occupies. */
export interface Cell {
  readonly cx: number;
  readonly cy: number;
}

export interface Node {
  readonly kind: Kind;
  readonly id: number;
  /** log2(radius in metres). Varies per node around its level's nominal value. */
  readonly logSpan: number;
  /** Anchor cell at each ancestor, root-first. Empty at the root. This IS the permalink. */
  readonly path: readonly Cell[];
}

/**
 * Everything needed to place and enter a child without building it: its centre in PARENT node
 * units, and `rel` = its radius in parent node units. Node local space is always [-1,1]^2, so a
 * node's radius is 1 in its own units and `rel` in its parent's.
 */
export interface ChildRef {
  readonly cell: Cell;
  readonly id: number;
  readonly kind: Kind;
  readonly logSpan: number;
  readonly ox: number;
  readonly oy: number;
  readonly rel: number;
}

export function rootNode(seed: number): Node {
  return { kind: ROOT_KIND, id: hash(0x5eed, seed), logSpan: LEVELS[ROOT_KIND].logSpan, path: [] };
}

export function cellsPerAxis(k: number): number {
  return 2 ** k;
}

/**
 * The child in a given anchor cell, or null if that cell is empty. O(1) — no siblings are built,
 * nothing is cached, and the answer is identical on every visit forever.
 */
export function childAt(node: Node, cell: Cell): ChildRef | null {
  const level = LEVELS[node.kind];
  const kind = level.child;
  if (!kind) return null;

  const k = anchorLevel(node.kind);
  const n = cellsPerAxis(k);
  if (!Number.isInteger(cell.cx) || !Number.isInteger(cell.cy)) return null;
  if (cell.cx < 0 || cell.cy < 0 || cell.cx >= n || cell.cy >= n) return null;

  const id = hash(node.id, k, cell.cx, cell.cy);
  if (f01(hash(id, 0x01)) >= level.density) return null;

  const half = 2 ** -k; // cell half-size in node units
  const centreX = -1 + (2 * cell.cx + 1) * half;
  const centreY = -1 + (2 * cell.cy + 1) * half;

  const logSpan = LEVELS[kind].logSpan + fSym(hash(id, 0x02)) * level.sizeJitter;
  const rel = 2 ** (logSpan - node.logSpan);

  // Jitter inside the cell, but keep the child wholly within it so cells stay independent.
  const room = Math.max(0, half - rel);
  const ox = centreX + fSym(hash(id, 0x03)) * room;
  const oy = centreY + fSym(hash(id, 0x04)) * room;

  // A node's own extent is the unit DISC, but its anchor grid is a square, so the corners of that
  // square fall outside the parent. Children must live inside the parent they are drawn inside of.
  const dist = Math.hypot(ox, oy);
  if (dist + rel > 1) return null;

  // Thin the population towards the rim rather than stopping dead at it, so the edge reads as an
  // edge rather than as a crop.
  const edge = 1 - dist;
  if (edge < 0.12 && f01(hash(id, 0x05)) > edge / 0.12) return null;

  // Copy the cell rather than retaining the caller's object. The renderer reuses one mutable cell
  // across its whole iteration for speed, and retaining it aliased every child's path to whichever
  // cell the loop last touched -- which silently corrupted node cache keys and made click-to-fly
  // resolve to an empty cell and do nothing.
  return { cell: { cx: cell.cx, cy: cell.cy }, id, kind, logSpan, ox, oy, rel };
}

export function makeChild(parent: Node, ref: ChildRef): Node {
  return { kind: ref.kind, id: ref.id, logSpan: ref.logSpan, path: [...parent.path, ref.cell] };
}

/** The anchor cell of `node`'s child grid that contains a point given in node units. */
export function anchorCellAt(node: Node, nx: number, ny: number): Cell {
  const k = anchorLevel(node.kind);
  const span = 2 ** (1 - k); // cell full width in node units
  return { cx: Math.floor((nx + 1) / span), cy: Math.floor((ny + 1) / span) };
}

export function pathKey(path: readonly Cell[]): string {
  let s = '';
  for (const c of path) s += `${c.cx},${c.cy}/`;
  return s;
}
