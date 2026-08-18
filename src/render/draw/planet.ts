import { simTime } from '../../core/clock.ts';
import { f01, hash2, hash3 } from '../../core/rng.ts';
import { isGiant, type PlanetClass, type PlanetTraits } from '../../universe/gen/planet.ts';
import { COAST_DETAIL, RELIEF, groundAt, seaRadiusOf } from '../../culture/terrain.ts';
import { makeChild, orbitCount, orbitRadius, orbitalChild, type Node } from '../../universe/node.ts';
import { LEVELS } from '../../universe/schema.ts';
import { outlineWidth, smoothstep } from '../bands.ts';
import { PLATE_RIND, drawPlanetBody } from './ground.ts';
import { beachDepth, classifySkin, materialTone, skinDepth } from './skin.ts';
import { makeSurface } from '../sprites.ts';
import { atLuminance, css, hueDelta, luminanceOf, shade, solveL, type Hsl } from '../color.ts';

/**
 * Cartoon planets: flat fills, two-value shading, hard edges everywhere, and no gradients at all. A soft
 * feathered edge is the single quickest way to make flat art look like a 3D render that did not quite
 * come off -- which is also why there is no terminator here any more; see `drawPlanet`.
 */

export interface Surface {
  land: Hsl;
  landShade: Hsl;
  sea: Hsl;
  ice: Hsl;
  cloud: Hsl;
  /** Ink for coastlines: a very dark tinted neutral, never black. */
  coast: Hsl;
}

const BASE: Record<PlanetClass, { land: [number, number]; sea: [number, number] }> = {
  //                 land: [hue, sat]      sea: [hue, sat]
  molten: { land: [12, 0.85], sea: [34, 0.95] },
  scorched: { land: [24, 0.35], sea: [18, 0.4] },
  desert: { land: [38, 0.62], sea: [188, 0.45] },
  savanna: { land: [64, 0.5], sea: [196, 0.5] },
  terran: { land: [108, 0.45], sea: [206, 0.55] },
  ocean: { land: [128, 0.42], sea: [204, 0.6] },
  jungle: { land: [136, 0.55], sea: [176, 0.5] },
  tundra: { land: [46, 0.22], sea: [204, 0.4] },
  ice: { land: [198, 0.16], sea: [206, 0.3] },
  frozenRock: { land: [214, 0.12], sea: [214, 0.16] },
  greenhouse: { land: [46, 0.7], sea: [40, 0.6] },
  gasGiant: { land: [30, 0.55], sea: [26, 0.45] },
  iceGiant: { land: [196, 0.5], sea: [204, 0.45] },
};

export function surfaceColours(t: PlanetTraits): Surface {
  const base = BASE[t.cls];
  const light = t.starLight;
  // The star's light tints everything, and shadows take its complement: warm sun, cool shadows. One
  // line of code, and it is the cue that carries the star's identity down to a single wall.
  const tint = (hue: number, sat: number, y: number): Hsl => {
    const h = hue + hueDelta(hue, light.colour.h) * 0.22 * light.cls.sat;
    const s = Math.min(0.95, sat * (1 + 0.12 * light.cls.sat));
    return { h, s, l: solveL(h, s, y * (0.86 + 0.28 * light.cls.rel)) };
  };
  const land = tint(base.land[0], base.land[1], 0.42);
  // On a dry world the base is not sea, it is rock -- so it takes the land's hue a couple of steps
  // darker. Keeping a blue "sea" under a desert left the whole disc one flat value.
  const dry = t.aridity > 0.62;
  const seaHue = dry ? base.land[0] - 6 : base.sea[0];
  const seaSat = dry ? base.land[1] * 0.8 : base.sea[1];
  return {
    land,
    landShade: shade(land, light.shadowHue, 0.9),
    // A clear luminance step below the land, so continents read as continents at any size.
    sea: tint(seaHue, seaSat, dry ? 0.2 : 0.13),
    ice: tint(198, 0.1, 0.84),
    cloud: tint(t.atmHue, 0.12, 0.9),
    coast: { h: seaHue, s: 0.35, l: solveL(seaHue, 0.35, 0.04) },
  };
}

// --- What a world averages to ----------------------------------------------------------------------
//
// A planet drawn at four pixels used to be a hand-picked chart symbol: a disc of its sea with a disc of
// its land at a fixed 0.52 of the radius, whatever its actual land fraction. That is a picture of a
// generic planet, and it disagreed with the world you arrived at -- an all-ocean world and an all-desert
// world produced the same arrangement at different hues, and the disc changed proportions the moment the
// real drawing took over. What a body a few pixels across genuinely looks like is the AREA-WEIGHTED MEAN
// of what it is made of, so that is what gets drawn, computed from the same terrain field the full-size
// drawing traces.

/** Interior steps under the rind. Mirrors INTERIOR_BANDS in ground.ts, which draws the same ramp. */
const INTERIOR_STEPS = 3;
/** Samples round the circumference. The shore is a coarse feature at this range; 192 resolves it. */
const MEAN_SAMPLES = 192;

export interface PlanetMean {
  /** The whole disc: what the world averages to once it is small enough to be a stamp. */
  readonly disc: Hsl;
  /** The living rind alone, sea and land, which is what says what kind of world this is. */
  readonly surface: Hsl;
  /** Everything under the rind. */
  readonly interior: Hsl;
  /** Fraction of the disc's radius that is interior, so the stamp can be built in the same proportions. */
  readonly crust: number;
}

/**
 * Mean of a set of colours by area.
 *
 * Averaged the way this project reasons about colour rather than by mixing bytes: hue as a vector, so
 * opposite hues cancel instead of passing through grey the long way round and weighted by saturation so a
 * near-neutral cannot drag it; saturation and relative LUMINANCE by plain area; and then the lightness
 * solved to hit that luminance, exactly as every other derived colour here is built.
 */
function meanOf(parts: readonly (readonly [Hsl, number])[]): Hsl {
  let hx = 0;
  let hy = 0;
  let sat = 0;
  let lum = 0;
  let area = 0;
  for (const [c, a] of parts) {
    if (a <= 0) continue;
    const rad = (c.h * Math.PI) / 180;
    hx += Math.cos(rad) * c.s * a;
    hy += Math.sin(rad) * c.s * a;
    sat += c.s * a;
    lum += luminanceOf(c) * a;
    area += a;
  }
  if (area <= 0) return { h: 0, s: 0, l: 0 };
  const h = (Math.atan2(hy, hx) * 180) / Math.PI;
  const s = Math.min(0.95, sat / area);
  return { h, s, l: solveL(h, s, lum / area) };
}

const meanCache = new Map<number, PlanetMean>();

/**
 * What this world averages to, by area, at every level of its own construction.
 *
 * Pure in the planet's address, so it is cached: the shore is sampled at COAST_DETAIL, which is nine
 * octaves at a hundred and ninety-two angles, and it must not be recomputed for a dot that is on screen
 * for a thousand frames. Time-independent as well -- a gas giant's bands drift, and averaging them at the
 * current phase would make the world's icon shimmer.
 */
export function planetMeanColour(id: number, t: PlanetTraits): PlanetMean {
  const hit = meanCache.get(id);
  if (hit) return hit;
  const mean = isGiant(t.cls) ? giantMean(id, t) : rockyMean(id, t);
  if (meanCache.size > 256) meanCache.clear();
  meanCache.set(id, mean);
  return mean;
}

/** One planet radius, in metres. The depths in skin.ts are real lengths, so the mean has to be honest about scale. */
const PLANET_METRES = 2 ** LEVELS.planet.logSpan;

/**
 * A rocky world, integrated exactly as the disc painter builds it: a core and the interior ramp under the
 * crust, then the rind -- skin over rock -- and the water column standing over whatever of the rind lies
 * below the sea.
 *
 * Areas come out of the field directly. The wedge between two angles at radii a..b has area
 * (b^2 - a^2)/2 per radian, so no sampling of the interior is needed at all and the rim is the only
 * thing that has to be walked.
 *
 * THE RIND IS THE SKIN'S COLOUR, NOT THE LAND'S, and this is the whole of what the average has to get
 * right. `skinDepth` is floored at two SCREEN pixels, so at every size the stamp is ever drawn the skin
 * band is a quarter of a planet radius deep against a rind of a sixth -- the skin covers the rind
 * entirely, and what is on the screen is `materialTone` for every run of it. Weighting the rind at
 * `s.land` instead made an ice-capped world stamp as its biome-soil green and a desert stamp green too,
 * and then both changed colour as you arrived: exactly the disagreement between the icon and the world
 * that having an area mean at all is meant to remove. So the runs come from `classifySkin`, off the same
 * radii at the same COAST_DETAIL, and each is weighted by the wedge of rind it owns.
 *
 * Note what this says about a two-dimensional ocean world: the sea is a film a few hundredths of a
 * radius deep over a rind two tenths deep, so by area a water world is mostly its own ground. That is
 * not a shortcoming of the average -- it is what the world looks like, and the stamp agreeing with it is
 * the entire point.
 */
function rockyMean(id: number, t: PlanetTraits): PlanetMean {
  const s = surfaceColours(t);
  // Set to match what a region plate paints, exactly as in ground.ts: see PLATE_RIND.
  const crust = Math.min(1 - RELIEF * 0.7, 1 - PLATE_RIND);
  const seaR = seaRadiusOf(id, t);
  const step = (Math.PI * 2) / MEAN_SAMPLES;

  const rad = new Float64Array(MEAN_SAMPLES);
  for (let i = 0; i < MEAN_SAMPLES; i++) rad[i] = Math.max(crust, groundAt(id, t, i * step, COAST_DETAIL));

  // The two depths ground.ts paints with, asked for at the size the stamp stands in for, so the bands
  // measured here are the bands drawn there.
  const skin = skinDepth(STAMP_PX, PLANET_METRES);
  const shallow = Math.max(2 / STAMP_PX, skin * 2.2);

  /**
   * Wedge areas, sample by sample: the skin at the top of the rind, the rock left under it, and the
   * water split at the depth the lighter shallows reach -- which at this size is the whole of it, since
   * a sea a tenth of a radius deep is shallower than the band that lightens it.
   */
  const skinArea = new Float64Array(MEAN_SAMPLES);
  let rock = 0;
  let shelf = 0;
  let deep = 0;
  for (let i = 0; i < MEAN_SAMPLES; i++) {
    const g = rad[i]!;
    const under = Math.max(crust, g - skin);
    skinArea[i] = ((g * g - under * under) / 2) * step;
    rock += ((under * under - crust * crust) / 2) * step;
    if (seaR > g) {
      const top = Math.min(seaR, g + shallow);
      shelf += ((top * top - g * g) / 2) * step;
      deep += ((seaR * seaR - top * top) / 2) * step;
    }
  }

  const runs = classifySkin(
    id,
    t,
    seaR,
    MEAN_SAMPLES,
    (i) => i * step,
    (i) => rad[i]!,
    beachDepth(t, STAMP_PX, PLANET_METRES),
  );
  const rind: [Hsl, number][] = [];
  for (let k = 0; k < runs.length; k++) {
    const run = runs[k]!;
    // Runs meet on a shared sample, so every run but the last stops one short of its own last index and
    // no wedge is counted twice.
    const end = k === runs.length - 1 ? run.to : run.to - 1;
    let area = 0;
    for (let i = run.from; i <= end; i++) area += skinArea[i]!;
    rind.push([materialTone(run.material, run.biome, s, t), area]);
  }
  // What is left of the rind, in the tones ground.ts fills it with: rock under the skin, then the
  // lightened shelf water and the deep water over the drowned part of it.
  rind.push([atLuminance(s.land, Math.max(0.04, luminanceOf(s.land) * 0.62)), rock]);
  rind.push([atLuminance(s.sea, Math.min(0.72, luminanceOf(s.sea) + 0.16)), shelf]);
  rind.push([s.sea, deep]);

  // The interior ramp, annulus by annulus, in the same tones ground.ts fills them with.
  const interior: [Hsl, number][] = [];
  const yLand = luminanceOf(s.land);
  const coreR = crust * 0.13;
  for (let b = 0; b < INTERIOR_STEPS; b++) {
    const f = b / (INTERIOR_STEPS - 1);
    const outer = crust * (1 - (b / INTERIOR_STEPS) * 0.78);
    const inner = b === INTERIOR_STEPS - 1 ? coreR : crust * (1 - ((b + 1) / INTERIOR_STEPS) * 0.78);
    interior.push([
      atLuminance({ ...s.land, s: s.land.s * (0.7 - f * 0.32) }, Math.max(0.035, yLand * (0.3 - f * 0.2))),
      Math.max(0, Math.PI * (outer * outer - inner * inner)),
    ]);
  }
  interior.push([atLuminance(shade(s.land, t.starLight.shadowHue, 1.4), 0.15), Math.PI * coreR * coreR]);

  const inside = meanOf(interior);
  return {
    disc: meanOf([...interior, ...rind]),
    surface: meanOf(rind),
    interior: inside,
    crust,
  };
}

/**
 * A giant is gas all the way down, so its disc IS its surface: the mean is over the same bands
 * `paintBands` draws, weighted by the chord of the disc at each height, which is what makes it an area
 * average rather than a height average.
 */
function giantMean(id: number, t: PlanetTraits): PlanetMean {
  const s = surfaceColours(t);
  const count = 5 + Math.floor(f01(hash2(id, 0x41)) * 5);
  const spans: { y0: number; y1: number; tone: Hsl }[] = [];
  for (let i = 0; i < count; i++) {
    const y0 = -1 + (2 * i) / count;
    const y1 = y0 + (2 / count) * (0.55 + f01(hash3(id, 0x42, i)) * 0.7);
    spans.push({ y0, y1, tone: i % 2 === 0 ? s.land : s.landShade });
  }

  const parts: [Hsl, number][] = [];
  const rows = 128;
  for (let j = 0; j < rows; j++) {
    const y = -1 + ((j + 0.5) / rows) * 2;
    // Chord of the unit disc at this height, times the row's own thickness: an area, not a length.
    const w = 2 * Math.sqrt(Math.max(0, 1 - y * y)) * (2 / rows);
    // Bands are painted in order and overlap, so the last one covering this height is the one you see.
    let tone: Hsl = s.sea;
    for (const span of spans) if (y >= span.y0 && y <= span.y1) tone = span.tone;
    parts.push([tone, w]);
  }
  // The one oval storm, at its own share of the disc: a 0.2 by 0.1 ellipse in a unit circle is 2%.
  if (f01(hash2(id, 0x43)) < 0.7) {
    parts.push([atLuminance(s.land, Math.min(0.8, luminanceOf(s.land) + 0.22)), Math.PI * 0.02]);
  }
  const all = meanOf(parts);
  return { disc: all, surface: all, interior: all, crust: 0 };
}

function paintBands(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: PlanetTraits, id: number, s: Surface): void {
  const count = 5 + Math.floor(f01(hash2(id, 0x41)) * 5);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  for (let i = 0; i < count; i++) {
    const y0 = -1 + (2 * i) / count;
    const y1 = y0 + (2 / count) * (0.55 + f01(hash3(id, 0x42, i)) * 0.7);
    const tone = i % 2 === 0 ? s.land : s.landShade;
    // Bands drift, which is nearly the whole of a gas giant's animation budget.
    const drift = Math.sin(simTime() / (14 + i * 5) + i) * r * 0.03;
    ctx.fillStyle = css(tone, 0.92);
    ctx.beginPath();
    ctx.moveTo(cx - r, cy + y0 * r + drift);
    ctx.bezierCurveTo(
      cx - r * 0.3, cy + (y0 + 0.06) * r + drift,
      cx + r * 0.3, cy + (y0 - 0.05) * r + drift,
      cx + r, cy + y0 * r + drift,
    );
    ctx.lineTo(cx + r, cy + y1 * r + drift);
    ctx.bezierCurveTo(
      cx + r * 0.3, cy + (y1 - 0.05) * r + drift,
      cx - r * 0.3, cy + (y1 + 0.06) * r + drift,
      cx - r, cy + y1 * r + drift,
    );
    ctx.closePath();
    ctx.fill();
  }
  // One oval storm.
  if (f01(hash2(id, 0x43)) < 0.7) {
    const sy = (f01(hash2(id, 0x44)) * 2 - 1) * 0.5;
    ctx.fillStyle = css(atLuminance(s.land, Math.min(0.8, luminanceOf(s.land) + 0.22)), 0.95);
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.2, cy + sy * r, r * 0.2, r * 0.1, 0.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Cloud, as arcs of weather standing off the rim.
 *
 * Ellipses laid across the disc were the last of the map-projection art in this file: on a two-dimensional
 * world there is no face to have weather over, so a cloud is a stretch of sky above a stretch of ground. Each
 * one is a thick arc between the surface and the top of the atmosphere, drifting slowly around the world --
 * and drifting all the way round is correct here, because a 2D planet's sky is a closed loop.
 */
function paintClouds(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: PlanetTraits, id: number, s: Surface): void {
  if (t.cloudCover <= 0.04) return;
  const count = 3 + Math.floor(t.cloudCover * 9);
  const reach = AIR_REACH * Math.min(1, t.atmDensity);
  if (reach * r < 2) return;
  ctx.strokeStyle = css(s.cloud, 0.34 + t.cloudCover * 0.34);
  for (let i = 0; i < count; i++) {
    // Height in the air, thickness, angular length and drift rate all per cloud, so no two read as the same
    // stamp repeated. Kept inside the air band, because a cloud above the atmosphere is not a cloud.
    const lift = 1 + reach * (0.12 + 0.6 * f01(hash3(id, 0x61, i)));
    const thick = r * reach * (0.1 + f01(hash3(id, 0x62, i)) * 0.24);
    if (thick < 0.4) continue;
    const arc = 0.04 + f01(hash3(id, 0x63, i)) * 0.4;
    const period = (300 + f01(hash3(id, 0x64, i)) * 600) * (f01(hash3(id, 0x65, i)) < 0.5 ? -1 : 1);
    const a0 = f01(hash3(id, 0x66, i)) * Math.PI * 2 + (simTime() / period) * Math.PI * 2;
    ctx.lineWidth = thick;
    ctx.beginPath();
    ctx.arc(cx, cy, r * lift, a0, a0 + arc);
    ctx.stroke();
  }
}

export function drawPlanet(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  id: number,
  t: PlanetTraits,
): void {
  const s = surfaceColours(t);

  // The air, FIRST, because the ground is drawn over it: a two-dimensional world's atmosphere is an annulus
  // standing off its rim, and everything alive lives at the bottom of it.
  paintAir(ctx, cx, cy, r, t, s);

  if (isGiant(t.cls)) {
    // A giant has no rim to stand on: it is gas all the way down, so its disc IS the picture.
    ctx.fillStyle = css(s.sea);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    paintBands(ctx, cx, cy, r, t, id, s);
    const w = outlineWidth(r, 3);
    if (w > 0) {
      ctx.lineWidth = w;
      ctx.strokeStyle = css(s.coast, 0.95);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    /**
     * A ROCKY WORLD IS A DISC OF ROCK WITH EVERYTHING LIVING ON ITS EDGE.
     *
     * `drawPlanetBody` traces the same one-dimensional terrain field that places regions and that a region
     * plate draws edge on, so the shore you see from orbit is the shore you land on -- and there is no map
     * projection anywhere, because there is nothing round to project. It draws its own silhouette, because on
     * a 2D world the silhouette IS the coastline and a separate circle round the outside would contradict it.
     */
    drawPlanetBody(ctx, cx, cy, r, id, t);
  }
  paintClouds(ctx, cx, cy, r, t, id, s);

  /**
   * NO TERMINATOR AND NO RIM LIGHT.
   *
   * There used to be a hard-edged day/night crescent here -- the cleverest drawing in the file, and the
   * reason a planet read as a rendered ball. A lit crescent and a lit limb are statements about a sphere
   * under a light, and this is a flat world: everything that happens on it happens in plain view. The star's
   * identity still reaches every colour through the tint in `surfaceColours`, which is where it belongs.
   */

  // Rings last, because face-on they pass over nothing: they are rings AROUND the planet, not across it.
  if (t.hasRings) paintRings(ctx, cx, cy, r, id, t, s);
}

/** How far above the surface the air reaches on the thickest-aired world, as a fraction of the radius. */
const AIR_REACH = 0.085;

/**
 * The atmosphere: a band of sky standing off the rim, in three flat steps.
 *
 * A thin stroke round the outside is what used to be here, and it read as the gold rim of a dinner plate --
 * because a line says "edge" and what is wanted is "there is somewhere above the ground". Steps rather than a
 * gradient, for the same reason everything else in the project is stepped: three flat bands read as drawn,
 * a ramp reads as a render that did not come off.
 */
function paintAir(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: PlanetTraits, s: Surface): void {
  const reach = AIR_REACH * Math.min(1, t.atmDensity);
  if (reach * r < 0.6) return;
  const sky = skyTone(t);
  for (let b = 3; b >= 1; b--) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * (1 + (reach * b) / 3), 0, Math.PI * 2);
    ctx.fillStyle = css(sky, 0.34 - b * 0.07);
    ctx.fill();
  }
  // A hairline at the top of the air, so the sky has a lid and the world reads as having an inside.
  if (r > 40) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = css(sky, 0.3);
    ctx.beginPath();
    ctx.arc(cx, cy, r * (1 + reach), 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * Rings, as concentric circles around the disc.
 *
 * Edge-on ellipses were the last sphere cue in the file: a tilted hoop only makes sense if you are looking
 * at a ball from the side, and it needed a behind-half and an in-front-half painted either side of the
 * planet to sell it. Face-on, rings are what they actually are from above -- rings -- and they no longer
 * cross the face, so nothing is hidden and there is no front and back to get right.
 */
function paintRings(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  id: number,
  t: PlanetTraits,
  s: Surface,
): void {
  // Ice a few tens of metres thick: delicate, not slabs of plastic. Thin bands with real gaps between them
  // read as rings; three fat opaque ones read as a toy hoop.
  const inner = r * 1.28;
  const outer = inner + r * (0.3 + t.ringWidth * 0.55);
  /**
   * How many bands, from the system's own width. A broad system has room for more resolvable divisions
   * than a narrow one, and the count used to be four for every world in the universe.
   */
  const bands = 2 + Math.round(t.ringWidth * 6);
  const slot = (outer - inner) / bands;
  const yIce = luminanceOf(s.ice);
  for (let i = 0; i < bands; i++) {
    /**
     * Every band is ice -- that is what these are made of, and it is what the world's own lore says about
     * them. What differs band to band is how much of it there is, so density sets the band's width, its
     * brightness and its opacity together. The old tone list put the planet's LAND shade in one of them,
     * which is a fact about the ground, not about a ring.
     */
    const density = f01(hash3(id, 0x71, i));
    const a = inner + slot * i;
    const b = a + slot * (0.32 + density * 0.5);
    ctx.beginPath();
    ctx.arc(cx, cy, b, 0, Math.PI * 2);
    // Traced the other way, so the winding rule leaves an annulus rather than a filled disc.
    ctx.arc(cx, cy, a, 0, Math.PI * 2, true);
    ctx.fillStyle = css(atLuminance(s.ice, yIce * (0.5 + 0.5 * density)), 0.2 + 0.26 * density);
    ctx.fill();
  }
}

/**
 * The schematic used in a system view.
 *
 * A planet is about 2^-17 of its system, so at true scale it is a ten-thousandth of a pixel: correct,
 * and useless. An atlas draws an orbital diagram instead, so below a few pixels the body is drawn at a
 * floor size. The clamp is monotonic, so it merges into the true size as you approach with no pop, and
 * the orbit ring makes the schematic reading obvious.
 */
export const PLANET_ICON_MIN_PX = 4.2;

/**
 * The colour of this world's daylight sky, seen from inside its atmosphere.
 *
 * Two ends of one ramp, as everywhere else: in space you draw light shapes on a dark ground, and on a
 * surface you draw dark shapes on a light one. This is that light ground, and it is the planet's own
 * atmosphere hue tinted by its own star, so a white-hot sun over a thin atmosphere gives a pale hard
 * sky and a red dwarf over a thick one gives a dim orange afternoon.
 */
export function skyTone(t: PlanetTraits): Hsl {
  const light = t.starLight;
  const h = t.atmHue + hueDelta(t.atmHue, light.colour.h) * 0.3 * light.cls.sat;
  const sat = 0.16 + 0.34 * Math.min(1, t.atmDensity) * (0.5 + 0.5 * light.cls.sat);
  // A thin atmosphere over a bright star is not much lighter than the void; a thick one is nearly white.
  const y = 0.1 + 0.62 * Math.min(1, t.atmDensity * 1.4) * (0.55 + 0.45 * light.cls.rel);
  return { h, s: sat, l: solveL(h, sat, y) };
}

/**
 * Where the stamp gives way to the drawn world.
 *
 * The lower end is the schematic floor itself: at the floor a planet is a dot on an orbital diagram and
 * there is nothing else it can honestly be. By 11 px the shore has half a dozen pixels to bend in, the
 * ink outline has started to appear, and the drawn disc says something the stamp cannot. The two ramps
 * share both endpoints, so the stamp and the world sum to exactly one world throughout -- which is the
 * whole reason the stamp is the disc's own area mean and not a chart symbol invented for the purpose.
 */
export const PLANET_ICON_FADE_PX: readonly [number, number] = [PLANET_ICON_MIN_PX, 11];

/**
 * The size the world's average is taken at, in screen pixels: the middle of the handover in doublings,
 * where the stamp and the drawn world are each half of what you are looking at.
 *
 * One number, because the mean is cached per world and has to be one colour -- and one number is enough,
 * because across the whole of PLANET_ICON_FADE_PX the disc paints the same picture. `skinDepth`'s two
 * pixel floor is a quarter of a planet radius here against a rind of a sixth, so the skin covers the rind
 * at 4 px and at 11 px alike; and `beachDepth`'s floor reaches further above the water line than the
 * highest ground on any world, so what is not snow or cliff is beach at either end of the band. The
 * classification does not move while the stamp is on screen, so nothing is lost by fixing the size.
 */
const STAMP_PX = Math.sqrt(PLANET_ICON_FADE_PX[0] * PLANET_ICON_FADE_PX[1]);

/**
 * The stamp: the world at the resolution a few pixels can carry.
 *
 * Two flat values in their true proportions -- the interior out to the crust, the rind over it -- which
 * at four pixels antialiases to exactly the disc's area mean and at ten pixels already shows the rind as
 * a rind. Nothing here is picked: both tones and the radius between them come from the same field and the
 * same construction the full-size drawing uses.
 */
function paintPlanetStamp(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, id: number, t: PlanetTraits): void {
  const mean = planetMeanColour(id, t);
  ctx.fillStyle = css(mean.surface);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  if (mean.crust > 0) {
    ctx.fillStyle = css(mean.interior);
    ctx.beginPath();
    ctx.arc(cx, cy, r * mean.crust, 0, Math.PI * 2);
    ctx.fill();
  }
  // The world's edge, at whatever weight the size can carry: `outlineWidth` is zero under six pixels, so
  // the rim grows in rather than snapping on, and under it the stamp is two flat values and nothing else.
  const w = outlineWidth(r, 1.6);
  if (w > 0) {
    ctx.lineWidth = w;
    ctx.strokeStyle = css(surfaceColours(t).coast, 0.95);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * How far past its own radius a planet's icon draws, as a multiple of it: the outer edge of the widest
 * ring system, which is 1.28 + 0.3 + 0.63 * 0.55 radii out. Everything else -- air, cloud, the highest
 * ground -- falls well inside that.
 */
const ICON_REACH = 2.1;

/**
 * Two small surfaces the icon crossfade is mixed on. Grown to fit and then kept: the band they are used
 * in tops out at eleven pixels, so this is a few tens of kilobytes for the life of the page.
 */
let mixFore: ReturnType<typeof makeSurface> | null = null;
let mixBack: ReturnType<typeof makeSurface> | null = null;
let mixSize = 0;

function mixSurfaces(size: number): [ReturnType<typeof makeSurface>, ReturnType<typeof makeSurface>] {
  if (!mixFore || !mixBack || mixSize < size) {
    mixFore = makeSurface(size);
    mixBack = makeSurface(size);
    mixSize = size;
  }
  return [mixFore, mixBack];
}

/**
 * TWO PICTURES OF ONE WORLD, MIXED OFF SCREEN.
 *
 * Both halves of this crossfade are opaque where they overlap -- the stamp is a filled disc and the
 * drawn world fills its own silhouette -- so laying one over the other on the canvas does not blend
 * them: source-over leaves a * (1 - a) of the VOID showing through, a quarter of it at the middle of the
 * band, and the planet visibly darkened at around seven pixels before recovering. Nor can it be fixed by
 * reordering or by solving for a compensating alpha, because the two footprints are not the same shape:
 * the stamp is a circle of radius r and the world's rim wanders a tenth of that either side of it, so
 * any alpha that makes the overlap correct makes the ring outside the world's coastline wrong.
 *
 * Mixed on their own surfaces there is nothing to get wrong. Each picture is composited normally, in
 * isolation; the back one is scaled by its share with `destination-in`, which multiplies what is there
 * by a flat alpha; the front is added with `lighter`, which sums PREMULTIPLIED colour and alpha and so
 * is a weighted mean of two pictures rather than one over the other. The result is exactly
 * stamp * S + (1 - stamp) * P with the background nowhere in it, laid down in a single blit at whatever
 * alpha the caller was already using. The blit is integer-aligned and the two pictures carry the
 * fractional part of the position instead, so nothing is resampled twice and a planet still moves in
 * sub-pixel steps as you pan.
 */
export function drawPlanetIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  truePx: number,
  id: number,
  t: PlanetTraits,
): number {
  const r = Math.max(PLANET_ICON_MIN_PX, truePx);
  const stamp = 1 - smoothstep(PLANET_ICON_FADE_PX[0], PLANET_ICON_FADE_PX[1], r);

  // Outside the band only one of the two is on screen, and one picture composites correctly on its own.
  if (stamp <= 1 / 255) {
    drawPlanet(ctx, cx, cy, r, id, t);
    return r;
  }
  if (stamp >= 1 - 1 / 255) {
    paintPlanetStamp(ctx, cx, cy, r, id, t);
    return r;
  }

  const half = Math.ceil(r * ICON_REACH) + 2;
  const size = half * 2;
  const [fore, back] = mixSurfaces(size);
  // The blit lands on whole pixels and the drawings carry the remainder.
  const ix = Math.floor(cx) - half;
  const iy = Math.floor(cy) - half;
  const mx = half + (cx - Math.floor(cx));
  const my = half + (cy - Math.floor(cy));

  fore.ctx.clearRect(0, 0, size, size);
  paintPlanetStamp(fore.ctx, mx, my, r, id, t);
  back.ctx.clearRect(0, 0, size, size);
  drawPlanet(back.ctx, mx, my, r, id, t);

  back.ctx.globalCompositeOperation = 'destination-in';
  back.ctx.fillStyle = `rgba(0,0,0,${1 - stamp})`;
  back.ctx.fillRect(0, 0, size, size);
  back.ctx.globalCompositeOperation = 'lighter';
  back.ctx.globalAlpha = stamp;
  back.ctx.drawImage(fore.surface as CanvasImageSource, 0, 0, size, size, 0, 0, size, size);
  back.ctx.globalAlpha = 1;
  back.ctx.globalCompositeOperation = 'source-over';

  ctx.drawImage(back.surface as CanvasImageSource, 0, 0, size, size, ix, iy, size, size);
  return r;
}

/**
 * Where an orbit ring arrives.
 *
 * It used to vanish outright under six pixels, which is a ring of them blinking off together as a system
 * shrinks -- and an orbit is the one thing in a system view that is legible at three pixels, because a
 * circle needs no detail to read as a circle. So it ramps instead, from the size where the circle first
 * encloses more than the star drawn at its centre.
 */
export const ORBIT_RING_FADE_PX: readonly [number, number] = [4, 14];

/**
 * The luminance every orbit ring is drawn at.
 *
 * Fixed, so that hue is the only thing that varies between them: a ring's job is to say which world rides
 * it, and a dark world's ring must not read as a fainter orbit. The world's own area mean supplies the
 * hue, so the ring and the dot on it are the same colour and stay the same colour all the way down.
 */
export const ORBIT_RING_LUMINANCE = 0.38;

/** Orbit rings, drawn behind everything in a system. */
export function drawOrbitRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, radiusPx: number, colour: Hsl): void {
  const appear = smoothstep(ORBIT_RING_FADE_PX[0], ORBIT_RING_FADE_PX[1], radiusPx);
  if (appear <= 0) return;
  ctx.lineWidth = 1;
  ctx.strokeStyle = css(colour, 0.2 * appear);
  ctx.beginPath();
  ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * Every orbit of a system, each in the colour of the world that rides it.
 *
 * This is what makes a system view a chart rather than a target: a planet is a ten-thousandth of a pixel
 * out here and even its schematic dot is four pixels, so before anything resolves the only thing with
 * enough ink on screen to carry an identity is the orbit. Colouring them all alike threw that away. Now
 * the ring is the same derived colour its planet will be when you reach it, so the blue one is the water
 * world before you can see any water.
 *
 * An empty orbit -- a system with no body in that slot -- falls back to the caller's own colour, because
 * there is nothing whose colour it could otherwise be.
 */
export function drawOrbitRings(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rPx: number,
  node: Node,
  fallback: Hsl,
): void {
  const count = orbitCount(node);
  for (let i = 0; i < count; i++) {
    const ref = orbitalChild(node, i);
    const traits = ref ? makeChild(node, ref).ground?.traits : null;
    const tone =
      ref && traits
        ? atLuminance(planetMeanColour(ref.id, traits).disc, ORBIT_RING_LUMINANCE)
        : fallback;
    drawOrbitRing(ctx, cx, cy, orbitRadius(i, count) * rPx, tone);
  }
}
