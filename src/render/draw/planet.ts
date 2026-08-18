import { phase, simTime } from '../../core/clock.ts';
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

/** Continents, drawn in the same rotating longitude frame the surface will eventually use. */
function paintContinents(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  t: PlanetTraits,
  id: number,
  s: Surface,
): void {
  const count = 4 + Math.floor(f01(hash2(id, 0x31)) * 6);
  const spin = (t.retrograde ? -1 : 1) * phase(t.dayLength) * Math.PI * 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  for (let i = 0; i < count; i++) {
    const lon = f01(hash3(id, 0x32, i)) * Math.PI * 2 + spin;
    const lat = (f01(hash3(id, 0x33, i)) * 2 - 1) * 0.85;
    // Orthographic: a continent on the far side is simply off-disc.
    const px = Math.sin(lon) * Math.cos(lat * 1.2);
    if (Math.cos(lon) < -0.15) continue;
    const py = lat;
    const size = r * (0.16 + f01(hash3(id, 0x34, i)) * 0.3) * (1 - t.waterFraction * 0.45);
    // Squash towards the limb, which is all the sphericity a cartoon needs.
    const squash = Math.max(0.15, Math.cos(lon));
    ctx.save();
    ctx.translate(cx + px * r, cy + py * r);
    ctx.scale(squash, 1);
    blobPath(ctx, 0, 0, size, hash3(id, 0x35, i));
    ctx.fillStyle = css(s.land);
    ctx.fill();
    // A coastline in ink, not black: the outline is what makes flat fills read as drawn rather than as
    // an untextured 3D render. Width is corrected for the squash so it stays even around the limb.
    const w = outlineWidth(size, 2);
    if (w > 0) {
      ctx.lineWidth = w / squash;
      ctx.strokeStyle = css(s.coast, 0.85);
      ctx.stroke();
    }
    ctx.restore();
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

function paintCaps(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: PlanetTraits, id: number, s: Surface): void {
  if (t.snowIndex <= 0.02) return;
  const capLat = 1 - Math.min(0.95, 0.62 * t.snowIndex + 0.08);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = css(s.ice, 0.95);
  for (const sign of [-1, 1]) {
    blobPath(ctx, cx, cy + sign * r * (capLat + 0.55), r * 0.85, hash3(id, 0x51, sign), 9, 0.14);
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

function paintClouds(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: PlanetTraits, id: number, s: Surface): void {
  if (t.cloudCover <= 0.04) return;
  const count = 2 + Math.floor(t.cloudCover * 4);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = css(s.cloud, 0.42 + t.cloudCover * 0.3);
  for (let i = 0; i < count; i++) {
    const lat = (f01(hash3(id, 0x61, i)) * 2 - 1) * 0.75;
    // Clouds drift and wrap. This single animation does more for "alive" than anything else here.
    const speed = 0.05 + f01(hash3(id, 0x62, i)) * 0.09;
    const x = (((simTime() * speed + f01(hash3(id, 0x63, i))) % 2) - 1) * 1.6;
    const w = r * (0.3 + f01(hash3(id, 0x64, i)) * 0.45);
    const h = r * (0.05 + f01(hash3(id, 0x65, i)) * 0.07);
    ctx.beginPath();
    ctx.ellipse(cx + x * r, cy + lat * r, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The terminator, and the one trick worth spelling out: a hard-edged crescent made with nonzero
 * winding. Fill the disc's bounding box, subtract an offset ellipse traced in the opposite direction,
 * and clip to the disc. No feather, no gradient.
 */
function paintTerminator(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: PlanetTraits, s: Surface): void {
  const light = t.starLight;
  const lx = Math.cos(light.azimuth);
  const ly = Math.sin(light.azimuth);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.beginPath();
  ctx.rect(cx - r * 1.2, cy - r * 1.2, r * 2.4, r * 2.4);
  ctx.ellipse(cx + lx * r * 0.55, cy + ly * r * 0.55, r * 1.05, r * 1.05, 0, 0, Math.PI * 2, true);
  // Night is genuinely dark. A timid terminator reads as a smudge rather than as a day/night line.
  ctx.fillStyle = css(shade(s.sea, light.shadowHue, 1), 0.74);
  ctx.fill();
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

  if (t.hasRings) paintRings(ctx, cx, cy, r, t, s, false);

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
  paintTerminator(ctx, cx, cy, r, t, s);

  // Rim light on the star side: one arc, flat, no glow.
  if (r > 8) {
    ctx.lineWidth = Math.max(1, r * 0.045);
    ctx.strokeStyle = css(atLuminance(light.colour, 0.86), 0.6);
    ctx.beginPath();
    ctx.arc(cx, cy, r - ctx.lineWidth * 0.5, light.azimuth - 1.2, light.azimuth + 1.2);
    ctx.stroke();
  }

  // Cartoon atmosphere: an offset outline, not a fog. Capped, because scaling it with the radius gave
  // a ten-pixel grey rim that read as the edge of a dinner plate.
  if (t.atmDensity > 0.15 && r > 5) {
    ctx.lineWidth = Math.min(4, Math.max(1, r * 0.02)) * Math.min(1, t.atmDensity);
    ctx.strokeStyle = css({ h: t.atmHue, s: 0.5, l: 0.7 }, 0.35);
    ctx.beginPath();
    ctx.arc(cx, cy, r + ctx.lineWidth, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (t.hasRings) paintRings(ctx, cx, cy, r, t, s, true);

  const w = outlineWidth(r, 2.5);
  if (w > 0) {
    ctx.lineWidth = w;
    ctx.strokeStyle = css(shade(s.sea, light.shadowHue, 1.4), 0.8);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function paintRings(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  t: PlanetTraits,
  s: Surface,
  front: boolean,
): void {
  // Rings are ice a few tens of metres thick seen edge-on: delicate, not slabs of plastic. Four thin
  // bands with real gaps between them, at low alpha, read as rings; three fat opaque ones read as a
  // toy hoop.
  const inner = r * 1.28;
  const outer = inner + r * (0.3 + t.ringWidth * 0.55);
  const ry = t.ringTilt;
  const bands = 4;
  const tones = [s.cloud, s.ice, s.landShade, s.ice];
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < bands; i++) {
    const slot = (outer - inner) / bands;
    const a = inner + slot * i;
    const b = a + slot * 0.56;
    ctx.beginPath();
    ctx.ellipse(0, 0, b, b * ry, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
    ctx.ellipse(0, 0, a, a * ry, 0, front ? Math.PI : Math.PI * 2, front ? 0 : Math.PI, true);
    ctx.closePath();
    // The near half is translucent: it passes in front of the planet, and an opaque band there
    // reads as a scratch across the disc rather than as ice.
    ctx.fillStyle = css(tones[i % tones.length]!, front ? 0.3 : 0.34);
    ctx.fill();
  }
  ctx.restore();
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
    // Too small for any of the detail to survive. A flat disc, a lit crescent, and a dark rim: enough
    // to read as a body on a diagram rather than as another star in the field behind it.
    const s = surfaceColours(t);
    ctx.fillStyle = css(s.land);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = css(atLuminance(t.starLight.colour, 0.82), 0.55);
    ctx.beginPath();
    ctx.arc(
      cx + Math.cos(t.starLight.azimuth) * r * 0.33,
      cy + Math.sin(t.starLight.azimuth) * r * 0.33,
      r * 0.55,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = css(shade(s.sea, t.starLight.shadowHue, 1.5), 0.85);
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
