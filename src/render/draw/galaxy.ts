import { f01, hash3, hash4, mix, sm32 } from '../../core/rng.ts';
import { armDensity, type GalaxyTraits } from '../../universe/gen/galaxy.ts';
import { css, hslToRgb, shade, type Hsl } from '../color.ts';
import { outlineWidth, smoothstep } from '../bands.ts';
import { getScratch, getSpriteBudgeted, makeSurface, sizeBucket, type Sprite } from '../sprites.ts';

/**
 * Galaxies are SHAPES WITH OUTLINES, not particle fog. Fog is what makes every procedural space project
 * look identical, so a galaxy is filled ribbons, a bar, and a core -- continuous forms, all of them.
 *
 * NOTHING HERE DRAWS A STAR. Not one point, at any zoom. Every star on screen inside a galaxy is one of
 * that galaxy's catalogued systems: a node with an address, a name, and a place you can travel to. What
 * this file contributes is the light of the hundred billion stars too faint to resolve, as diffuse glow
 * -- which is not a lie about what is there, because glow is what unresolved starlight actually looks
 * like. A 2 px white dot is a lie: it promises a discrete thing you could aim at.
 *
 * All three representations -- blurred blob, baked wash, live arms -- are rendered from the same
 * `armDensity` field, which is why they cross-fade without a seam instead of morphing.
 */

/** The one place a gradient is allowed, plus the star bloom. Everywhere else: flat fills. */
function paintCore(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: GalaxyTraits): void {
  const p = t.palette;
  const coreR = Math.max(1.5, r * t.coreRadius * 1.6);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.2);
  g.addColorStop(0, css(p.PAPER, 0.95 * t.bulge));
  g.addColorStop(0.45, css(p.LIGHT, 0.4 * t.bulge));
  g.addColorStop(1, css(p.LIGHT, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 2.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = css(p.PAPER, 0.9);
  ctx.beginPath();
  ctx.ellipse(cx, cy, coreR, coreR * (1 - t.ellipticity * 0.3), t.tilt, 0, Math.PI * 2);
  ctx.fill();
}

interface SpinePoint {
  x: number;
  y: number;
  /** Half-width of the ribbon here, in galaxy units. */
  w: number;
}

/** Logarithmic spiral spine: r = coreRadius * e^(b*theta). */
function armSpine(t: GalaxyTraits, index: number, steps: number): SpinePoint[] {
  const b = Math.tan(t.pitch);
  const theta0 = t.armTwist + (index / t.arms) * Math.PI * 2;
  const out: SpinePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const theta = theta0 + u * t.sweep * Math.PI * 2;
    const radius = t.coreRadius * Math.exp(b * (theta - theta0));
    if (radius > 1.02) break;
    out.push({
      x: Math.cos(theta) * radius,
      y: Math.sin(theta) * radius,
      /**
       * The taper, and it is keyed on the point's own RADIUS rather than on how far along the sweep it
       * is. That distinction is the whole of the fix: an arm stops being traced the moment it reaches
       * the rim, which for a tightly wound galaxy happens a third of the way through its sweep, so
       * measuring the taper against the sweep left the tip barely wider than the root and the ribbon
       * read as a constant-width strap. Against radius, 0 is the core and 1 is the rim by definition.
       *
       * It is also the width `armDensity` uses. Its Gaussian is angular, of half-width
       * armWidth * (0.35 + radius^0.6) / radius, so multiplying back by the radius to get a
       * perpendicular distance gives exactly this expression -- which means the drawn ribbon and the
       * field the catalogued stars are rejection-sampled against are now the same shape. They were not,
       * and stars were landing beside their arms rather than in them.
       */
      w: t.armWidth * (0.35 + radius ** 0.6),
    });
  }
  return out;
}

/**
 * Unit normal to the spine at a point, from its neighbours. One definition, used by the ribbon's two
 * sides and by the dust lane, so a lane cannot end up offset along a different axis than the arm it
 * belongs to -- which is exactly what used to happen.
 */
function normalAt(spine: readonly SpinePoint[], idx: number): [number, number] {
  const prev = spine[Math.max(0, idx - 1)]!;
  const next = spine[Math.min(spine.length - 1, idx + 1)]!;
  const nx = -(next.y - prev.y);
  const ny = next.x - prev.x;
  const len = Math.hypot(nx, ny) || 1;
  return [nx / len, ny / len];
}

function ribbon(ctx: CanvasRenderingContext2D, spine: readonly SpinePoint[], scale: number, cx: number, cy: number): void {
  if (spine.length < 2) return;
  ctx.beginPath();
  const side = (sign: number) => {
    for (let i = 0; i < spine.length; i++) {
      const idx = sign > 0 ? i : spine.length - 1 - i;
      const p = spine[idx]!;
      const [nx, ny] = normalAt(spine, idx);
      const px = cx + (p.x + nx * p.w * sign) * scale;
      const py = cy + (p.y + ny * p.w * sign) * scale;
      if (i === 0 && sign > 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  };
  side(1);
  /**
   * A POINT AT THE TIP, not a blunt end.
   *
   * The arm is widest exactly where it stops, because the taper grows outward and the spine is cut off at the
   * rim -- so the ribbon closed with a straight edge a full arm's width across, square to the sweep, with two
   * sharp corners. It read as a strap that had been snipped off, which is the one shape a spiral arm is not.
   *
   * The point is added to the DRAWING only. The width itself is shared with `armDensity`, which is what the
   * catalogued stars are rejection-sampled against, and narrowing that would move every star near the rim --
   * which is to say it would change their addresses, and every permalink to one. Extending the outline by one
   * width along the tangent closes the cap without touching where anything lives.
   */
  const tip = spine[spine.length - 1]!;
  const before = spine[Math.max(0, spine.length - 2)]!;
  const tx = tip.x - before.x;
  const ty = tip.y - before.y;
  const len = Math.hypot(tx, ty);
  if (len > 1e-9) {
    ctx.lineTo(cx + (tip.x + (tx / len) * tip.w) * scale, cy + (tip.y + (ty / len) * tip.w) * scale);
  }
  side(-1);
  ctx.closePath();
}

function paintArms(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: GalaxyTraits): void {
  const p = t.palette;
  for (let i = 0; i < t.arms; i++) {
    const spine = armSpine(t, i, 48);
    ribbon(ctx, spine, r, cx, cy);
    ctx.fillStyle = css(p.MID, 0.85);
    ctx.fill();
    const w = outlineWidth(r, 1);
    if (w > 0) {
      ctx.lineWidth = w;
      ctx.strokeStyle = css(p.INK, 0.5);
      ctx.stroke();
    }
  }
  // Dust lanes: the same spine, offset ACROSS the arm, in the darkest role.
  for (let d = 0; d < t.dustLanes; d++) {
    const i = d % Math.max(1, t.arms);
    const spine = armSpine(t, i, 40);
    const lane = spine.map((s, idx) => {
      const [nx, ny] = normalAt(spine, idx);
      return { x: s.x + nx * DUST_LANE_OFFSET * s.w, y: s.y + ny * DUST_LANE_OFFSET * s.w, w: s.w * 0.42 };
    });
    ribbon(ctx, lane, r, cx, cy);
    ctx.fillStyle = css(p.DEEP, 0.6);
    ctx.fill();
  }
}

/**
 * Where a dust lane sits, as a multiple of the arm's own half-width, measured along the arm's NORMAL.
 *
 * The lane used to be built by scaling the spine radially by 0.94, and scaling a logarithmic spiral is
 * the same curve rotated: r = c*e^(b*theta) scaled by k is the identical spiral at theta + ln(k)/b. So
 * the "offset" slid the lane ALONG its arm instead of putting it beside one, and what should have been a
 * dark line down the inner edge of a ribbon came out as a dark ribbon lying in the gap between two arms.
 * Six tenths of a half-width leaves the lane inside the arm with its dark edge against the arm's own
 * inner boundary, which is where a dust lane is.
 */
const DUST_LANE_OFFSET = -0.6;

function paintBar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: GalaxyTraits): void {
  const p = t.palette;
  const len = t.barLength * r;
  const wid = t.barWidth * r;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t.armTwist);
  ctx.beginPath();
  roundedRect(ctx, -len, -wid, len * 2, wid * 2, wid);
  ctx.fillStyle = css(p.LIGHT, 0.92);
  ctx.fill();
  const w = outlineWidth(r, 1.5);
  if (w > 0) {
    ctx.lineWidth = w;
    ctx.strokeStyle = css(p.INK, 0.55);
    ctx.stroke();
  }
  ctx.restore();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Concentric flat contours. Reads like a Ben-Day contour map and costs almost nothing. */
function paintElliptical(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: GalaxyTraits): void {
  const p = t.palette;
  const ramp: Hsl[] = [p.DEEP, p.BODY, p.MID, p.LIGHT, p.PAPER];
  const n = Math.min(ramp.length, t.bands + 2);
  for (let i = 0; i < n; i++) {
    const f = 1 - i / n;
    const rx = r * f;
    const ry = rx * (1 - t.ellipticity * 0.8);
    const jx = (f01(mix(sm32(i * 7717), 3)) - 0.5) * r * 0.04;
    const jy = (f01(mix(sm32(i * 7717), 5)) - 0.5) * r * 0.04;
    ctx.beginPath();
    ctx.ellipse(cx + jx, cy + jy, Math.max(0.6, rx), Math.max(0.5, ry), t.tilt, 0, Math.PI * 2);
    ctx.fillStyle = css(ramp[Math.min(ramp.length - 1, i)]!, i === 0 ? 0.7 : 0.95);
    ctx.fill();
  }
  if (t.morphology === 'lenticular') {
    // A single dark line along the major axis is enough to make it instantly recognisable.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t.tilt);
    ctx.beginPath();
    ctx.ellipse(0, r * 0.06, r * 0.92, Math.max(0.5, r * 0.02), 0, 0, Math.PI * 2);
    ctx.fillStyle = css(t.palette.DEEP, 0.75);
    ctx.fill();
    ctx.restore();
  }
}

function paintBlobs(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: GalaxyTraits): void {
  const p = t.palette;
  const tones = [p.MID, p.LIGHT, p.PAPER];
  for (let pass = 0; pass < 3; pass++) {
    ctx.beginPath();
    for (let i = 0; i < t.blobs; i++) {
      const a = (i / t.blobs) * Math.PI * 2 * t.asymmetry + t.armTwist;
      const rr = 0.25 + ((i * 0.37) % 1) * 0.55;
      const bx = cx + Math.cos(a) * rr * r * (1 - pass * 0.08);
      const by = cy + Math.sin(a) * rr * r * (1 - pass * 0.08);
      const br = r * (0.3 - pass * 0.07) * (0.7 + ((i * 0.53) % 1) * 0.6);
      ctx.moveTo(bx + br, by);
      ctx.arc(bx, by, Math.max(0.6, br), 0, Math.PI * 2);
    }
    ctx.fillStyle = css(tones[pass]!, pass === 0 ? 0.8 : 0.5);
    ctx.fill();
  }
}

function paintRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: GalaxyTraits): void {
  const p = t.palette;
  const rr = t.ringRadius * r;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rr, rr * (1 - t.ellipticity * 0.5), t.tilt, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.strokeStyle = css(p.MID, 0.9);
  ctx.stroke();
  for (let i = 0; i < t.ringKnots; i++) {
    const a = t.armTwist + (i / t.ringKnots) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * (1 - t.ellipticity * 0.5), Math.max(1, r * 0.07), 0, Math.PI * 2);
    ctx.fillStyle = css(p.ACCENT, 0.95);
    ctx.fill();
  }
}

/** Everything except the stipple. Shared by the live path and the baked sprite. */
function paintStructure(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: GalaxyTraits): void {
  switch (t.morphology) {
    case 'elliptical':
    case 'lenticular':
      paintElliptical(ctx, cx, cy, r, t);
      return;
    case 'dwarfBlob':
    case 'irregular':
      paintBlobs(ctx, cx, cy, r, t);
      paintCore(ctx, cx, cy, r, t);
      return;
    case 'ring':
    case 'cartwheel':
      paintRing(ctx, cx, cy, r, t);
      paintCore(ctx, cx, cy, r, t);
      return;
    default:
      paintArms(ctx, cx, cy, r, t);
      if (t.morphology === 'barredSpiral') paintBar(ctx, cx, cy, r, t);
      paintCore(ctx, cx, cy, r, t);
  }
}

/**
 * The `blob` and `wash` representations are BAKED RENDERS OF THE SAME GALAXY, not hand-authored
 * stand-ins. That is what makes the crossfade invisible: the blurred shape already has this galaxy's
 * arm asymmetry and brightness profile, so there is nothing to morph into.
 */
export function galaxySprite(
  id: number,
  t: GalaxyTraits,
  requestPx: number,
  blurred: boolean,
): Sprite | null {
  const size = sizeBucket(requestPx * 2, 32, blurred ? 96 : 1024);
  const key = `galaxy:${id}:${size}:${blurred ? 'blob' : 'wash'}`;
  return getSpriteBudgeted(key, size, (ctx, s) => {
    const r = s / 2 - 2;
    if (blurred) {
      // Blur radius scales with the sprite, and the stipple is nearly pointless once blurred, so the
      // blob bake stays cheap -- it is paid for up to a few hundred galaxies at wide zoom.
      ctx.filter = `blur(${Math.max(2, s / 12).toFixed(1)}px)`;
    }
    paintStructure(ctx, s / 2, s / 2, r, t);
    ctx.filter = 'none';
  });
}

// --- The floor of the galaxy ladder ---------------------------------------------------------------

/**
 * Below this on-screen radius a galaxy stops attempting structure and becomes a single stamp.
 *
 * At eleven pixels across an arm is under half a pixel wide, so there is no arm to draw: the blob bake
 * spends a full structure render -- ribbons, bar, contours, a core gradient -- and then blurs the result
 * into a smudge that carries none of it, at exactly the zoom where a field puts a hundred galaxies on
 * screen at once. Under 5.5 px a galaxy is therefore one stamp, and the stamp is its own arm
 * distribution sampled straight from `armDensity`: the same field the ribbons are shaped from and the
 * same field the catalogued stars are placed against, so the smudge and the arms it grows into are one
 * object at two resolutions rather than two different pictures.
 */
export const GALAXY_ICON_MIN_PX = 5.5;
/**
 * Where the stamp has completely handed over to the blurred structure bake.
 *
 * At 13 px the blob's 32 px bake is finally being drawn at something near its own scale, so its blurred
 * structure has stopped being shrunk into mush and genuinely says more than sixteen samples of the field
 * can. The two ramps share both endpoints, so their alphas sum to exactly 1 across the handover.
 */
export const GALAXY_ICON_FULL_PX = 13;

/** Samples across the stamp's density field. 16 is finer than the stamp is ever drawn: 11 px across. */
const ICON_FIELD = 16;
/**
 * Sub-samples per cell, per axis.
 *
 * Point-sampling the field is wrong for exactly the galaxies this stamp exists for: a spiral's arms are
 * a twentieth of a radius wide, so at sixteen cells across a single probe either lands on an arm or
 * misses it and the stamp comes out as a scatter of unrelated dots at whatever phase the sampling
 * happened to catch. A cell has to carry the MEAN of the field over its own area, which is what a
 * downsample is. Four probes is where the stamp stops changing shape as the count rises, and it holds
 * the whole bake to about four tenths of a millisecond -- six of them inside one frame's bake budget.
 */
const ICON_SUPERSAMPLE = 2;

/**
 * How much brighter the painter is than the field it is drawn from.
 *
 * The two are not the same quantity and cannot be: `armDensity` is a smooth ridge with a tail, and
 * `paintStructure` fills a hard-edged shape over the ridge at a flat 0.85. Taking the field's value as
 * an alpha would make the stamp a third the weight of the blob it hands over to, so the galaxy would
 * brighten as you approached it -- a slow pop, which is still a pop.
 *
 * These two numbers are the measured ratio of painted ink to field mean, over two hundred galaxies. The
 * families differ because their painters do: a spiral fills ribbons that cover a fraction of its disc,
 * while an elliptical, a lenticular and a blob field cover nearly all of theirs. Within a family the
 * ratio holds to about a quarter of a stop, which is far below what reads as a change in brightness
 * across the factor of 2.4 in zoom the handover takes.
 */
function stampGain(t: GalaxyTraits): number {
  switch (t.morphology) {
    case 'elliptical':
    case 'lenticular':
    case 'dwarfBlob':
    case 'irregular':
      return 4;
    default:
      return 2.6;
  }
}

let iconImage: ImageData | null = null;
function iconBuffer(): ImageData {
  if (!iconImage) iconImage = new ImageData(ICON_FIELD, ICON_FIELD);
  return iconImage;
}

/**
 * The stamp: this galaxy's density field, in this galaxy's own palette, at sixteen samples across.
 *
 * Not a generic dot and not a blurred render of the arms -- the field itself, which is the thing both
 * the arms and the catalogued stars are drawn from. A ring galaxy stamps as a ring, a barred spiral
 * stamps brighter along its bar, and an off-centre irregular stamps off-centre.
 */
function galaxyIconSprite(id: number, t: GalaxyTraits, requestPx: number): Sprite | null {
  // The stamp is never drawn above GALAXY_ICON_FULL_PX, so one bucket serves its whole life.
  const size = sizeBucket(requestPx * 2, 32, 64);
  return getSpriteBudgeted(`galaxy:${id}:${size}:icon`, size, (ctx, s) => {
    const p = t.palette;
    const gain = stampGain(t);
    const [mr, mg, mb] = hslToRgb(p.MID.h, p.MID.s, p.MID.l);
    const [lr, lg, lb] = hslToRgb(p.LIGHT.h, p.LIGHT.s, p.LIGHT.l);
    const [pr, pg, pb] = hslToRgb(p.PAPER.h, p.PAPER.s, p.PAPER.l);
    const image = iconBuffer();
    const px = image.data;
    const sub = ICON_SUPERSAMPLE;
    const cell = 2 / ICON_FIELD;
    for (let j = 0; j < ICON_FIELD; j++) {
      for (let i = 0; i < ICON_FIELD; i++) {
        let acc = 0;
        for (let sj = 0; sj < sub; sj++) {
          const gy = -1 + j * cell + ((sj + 0.5) / sub) * cell;
          for (let si = 0; si < sub; si++) {
            acc += armDensity(t, -1 + i * cell + ((si + 0.5) / sub) * cell, gy);
          }
        }
        const density = acc / (sub * sub);
        /**
         * The same two-step tone ramp the structure painter uses -- MID for a ribbon, LIGHT where it is
         * bright, PAPER at the core -- so the stamp's colours are the colours it dissolves into. Read as
         * a continuous lerp only because this is a sampled field rather than a fill: no gradient object
         * exists here, exactly as in the interior wash below.
         */
        const hot = Math.max(0, Math.min(1, (density - 0.5) / 0.3));
        const white = Math.max(0, Math.min(1, (density - 0.8) / 0.2));
        const o = (j * ICON_FIELD + i) * 4;
        px[o] = mr + (lr - mr) * hot + (pr - lr) * white;
        px[o + 1] = mg + (lg - mg) * hot + (pg - lg) * white;
        px[o + 2] = mb + (lb - mb) * hot + (pb - lb) * white;
        px[o + 3] = Math.min(1, density * gain) * 0.85 * 255;
      }
    }
    const { surface, ctx: fctx } = getScratch(ICON_FIELD);
    fctx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(surface as CanvasImageSource, 0, 0, ICON_FIELD, ICON_FIELD, 0, 0, s, s);
  });
}

/** Draw one live galaxy at full detail. Used only when it is large on screen. */
export function drawGalaxyLive(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  t: GalaxyTraits,
): void {
  /**
   * STRUCTURE ONLY -- no stipple, and no hero stars.
   *
   * The baked sprite still stipples (see `drawGalaxySprite`), because at cluster zoom a galaxy is a
   * picture and its grain is part of the picture. Live, it must not: at this size the galaxy's own
   * catalogued systems are drawn as real, clickable stars, and painting a second population of
   * decorative dots over them is what produced "stars just seem to shoot past at random". Every star you
   * can see at galaxy zoom is now a place you can go to.
   */
  paintStructure(ctx, cx, cy, r, t);
  if (t.activeNucleus) {
    // Two jet cones, flat fills, no glow.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t.tilt + Math.PI / 2);
    ctx.fillStyle = css(shade(t.palette.ACCENT, t.palette.shadowHue, 0.2), 0.35);
    for (const sign of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-r * 0.12, sign * r * 1.35);
      ctx.lineTo(r * 0.12, sign * r * 1.35);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * One small surface the icon handover is mixed on. The band it is wanted in ends at thirteen pixels, so
 * this is a couple of kilobytes for the life of the page rather than a canvas per galaxy per frame.
 */
let handover: ReturnType<typeof makeSurface> | null = null;
let handoverSize = 0;

function handoverSurface(size: number): ReturnType<typeof makeSurface> {
  if (!handover || handoverSize < size) {
    handover = makeSurface(size);
    handoverSize = size;
  }
  return handover;
}

/**
 * Blit a cached galaxy sprite, handing over to the icon stamp at the small end.
 *
 * Whatever is missing is filled with the flat stand-in AT ITS OWN SHARE rather than left to the caller.
 * The caller's fallback would repaint the whole galaxy at full strength on top of the half that did
 * arrive, which is a brighter galaxy for however many frames the bake queue takes -- and a galaxy that
 * dims as it sharpens is a pop like any other. So this always draws exactly one galaxy's worth of ink
 * and returns true.
 *
 * WHICH IS WHY THE TWO SHARES ARE MIXED OFF SCREEN. Alphas that sum to one do not make INK that sums to
 * one: laid one over the other, two layers at a and 1-a cover 1 - (1 - a * u)(1 - (1 - a) * v) of a
 * pixel, which is short of the a * u + (1 - a) * v they should by the product of the two. Where both
 * pictures are solid -- the whole disc of an elliptical, the core of a spiral -- that is a quarter of the
 * galaxy's ink lost to the void at the middle of the handover, a slow dim and recover in the one range
 * where the two representations are meant to be indistinguishable. Composited on their own surface with
 * `lighter`, which sums PREMULTIPLIED colour and alpha, the mix is a weighted mean of two pictures
 * instead of one over the other, and the void is nowhere in it. The blit back is integer-aligned with
 * the fractional part of the position carried by the drawings, so nothing is resampled twice.
 */
export function drawGalaxySprite(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  id: number,
  t: GalaxyTraits,
  blurred: boolean,
): boolean {
  // Only the blurred blob has a floor beneath it; by the time the wash is live the icon is long gone.
  const iconShare = blurred ? 1 - smoothstep(GALAXY_ICON_MIN_PX, GALAXY_ICON_FULL_PX, r) : 0;

  // Outside the handover only one of the two is on screen, and one picture composites correctly alone.
  if (iconShare <= 1 / 255) {
    const sprite = galaxySprite(id, t, Math.max(8, r), blurred);
    if (sprite) ctx.drawImage(sprite.canvas as CanvasImageSource, cx - r, cy - r, r * 2, r * 2);
    else drawGalaxyStandIn(ctx, cx, cy, r, t);
    return true;
  }
  if (iconShare >= 1 - 1 / 255) {
    const only = galaxyIconSprite(id, t, Math.max(4, r));
    if (only) ctx.drawImage(only.canvas as CanvasImageSource, cx - r, cy - r, r * 2, r * 2);
    else drawGalaxyStandIn(ctx, cx, cy, r, t);
    return true;
  }

  // Either may still be queued for baking, and what is available decides how the mix is put together.
  const icon = galaxyIconSprite(id, t, Math.max(4, r));
  const blob = galaxySprite(id, t, Math.max(8, r), blurred);
  if (!icon && !blob) {
    // One stand-in serves both shares, and a share of a picture plus the rest of it is that picture.
    drawGalaxyStandIn(ctx, cx, cy, r, t);
    return true;
  }

  const half = Math.ceil(r) + 1;
  const size = half * 2;
  const s = handoverSurface(size);
  const ix = Math.floor(cx) - half;
  const iy = Math.floor(cy) - half;
  const mx = half + (cx - Math.floor(cx));
  const my = half + (cy - Math.floor(cy));

  s.ctx.clearRect(0, 0, size, size);
  if (icon && blob) {
    // A single image at a global alpha IS that image scaled, so each share can be laid straight down.
    s.ctx.globalAlpha = iconShare;
    s.ctx.drawImage(icon.canvas as CanvasImageSource, mx - r, my - r, r * 2, r * 2);
    s.ctx.globalCompositeOperation = 'lighter';
    s.ctx.globalAlpha = 1 - iconShare;
    s.ctx.drawImage(blob.canvas as CanvasImageSource, mx - r, my - r, r * 2, r * 2);
  } else {
    /**
     * The stand-in is several overlapping fills rather than one image, so it cannot be scaled by a
     * global alpha -- two overlapping fills at a half come out at three quarters, not a half. It is
     * drawn whole and the finished picture is then scaled by `destination-in`, which multiplies what is
     * already there by a flat alpha. It goes first because only the second layer has to be one image,
     * and a sum does not care which way round it is written.
     */
    const sprite = icon ?? blob!;
    const standShare = icon ? 1 - iconShare : iconShare;
    drawGalaxyStandIn(s.ctx, mx, my, r, t);
    s.ctx.globalCompositeOperation = 'destination-in';
    s.ctx.fillStyle = `rgba(0,0,0,${standShare})`;
    s.ctx.fillRect(0, 0, size, size);
    s.ctx.globalCompositeOperation = 'lighter';
    s.ctx.globalAlpha = 1 - standShare;
    s.ctx.drawImage(sprite.canvas as CanvasImageSource, mx - r, my - r, r * 2, r * 2);
  }
  s.ctx.globalAlpha = 1;
  s.ctx.globalCompositeOperation = 'source-over';

  ctx.drawImage(s.surface as CanvasImageSource, 0, 0, size, size, ix, iy, size, size);
  return true;
}

/**
 * The stand-in used while a sprite is still queued: a flat ellipse in the galaxy's own MID role at its
 * own ellipticity and tilt. Same colour, same footprint, so the sprite arriving reads as sharpening
 * rather than as something appearing.
 */
export function drawGalaxyStandIn(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  t: GalaxyTraits,
): void {
  ctx.fillStyle = css(t.palette.MID, 0.5);
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.8, r * 0.8 * (1 - t.ellipticity * 0.5), t.tilt, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = css(t.palette.PAPER, 0.7);
  const cr = Math.max(0.6, r * t.coreRadius * 1.4);
  ctx.beginPath();
  ctx.arc(cx, cy, cr, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * SCALE QUANTISATION -- what keeps the diffuse glow from boiling as you zoom.
 *
 * The first version derived its noise frequency from the viewport span, with a comment saying this kept
 * features still "while panning". That was true, and it missed the gesture people actually use: while
 * ZOOMING the span changes every frame, so the field rescaled every frame and every feature moved. Back
 * when this also drove a point starfield the symptom was unmissable -- stars shooting past at random,
 * because the field was being re-randomised sixty times a second.
 *
 * The fix is to anchor everything to POWERS OF TWO in galaxy space, so a given level's features have
 * fixed positions no matter how the camera moves, and to blend two adjacent levels with weights that
 * form a partition of unity in log space:
 *
 *     w(n) = max(0, 1 - |nf - n|)      sums to exactly 1 for any nf
 *
 * Only two levels are ever non-zero. Coarse features drift outward with correct parallax and dim as they
 * spread; finer ones fade in between them, so descending reveals detail instead of replacing it.
 */
export function scaleLevels(nf: number): [number, number, number] {
  const n0 = Math.floor(nf);
  const frac = nf - n0;
  return [n0, 1 - frac, frac];
}

/** Smooth value noise on a lattice of the given level, anchored in galaxy space. */
function noiseAtLevel(x: number, y: number, level: number, salt: number): number {
  const f = 2 ** level;
  const px = x * f;
  const py = y * f;
  const xi = Math.floor(px);
  const yi = Math.floor(py);
  const fx = px - xi;
  const fy = py - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (i: number, j: number) => f01(hash4(i, j, level, salt));
  const a = at(xi, yi);
  const b = at(xi + 1, yi);
  const c = at(xi, yi + 1);
  const d = at(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Two octaves anchored at a fixed level, so the texture does not swim as the camera moves. */
function cloudAt(x: number, y: number, level: number): number {
  return noiseAtLevel(x, y, level, 0x9e37) * 0.62 + noiseAtLevel(x, y, level - 1, 0x51a3) * 0.38;
}

/**
 * The angle the galaxy's own form is drawn at.
 *
 * The diffuse glow's noise lattice is axis-aligned, and the axes it aligns to are the frame's, not the
 * galaxy's -- so the grain of the interstellar medium ran across the arms rather than with them, and a
 * lenticular's dark lane cut across its own texture at whatever angle its tilt happened to be. Turning
 * the lattice by this makes the grain belong to the galaxy: every galaxy gets its own weave, fixed to
 * its own form, and the arms no longer slide over a texture that is holding still behind them.
 *
 * Which angle IS the orientation depends on the form: a spiral, a bar and a blob field are all laid out
 * from `armTwist`, and only the smooth ellipsoids are drawn at `tilt`.
 */
export function galaxyOrientation(t: GalaxyTraits): number {
  return t.morphology === 'elliptical' || t.morphology === 'lenticular' ? t.tilt : t.armTwist;
}

const WASH_W = 64;
const WASH_H = 40;

/**
 * One reused pixel buffer for the glow. `getImageData` would hand back a fresh 10 KB array every frame,
 * which is 600 KB a second of garbage for a buffer whose size never changes.
 */
let wash: ImageData | null = null;
function washBuffer(): ImageData {
  if (!wash) wash = new ImageData(WASH_W, WASH_H);
  return wash;
}
/** Target on-screen size of one feature of the diffuse glow, in pixels. */
const CLOUD_FEATURE_PX = 300;
/**
 * Must stay equal to the `arms` band's fade-out range in bands.ts: arm structure leaving and diffuse glow
 * taking over are two halves of one crossfade, and if the numbers drift apart there is a stretch of zoom
 * where neither carries the view.
 */
const ARMS_FADE_PX: readonly [number, number] = [420, 1700];

/**
 * The depth at which the diffuse glow stops resolving finer -- and the one place in this project that
 * needed a limit like this.
 *
 * Everything else navigates by a focus frame normalised to radius 1, precisely so no coordinate ever has
 * to carry 76 bits of range. The sky is the exception: it is sampled in absolute GALAXY units, so its
 * detail level grows without bound as you descend, and by planet depth a noise cell index came out around
 * 2^57. Float64 holds integers exactly only to 2^53; past that, adjacent doubles are 4 or more apart, so
 * `i++` leaves `i` unchanged. When the old point starfield counted through cells that way it spun
 * forever, and zooming in on a planet anywhere but the exact galactic centre locked the tab up hard. The
 * points are gone now, but the interpolated noise degenerates on the same boundary, so the cap stays.
 *
 * It is also the physically honest answer: from inside a solar system, moving a few thousand kilometres
 * does not change what the rest of the galaxy looks like. Below this depth the sky stops subdividing and
 * stops parallaxing -- it is widened by the same factor the zoom narrowed it, which holds it fixed.
 * Level 44 leaves eight bits of headroom at the finest level the glow samples.
 */
export const MAX_SKY_DETAIL_LEVEL = 44;

/**
 * The sky's bounds in galaxy units, widened if we are past the freeze depth.
 *
 * Takes a CENTRE and a HALF-EXTENT rather than two edges, and that is not a style preference: at region
 * depth the half-extent is about 2^-54 galaxy units, so `nx - halfW` and `nx + halfW` round to the same
 * double and their difference is exactly zero. Deriving the scale from that zero gave a detail level of
 * 1001 and cell indices around 2e300, which is how the freeze got bypassed and the hang came back four
 * rungs further down. The scale has to come from `halfW` itself, which never underflows.
 */
export function skyBounds(
  nx: number,
  ny: number,
  halfW: number,
  halfH: number,
  viewW: number,
): { x0: number; x1: number; y0: number; y1: number; pxPerUnit: number; rawPxPerUnit: number } {
  const rawPxPerUnit = viewW / (2 * Math.max(Number.MIN_VALUE, halfW));
  const freeze = skyFreeze(rawPxPerUnit);
  const hw = halfW * freeze;
  const hh = halfH * freeze;
  return {
    x0: nx - hw,
    x1: nx + hw,
    y0: ny - hh,
    y1: ny + hh,
    pxPerUnit: rawPxPerUnit / freeze,
    rawPxPerUnit,
  };
}

/**
 * How much to widen the sky so its noise never samples past MAX_SKY_DETAIL_LEVEL. 1 means "not frozen
 * yet". Exported so a test can assert the resulting cell indices stay exact integers.
 */
export function skyFreeze(rawPxPerUnit: number): number {
  return Math.max(1, rawPxPerUnit / (CLOUD_FEATURE_PX * 2 ** MAX_SKY_DETAIL_LEVEL));
}

/** The detail level the glow settles on, given the galaxy's true radius in pixels. */
export function skyDetailLevel(rawPxPerUnit: number): number {
  return Math.floor(Math.log2(rawPxPerUnit / skyFreeze(rawPxPerUnit) / CLOUD_FEATURE_PX));
}

export function drawGalaxyInterior(
  ctx: CanvasRenderingContext2D,
  t: GalaxyTraits,
  /**
   * The viewport in GALAXY units, as a centre and a half-extent. Never as two edges: see `skyBounds`
   * for what goes wrong when the two edges are the same double.
   */
  nx: number,
  ny: number,
  halfW: number,
  halfH: number,
  viewW: number,
  viewH: number,
): void {
  const { x0, x1, y0, y1, pxPerUnit, rawPxPerUnit } = skyBounds(nx, ny, halfW, halfH, viewW);

  // Nothing to draw if the viewport has left the galaxy entirely.
  const nearestX = Math.max(x0, Math.min(0, x1));
  const nearestY = Math.max(y0, Math.min(0, y1));
  if (Math.hypot(nearestX, nearestY) > 1.05) return;

  /**
   * The glow strengthens exactly as the arm ribbons fade out, so the two are one crossfade rather than
   * two independent knobs. Out at galaxy zoom the ribbons are the picture and the glow is a hint between
   * them; deep inside, the ribbons are gone and the glow IS the picture -- the light of every star too
   * faint to have its own entry in the catalogue.
   */
  const deep = smoothstep(ARMS_FADE_PX[0], ARMS_FADE_PX[1], rawPxPerUnit);

  const [cloudLevel, wCoarse, wFine] = scaleLevels(Math.log2(pxPerUnit / CLOUD_FEATURE_PX));

  const { surface, ctx: wctx } = getScratch(WASH_W);
  const p = t.palette;
  const [gr, gg, gb] = hslToRgb(p.MID.h, p.MID.s, p.MID.l);
  const [br, bg, bb] = hslToRgb(p.LIGHT.h, p.LIGHT.s, p.LIGHT.l);

  /**
   * EVERY CELL GETS WRITTEN, AND NOTHING IS THRESHOLDED. The field is magnified about twenty times on its
   * way to the screen, so any discontinuity in it -- a skipped cell, a hue that flips at a cutoff --
   * becomes a hard stair-stepped edge dozens of pixels long. Two earlier shortcuts did exactly that: cells
   * below a density floor were skipped entirely, and the tone snapped from MID to LIGHT at a texture of
   * 0.72. Deep inside a galaxy that produced blocky slabs of colour.
   *
   * Written straight into an ImageData buffer, not with fillRect. Once nothing is skipped that is 2,560
   * cells every frame, and a fillRect each with its own alpha and fillStyle spent more time changing
   * canvas state than filling pixels -- it doubled the cost of a galaxy frame on its own.
   */
  // The lattice turns with the galaxy, so its grain lies along the arms instead of across them.
  const spin = galaxyOrientation(t);
  const cosT = Math.cos(spin);
  const sinT = Math.sin(spin);

  const image = washBuffer();
  const px = image.data;
  for (let j = 0; j < WASH_H; j++) {
    const gy = y0 + ((j + 0.5) / WASH_H) * (y1 - y0);
    for (let i = 0; i < WASH_W; i++) {
      const gx = x0 + ((i + 0.5) / WASH_W) * (x1 - x0);
      const density = armDensity(t, gx, gy);
      // Into the galaxy's own frame for the noise only: `armDensity` already carries its orientation.
      const lx = gx * cosT + gy * sinT;
      const ly = gy * cosT - gx * sinT;
      const texture = cloudAt(lx, ly, cloudLevel) * wCoarse + cloudAt(lx, ly, cloudLevel + 1) * wFine;
      // Diffuse, unresolved emission: dim and additive, never a covering layer.
      const a = Math.min(0.5, density * (0.25 + 0.75 * texture) * (0.26 + 0.09 * deep));
      // The bright cores of the clouds blend in continuously rather than switching tone at a threshold.
      const hot = Math.max(0, Math.min(1, (texture - 0.58) / 0.42));
      const o = (j * WASH_W + i) * 4;
      px[o] = gr + (br - gr) * hot;
      px[o + 1] = gg + (bg - gg) * hot;
      px[o + 2] = gb + (bb - gb) * hot;
      px[o + 3] = a * 255;
    }
  }
  wctx.putImageData(image, 0, 0);

  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  // Emission adds to the void rather than painting over it.
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.72;
  ctx.drawImage(surface as CanvasImageSource, 0, 0, WASH_W, WASH_H, 0, 0, viewW, viewH);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = smoothing;
}
