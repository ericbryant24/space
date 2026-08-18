import { simTime } from '../core/clock.ts';
import { f01, fSym, hash, hash2, hash3, hash4, roll } from '../core/rng.ts';
import { armDensity, galaxyShape } from './gen/galaxyShape.ts';
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

  if (level.placement === 'orbits') {
    if (cell.cy !== 0) return null;
    return orbitalChild(node, cell.cx);
  }

  const k = anchorLevel(node.kind);
  const n = cellsPerAxis(k);
  if (!Number.isInteger(cell.cx) || !Number.isInteger(cell.cy)) return null;
  if (cell.cx < 0 || cell.cy < 0 || cell.cx >= n || cell.cy >= n) return null;

  const id = hash4(node.id, k, cell.cx, cell.cy);
  if (f01(hash2(id, 0x01)) >= level.density) return null;

  const half = 2 ** -k; // cell half-size in node units
  const centreX = -1 + (2 * cell.cx + 1) * half;
  const centreY = -1 + (2 * cell.cy + 1) * half;

  const logSpan = LEVELS[kind].logSpan + fSym(hash2(id, 0x02)) * level.sizeJitter;
  const rel = 2 ** (logSpan - node.logSpan);

  // Jitter inside the cell, but keep the child wholly within it so cells stay independent.
  const room = Math.max(0, half - rel);
  const ox = centreX + fSym(hash2(id, 0x03)) * room;
  const oy = centreY + fSym(hash2(id, 0x04)) * room;

  // A node's own extent is the unit DISC, but its anchor grid is a square, so the corners of that
  // square fall outside the parent. Children must live inside the parent they are drawn inside of.
  const dist = Math.hypot(ox, oy);
  if (dist + rel > 1) return null;

  // Thin the population towards the rim rather than stopping dead at it, so the edge reads as an
  // edge rather than as a crop.
  const edge = 1 - dist;
  if (edge < 0.12 && f01(hash2(id, 0x05)) > edge / 0.12) return null;

  // Inside a galaxy, stars exist where the galaxy is luminous. Uniform placement put real systems in
  // regions the art draws as empty -- the mirror image of scattering decorative dots that correspond
  // to nothing, and just as much of a lie.
  if (node.kind === 'galaxy') {
    const density = armDensity(galaxyShape(node.id), ox, oy);
    if (f01(hash2(id, 0x06)) > density * 0.92 + 0.02) return null;
  }

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

/**
 * How many bodies a system holds. Bounded and small, which is why orbital placement does not need the
 * cell grid that makes galaxies tractable.
 */
export function orbitCount(node: Node): number {
  if (LEVELS[node.kind].placement !== 'orbits') return 0;
  const r = f01(roll(node.id, 'planetCount'));
  // A plain skew towards low counts left a third of all systems holding a single planet, which reads
  // as broken rather than as sparse. Barren and single-planet systems still exist -- they are honest,
  // and variety needs them -- but most systems now carry a family worth flying through.
  if (r < 0.08) return 0;
  if (r < 0.16) return 1;
  return 2 + Math.floor(r * r * 8);
}

/**
 * The i-th body of an orbital system, at the CURRENT time.
 *
 * Position is a function of the clock, so orbits tick. That is safe for navigation because a path
 * identifies the body, not a location: once the camera is focused on a planet its coordinates are
 * relative to that planet, so the planet carries the camera with it. Approaching from the system view
 * you see it move, which is the point.
 */
export function orbitalChild(node: Node, index: number): ChildRef | null {
  const level = LEVELS[node.kind];
  const kind = level.child;
  if (!kind || level.placement !== 'orbits') return null;
  const count = orbitCount(node);
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;

  const id = hash3(node.id, 0x0121b, index);
  const logSpan = LEVELS[kind].logSpan + fSym(hash2(id, 0x02)) * level.sizeJitter;
  const rel = 2 ** (logSpan - node.logSpan);

  const radius = orbitRadius(index, count);
  // Kepler's third law, with the constant chosen so the innermost body takes about half a minute:
  // fast enough to notice, slow enough not to look frantic.
  const period = 24 * radius ** 1.5;
  const angle = f01(hash2(id, 0x07)) * Math.PI * 2 + (simTime() / period) * Math.PI * 2;

  return {
    cell: { cx: index, cy: 0 },
    id,
    kind,
    logSpan,
    ox: Math.cos(angle) * radius,
    oy: Math.sin(angle) * radius,
    rel,
  };
}

/** Orbital radius in parent units. A Titius-Bode-like progression: crowded inside, spread outside. */
export function orbitRadius(index: number, count: number): number {
  const frac = (index + 1) / (count + 0.6);
  return 0.13 + 0.79 * frac ** 1.35;
}

/** Every body of an orbital system, in order. At most nine, so building the list is cheap. */
export function orbitalChildren(node: Node): ChildRef[] {
  const out: ChildRef[] = [];
  const count = orbitCount(node);
  for (let i = 0; i < count; i++) {
    const ref = orbitalChild(node, i);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * The child nearest a point given in node units, whatever the placement mode. Used by navigation
 * helpers (dive, Tab) that want "something to go to near here" rather than "what is exactly here".
 */
export function childNear(node: Node, nx: number, ny: number, searchRings = 6): ChildRef | null {
  const level = LEVELS[node.kind];
  if (!level.child) return null;

  if (level.placement === 'orbits') {
    let best: ChildRef | null = null;
    let bestDist = Infinity;
    for (const ref of orbitalChildren(node)) {
      const d = (nx - ref.ox) ** 2 + (ny - ref.oy) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = ref;
      }
    }
    return best;
  }

  const here = anchorCellAt(node, nx, ny);
  const direct = childAt(node, here);
  if (direct) return direct;
  for (let ring = 1; ring <= searchRings; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const found = childAt(node, { cx: here.cx + dx, cy: here.cy + dy });
        if (found) return found;
      }
    }
  }
  return null;
}

/** Children near a point, for cycling through with Tab. Ordered and bounded. */
export function childrenNear(node: Node, nx: number, ny: number, limit = 24): ChildRef[] {
  const level = LEVELS[node.kind];
  if (!level.child) return [];
  if (level.placement === 'orbits') return orbitalChildren(node).slice(0, limit);

  const here = anchorCellAt(node, nx, ny);
  const out: ChildRef[] = [];
  for (let ring = 0; ring <= 4 && out.length < limit; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const found = childAt(node, { cx: here.cx + dx, cy: here.cy + dy });
        if (found) out.push(found);
      }
    }
  }
  return out;
}
