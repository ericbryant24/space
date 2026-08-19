import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  COAST_DETAIL,
  PLACEMENT_DETAIL,
  RELIEF,
  detailForScale,
  groundAt,
  isLandAt,
  landFractionOf,
  seaRadiusOf,
} from '../src/culture/terrain.ts';
import {
  groundHeightAt,
  isInhabited,
  makeChild,
  rimCells,
  rimChild,
  rimChildren,
  type Node,
} from '../src/universe/node.ts';
import { LEVELS } from '../src/universe/schema.ts';
import { HABITABLE_THRESHOLD, planetTraits } from '../src/universe/gen/planet.ts';

const worlds_ = () => {
  const out = [];
  for (let i = 0; i < 60; i++) {
    const id = (i * 2654435761 + 12345) >>> 0;
    const sys = (i * 40503 + 7) >>> 0;
    out.push({ id, traits: planetTraits(id, sys, i % 5, 5) });
  }
  return out;
};

const planetNode = (id: number, traits: ReturnType<typeof planetTraits>): Node => ({
  kind: 'planet',
  id,
  parentId: 0,
  logSpan: LEVELS.planet.logSpan,
  path: [],
  ground: { planetId: id, traits, theta: 0, span: 1, baseRadius: 0 },
});

/**
 * THE PROMISE THIS FILE EXISTS FOR: the coastline you see from orbit is the coastline you land on.
 *
 * A planet traces its shore at a coarse detail level and a region samples the same field at a fine one, so the two
 * agree only if the extra octaves REFINE the boundary rather than move it. Getting this wrong would not crash
 * anything -- it would quietly mean a region drawn as ocean sitting inside a continent, which is the exact
 * inconsistency the field was built to remove.
 */
test('finer detail refines the coastline instead of moving it', () => {
  for (const { id, traits } of worlds_()) {
    const sea = seaRadiusOf(id, traits);
    let sampled = 0;
    let disagree = 0;
    let disagreeAwayFromShore = 0;

    for (let i = 0; i < 600; i++) {
      const theta = (i / 600) * Math.PI * 2;
      const coarse = groundAt(id, traits, theta, 7);
      const fine = groundAt(id, traits, theta, 22);
      sampled++;
      if (coarse > sea === fine > sea) continue;
      disagree++;
      // "Away from the shore" means the coarse view was confident. Ground the coarse field puts well above the
      // water must not turn into sea when the detail arrives, however fine it gets.
      if (Math.abs(coarse - sea) > RELIEF * 0.15) disagreeAwayFromShore++;
    }

    assert.equal(
      disagreeAwayFromShore,
      0,
      `planet ${id}: ${disagreeAwayFromShore} angles well away from the shore changed sides between detail 7 and 22`,
    );
    // Near the shore a flip is correct -- that is what added detail is for -- but it has to stay a fringe.
    assert.ok(
      disagree / sampled < 0.14,
      `planet ${id}: ${((100 * disagree) / sampled).toFixed(1)}% of the circumference changed sides, so the coast moved`,
    );
  }
});

/** Sea level is calibrated against the field, so `waterFraction` means what it says. */
test('a world is as wet as its traits claim', () => {
  let worst = 0;
  for (const { id, traits } of worlds_()) {
    const land = landFractionOf(id, traits);
    const expected = 1 - traits.waterFraction;
    worst = Math.max(worst, Math.abs(land - expected));
    assert.ok(
      Math.abs(land - expected) < 0.1,
      `planet ${id}: ${(100 * traits.waterFraction).toFixed(0)}% water should leave ` +
        `${(100 * expected).toFixed(0)}% land, traced ${(100 * land).toFixed(0)}%`,
    );
  }
  assert.ok(worst < 0.1, `worst land-fraction error ${worst.toFixed(3)}`);
});

/**
 * A world with no water and a world with no land are both legitimate, and neither has a shore anywhere on it.
 *
 * The sea radius is a quantile of the field rather than an assumed height, which is what makes the extremes fall
 * out honestly instead of drowning or drying every world -- the mistake the first version of this made.
 */
test('the extremes have no shore, and say which they are', () => {
  const { id, traits } = worlds_()[0]!;

  const dry = { ...traits, waterFraction: 0 };
  assert.equal(landFractionOf(id, dry), 1, 'a world with no water should be all land');
  for (let i = 0; i < 400; i++) {
    assert.ok(isLandAt(id, dry, (i / 400) * Math.PI * 2, 18), 'a world with no water has sea somewhere on it');
  }

  const drowned = { ...traits, waterFraction: 1 };
  assert.equal(landFractionOf(id, drowned), 0, 'a world with no land should be all sea');
  for (let i = 0; i < 400; i++) {
    assert.ok(!isLandAt(id, drowned, (i / 400) * Math.PI * 2, 18), 'a world with no land has ground above water');
  }
});

/**
 * The field is SELF-SIMILAR: the relief across a frame is the same fraction of that frame at every rung.
 *
 * This is the single number the whole rim design rests on, and it is the one that was wrong. At a persistence of
 * 0.68 -- picked to stop the old two-dimensional field looking flat -- slope grew by 1.36 per octave, so by
 * building zoom the ground swung five to forty frame-radii and the surface was simply not in the picture. Below 0.5
 * it converges the other way and a street is a ruled line. Only 0.5 holds across the whole descent.
 */
test('the ground is equally bumpy at every level of the ladder', () => {
  const spans = [
    ['region', 2 ** (LEVELS.region.logSpan - LEVELS.planet.logSpan)],
    ['settlement', 2 ** (LEVELS.settlement.logSpan - LEVELS.planet.logSpan)],
    ['building', 2 ** (LEVELS.building.logSpan - LEVELS.planet.logSpan)],
  ] as const;

  const medians: number[] = [];
  for (const [name, span] of spans) {
    const detail = Math.min(30, Math.round(Math.log2(1 / span)) + 8);
    const spread: number[] = [];
    for (const { id, traits } of worlds_().slice(0, 24)) {
      for (let t = 0; t < 6; t++) {
        const theta0 = (t / 6) * Math.PI * 2 + id * 1e-7;
        const base = groundAt(id, traits, theta0, detail);
        const v: number[] = [];
        for (let i = 0; i < 160; i++) {
          v.push((groundAt(id, traits, theta0 + (-1 + (2 * i) / 159) * span, detail) - base) / span);
        }
        v.sort((a, b) => a - b);
        spread.push(v[Math.floor(v.length * 0.95)]! - v[Math.floor(v.length * 0.05)]!);
      }
    }
    spread.sort((a, b) => a - b);
    const median = spread[Math.floor(spread.length / 2)]!;
    medians.push(median);
    // Wide enough to see, narrow enough to stay in frame. Both ends are a real failure of the picture.
    assert.ok(median > 0.06, `${name}: relief across a frame is ${median.toFixed(3)} radii -- a ruled line`);
    assert.ok(median < 0.9, `${name}: relief across a frame is ${median.toFixed(3)} radii -- off the top of the view`);
  }
  // And the same at every rung, not merely in range at each: that is what self-similar means.
  assert.ok(
    Math.max(...medians) / Math.min(...medians) < 2.2,
    `relief per frame varies ${(Math.max(...medians) / Math.min(...medians)).toFixed(2)}x across the ladder: ${medians
      .map((m) => m.toFixed(2))
      .join(', ')}`,
  );
});

test('detail rises with zoom, and both ends are bounded', () => {
  let last = -Infinity;
  for (let e = 0; e < 60; e += 1) {
    const d = detailForScale(2 ** e);
    assert.ok(Number.isFinite(d), `detail at 2^${e} px is not finite`);
    assert.ok(d >= last, 'detail must never fall as the view gets closer');
    last = d;
  }
  // A wildly small scale must not ask for a negative octave and index a lattice backwards.
  assert.ok(detailForScale(0) >= 0, 'detail must never go negative');
  assert.ok(detailForScale(1e-9) >= 0, 'detail must never go negative');
});

test('a sea radius is stable for a planet, whatever asks for it', () => {
  const { id, traits } = worlds_()[3]!;
  assert.equal(seaRadiusOf(id, traits), seaRadiusOf(id, traits), 'a cached sea radius must be the same number');
  // The cache is keyed on the water fraction too, so it cannot lie to a caller handing over modified traits.
  assert.notEqual(
    seaRadiusOf(id, traits),
    seaRadiusOf(id, { ...traits, waterFraction: Math.min(0.95, traits.waterFraction + 0.4) }),
    'a wetter world must have a higher water line',
  );
});

/**
 * NOTHING IS BUILT IN THE SEA.
 *
 * Every stretch of ground below a planet is a real place, including the sea bed -- refusing to generate ocean
 * regions left every ocean on every world as a gap in the ladder with bare sky where the water should be, which is
 * the same lie as a decorative dot told the other way round. What must never happen is a HOUSE under water, and
 * that is `isInhabited`'s job: it consults the same field the shore is drawn from, at a fixed detail level, so the
 * answer is a pure function of address and a house near the waterline does not blink as you approach it.
 */
test('nothing is inhabited below the waterline', () => {
  let checkedDry = 0;
  let checkedWet = 0;

  for (const { id, traits } of worlds_().slice(0, 12)) {
    const planet = planetNode(id, traits);
    const sea = seaRadiusOf(id, traits);

    for (const rref of rimChildren(planet).slice(0, 60)) {
      const region = makeChild(planet, rref);
      for (const sref of rimChildren(region)) {
        const sett = makeChild(region, sref);
        for (const bref of rimChildren(sett).slice(0, 8)) {
          const b = makeChild(sett, bref);
          const g = b.ground!;
          const wet = g.baseRadius <= sea;
          if (wet) {
            checkedWet++;
            assert.ok(!isInhabited(b), `a building on planet ${id} stands under water at radius ${g.baseRadius}`);
          } else {
            checkedDry++;
          }
        }
      }
    }
  }

  // The rule is worthless if the walk never found anything to check on either side of the shore.
  assert.ok(checkedWet > 200, `only ${checkedWet} submerged addresses examined`);
  assert.ok(checkedDry > 200, `only ${checkedDry} dry addresses examined`);
});

/**
 * And some of the dry ones ARE inhabited, or the rule above passes on an empty universe.
 *
 * On a HABITABLE world only. Nothing is built on a five-hundred-kelvin cinder however dry its ground is, which is
 * the second half of what `isInhabited` decides -- and the half that keeps houses off worlds with no culture, no
 * language and no name for themselves. Counting across all worlds instead measured the two rules multiplied
 * together and reported nine percent for a schema that says thirty-four.
 */
test('dry ground on a habitable world is settled at the density the schema claims', () => {
  let dry = 0;
  let built = 0;
  let worlds = 0;
  for (const { id, traits } of worlds_().slice(0, 40)) {
    if (traits.habitability < HABITABLE_THRESHOLD) continue;
    worlds++;
    const planet = planetNode(id, traits);
    const sea = seaRadiusOf(id, traits);
    for (const rref of rimChildren(planet).slice(0, 40)) {
      const region = makeChild(planet, rref);
      for (const sref of rimChildren(region)) {
        const sett = makeChild(region, sref);
        for (const bref of rimChildren(sett)) {
          const b = makeChild(sett, bref);
          if (b.ground!.baseRadius <= sea) continue;
          dry++;
          if (isInhabited(b)) built++;
        }
      }
    }
  }
  assert.ok(worlds >= 3, `only ${worlds} habitable worlds in the sample`);
  assert.ok(dry > 500, `only ${dry} dry building slots found`);
  const rate = built / dry;
  assert.ok(
    Math.abs(rate - LEVELS.settlement.density) < 0.06,
    `${(100 * rate).toFixed(1)}% of dry slots are built on; the schema says ${100 * LEVELS.settlement.density}%`,
  );
});

/** NOTHING IS BUILT ON A WORLD NOBODY COULD LIVE ON, however dry and however temperate the stretch of ground. */
test('an uninhabitable world has nothing built on it anywhere', () => {
  let checked = 0;
  for (const { id, traits } of worlds_()) {
    if (traits.habitability >= HABITABLE_THRESHOLD) continue;
    const planet = planetNode(id, traits);
    for (const rref of rimChildren(planet).slice(0, 12)) {
      const region = makeChild(planet, rref);
      assert.ok(!isInhabited(region), `a region on uninhabitable planet ${id} counts as inhabited`);
      for (const sref of rimChildren(region).slice(0, 6)) {
        const sett = makeChild(region, sref);
        checked++;
        assert.ok(!isInhabited(sett), `a settlement on uninhabitable planet ${id} counts as inhabited`);
      }
    }
  }
  assert.ok(checked > 200, `only ${checked} addresses on uninhabitable worlds examined`);
});

/**
 * The ground frame has to compose down the tree, or everything below a region is placed against the wrong patch.
 *
 * And it has to compose through a ROTATION now: a node's frame below a planet is turned so its own "up" is the
 * direction away from the planet's centre, which is different for every region. `theta` is what carries that.
 */
test('the ground frame composes down the tree', () => {
  const { id, traits } = worlds_()[5]!;
  const planet = planetNode(id, traits);
  const refs = rimChildren(planet);
  assert.ok(refs.length > 8, 'a planet should tile its rim with many regions');

  const rref = refs[7]!;
  const region = makeChild(planet, rref);
  const g = region.ground!;
  assert.equal(g.planetId, id, 'a region must belong to its own planet');
  assert.ok(Math.abs(g.span - rref.rel) < 1e-15, 'a region spans what its ref says');
  // Its origin sits ON the surface, at the ground radius for its own angle.
  assert.ok(
    Math.abs(g.baseRadius - groundAt(id, traits, g.theta, PLACEMENT_DETAIL)) < 1e-12,
    'a region does not sit on its own ground',
  );
  // And the ref's offset is that same point on the circle, in the planet's own coordinates.
  assert.ok(Math.abs(Math.hypot(rref.ox, rref.oy) - g.baseRadius) < 1e-12, 'a region is not on the rim');
  assert.ok(Math.abs(rref.spin - (g.theta + Math.PI / 2)) < 1e-12, 'a region is not turned to face outward');

  const sref = rimChildren(region)[3]!;
  const sett = makeChild(region, sref);
  const sg = sett.ground!;
  assert.ok(Math.abs(sg.span - g.span * sref.rel) < 1e-18, 'a settlement is scaled by its region');
  // Composition, stated as the arithmetic it is: local offset becomes an angle at the parent's own radius.
  assert.ok(
    Math.abs(sg.theta - (g.theta + (sref.ox * g.span) / g.baseRadius)) < 1e-15,
    'a settlement sits at the wrong angle within its region',
  );
  assert.ok(Math.abs(sref.spin - (sg.theta - g.theta)) < 1e-15, 'a settlement is not turned to match its own patch');
  // The ground line drawn on the settlement's plate passes through its own origin.
  assert.ok(
    Math.abs(groundHeightAt(sg, 0, PLACEMENT_DETAIL)) < 1e-9,
    'a settlement does not stand on the ground it draws',
  );
});

/** Slot counts stay bounded, or a planet's rim becomes a per-frame walk over millions of children. */
test('rim slot counts are powers of two and bounded', () => {
  const { id, traits } = worlds_()[2]!;
  const planet = planetNode(id, traits);
  let node: Node = planet;
  for (const kind of ['planet', 'region', 'settlement'] as const) {
    assert.equal(node.kind, kind);
    const count = rimCells(node);
    assert.ok(Number.isInteger(Math.log2(count)), `${kind} has ${count} slots, which is not a power of two`);
    assert.ok(count >= 2 && count <= 4096, `${kind} has ${count} slots`);
    const ref = rimChild(node, count >> 1);
    assert.ok(ref, `${kind} slot ${count >> 1} is empty`);
    node = makeChild(node, ref);
  }
});

test('the coarse geography a planet is drawn from is the one placement uses', () => {
  // Two different detail levels, one shore. If these disagreed, a planet would draw a coast where nothing stands.
  for (const { id, traits } of worlds_().slice(0, 20)) {
    const sea = seaRadiusOf(id, traits);
    let flips = 0;
    for (let i = 0; i < 512; i++) {
      const theta = (i / 512) * Math.PI * 2;
      if (groundAt(id, traits, theta, COAST_DETAIL) > sea !== groundAt(id, traits, theta, PLACEMENT_DETAIL) > sea) {
        flips++;
      }
    }
    assert.ok(flips / 512 < 0.09, `planet ${id}: ${((100 * flips) / 512).toFixed(1)}% of the shore moves with detail`);
  }
});
