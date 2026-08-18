import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { f01, hash, roll, sm32, stream } from '../src/core/rng.ts';
import { anchorCellAt, childAt, makeChild, rootNode, type Cell, type Node } from '../src/universe/node.ts';
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
  // make "what is under the camera" ambiguous.
  const tree = new Tree(0x2b2b);
  for (const kind of ['field', 'cluster', 'planet', 'settlement'] as const) {
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
  // would also break pickEnterableChild, which assumes containment.
  const tree = new Tree(0x9f9f);
  for (const kind of ['field', 'cluster', 'region', 'settlement'] as const) {
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
