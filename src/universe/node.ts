import { simTime } from '../core/clock.ts';
import { f01, fSym, hash, hash2, hash3, hash4, mix, roll } from '../core/rng.ts';
import { armDensity, galaxyShape } from './gen/galaxyShape.ts';
import { orbitRadius } from './orbits.ts';
import { KIND_ORDER, LEVELS, ROOT_KIND, anchorLevel, type Kind } from './schema.ts';
import { HABITABLE_THRESHOLD, planetTraits, type PlanetTraits } from './gen/planet.ts';
import { PLACEMENT_DETAIL, groundAt, seaRadiusOf } from '../culture/terrain.ts';

export { orbitRadius };

/** A child's address within its parent: the anchor-grid cell it occupies. */
export interface Cell {
  readonly cx: number;
  readonly cy: number;
}

export interface Node {
  readonly kind: Kind;
  readonly id: number;
  /**
   * The id of the node this one hangs off, or 0 at the root.
   *
   * A node's traits are a pure function of its own address, so almost nothing needs this -- but some facts belong
   * to a PARENT and are read from the child. Whether a town stands empty is one: it is a property of the town, and
   * the last rung of the descent is a single building inside that town, which has to know it or it would grow
   * windows and lit rooms again at the moment you arrived. Carried rather than looked up, because `makeChild` has
   * the parent in hand and the tree is not available to a pure function.
   */
  readonly parentId: number;
  /** log2(radius in metres). Varies per node around its level's nominal value. */
  readonly logSpan: number;
  /** Anchor cell at each ancestor, root-first. Empty at the root. This IS the permalink. */
  readonly path: readonly Cell[];
  /** Where this node sits on its planet, for a planet and everything below it. Null above. */
  readonly ground: Ground | null;
}

/**
 * A node's place on its planet's surface, carried down the tree.
 *
 * This is the heritage chain the design always called for, made concrete: a planet knows its own traits, and
 * every region, settlement and building below it knows where it stands in planet coordinates. Nothing has to
 * walk back up through the tree to find out, which matters because `childAt` -- the one function that decides
 * whether a child exists at all -- is pure and has no tree to walk. Carrying the frame is what lets it ask
 * whether the ground there is above water.
 */
export interface Ground {
  readonly planetId: number;
  readonly traits: PlanetTraits;
  /**
   * Angle around the planet's circumference where this node's centre sits. Meaningless for the planet itself,
   * which IS the circle.
   */
  readonly theta: number;
  /** Radius in planet units. One of this node's own local units is this many planet units. */
  readonly span: number;
  /**
   * Radius, in planet units, that this node's local origin sits at -- so a region straddles the ground line
   * rather than hovering over it. Zero for the planet, whose origin is its centre.
   *
   * Stored rather than recomputed, and computed at PLACEMENT_DETAIL, so that the frame a settlement is placed
   * in is the same frame the painter draws the ground line in. Recomputing it at the current zoom would drift
   * the two apart and float every building off the surface.
   */
  readonly baseRadius: number;
}

/**
 * The angle of a point at local horizontal offset `u` within a node's frame.
 *
 * Below the planet the arc is short enough to treat as straight -- a region spans a two-hundred-and-fiftieth of
 * the circumference -- so local horizontal is arc length, and dividing by the radius converts it to an angle.
 */
export function angleAtOffset(g: Ground, u: number): number {
  return g.theta + (u * g.span) / Math.max(1e-9, g.baseRadius);
}

/** Where the ground line crosses this node's frame, in local units, at local horizontal offset `u`. */
export function groundHeightAt(g: Ground, u: number, detail: number): number {
  const r = groundAt(g.planetId, g.traits, angleAtOffset(g, u), detail);
  return (r - g.baseRadius) / g.span;
}

/** Where the water line crosses this node's frame, in local units. Below the ground line means dry. */
export function seaHeightOf(g: Ground): number {
  return (seaRadiusOf(g.planetId, g.traits) - g.baseRadius) / g.span;
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
  /**
   * Rotation, in radians, from the child's own frame into its parent's. Zero everywhere except below a planet.
   *
   * THIS IS THE ONE PLACE THE PROJECT HAS A ROTATION, and it is not decoration: on a two-dimensional world the
   * surface is the planet's circumference, so a region's "up" is the direction away from the planet's centre --
   * which points somewhere different for every region. Without this, a region on the left of a planet was drawn
   * with its ground line horizontal while its frame sat on a vertical stretch of rim, so plates met at angles
   * and the ground broke at every seam.
   *
   * It composes exactly like `ox`/`oy`/`rel` do, through `enterChild` and `ascend` and the renderer's climb, so
   * entering a region and leaving it again lands the camera precisely where it started and the whole scene turns
   * with it. Rotation is also the one transform that leaves screen-space line widths alone, which is why it can
   * be handed to the canvas without breaking the art direction.
   */
  readonly spin: number;
  /**
   * For a rim child: the angle round the planet it stands at, and the ground radius there.
   *
   * Carried rather than recomputed. `rimChild` works both out to place the slot and then threw them away, and
   * `groundFor` immediately sampled the same field at the same angle and the same detail to fill in the child's
   * frame -- sixteen octaves, five microseconds, for a number that was already in hand. A region plate builds
   * thirty-two of these a frame and a settlement sixty.
   */
  readonly theta: number;
  readonly baseRadius: number;
}

export function rootNode(seed: number): Node {
  return { kind: ROOT_KIND, id: hash(0x5eed, seed), parentId: 0, logSpan: LEVELS[ROOT_KIND].logSpan, path: [], ground: null };
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
  if (level.placement === 'scatter') {
    if (cell.cy !== 0) return null;
    return scatterChild(node, cell.cx);
  }
  if (level.placement === 'rim') {
    if (cell.cy !== 0) return null;
    return rimChild(node, cell.cx);
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
  return { cell: { cx: cell.cx, cy: cell.cy }, id, kind, logSpan, ox, oy, rel, spin: 0, theta: 0, baseRadius: 0 };
}

export function makeChild(parent: Node, ref: ChildRef): Node {
  return {
    kind: ref.kind,
    id: ref.id,
    parentId: parent.id,
    logSpan: ref.logSpan,
    path: [...parent.path, ref.cell],
    ground: groundFor(parent, ref),
  };
}

/**
 * The child's place on its planet.
 *
 * A planet starts the chain -- it IS its own coordinate system, so its frame is the unit disc, and its traits
 * come from its star and its orbit, both of which are the parent system's business. Below that the frame is
 * simple composition: the child sits at the parent's centre plus its own offset scaled by the parent's span.
 */
function groundFor(parent: Node, ref: ChildRef): Ground | null {
  if (ref.kind === 'planet') {
    const index = ref.cell.cx;
    const count = Math.max(1, orbitCount(parent));
    return {
      planetId: ref.id,
      traits: planetTraits(ref.id, parent.id, index, count),
      theta: 0,
      span: 1,
      // A planet's local origin is its own centre, which on a 2D world is the one place nothing lives.
      baseRadius: 0,
    };
  }
  const g = parent.ground;
  if (!g) return null;
  // A rim child already knows both, because placing it required them; anything else is a cell or an orbit, whose
  // frame is its parent's turned by nothing and standing on nothing.
  const theta = ref.baseRadius > 0 ? ref.theta : angleAtOffset(g, ref.ox);
  return {
    planetId: g.planetId,
    traits: g.traits,
    theta,
    span: g.span * ref.rel,
    // The child's origin sits on the ground line, which is where `rimChild` put it.
    baseRadius: ref.baseRadius > 0 ? ref.baseRadius : groundAt(g.planetId, g.traits, theta, PLACEMENT_DETAIL),
  };
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
  /**
   * Kepler's third law. The constant was 24, which gave the innermost body an orbit of about four
   * seconds -- roughly 200 px per second across a system view. At that speed a planet drawn as a
   * four-pixel dot is under the cursor for a tenth of a second, so aiming at one was impossible and
   * scrolling toward one never hit it. Ambient motion has to be slow enough to point at.
   *
   * At 360 the innermost orbit takes about ninety seconds and the outermost about six minutes: plainly
   * moving if you watch for a few seconds, and steady enough to aim at.
   */
  const period = 360 * radius ** 1.5;
  const angle = f01(hash2(id, 0x07)) * Math.PI * 2 + (simTime() / period) * Math.PI * 2;

  return {
    cell: { cx: index, cy: 0 },
    id,
    kind,
    logSpan,
    ox: Math.cos(angle) * radius,
    oy: Math.sin(angle) * radius,
    rel,
    spin: 0,
    theta: 0,
    baseRadius: 0,
  };
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
 * RIM PLACEMENT: children stand ON their parent's surface.
 *
 * A two-dimensional planet is a disc of rock whose surface is its circumference, so its children are arcs of
 * that circumference rather than patches of its face -- and below the planet the frame has already been turned
 * edge on, so a child is a stretch of the ground line running left to right across it. Both are the same
 * one-dimensional address: a slot index along the parent's surface.
 *
 * This is what replaced a square anchor grid over the planet's disc. That grid put regions in the middle of a
 * planet, which is mantle, and it only worked at all because the terrain was a map projection -- flat art of a
 * round world rather than a genuinely flat one.
 */

/**
 * How many slots a rim level divides its surface into. Always a power of two.
 *
 * A power of two keeps the slot boundaries exact in float64 and makes "which slot is under the camera" the same
 * floor division the cell grid uses, so rim placement inherits the O(1) spatial query rather than needing its
 * own. The target width is a fixed multiple of the child's own radius, which is what `spacing` means everywhere.
 */
export function rimCells(node: Node): number {
  const level = LEVELS[node.kind];
  const kind = level.child;
  if (!kind || level.placement !== 'rim') return 0;
  const rel = 2 ** (LEVELS[kind].logSpan - node.logSpan);
  // A planet's surface is a whole turn of angle; below it, a frame is two local units of ground line wide.
  const surface = node.kind === 'planet' ? Math.PI * 2 : 2;
  const want = surface / Math.max(1e-12, 2 * rel * level.spacing);
  return 2 ** Math.max(1, Math.min(24, Math.round(Math.log2(want))));
}

/**
 * The id a rim slot will have, without building the child.
 *
 * Exported because the painter needs it: a settlement seen from its region draws its own building slots before any
 * of them is a node, and everything about how one looks -- its roof, its storeys, whether its windows are lit --
 * hangs off this id. Two copies of the expression would mean every house on a horizon changed the moment you got
 * close enough for it to become real.
 */
export function rimSlotId(node: Node, index: number): number {
  return hash3(node.id, 0x21b0, index);
}

/**
 * Whether the hash says a slot is lived in, without building the child.
 *
 * The other half of `isInhabited`, split out for the same reason. What is left there is the pair of terrain
 * questions -- is this above water, is the world habitable at all -- which cost a field sample and are not asked
 * of the thousands of slots a region plate can see at once.
 */
export function slotIsSettled(id: number, parentKind: Kind): boolean {
  return f01(hash2(id, 0x01)) < LEVELS[parentKind].density;
}

/** Which rim slot a point in node units falls in. */
export function rimCellAt(node: Node, nx: number, ny: number): number {
  const count = rimCells(node);
  if (count === 0) return 0;
  // On the planet the surface coordinate IS the angle; below it, it is the local horizontal.
  const u = node.kind === 'planet' ? Math.atan2(ny, nx) / Math.PI : nx;
  return Math.max(0, Math.min(count - 1, Math.floor(((u + 1) / 2) * count)));
}

/**
 * The child in a rim slot, or null if that slot is empty -- which includes every slot whose ground is under
 * water. NOTHING IS BUILT IN THE SEA, and this is the one place that rule is enforced: placement asks the same
 * field the surface is drawn from, at a fixed detail level, so the answer is a pure function of address.
 */
export function rimChild(node: Node, index: number): ChildRef | null {
  const level = LEVELS[node.kind];
  const kind = level.child;
  if (!kind || level.placement !== 'rim') return null;
  const g = node.ground;
  if (!g) return null;
  const count = rimCells(node);
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;

  /**
   * No density roll and no size jitter: rim slots TILE, so every one holds a child, each sits at its slot's centre,
   * and each is exactly as wide as its slot. `density` describes how many are INHABITED -- see `isInhabited`.
   *
   * The size is DERIVED from the slot rather than taken from the level's nominal `logSpan`, and that is what makes
   * the tiling exact. The nominal only decides how many slots there are, and the count is rounded to a power of
   * two, so a child sized from the nominal comes out up to 40% narrower or wider than the slot it occupies --
   * which left hairline gaps of bare parent between plates wherever it came out narrow. A level's logSpan was
   * always a pacing knob rather than physics (see schema.ts), and here the pacing is what picks the slot count.
   */
  const id = rimSlotId(node, index);
  const u = -1 + ((index + 0.5) * 2) / count;
  const onPlanet = node.kind === 'planet';
  const theta = onPlanet ? u * Math.PI : angleAtOffset(g, u);
  const ground = groundAt(g.planetId, g.traits, theta, PLACEMENT_DETAIL);
  // On the planet a slot is an ARC, so the child's radius is that arc's half-length at the ground it stands on.
  const rel = onPlanet ? (Math.PI * ground) / count : 1 / count;
  const logSpan = node.logSpan + Math.log2(rel);

  /**
   * Node space has y pointing DOWN, the way the screen does, so a child standing higher than its parent's
   * origin sits at NEGATIVE oy. On the planet there is no flip to make: the child is simply at the point on the
   * circle, and `theta` is measured in that same y-down space throughout.
   */
  const ox = onPlanet ? Math.cos(theta) * ground : u;
  const oy = onPlanet ? Math.sin(theta) * ground : -(ground - g.baseRadius) / g.span;

  /**
   * The child's frame, turned so its own "up" is away from the planet's centre.
   *
   * On the planet that is a big rotation and different for every region -- a region a quarter of the way round
   * is drawn on its side relative to the planet's own axes. Below the planet it is the small difference between
   * two angles, which is what keeps a settlement's ground line continuous with its region's.
   */
  const spin = onPlanet ? theta + Math.PI / 2 : theta - g.theta;

  /**
   * A region STRADDLES its planet's rim -- half of it is sky -- so the containment test that keeps cell
   * children inside their parent's disc is exactly wrong here and is not applied on the planet. Below the
   * planet it still is: a slot whose ground has climbed clean out of the frame is a cliff face, and putting a
   * town in one would leave it floating in a corner with nothing under it.
   */
  if (!onPlanet && Math.abs(oy) + rel > 1) return null;

  return { cell: { cx: index, cy: 0 }, id, kind, logSpan, ox, oy, rel, spin, theta, baseRadius: ground };
}

/**
 * Whether anything is BUILT on this stretch of ground.
 *
 * Two conditions, and they are the two halves of the promise the project is built on. Nothing stands in the sea,
 * which is why this asks the same terrain field that drew the shore -- at a fixed detail level, so the answer is a
 * pure function of address and a house near the waterline does not blink in and out as you approach it. And only
 * `density` of the dry stretches are settled at all, because a world of continuous city is not a world.
 */
export function isInhabited(node: Node): boolean {
  const g = node.ground;
  if (!g || node.kind === 'planet') return false;
  // Nobody lives on a five-hundred-kelvin cinder or a frozen rock. Without this, houses appeared on worlds
  // with no culture, no language and no name for themselves -- which is the one inconsistency the whole
  // heritage chain exists to prevent.
  if (g.traits.habitability < HABITABLE_THRESHOLD) return false;
  if (g.baseRadius <= seaRadiusOf(g.planetId, g.traits)) return false;
  const parentKind = KIND_ORDER[Math.max(0, KIND_ORDER.indexOf(node.kind) - 1)]!;
  return slotIsSettled(node.id, parentKind);
}

const rimCache = new Map<number, ChildRef[]>();

/**
 * Every child along a parent's surface, cached.
 *
 * Positions are time-independent, and each entry costs a terrain sample at placement detail, so a planet's
 * thousand slots are worth computing once rather than once per frame.
 */
export function rimChildren(node: Node): ChildRef[] {
  const hit = rimCache.get(node.id);
  if (hit) return hit;
  const out: ChildRef[] = [];
  const count = rimCells(node);
  for (let i = 0; i < count; i++) {
    const ref = rimChild(node, i);
    if (ref) out.push(ref);
  }
  if (rimCache.size > 64) rimCache.clear();
  rimCache.set(node.id, out);
  return out;
}

/** The rim child nearest a point in node units, searching outwards from the slot the point is in. */
export function nearestRim(node: Node, nx: number, ny: number, searchSlots = 24): ChildRef | null {
  const count = rimCells(node);
  if (count === 0) return null;
  const here = rimCellAt(node, nx, ny);
  const wraps = node.kind === 'planet';
  for (let d = 0; d <= searchSlots; d++) {
    for (const i of d === 0 ? [here] : [here - d, here + d]) {
      // The planet's surface closes on itself, so its slots wrap; a frame below it has two real ends.
      const j = wraps ? ((i % count) + count) % count : i;
      if (j < 0 || j >= count) continue;
      const ref = rimChild(node, j);
      if (ref) return ref;
    }
  }
  return null;
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
  if (level.placement === 'scatter') return nearestScatter(node, nx, ny);
  if (level.placement === 'rim') return nearestRim(node, nx, ny, searchRings * 4);

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
  if (level.placement === 'scatter') {
    // Nearest first, so Tab tours the stars around you rather than the galaxy's index order. Sorting a
    // COPY: the list itself is cached and shared with the renderer.
    const all = scatterChildren(node).slice();
    all.sort((a, b) => (nx - a.ox) ** 2 + (ny - a.oy) ** 2 - ((nx - b.ox) ** 2 + (ny - b.oy) ** 2));
    return all.slice(0, limit);
  }
  if (level.placement === 'rim') {
    const all = rimChildren(node).slice();
    all.sort((a, b) => (nx - a.ox) ** 2 + (ny - a.oy) ** 2 - ((nx - b.ox) ** 2 + (ny - b.oy) ** 2));
    return all.slice(0, limit);
  }

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

/**
 * How many systems a galaxy has catalogued. Bounded and a few thousand: the number of stars you could
 * plausibly pick out and travel to, not the hundred billion that are actually there.
 */
export function scatterCount(node: Node): number {
  if (LEVELS[node.kind].placement !== 'scatter') return 0;
  return galaxyShape(node.id).starCount;
}

/**
 * The i-th catalogued system of a galaxy, at a fixed position drawn from the galaxy's own density field.
 *
 * Rejection sampling against `armDensity` is what makes the stars sit in the arms rather than in a
 * uniform smear, and it is the same field the arms and the diffuse glow are drawn from -- so the stars
 * you can travel to are exactly where the galaxy looks bright.
 */
export function scatterChild(node: Node, index: number): ChildRef | null {
  const level = LEVELS[node.kind];
  const kind = level.child;
  if (!kind || level.placement !== 'scatter') return null;
  if (!Number.isInteger(index) || index < 0 || index >= scatterCount(node)) return null;

  const shape = galaxyShape(node.id);
  const id = hash3(node.id, 0x57a2, index);

  // Rejection-sample a position inside the unit disc, weighted by arm density. Bounded attempts, then
  // fall back to the core, which is dense in every morphology -- so a ref is always produced.
  let ox: number | null = null;
  let oy = 0;
  for (let attempt = 0; attempt < 10 && ox === null; attempt++) {
    const h = hash2(id, attempt);
    const x = fSym(h) * 0.97;
    const y = fSym(mix(h, 1)) * 0.97;
    if (x * x + y * y > 0.94) continue;
    if (f01(mix(h, 2)) <= armDensity(shape, x, y)) {
      ox = x;
      oy = y;
    }
  }
  if (ox === null) {
    // Somewhere in the core, which is dense in every morphology. The alternative -- returning null --
    // would leave holes in an ordered list whose indices are permalinks.
    const h = hash2(id, 0x0fa11);
    const a = f01(h) * Math.PI * 2;
    const rad = shape.coreRadius * f01(mix(h, 1));
    ox = Math.cos(a) * rad;
    oy = Math.sin(a) * rad;
  }

  const logSpan = LEVELS[kind].logSpan + fSym(hash2(id, 0x02)) * level.sizeJitter;
  return {
    cell: { cx: index, cy: 0 },
    id,
    kind,
    logSpan,
    ox,
    oy,
    rel: 2 ** (logSpan - node.logSpan),
    spin: 0,
    theta: 0,
    baseRadius: 0,
  };
}

/**
 * Every catalogued system of a galaxy, cached.
 *
 * Positions are fixed and time-independent, so this is computed once per galaxy rather than per frame.
 * Rebuilding it each frame cost 13 ms: a few thousand children, each rejection-sampling against
 * `armDensity` up to twenty times.
 */
const scatterCache = new Map<number, ChildRef[]>();

export function scatterChildren(node: Node): ChildRef[] {
  const hit = scatterCache.get(node.id);
  if (hit) return hit;

  const out: ChildRef[] = [];
  const count = scatterCount(node);
  for (let i = 0; i < count; i++) {
    const ref = scatterChild(node, i);
    if (ref) out.push(ref);
  }
  // Only a handful of galaxies are ever in play at once, and each list is a few thousand small objects.
  if (scatterCache.size > 6) scatterCache.clear();
  scatterCache.set(node.id, out);
  return out;
}

/** The scattered child nearest a point, in node units. Linear over a few thousand: still trivial. */
export function nearestScatter(node: Node, nx: number, ny: number): ChildRef | null {
  let best: ChildRef | null = null;
  let bestDist = Infinity;
  for (const ref of scatterChildren(node)) {
    const d = (nx - ref.ox) ** 2 + (ny - ref.oy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = ref;
    }
  }
  return best;
}
