import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { f01, hash, hash1, hash2, hash3, hash4, roll, sm32, stream } from '../src/core/rng.ts';
import {
  anchorCellAt,
  childAt,
  makeChild,
  orbitCount,
  orbitalChildren,
  rimCells,
  rimChild,
  rootNode,
  type Cell,
  type Node,
} from '../src/universe/node.ts';
import { setSimTime } from '../src/core/clock.ts';
import { LEVELS, anchorLevel } from '../src/universe/schema.ts';
import { Tree } from '../src/universe/tree.ts';

/**
 * GOLDEN VALUES. These permanently define the universe: every shared permalink resolves through
 * them. Changing a number here silently relocates every place anyone has ever bookmarked, so treat a
 * failure as "the hash was altered", never as "the expectation is stale".
 */
test('hash primitives match their locked golden values', () => {
  assert.equal(sm32(0), 1684164658);
  assert.equal(sm32(1), 1580013426);
  assert.equal(sm32(123456789), 1939085726);
  assert.equal(hash(1, 2, 3), 2384164142);
  assert.equal(stream(12345, 'biome'), 3293625142);
  assert.equal(roll(12345, 'biome', 7), 3898721144);
  assert.equal(f01(hash(9)), 0.6928821802139282);
  assert.equal(rootNode(0).id, 1047088092);
});

test('the allocation-free hash variants are bit-identical to the variadic one', () => {
  // The fixed-arity forms exist purely to avoid the rest-parameter array allocation, which caused a
  // periodic 213 ms GC pause. If they ever diverge from hash(), the universe silently moves.
  for (let i = 0; i < 500; i++) {
    const a = i * 2654435761;
    const b = ~i * 40503;
    const c = i ^ 0x5bf03635;
    const d = (i << 7) | 1;
    assert.equal(hash1(a), hash(a), `hash1 diverged at ${i}`);
    assert.equal(hash2(a, b), hash(a, b), `hash2 diverged at ${i}`);
    assert.equal(hash3(a, b, c), hash(a, b, c), `hash3 diverged at ${i}`);
    assert.equal(hash4(a, b, c, d), hash(a, b, c, d), `hash4 diverged at ${i}`);
  }
});

test('the first child of the root is exactly where it has always been', () => {
  // Cell (0,0) is a corner of the anchor grid and therefore outside the root's unit disc.
  const corner = childAt(rootNode(0), { cx: 0, cy: 0 });
  assert.equal(corner, null, 'grid corners fall outside the parent disc and must stay empty');

  const child = childAt(rootNode(0), { cx: 0, cy: 3 });
  assert.ok(child, 'root cell (0,3) should hold a child');
  assert.equal(child.id, 3747659499);
  assert.equal(child.ox, -0.8261370436447826);
  assert.equal(child.oy, -0.05686236148582756);
  assert.equal(child.rel, 0.036949210420259324);
  assert.equal(child.logSpan, 75.24168734550476);
});

test('the anchor grid is populated but not crowded', () => {
  // Too sparse and the descent is mostly void; too dense and nothing reads as space between things.
  const root = rootNode(0);
  const n = 2 ** anchorLevel(root.kind);
  let occupied = 0;
  for (let cx = 0; cx < n; cx++) for (let cy = 0; cy < n; cy++) if (childAt(root, { cx, cy })) occupied++;
  const fraction = occupied / (n * n);
  assert.ok(fraction > 0.2 && fraction < 0.7, `root occupancy ${(fraction * 100).toFixed(1)}% is out of range`);
});

test('adding an unrelated named stream disturbs nothing', () => {
  // The whole point of named streams: a new trait must not reshuffle existing ones.
  const before = stream(999, 'roofPitch');
  const unrelated = stream(999, 'chimneyCount');
  assert.equal(stream(999, 'roofPitch'), before);
  assert.notEqual(unrelated, before);
});

test('named streams are independent of each other', () => {
  const names = ['biome', 'roofPitch', 'name', 'palette', 'motif', 'language'];
  const seen = new Map<number, string>();
  for (let id = 1; id < 400; id++) {
    for (const n of names) {
      const v = stream(id, n);
      const clash = seen.get(v);
      assert.equal(clash, undefined, `stream collision between ${n} and ${clash} at id ${id}`);
      seen.set(v, `${n}@${id}`);
    }
  }
});

test('a node is identical however it is reached', () => {
  // Generation order must not matter: no shared mutable state anywhere in the chain.
  const paths = samplePaths(0xa11ce, 40);
  const forward = new Tree(0xa11ce);
  const shuffled = new Tree(0xa11ce);

  const a = paths.map((p) => forward.resolve(p));
  const reversed = [...paths].reverse();
  const bReversed = reversed.map((p) => shuffled.resolve(p));
  const b = [...bReversed].reverse();

  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual(strip(a[i]!), strip(b[i]!), `path ${JSON.stringify(paths[i])} differed by order`);
  }
});

test('two trees with the same seed agree; different seeds do not', () => {
  const paths = samplePaths(7, 30);
  const one = new Tree(7);
  const two = new Tree(7);
  const other = new Tree(8);
  let differences = 0;
  for (const p of paths) {
    assert.deepEqual(strip(one.resolve(p)), strip(two.resolve(p)));
    if (JSON.stringify(strip(one.resolve(p))) !== JSON.stringify(strip(other.resolve(p)))) differences++;
  }
  assert.ok(differences > paths.length * 0.5, 'a different seed should produce a different universe');
});

test('children stay wholly inside their own anchor cell', () => {
  // Cells must be independent for O(1) lookup to be correct: a child spilling into a neighbour would
  // make "what is under the camera" ambiguous. Grid levels only -- rim levels tile a surface rather than
  // filling a square, and their invariant is the one asserted below.
  const tree = new Tree(0x2b2b);
  for (const kind of ['field', 'cluster'] as const) {
    const node = firstNodeOfKind(tree, kind);
    if (!node) continue;
    const k = anchorLevel(kind);
    const half = 2 ** -k;
    let checked = 0;
    for (let cx = 0; cx < 2 ** k && checked < 60; cx++) {
      for (let cy = 0; cy < 2 ** k && checked < 60; cy++) {
        const c = childAt(node, { cx, cy });
        if (!c) continue;
        checked++;
        const centreX = -1 + (2 * cx + 1) * half;
        const centreY = -1 + (2 * cy + 1) * half;
        assert.ok(
          Math.abs(c.ox - centreX) + c.rel <= half + 1e-12,
          `${kind} child at (${cx},${cy}) escapes its cell in x`,
        );
        assert.ok(
          Math.abs(c.oy - centreY) + c.rel <= half + 1e-12,
          `${kind} child at (${cx},${cy}) escapes its cell in y`,
        );
      }
    }
  }
});

test('children never escape their parent disc', () => {
  // The renderer draws a node as a disc, so a child outside that disc is a visible lie -- and it
  // would also break pickEnterableChild, which assumes containment. Grid levels only, for the reason above.
  const tree = new Tree(0x9f9f);
  for (const kind of ['field', 'cluster'] as const) {
    const node = firstNodeOfKind(tree, kind);
    if (!node) continue;
    const k = anchorLevel(kind);
    const n = 2 ** k;
    let checked = 0;
    for (let cx = 0; cx < n && checked < 400; cx++) {
      for (let cy = 0; cy < n && checked < 400; cy++) {
        const c = childAt(node, { cx, cy });
        if (!c) continue;
        checked++;
        assert.ok(
          Math.hypot(c.ox, c.oy) + c.rel <= 1 + 1e-12,
          `${kind} child at (${cx},${cy}) sticks out of its parent`,
        );
      }
    }
    assert.ok(checked > 0, `expected to find some ${kind} children to check`);
  }
});

/**
 * Rim children TILE their parent's surface, and the containment rule is different because the geometry is.
 *
 * A region straddles its planet's rim -- half of it is sky -- so "inside the parent's disc" is exactly the wrong
 * test there and the square-grid version of it rejected every region on every world. What has to hold instead is
 * that the slots meet with no gap and no overlap along the surface, because that is what makes the ground
 * continuous and what makes "which slot is under the camera" a floor division.
 */
test('rim children tile their parent surface exactly', () => {
  const tree = new Tree(0x71b0);
  for (const kind of ['planet', 'region', 'settlement'] as const) {
    const node = firstNodeOfKind(tree, kind);
    if (!node) continue;
    const count = rimCells(node);
    assert.ok(count >= 2 && Number.isInteger(Math.log2(count)), `${kind} has ${count} rim slots`);

    let prev: number | null = null;
    let checked = 0;
    for (let i = 0; i < Math.min(count, 200); i++) {
      const c = rimChild(node, i);
      assert.ok(c, `${kind} rim slot ${i} is empty; every stretch of ground is a real place`);
      checked++;
      // The slot's own half-width along the surface, which the child's radius has to match.
      const half = kind === 'planet' ? (Math.PI * Math.hypot(c.ox, c.oy)) / count : 1 / count;
      assert.ok(
        Math.abs(c.rel - half) < 1e-9 * Math.max(1, half),
        `${kind} slot ${i}: child radius ${c.rel} does not fill its slot ${half}`,
      );
      // Consecutive slots are exactly one slot apart along the surface, so they abut with nothing between.
      const along = kind === 'planet' ? Math.atan2(c.oy, c.ox) : c.ox;
      if (prev !== null && kind !== 'planet') {
        assert.ok(
          Math.abs(along - prev - 2 / count) < 1e-12,
          `${kind} slot ${i} is ${along - prev} from its neighbour, not ${2 / count}`,
        );
      }
      prev = along;
      // Below a planet a child sits ON the ground line, and the ground has to stay inside the frame.
      if (kind !== 'planet') assert.ok(Math.abs(c.oy) + c.rel <= 1 + 1e-12, `${kind} slot ${i} is off its parent`);
    }
    assert.ok(checked > 1, `expected to walk some ${kind} rim slots`);
  }
});

test('childAt does not retain the caller\'s cell object', () => {
  // The renderer reuses one mutable cell object for its whole traversal. If childAt keeps that
  // reference, every path it produces aliases the last cell visited: node cache keys collide and
  // click-to-fly resolves to an empty cell.
  const root = rootNode(0x5151);
  const scratch = { cx: 0, cy: 0 };
  const refs: { cx: number; cy: number }[] = [];
  const n = 2 ** anchorLevel(root.kind);
  for (let cx = 0; cx < n; cx++) {
    for (let cy = 0; cy < n; cy++) {
      scratch.cx = cx;
      scratch.cy = cy;
      const c = childAt(root, scratch);
      if (c) refs.push(c.cell);
    }
  }
  assert.ok(refs.length > 3, 'expected several children to compare');
  // Mutating the scratch object afterwards must not disturb anything already returned.
  scratch.cx = 999;
  scratch.cy = 999;
  const distinct = new Set(refs.map((c) => `${c.cx},${c.cy}`));
  assert.equal(distinct.size, refs.length, 'returned cells alias each other');
  assert.ok(!distinct.has('999,999'), 'a returned cell tracked the caller\'s mutation');
});

test('a node resolved from a rendered path is the node that was rendered', () => {
  // End-to-end version of the same bug: paths handed out by traversal must resolve back.
  const tree = new Tree(0x764a);
  const scratch = { cx: 0, cy: 0 };
  const n = 2 ** anchorLevel(tree.root.kind);
  let checked = 0;
  for (let cx = 0; cx < n && checked < 12; cx++) {
    for (let cy = 0; cy < n && checked < 12; cy++) {
      scratch.cx = cx;
      scratch.cy = cy;
      const ref = childAt(tree.root, scratch);
      if (!ref) continue;
      const built = makeChild(tree.root, ref);
      const resolved = tree.resolve(built.path);
      assert.ok(resolved, `path ${JSON.stringify(built.path)} failed to resolve`);
      assert.equal(resolved.id, built.id);
      checked++;
    }
  }
  assert.ok(checked > 0, 'expected to check some children');
});

test('anchorCellAt inverts the cell centre it names', () => {
  const node = rootNode(3);
  const k = anchorLevel(node.kind);
  const half = 2 ** -k;
  for (let i = 0; i < 50; i++) {
    const cx = i % 2 ** k;
    const cy = (i * 7) % 2 ** k;
    const centreX = -1 + (2 * cx + 1) * half;
    const centreY = -1 + (2 * cy + 1) * half;
    assert.deepEqual(anchorCellAt(node, centreX, centreY), { cx, cy });
  }
});

test('orbiting bodies are slow enough to point at', () => {
  // The bug this guards is a usability one, and it made the whole viewer feel broken: at the original
  // orbital constant the innermost planet crossed a system view at roughly 200 px/s, so a body drawn as
  // a four-pixel dot sat under the cursor for about a tenth of a second. Aiming at one was impossible.
  const tree = new Tree(0x51ace);
  // A synthetic system node is enough: only its id and logSpan matter to the orbit maths.
  const system: Node = { ...{ kind: 'system', id: 0x5157, parentId: 0, logSpan: LEVELS.system.logSpan, path: [{ cx: 1, cy: 1 }] }, ground: null };
  const count = orbitCount(system);
  assert.ok(count > 0, 'need a system with planets to measure');

  // A system framed at 256 px radius, which is how it appears when it is the focus.
  const systemRadiusPx = 256;
  let worstPxPerSecond = 0;
  for (const step of [0, 1]) {
    setSimTime(step);
    const positions = orbitalChildren(system).map((r) => ({ x: r.ox, y: r.oy }));
    if (step === 1) {
      setSimTime(0);
      const before = orbitalChildren(system).map((r) => ({ x: r.ox, y: r.oy }));
      for (let i = 0; i < positions.length; i++) {
        const d = Math.hypot(positions[i]!.x - before[i]!.x, positions[i]!.y - before[i]!.y);
        worstPxPerSecond = Math.max(worstPxPerSecond, d * systemRadiusPx);
      }
    }
  }
  setSimTime(0);
  console.log(`      fastest body crosses a framed system at ${worstPxPerSecond.toFixed(1)} px/s`);
  assert.ok(worstPxPerSecond > 0.5, 'orbits should visibly move; ambient motion is the point');
  assert.ok(worstPxPerSecond < 40, `${worstPxPerSecond.toFixed(1)} px/s is too fast to aim at`);
  assert.ok(tree.root.kind === 'field');
});

test('every level except the last has somewhere to go', () => {
  for (const [kind, level] of Object.entries(LEVELS)) {
    if (kind === 'building') {
      assert.equal(level.child, null);
      continue;
    }
    assert.ok(level.child, `${kind} must have a child kind`);
    assert.ok(level.logSpan > LEVELS[level.child!].logSpan, `${kind} must be larger than its child`);
    assert.ok(anchorLevel(kind as keyof typeof LEVELS) >= 1, `${kind} needs a usable anchor level`);
  }
});

function strip(n: Node | null) {
  return n === null ? null : { kind: n.kind, id: n.id, logSpan: n.logSpan, path: n.path.map((c) => [c.cx, c.cy]) };
}

/** Walk down from the root picking occupied cells, collecting paths of assorted depths. */
function samplePaths(seed: number, count: number): Cell[][] {
  const out: Cell[][] = [];
  const tree = new Tree(seed);
  let node = tree.root;
  const path: Cell[] = [];
  while (out.length < count) {
    const found = firstOccupiedCell(node);
    if (!found) break;
    path.push(found.cell);
    out.push([...path]);
    node = makeChild(node, found);
    if (!LEVELS[node.kind].child) {
      node = tree.root;
      path.length = 0;
    }
  }
  // Pad with shallow variations so the set is not one single lineage.
  for (let i = 0; out.length < count; i++) {
    const c = firstOccupiedCell(tree.root, i);
    if (!c) break;
    out.push([c.cell]);
  }
  return out;
}

function firstOccupiedCell(node: Node, skip = 0) {
  const k = anchorLevel(node.kind);
  const n = 2 ** k;
  let skipped = 0;
  for (let cx = 0; cx < Math.min(n, 64); cx++) {
    for (let cy = 0; cy < Math.min(n, 64); cy++) {
      const c = childAt(node, { cx, cy });
      if (c) {
        if (skipped++ < skip) continue;
        return c;
      }
    }
  }
  return null;
}

function firstNodeOfKind(tree: Tree, kind: keyof typeof LEVELS): Node | null {
  let node: Node = tree.root;
  for (let depth = 0; depth < 10; depth++) {
    if (node.kind === kind) return node;
    const c = firstOccupiedCell(node);
    if (!c) return null;
    node = makeChild(node, c);
  }
  return null;
}
