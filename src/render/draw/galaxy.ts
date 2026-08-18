import { f01, hash3, hash4, mix, sm32 } from '../../core/rng.ts';
import { armDensity, type GalaxyTraits } from '../../universe/gen/galaxy.ts';
import { css, shade, type Hsl } from '../color.ts';
import { outlineWidth, smoothstep } from '../bands.ts';
import { getScratch, getSpriteBudgeted, sizeBucket, type Sprite } from '../sprites.ts';

/**
 * Galaxies are SHAPES WITH OUTLINES, not particle fog. Fog is what makes every procedural space
 * project look identical, so arms are drawn as filled ribbons first and stars stippled on top second.
 *
 * All three representations -- blurred blob, baked wash, individual arms -- are rendered from the same
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

/** Logarithmic spiral spine: r = coreRadius * e^(b*theta). */
function armSpine(t: GalaxyTraits, index: number, steps: number): { x: number; y: number; w: number }[] {
  const b = Math.tan(t.pitch);
  const theta0 = t.armTwist + (index / t.arms) * Math.PI * 2;
  const out: { x: number; y: number; w: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const theta = theta0 + u * t.sweep * Math.PI * 2;
    const radius = t.coreRadius * Math.exp(b * (theta - theta0));
    if (radius > 1.02) break;
    out.push({
      x: Math.cos(theta) * radius,
      y: Math.sin(theta) * radius,
      // Arms broaden outwards; this matches the width used by armDensity.
      w: t.armWidth * (0.35 + u ** 0.6),
    });
  }
  return out;
}

function ribbon(ctx: CanvasRenderingContext2D, spine: { x: number; y: number; w: number }[], scale: number, cx: number, cy: number): void {
  if (spine.length < 2) return;
  ctx.beginPath();
  const side = (sign: number) => {
    for (let i = 0; i < spine.length; i++) {
      const idx = sign > 0 ? i : spine.length - 1 - i;
      const p = spine[idx]!;
      const prev = spine[Math.max(0, idx - 1)]!;
      const next = spine[Math.min(spine.length - 1, idx + 1)]!;
      let nx = -(next.y - prev.y);
      let ny = next.x - prev.x;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      const px = cx + (p.x + nx * p.w * sign) * scale;
      const py = cy + (p.y + ny * p.w * sign) * scale;
      if (i === 0 && sign > 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  };
  side(1);
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
  // Dust lanes: the same spine, offset inwards, in the darkest role.
  for (let d = 0; d < t.dustLanes; d++) {
    const i = d % Math.max(1, t.arms);
    const spine = armSpine(t, i, 40).map((s) => ({ ...s, w: s.w * 0.42 }));
    const shifted = spine.map((s) => ({ x: s.x * 0.94, y: s.y * 0.94, w: s.w }));
    ribbon(ctx, shifted, r, cx, cy);
    ctx.fillStyle = css(p.DEEP, 0.6);
    ctx.fill();
  }
}

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

/** Stars stippled inside the density field, as fillRects -- never arcs, which cost several times more. */
function paintStars(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: GalaxyTraits, budget: number): number {
  const p = t.palette;
  const tones = [css(p.PAPER, 0.95), css(p.LIGHT, 0.9), css(p.ACCENT, 0.85), css(p.MID, 0.8)];
  const want = Math.min(budget, t.starCount);
  let drawn = 0;
  let h = sm32(0x51a55);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < want * 3 && drawn < want; i++) {
    h = sm32(h);
    const x = f01(h) * 2 - 1;
    h = sm32(h);
    const y = f01(h) * 2 - 1;
    h = sm32(h);
    if (f01(h) > armDensity(t, x, y)) continue;
    h = sm32(h);
    const size = 1 + Math.floor(f01(h) * 2.4);
    ctx.fillStyle = tones[(h >>> 11) % tones.length]!;
    ctx.fillRect(cx + x * r - size / 2, cy + y * r - size / 2, size, size);
    drawn++;
  }
  ctx.globalCompositeOperation = 'source-over';
  return drawn;
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
    paintStars(ctx, s / 2, s / 2, r, t, blurred ? 40 : 1400);
    ctx.filter = 'none';
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
 * Blit a cached galaxy sprite. Returns false if the sprite is not baked yet, so the caller can draw a
 * flat stand-in instead of leaving a hole.
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
  const sprite = galaxySprite(id, t, Math.max(8, r), blurred);
  if (!sprite) return false;
  ctx.drawImage(sprite.canvas as CanvasImageSource, cx - r, cy - r, r * 2, r * 2);
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
 * SCALE QUANTISATION -- the idea both the cloud and the starfield depend on.
 *
 * The first version derived its lattice spacing and its noise frequency from the viewport span, with a
 * comment saying this kept stars still "while panning". That was true, and it missed the gesture people
 * actually use: while ZOOMING the span changes every frame, so the lattice rescaled every frame and
 * every star jumped to a new position. The reported symptom was stars shooting past at random, and that
 * is exactly what it was -- the field was being re-randomised sixty times a second.
 *
 * The fix is to anchor everything to POWERS OF TWO in galaxy space, so a given level's features have
 * fixed positions no matter how the camera moves, and to blend two adjacent levels with weights that
 * form a partition of unity in log space:
 *
 *     w(n) = max(0, 1 - |nf - n|)      sums to exactly 1 for any nf
 *
 * Only two levels are ever non-zero. Coarse features drift outward with correct parallax and dim as
 * they spread; finer ones fade in between them. That is what an infinite starfield actually looks like.
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
 * Clustering weight for stars. One octave, not two: stars only need to gather where the cloud is thick,
 * and this runs once per lattice cell per level -- the single hottest loop in the renderer.
 */
function clusterAt(x: number, y: number, level: number): number {
  return noiseAtLevel(x, y, level, 0x9e37);
}

const WASH_W = 64;
const WASH_H = 40;
/** Target on-screen size of one cloud feature and one starfield cell, in pixels. */
const CLOUD_FEATURE_PX = 300;
const STAR_PITCH_PX = 38;

/**
 * Must stay equal to the `arms` band's fade-out range in bands.ts: arm structure leaving and unresolved
 * haze arriving are two halves of one crossfade, and if the numbers drift apart there is a stretch of
 * zoom where neither is drawn.
 */
const ARMS_FADE_PX: readonly [number, number] = [420, 1700];

/**
 * The depth at which the sky stops resolving finer -- and the one place in this project that needed a
 * limit like this.
 *
 * Everything else navigates by a focus frame normalised to radius 1, precisely so no coordinate ever has
 * to carry 76 bits of range. The starfield broke that rule: its lattice is indexed in absolute GALAXY
 * units, and by planet depth a cell index came out around 2^57. Float64 holds integers exactly only to
 * 2^53; past that, adjacent doubles are 4 or more apart, so `i++` leaves `i` unchanged and
 * `for (let i = i0; i <= i1; i++)` spins forever. Zooming in on a planet anywhere but the exact galactic
 * centre locked the tab up hard.
 *
 * The fix is also the physically honest answer: stars are effectively at infinity. Moving a few thousand
 * kilometres inside a solar system does not shift the constellations, so below this depth the lattice
 * stops subdividing and the field stops parallaxing -- the sky is widened by the same factor the zoom
 * narrowed it, which holds it fixed on screen. Level 44 leaves nine bits of headroom at the deepest
 * index the two drawn levels can reach.
 */
export const MAX_LATTICE_LEVEL = 44;

/**
 * The sky's bounds in galaxy units, widened if we are past the freeze depth.
 *
 * Takes a CENTRE and a HALF-EXTENT rather than two edges, and that is not a style preference: at region
 * depth the half-extent is about 2^-54 galaxy units, so `nx - halfW` and `nx + halfW` round to the same
 * double and their difference is exactly zero. Deriving the scale from that zero gave a lattice level of
 * 1001 and cell indices around 2e300, which is how the freeze got bypassed and the hang came back at a
 * level further down. The scale has to come from `halfW` itself, which never underflows.
 */
export function skyBounds(
  nx: number,
  ny: number,
  halfW: number,
  halfH: number,
  viewW: number,
): { x0: number; x1: number; y0: number; y1: number; pxPerUnit: number; rawPxPerUnit: number } {
  const rawPxPerUnit = viewW / (2 * Math.max(Number.MIN_VALUE, halfW));
  const freeze = latticeFreeze(rawPxPerUnit);
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
 * How much to widen the sky so its lattice never subdivides past MAX_LATTICE_LEVEL. 1 means "not frozen
 * yet". Exported so a test can assert the resulting cell indices stay exact integers.
 */
export function latticeFreeze(rawPxPerUnit: number): number {
  return Math.max(1, rawPxPerUnit / (STAR_PITCH_PX * 2 ** MAX_LATTICE_LEVEL));
}

/** The lattice level the sky settles on, given the galaxy's true radius in pixels. */
export function latticeLevel(rawPxPerUnit: number): number {
  return Math.floor(Math.log2(rawPxPerUnit / latticeFreeze(rawPxPerUnit) / STAR_PITCH_PX));
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
   * Unresolved points belong only where the galaxy is far larger than the screen -- deep between the
   * stars, where no individual star is a plausible destination and the sky is genuinely a haze.
   *
   * At galaxy zoom the galaxy's own catalogued systems are drawn as real stars, and adding a second,
   * unreachable population on top of them is what made pointing at a star do nothing: most of the stars
   * you could see went nowhere. So the haze fades in over exactly the range the arm ribbons fade out, by
   * which point the catalogued stars have grown to their capped symbol size and carry haloes and
   * sparkles. A 12 px star with a halo beside a 1 px speck is not a target anyone confuses.
   *
   * `rawPxPerUnit` IS the galaxy's radius in pixels, because a galaxy is one unit of its own space.
   */
  const hazeAlpha = smoothstep(ARMS_FADE_PX[0], ARMS_FADE_PX[1], rawPxPerUnit);

  const [cloudLevel, wCoarse, wFine] = scaleLevels(Math.log2(pxPerUnit / CLOUD_FEATURE_PX));

  const { surface, ctx: wctx } = getScratch(WASH_W);
  const p = t.palette;
  const glow = css(p.MID, 1);
  const bright = css(p.LIGHT, 1);

  for (let j = 0; j < WASH_H; j++) {
    const gy = y0 + ((j + 0.5) / WASH_H) * (y1 - y0);
    for (let i = 0; i < WASH_W; i++) {
      const gx = x0 + ((i + 0.5) / WASH_W) * (x1 - x0);
      const density = armDensity(t, gx, gy);
      if (density <= 0.02) continue;
      const texture =
        cloudAt(gx, gy, cloudLevel) * wCoarse + cloudAt(gx, gy, cloudLevel + 1) * wFine;
      // Diffuse, unresolved emission: dim and additive, never a covering layer.
      const a = density * (0.25 + 0.75 * texture) * 0.3;
      if (a < 0.01) continue;
      wctx.globalAlpha = Math.min(0.55, a);
      wctx.fillStyle = texture > 0.72 ? bright : glow;
      wctx.fillRect(i, j, 1, 1);
    }
  }
  wctx.globalAlpha = 1;

  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  // Emission adds to the void rather than painting over it.
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.75;
  ctx.drawImage(surface as CanvasImageSource, 0, 0, WASH_W, WASH_H, 0, 0, viewW, viewH);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = smoothing;

  if (hazeAlpha > 0.01) {
    drawStarfield(ctx, t, x0, x1, y0, y1, viewW, viewH, pxPerUnit, cloudLevel, hazeAlpha);
  }
}

/**
 * Point stars on a power-of-two lattice in galaxy space.
 *
 * Star positions are therefore FIXED: zooming moves them outward with correct parallax instead of
 * shuffling them. Two lattice levels are drawn, weighted so their contributions sum to one, so finer
 * stars fade in between coarser ones as you descend and nothing ever pops.
 *
 * Drawing matters as much as generating. Two thousand separate fillRect calls, each preceded by a
 * fillStyle change and wrapped in additive blending, produced a periodic 210 ms stall, so the points
 * are batched into one path per colour per level.
 */
const TONE_COUNT = 4;
const MAX_POINTS = 9000;
/** Defensive bound: never iterate more lattice cells than this per level. */
const MAX_CELLS = 24000;

const pointX: Float32Array[] = [];
const pointY: Float32Array[] = [];
const pointS: Float32Array[] = [];
const pointN: number[] = [];
for (let i = 0; i < TONE_COUNT; i++) {
  pointX.push(new Float32Array(MAX_POINTS));
  pointY.push(new Float32Array(MAX_POINTS));
  pointS.push(new Float32Array(MAX_POINTS));
  pointN.push(0);
}

function drawStarfield(
  ctx: CanvasRenderingContext2D,
  t: GalaxyTraits,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  viewW: number,
  viewH: number,
  pxPerUnit: number,
  cloudLevel: number,
  /** Fades the whole unresolved population in as the resolved one thins out. */
  hazeAlpha: number,
): void {
  const p = t.palette;
  // Blending two levels splits each star's light between them, so the tones sit brighter than they
  // would for a single-level field. A handful of stars are brighter and larger than the rest, because a
  // field of uniform dots reads as dust rather than as stars.
  const tones = [css(p.PAPER, 1), css(p.LIGHT, 0.92), css(p.ACCENT, 0.8), css(p.PAPER, 1)];
  const [level, wCoarse, wFine] = scaleLevels(Math.log2(pxPerUnit / STAR_PITCH_PX));

  for (const [n, weight] of [
    [level, wCoarse],
    [level + 1, wFine],
  ] as const) {
    if (weight <= 0.004) continue;
    emitLevel(t, x0, x1, y0, y1, viewW, viewH, n, cloudLevel);
    ctx.globalAlpha = weight * hazeAlpha;
    for (let tone = 0; tone < TONE_COUNT; tone++) {
      const count = pointN[tone]!;
      if (count === 0) continue;
      const xs = pointX[tone]!;
      const ys = pointY[tone]!;
      const ss = pointS[tone]!;
      ctx.fillStyle = tones[tone]!;
      ctx.beginPath();
      for (let k = 0; k < count; k++) ctx.rect(xs[k]!, ys[k]!, ss[k]!, ss[k]!);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** Fill the point buffers with one lattice level's stars, in screen coordinates. */
function emitLevel(
  t: GalaxyTraits,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  viewW: number,
  viewH: number,
  level: number,
  cloudLevel: number,
): void {
  for (let i = 0; i < TONE_COUNT; i++) pointN[i] = 0;

  const cell = 2 ** -level; // galaxy units, a fixed power of two
  const i0 = Math.floor(x0 / cell);
  const i1 = Math.floor(x1 / cell);
  const j0 = Math.floor(y0 / cell);
  const j1 = Math.floor(y1 / cell);
  if ((i1 - i0 + 2) * (j1 - j0 + 2) > MAX_CELLS) return;

  const sxScale = viewW / (x1 - x0);
  const syScale = viewH / (y1 - y0);

  for (let j = j0; j <= j1 + 1; j++) {
    for (let i = i0; i <= i1 + 1; i++) {
      const h = hash4(i, j, level, 0x5747);
      // Fixed position within a fixed cell: the star lives at this point in galaxy space forever.
      const gx = (i + f01(h)) * cell;
      const gy = (j + f01(mix(h, 1))) * cell;
      const arm = armDensity(t, gx, gy);
      if (arm <= 0.02) continue;
      // Stars cluster where the cloud is thick, so the field and the wash agree.
      const d = arm * (0.35 + 0.9 * clusterAt(gx, gy, cloudLevel));
      if (f01(mix(h, 2)) > d * 0.95) continue;
      // Tone 3 is the rare bright one: about one star in fourteen.
      const roll = (h >>> 9) % 42;
      const tone = roll < 3 ? 3 : roll % 3;
      const n = pointN[tone]!;
      if (n >= MAX_POINTS) continue;
      const size = (tone === 3 ? 2 : 1) + Math.floor(f01(mix(h, 3)) * 2.2);
      pointX[tone]![n] = (gx - x0) * sxScale - size / 2;
      pointY[tone]![n] = (gy - y0) * syScale - size / 2;
      pointS[tone]![n] = size;
      pointN[tone] = n + 1;
    }
  }
}
