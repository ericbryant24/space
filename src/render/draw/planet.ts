import { simTime } from '../../core/clock.ts';
import { f01, hash2, hash3 } from '../../core/rng.ts';
import { isGiant, type PlanetClass, type PlanetTraits } from '../../universe/gen/planet.ts';
import { outlineWidth } from '../bands.ts';
import { atLuminance, css, hueDelta, luminanceOf, shade, solveL, type Hsl } from '../color.ts';

/**
 * Cartoon planets: flat fills, two-value shading, a HARD-edged terminator, and no gradients anywhere.
 * A soft feathered terminator is the single quickest way to make flat art look like a 3D render that
 * did not quite work.
 */

interface Surface {
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

function surfaceColours(t: PlanetTraits): Surface {
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

/**
 * A wobbly closed blob: a circle with its radius perturbed at a dozen control points and closed with a
 * Catmull-Rom pass. Not noise -- the low control count is what makes it read as drawn by hand.
 */
function blobPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  seed: number,
  points = 11,
  wobble = 0.24,
): void {
  const pts: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const r = radius * (1 - wobble / 2 + f01(hash2(seed, i)) * wobble);
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[(i - 1 + pts.length) % pts.length]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % pts.length]!;
    const p3 = pts[(i + 2) % pts.length]!;
    if (i === 0) ctx.moveTo(p1[0], p1[1]);
    // Catmull-Rom expressed as a cubic Bezier.
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1],
    );
  }
  ctx.closePath();
}

/**
 * Continents, flat, on the face you are looking at.
 *
 * TRUE 2D. This used to be an orthographic projection of a sphere: continents were placed by longitude,
 * squashed by cos(lon) towards the limb, culled when they went round the back, and drifted with the
 * planet's day length. Every one of those is a three-dimensional claim, and together they made a planet
 * read as a rendered ball rather than as a thing on a map. A planet has ONE SET FACE now: land sits at a
 * fixed place on the disc, at its true size wherever it falls, and it stays there. It also stays there
 * while you aim at it, which is the other half of why this changed.
 */
function paintContinents(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  t: PlanetTraits,
  id: number,
  s: Surface,
): void {
  const count = 5 + Math.floor(f01(hash2(id, 0x31)) * 7);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  for (let i = 0; i < count; i++) {
    /**
     * Golden angle, not a free roll, for the bearing -- and sqrt for the distance so the disc fills evenly
     * instead of piling up in the middle. Placed at random, half a dozen continents at these sizes landed
     * on top of each other and merged into one lump filling the planet; spread this way they read as
     * separate landmasses on a world, which is the whole point of drawing more than one.
     */
    const a = i * 2.39996 + f01(hash3(id, 0x32, i)) * 0.8;
    const d = Math.sqrt((i + 0.55) / count) * 0.74;
    const size = r * (0.1 + f01(hash3(id, 0x34, i)) * 0.17) * (1 - t.waterFraction * 0.5);
    blobPath(ctx, cx + Math.cos(a) * d * r, cy + Math.sin(a) * d * r, size, hash3(id, 0x35, i));
    ctx.fillStyle = css(s.land);
    ctx.fill();
    // A coastline in ink, not black: the outline is what makes flat fills read as drawn rather than as an
    // untextured render.
    const w = outlineWidth(size, 2);
    if (w > 0) {
      ctx.lineWidth = w;
      ctx.strokeStyle = css(s.coast, 0.85);
      ctx.stroke();
    }
  }
  ctx.restore();
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
 * Ice, as a flat cap across the top and the bottom of the disc.
 *
 * Poles are at the top and bottom of a face-on disc, which is the one piece of sphere geometry that
 * survives into a flat drawing without implying depth: a lens-shaped band across each end, clipped, with
 * a wobbly inner boundary so it reads as ice rather than as a crop.
 */
function paintCaps(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: PlanetTraits, id: number, s: Surface): void {
  if (t.snowIndex <= 0.02) return;
  // How far down from each pole the ice reaches, as a fraction of the radius.
  const reach = Math.min(0.92, 0.14 + 0.72 * t.snowIndex);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = css(s.ice, 0.95);
  for (const sign of [-1, 1]) {
    // A blob wider than the disc, centred beyond the pole, so what lands inside the clip is a cap with a
    // wobbly edge and a clean straight rim.
    blobPath(ctx, cx, cy + sign * r * (2 - reach), r * 1.55, hash3(id, 0x51, sign), 13, 0.1);
    ctx.fill();
    const w = outlineWidth(r * 0.85, 1.6);
    if (w > 0) {
      ctx.lineWidth = w;
      ctx.strokeStyle = css(s.coast, 0.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Cloud, drifting.
 *
 * The drift is a slow back-and-forth rather than a wrap all the way round, because a cloud sliding off one
 * limb and reappearing at the other is a rotation cue, and this planet does not turn. It is still the
 * single cheapest thing on screen that makes a world feel alive.
 */
function paintClouds(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: PlanetTraits, id: number, s: Surface): void {
  if (t.cloudCover <= 0.04) return;
  const count = 3 + Math.floor(t.cloudCover * 7);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = css(s.cloud, 0.4 + t.cloudCover * 0.28);
  for (let i = 0; i < count; i++) {
    // Spread across the disc rather than stacked: two wide ellipses at the same height read as one painted
    // stripe, which is the last thing a sky should look like.
    const lat = ((i + 0.5) / count) * 1.6 - 0.8 + (f01(hash3(id, 0x61, i)) - 0.5) * 0.18;
    const period = 90 + f01(hash3(id, 0x62, i)) * 140;
    const x = Math.sin((simTime() / period) * Math.PI * 2 + f01(hash3(id, 0x63, i)) * Math.PI * 2) * 0.42;
    const w = r * (0.16 + f01(hash3(id, 0x64, i)) * 0.26);
    const h = r * (0.04 + f01(hash3(id, 0x65, i)) * 0.05);
    ctx.beginPath();
    ctx.ellipse(cx + x * r, cy + lat * r, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
  const light = t.starLight;

  // Disc.
  ctx.fillStyle = css(s.sea);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  if (isGiant(t.cls)) {
    paintBands(ctx, cx, cy, r, t, id, s);
  } else {
    paintContinents(ctx, cx, cy, r, t, id, s);
    paintCaps(ctx, cx, cy, r, t, id, s);
  }
  paintClouds(ctx, cx, cy, r, t, id, s);

  /**
   * NO TERMINATOR AND NO RIM LIGHT.
   *
   * There used to be a hard-edged day/night crescent here -- the cleverest drawing in the file, and the
   * reason a planet read as a rendered ball. A lit crescent and a lit limb are statements about a sphere
   * under a light, and this is a flat map: a circle with one set face, and everything that happens on it
   * happening in plain view. The star's identity still reaches every colour on the disc through the tint
   * in `surfaceColours`, which is where it belongs.
   */

  // Cartoon atmosphere: an offset outline, not a fog. Capped, because scaling it with the radius gave a
  // ten-pixel grey rim that read as the edge of a dinner plate.
  if (t.atmDensity > 0.15 && r > 5) {
    // Kept lighter than the silhouette: the ink line is the planet's edge, and a heavier grey ring outside
    // it stole the read.
    ctx.lineWidth = Math.min(2.5, Math.max(1, r * 0.016)) * Math.min(1, t.atmDensity);
    ctx.strokeStyle = css({ h: t.atmHue, s: 0.5, l: 0.7 }, 0.3);
    ctx.beginPath();
    ctx.arc(cx, cy, r + ctx.lineWidth, 0, Math.PI * 2);
    ctx.stroke();
  }

  // The thick cartoon line, and the whole of the planet's silhouette. In INK -- `s.coast`, a very dark
  // tinted neutral -- and not a hue-rotated sea colour, which over a warm star came out bright red and read
  // as a highlighter ring drawn round the planet rather than as the edge of it.
  const w = outlineWidth(r, 3);
  if (w > 0) {
    ctx.lineWidth = w;
    ctx.strokeStyle = css(s.coast, 0.95);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Rings last, because face-on they pass over nothing: they are rings AROUND the planet, not across it.
  if (t.hasRings) paintRings(ctx, cx, cy, r, t, s);
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
  t: PlanetTraits,
  s: Surface,
): void {
  // Ice a few tens of metres thick: delicate, not slabs of plastic. Four thin bands with real gaps between
  // them read as rings; three fat opaque ones read as a toy hoop.
  const inner = r * 1.28;
  const outer = inner + r * (0.3 + t.ringWidth * 0.55);
  const bands = 4;
  const tones = [s.cloud, s.ice, s.landShade, s.ice];
  const slot = (outer - inner) / bands;
  for (let i = 0; i < bands; i++) {
    const a = inner + slot * i;
    const b = a + slot * 0.56;
    ctx.beginPath();
    ctx.arc(cx, cy, b, 0, Math.PI * 2);
    // Traced the other way, so the winding rule leaves an annulus rather than a filled disc.
    ctx.arc(cx, cy, a, 0, Math.PI * 2, true);
    ctx.fillStyle = css(tones[i % tones.length]!, 0.34);
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

export function drawPlanetIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  truePx: number,
  id: number,
  t: PlanetTraits,
): number {
  const r = Math.max(PLANET_ICON_MIN_PX, truePx);
  if (r <= 7) {
    // Too small for any of the detail to survive: a flat disc in the world's own colour, a smaller disc of
    // its land, and a dark rim. Enough to read as a body on a chart rather than as another star in the
    // field behind it -- and no lit crescent, which is the sphere cue this whole pass exists to remove.
    const s = surfaceColours(t);
    ctx.fillStyle = css(s.sea);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = css(s.land, 0.9);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.52, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = css(s.coast, 0.95);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    return r;
  }
  drawPlanet(ctx, cx, cy, r, id, t);
  return r;
}

/** Orbit rings, drawn behind everything in a system. */
export function drawOrbitRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, radiusPx: number, colour: Hsl): void {
  if (radiusPx < 6) return;
  ctx.lineWidth = 1;
  ctx.strokeStyle = css(colour, 0.16);
  ctx.beginPath();
  ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
  ctx.stroke();
}
