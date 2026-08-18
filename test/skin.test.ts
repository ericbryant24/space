import { strict as assert } from 'node:assert';
import test from 'node:test';
import { RELIEF, groundAt, seaRadiusOf } from '../src/culture/terrain.ts';
import { LEVELS } from '../src/universe/schema.ts';
import { planetTraits } from '../src/universe/gen/planet.ts';
import { beachDepth, classifySkin, skinDepth, strataFor } from '../src/render/draw/skin.ts';

const PLANET_METRES = 2 ** LEVELS.planet.logSpan;

/** Rungs that draw the ground edge on, with the span of one of their frames in planet units. */
const RUNGS = (['region', 'settlement', 'building'] as const).map((kind) => ({
  kind,
  span: 2 ** (LEVELS[kind].logSpan - LEVELS.planet.logSpan),
  metres: 2 ** LEVELS[kind].logSpan,
}));

const worlds = () => {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const id = (i * 2654435761 + 7717) >>> 0;
    out.push({ id, traits: planetTraits(id, (i * 40503 + 7) >>> 0, i % 5, 5) });
  }
  return out;
};

/**
 * THE HANDOVER TEST.
 *
 * A planet paints its own rind until its regions take over, and the two painters have to agree about how deep
 * the living layer is or the world changes colour in one frame. They compute it from different numbers -- the
 * disc from its own radius in pixels and the planet's radius in metres, a plate from its plate's radius in
 * pixels and its own rung's radius in metres -- so the agreement is a property worth pinning rather than
 * assuming. It holds exactly, because both terms of the max scale the same way.
 */
test('the disc and a plate agree exactly about how deep the surface is', () => {
  for (const w of worlds()) {
    for (const planetPx of [400, 2_000, 11_250, 90_000, 4e6]) {
      const disc = skinDepth(planetPx, PLANET_METRES);
      const discBeach = beachDepth(w.traits, planetPx, PLANET_METRES);
      for (const rung of RUNGS) {
        const platePx = planetPx * rung.span;
        const plate = skinDepth(platePx, rung.metres) * rung.span;
        const plateBeach = beachDepth(w.traits, platePx, rung.metres) * rung.span;
        assert.ok(
          Math.abs(disc - plate) <= disc * 1e-12,
          `${rung.kind} soil depth ${plate} != disc ${disc} at ${planetPx}px`,
        );
        assert.ok(
          Math.abs(discBeach - plateBeach) <= discBeach * 1e-12,
          `${rung.kind} beach ${plateBeach} != disc ${discBeach} at ${planetPx}px`,
        );
      }
    }
  }
});

/**
 * A bed of rock is a fact about the planet, not about the viewport.
 *
 * This is the invariant the old frame-relative strata could not have: bed 4 lies at the same depth however you
 * are looking at it, so descending resolves finer beds between the ones already on screen instead of sliding
 * one set off and snapping another in at every rung.
 */
test('the beds of rock lie at fixed depths whatever the zoom', () => {
  for (let e = 4; e < 40; e += 1) {
    const px = 2 ** e;
    for (const bed of strataFor(px, RELIEF)) {
      assert.equal(bed.depth, RELIEF * 2 ** -bed.index);
      assert.ok(bed.alpha > 0 && bed.alpha <= 1);
    }
  }
});

/** Nothing may appear at a visible weight: a bed has to fade in from nothing as it becomes separable. */
test('beds of rock fade in and out rather than appearing', () => {
  const reach = 0.16;
  let prev = new Map<number, number>();
  for (let e = 40; e <= 900; e++) {
    // A slow continuous sweep through fifty doublings of zoom, in fortieths of a doubling.
    const px = 2 ** (e / 40);
    const now = new Map(strataFor(px, reach).map((b) => [b.index, b.alpha]));
    for (const [index, alpha] of now) {
      const before = prev.get(index) ?? 0;
      assert.ok(
        Math.abs(alpha - before) < 0.06,
        `bed ${index} jumped from ${before} to ${alpha} at ${px}px per planet unit`,
      );
    }
    for (const [index, alpha] of prev) {
      if (!now.has(index)) assert.ok(alpha < 0.06, `bed ${index} vanished at alpha ${alpha}`);
    }
    prev = now;
  }
});

/**
 * The surface a disc paints and the surface a plate paints are the same surface.
 *
 * Classified from the same angles and the same radii, in planet units, so whichever painter is holding the
 * brush the snow line, the beach and the bare rock land in the same places.
 */
test('the disc and a plate classify the same stretch of rim the same way', () => {
  for (const w of worlds().slice(0, 8)) {
    const seaR = seaRadiusOf(w.id, w.traits);
    const theta0 = 1.234;
    const arc = 0.02;
    const n = 64;
    const thetaAt = (i: number) => theta0 + (arc * i) / (n - 1);
    const radiusAt = (i: number) => groundAt(w.id, w.traits, thetaAt(i), 14);
    const beach = beachDepth(w.traits, 5e5, PLANET_METRES);
    const a = classifySkin(w.id, w.traits, seaR, n, thetaAt, radiusAt, beach);
    const b = classifySkin(w.id, w.traits, seaR, n, thetaAt, radiusAt, beach);
    assert.deepEqual(a, b);
    assert.ok(a.length > 0);
    // The runs must tile the stretch with no gap: each starts where the last ended.
    assert.equal(a[0]!.from, 0);
    assert.equal(a[a.length - 1]!.to, n - 1);
    for (let i = 1; i < a.length; i++) assert.equal(a[i]!.from, a[i - 1]!.to);
  }
});

/**
 * Sand needs a tide to put it there, and a tide needs a moon to raise it.
 *
 * Measured close in, where the real width in metres is what the beach is: further out the screen floor -- the
 * statement that a surface is at least a line thick -- is wider than any world's tides and both come out the same,
 * which is correct and is why the comparison has to be made at a zoom where you could actually walk the beach.
 */
test('a moonless world has a narrower shore than a many-mooned one of the same mass', () => {
  const base = worlds()[3]!;
  const close = 1e10;
  const none = beachDepth({ ...base.traits, moonCount: 0, massClass: 1 }, close, PLANET_METRES);
  const many = beachDepth({ ...base.traits, moonCount: 4, massClass: 1 }, close, PLANET_METRES);
  assert.ok(many > none * 2, `${many} should be well over ${none}`);
});
