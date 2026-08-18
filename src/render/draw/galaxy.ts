import { f01, hash, mix, sm32 } from '../../core/rng.ts';
import { armDensity, type GalaxyTraits } from '../../universe/gen/galaxy.ts';
import { css, shade, type Hsl } from '../color.ts';
import { outlineWidth } from '../bands.ts';
import { getSpriteBudgeted, makeSurface, sizeBucket, type Sprite } from '../sprites.ts';

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

/** Four-point cartoon sparkles. Only these carry labels at galaxy zoom. */
function paintHeroStars(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: GalaxyTraits): void {
  const p = t.palette;
  let h = sm32(0x0beac04);
  for (let i = 0; i < t.heroStars; i++) {
    h = sm32(h);
    const x = f01(h) * 2 - 1;
    h = sm32(h);
    const y = f01(h) * 2 - 1;
    h = sm32(h);
    if (f01(h) > armDensity(t, x, y) * 0.8) continue;
    h = sm32(h);
    const len = r * (0.012 + f01(h) * 0.016);
    const sx = cx + x * r;
    const sy = cy + y * r;
    ctx.fillStyle = css(p.PAPER, 0.95);
    ctx.beginPath();
    ctx.moveTo(sx - len, sy);
    ctx.lineTo(sx, sy - len * 0.22);
    ctx.lineTo(sx + len, sy);
    ctx.lineTo(sx, sy + len * 0.22);
    ctx.closePath();
    ctx.moveTo(sx, sy - len);
    ctx.lineTo(sx + len * 0.22, sy);
    ctx.lineTo(sx, sy + len);
    ctx.lineTo(sx - len * 0.22, sy);
    ctx.closePath();
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
    paintStars(ctx, s / 2, s / 2, r, t, blurred ? 40 : 1400);
    ctx.filter = 'none';
  });
}

export interface GalaxyDrawOptions {
  readonly starBudget: number;
}

/** Draw one live galaxy at full detail. Used only when it is large on screen. */
export function drawGalaxyLive(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  t: GalaxyTraits,
  opts: GalaxyDrawOptions,
): number {
  paintStructure(ctx, cx, cy, r, t);
  const drawn = paintStars(ctx, cx, cy, r, t, opts.starBudget);
  paintHeroStars(ctx, cx, cy, r, t);
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
  return drawn;
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
 * What you see when you are INSIDE a galaxy.
 *
 * There is a window of roughly a dozen doublings where the galaxy is far larger than the viewport (so
 * its silhouette is meaningless) but individual star systems are still sub-pixel. Before this existed
 * that window rendered as a completely blank screen -- twelve doublings of nothing, which is exactly
 * the "everything in between" the project is supposed to deliver.
 *
 * What belongs there is physically unambiguous: at that distance individual stars are unresolved, so
 * you are looking at the collective glow of the arm you are inside. That is drawn by sampling the same
 * `armDensity` field the arms and blob come from, at low resolution, and upscaling it smoothly.
 *
 * The scattered points on top are unresolved star clouds, not objects: they carry no label and are not
 * click targets, so nothing is claimed to be enterable that is not. Systems that ARE resolvable get
 * drawn by the normal traversal as soon as they exceed the minimum size.
 */
const WASH_W = 64;
const WASH_H = 40;

/** Smooth value noise on an integer lattice. Cheap, stateless, and deterministic. */
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (i: number, j: number) => f01(hash(i, j, 0x9e37));
  const a = at(xi, yi);
  const b = at(xi + 1, yi);
  const c = at(xi, yi + 1);
  const d = at(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/**
 * Fractional Brownian motion. The base frequency is tied to the VIEWPORT span rather than to galaxy
 * space, so there is visible cloud structure at every depth. Without this the wash is a flat wall of
 * colour once you are deep inside a single arm, where armDensity is essentially constant.
 */
function fbm(x: number, y: number, baseFreq: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = baseFreq;
  for (let o = 0; o < 3; o++) {
    sum += vnoise(x * freq, y * freq) * amp;
    freq *= 2.07;
    amp *= 0.5;
  }
  return sum / 0.875;
}

export function drawGalaxyInterior(
  ctx: CanvasRenderingContext2D,
  t: GalaxyTraits,
  /**
   * Viewport bounds in GALAXY units. Passed directly rather than derived from a centre and radius in
   * pixels, because by planet depth the galaxy's radius is about 2^60 px and that subtraction would
   * throw away every bit that matters.
   */
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  viewW: number,
  viewH: number,
): void {
  // Nothing to draw if the viewport has left the galaxy entirely.
  const nearestX = Math.max(x0, Math.min(0, x1));
  const nearestY = Math.max(y0, Math.min(0, y1));
  if (Math.hypot(nearestX, nearestY) > 1.05) return;

  // Roughly three cloud features across the screen, whatever the depth.
  const baseFreq = 3 / Math.max(1e-30, x1 - x0);

  const { surface, ctx: wctx } = makeSurface(WASH_W);
  const p = t.palette;
  const glow = css(p.MID, 1);
  const bright = css(p.LIGHT, 1);

  wctx.clearRect(0, 0, WASH_W, WASH_W);
  for (let j = 0; j < WASH_H; j++) {
    const gy = y0 + ((j + 0.5) / WASH_H) * (y1 - y0);
    for (let i = 0; i < WASH_W; i++) {
      const gx = x0 + ((i + 0.5) / WASH_W) * (x1 - x0);
      const density = armDensity(t, gx, gy);
      if (density <= 0.02) continue;
      const texture = fbm(gx, gy, baseFreq);
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

  drawUnresolvedStars(ctx, t, x0, x1, y0, y1, viewW, viewH, baseFreq);
}

/**
 * Point stars at a fixed SCREEN pitch, so the field stays similarly dense at every depth. This is not
 * a cheat: real starfields are self-similar under magnification, because stars are point sources that
 * never resolve into discs however far you zoom.
 */
function drawUnresolvedStars(
  ctx: CanvasRenderingContext2D,
  t: GalaxyTraits,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  viewW: number,
  viewH: number,
  baseFreq: number,
): void {
  const PITCH_PX = 26;
  const cols = Math.ceil(viewW / PITCH_PX);
  const rows = Math.ceil(viewH / PITCH_PX);
  const p = t.palette;
  const tones = [css(p.PAPER, 0.9), css(p.LIGHT, 0.8), css(p.ACCENT, 0.7)];

  // Quantise the sampling grid to galaxy space so stars stay put while panning rather than crawling.
  const spanX = (x1 - x0) / cols;
  const spanY = (y1 - y0) / rows;
  const i0 = Math.floor(x0 / spanX);
  const j0 = Math.floor(y0 / spanY);

  ctx.globalCompositeOperation = 'lighter';
  for (let j = 0; j <= rows + 1; j++) {
    for (let i = 0; i <= cols + 1; i++) {
      const gi = i0 + i;
      const gj = j0 + j;
      const h = hash(gi, gj, 0x5747);
      const jx = (gi + f01(h)) * spanX;
      const jy = (gj + f01(mix(h, 1))) * spanY;
      // Stars cluster where the cloud is thick, so the field and the wash agree.
      const d = armDensity(t, jx, jy) * (0.35 + 0.9 * fbm(jx, jy, baseFreq));
      if (f01(mix(h, 2)) > d * 0.95) continue;
      const sx = ((jx - x0) / (x1 - x0)) * viewW;
      const sy = ((jy - y0) / (y1 - y0)) * viewH;
      const size = 1 + Math.floor(f01(mix(h, 3)) * 2.2);
      ctx.fillStyle = tones[(h >>> 9) % tones.length]!;
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}
