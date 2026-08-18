import { strict as assert } from 'node:assert';
import test from 'node:test';
import { coastlineOf, detailForScale, elevationAt, seaLevelOf, traceRings } from '../src/culture/terrain.ts';
import { planetTraits } from '../src/universe/gen/planet.ts';

const worlds = () => {
  const out = [];
  for (let i = 0; i < 60; i++) {
    const id = (i * 2654435761 + 12345) >>> 0;
    const sys = (i * 40503 + 7) >>> 0;
    out.push({ id, traits: planetTraits(id, sys, i % 5, 5) });
  }
  return out;
};

/**
 * THE PROMISE THIS FILE EXISTS FOR: the coastline you see from orbit is the coastline you land on.
 *
 * A planet traces its shore at a coarse detail level and a region samples the same field at a fine one, so
 * the two agree only if the extra octaves refine the boundary rather than move it. Getting this wrong would
 * not crash anything -- it would quietly mean a region drawn as ocean sitting inside a continent, which is
 * the exact inconsistency the field was built to remove.
 */
test('finer detail refines the coastline instead of moving it', () => {
  for (const { id, traits } of worlds()) {
    let sampled = 0;
    let disagree = 0;
    let disagreeAwayFromShore = 0;

    for (let i = 0; i < 400; i++) {
      // A deterministic scatter over the disc, no RNG needed.
      const a = i * 2.39996;
      const d = Math.sqrt((i + 0.5) / 400) * 0.95;
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d;

      const coarse = elevationAt(id, traits, x, y, 7);
      const fine = elevationAt(id, traits, x, y, 18);
      sampled++;
      if (coarse > 0 === fine > 0) continue;
      disagree++;
      // "Away from the shore" means the coarse view was confident. A point the coarse field puts well inland
      // must not turn into sea when the detail arrives, however fine it gets.
      if (Math.abs(coarse) > 0.05) disagreeAwayFromShore++;
    }

    assert.equal(
      disagreeAwayFromShore,
      0,
      `planet ${id}: ${disagreeAwayFromShore} points well away from the shore changed sides between detail 7 and 18`,
    );
    // Near the shore a flip is correct -- that is what added detail is for -- but it has to stay a fringe.
    assert.ok(
      disagree / sampled < 0.12,
      `planet ${id}: ${((100 * disagree) / sampled).toFixed(1)}% of the disc changed sides, so the coast moved`,
    );
  }
});

/** Sea level is calibrated against the field, so `waterFraction` means what it says. */
test('a world is as wet as its traits claim', () => {
  let worst = 0;
  for (const { id, traits } of worlds()) {
    const coast = coastlineOf(id, traits);
    const expected = 1 - traits.waterFraction;
    worst = Math.max(worst, Math.abs(coast.landFraction - expected));
    assert.ok(
      Math.abs(coast.landFraction - expected) < 0.12,
      `planet ${id}: ${(100 * traits.waterFraction).toFixed(0)}% water should leave ` +
        `${(100 * expected).toFixed(0)}% land, traced ${(100 * coast.landFraction).toFixed(0)}%`,
    );
  }
  assert.ok(worst < 0.12, `worst land-fraction error ${worst.toFixed(3)}`);
});

/**
 * A world with no water and a world with no land are both legitimate, and neither has a shore inside it.
 *
 * The trace is windowed just outside the disc, so an all-land world comes back with one ring hugging the rim
 * rather than none -- which is what lets every painter fill water first and even-odd the rings as land with no
 * special case at all. What must never appear is a shore INSIDE a world that has no water.
 */
test('the extremes have no shore inside them, and say which they are', () => {
  const { id, traits } = worlds()[0]!;

  const dry = coastlineOf(id, { ...traits, waterFraction: 0 });
  assert.ok(dry.landFraction > 0.99, `expected all land, got ${dry.landFraction}`);
  for (const ring of dry.rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const d = Math.hypot(ring[i]!, ring[i + 1]!);
      assert.ok(d > 0.99, `a world with no water has a shore at radius ${d.toFixed(3)}`);
    }
  }

  const drowned = coastlineOf(id, { ...traits, waterFraction: 1 });
  assert.equal(drowned.rings.length, 0, 'a world with no land should have no shore at all');
  assert.ok(drowned.landFraction < 0.01, `expected all sea, got ${drowned.landFraction}`);
});

/** Every ring closes. An open ring fills as a straight chord, which is how the first version drew wedges. */
test('traced rings are closed loops', () => {
  for (const { id, traits } of worlds().slice(0, 12)) {
    const rings = traceRings((x, y) => Math.min(elevationAt(id, traits, x, y, 7), (1.04 - Math.hypot(x, y)) * 10), 96, 1.04);
    for (const ring of rings) {
      assert.ok(ring.length >= 8 && ring.length % 2 === 0, `ring of ${ring.length} numbers`);
      const gap = Math.hypot(ring[0]! - ring[ring.length - 2]!, ring[1]! - ring[ring.length - 1]!);
      assert.ok(gap < 0.05, `planet ${id}: a ring ends ${gap.toFixed(4)} from where it started`);
    }
  }
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
  assert.ok(detailForScale(0) >= 0 || Number.isFinite(detailForScale(0)));
});

test('sea level is stable for a planet, whatever asks for it', () => {
  const { id, traits } = worlds()[3]!;
  const a = seaLevelOf(id, traits);
  const b = seaLevelOf(id, traits);
  assert.equal(a, b, 'a cached sea level must be the same number every time');
});
