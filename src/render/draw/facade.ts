import { f01, hash2, hash3 } from '../../core/rng.ts';
import { needsHeating, pitchAt, type Arch, type BuildingLook, type Roof, type Window } from '../../culture/arch.ts';
import { biosphereOf, standingIn } from '../../culture/biosphere.ts';
import type { LocalClimate } from '../../culture/climate.ts';
import { motifPath, type Motif } from '../../culture/motif.ts';
import { drawScript, scriptWidth, type Script } from '../../culture/script.ts';
import type { PlanetTraits } from '../../universe/gen/planet.ts';
import { atLuminance, css, hueDelta, luminanceOf, shade, solveL, type Hsl } from '../color.ts';
import { smoothstep } from '../bands.ts';
import { leafColour } from './flora.ts';
import { daylight, type Sky } from './sky.ts';

/**
 * A BUILDING, AS A FRONT ELEVATION.
 *
 * This is the bottom of the ladder and the whole argument for the project, so it is worth stating what it has
 * to do. A single screenshot of one building, filling the screen, should let you correctly infer five facts
 * about the world it stands on:
 *
 *   the window silhouette      is the planet's motif
 *   the script on the sign     is the planet's own language, spelling this building's own name
 *   roof pitch, eaves, chimney are the local climate
 *   the plant by the door      is the planet's biosphere
 *   lit wall against shadow    is the star's spectral class
 *   the wall material          is the region's biome and the galaxy's metallicity at this radius
 *
 * None of that is decoration and none of it is a caption. Every one is a shape or a colour that some generator
 * elsewhere in the project decided, drawn here for the first time -- which is why this file is where a dozen
 * modules finally meet.
 *
 * A front elevation is not a chosen viewpoint, either. On a two-dimensional world it is what a building IS: the
 * plate has already turned the frame edge on, so a house is a shape standing on the ground line with the sky
 * behind it. There is no projection here and nothing is foreshortened.
 *
 * Flat fills, two values per material, ink outlines that are never black, and texture as stamps.
 */

export interface Facade {
  readonly arch: Arch;
  readonly look: BuildingLook;
  readonly motif: Motif;
  readonly script: Script;
  /** This building's own name in the local language. Drawn as strokes, never as text. */
  readonly sign: string;
  readonly climate: LocalClimate;
  readonly sky: Sky;
  readonly traits: PlanetTraits;
  /** Hue ores tend towards in the enclosing galaxy: rusts and irons, or chalks and salts. */
  readonly oreHue: number;
  /** 0 = a metal-poor rim world, 1 = a metal-rich core world. Sets how dark stone reads. */
  readonly metallicity: number;
  readonly civic: boolean;
  readonly id: number;
  readonly planetId: number;
}

/** Below this a facade is a silhouette and detail is wasted; the caller draws a plain block instead. */
export const FACADE_MIN_PX = 26;

interface Palette {
  readonly wall: Hsl;
  readonly wallShade: Hsl;
  readonly trim: Hsl;
  readonly roof: Hsl;
  readonly glass: Hsl;
  readonly lit: Hsl;
  readonly ink: Hsl;
  readonly snow: Hsl;
}

/**
 * Materials.
 *
 * Two inheritances meet here and neither is a hash. The ORE HUE and the metallicity come from the galaxy, four
 * levels up, and they are chemistry rather than culture -- a metal-poor rim world builds in pale chalk and a
 * core world in dark iron-stained stone, and that is the one trait in the project that legitimately spans a
 * hundred billion stars. The biome supplies what is locally to hand: timber where there are trees, mud brick on
 * a floodplain, bleached stone in a desert.
 *
 * Then the star tints everything and its complement colours every shadow, which is standard illustration
 * practice, one line of code, and THE cue that carries a star's identity down to a single wall.
 */
function palette(f: Facade): Palette {
  const light = f.traits.starLight;
  const dark = Math.min(1, Math.max(0, (f.metallicity - 0.1) / 0.9));
  // Biome decides the base value: forest worlds build dark, deserts pale, ice worlds paler still.
  const biomeLift =
    f.climate.biome === 'desert' || f.climate.biome === 'saltpan'
      ? 0.16
      : f.climate.biome === 'ice' || f.climate.biome === 'tundra'
        ? 0.1
        : f.climate.biome === 'jungle' || f.climate.biome === 'forest'
          ? -0.08
          : 0;
  const hue = f.oreHue + hueDelta(f.oreHue, light.colour.h) * 0.28 * light.cls.sat;
  const sat = 0.1 + dark * 0.26;
  const y = Math.min(0.82, Math.max(0.12, 0.62 - dark * 0.34 + biomeLift));
  const wall = daylight({ h: hue, s: sat, l: solveL(hue, sat, y) }, f.sky, light.shadowHue);

  const roofHue = hue + 18 + dark * 22;
  const roofY = Math.max(0.06, y * (0.46 + dark * 0.1));
  const trimY = Math.min(0.9, y + 0.16);
  return {
    wall,
    wallShade: shade(wall, light.shadowHue, 1),
    trim: daylight({ h: hue, s: sat * 0.8, l: solveL(hue, sat * 0.8, trimY) }, f.sky, light.shadowHue),
    roof: daylight({ h: roofHue, s: sat + 0.14, l: solveL(roofHue, sat + 0.14, roofY) }, f.sky, light.shadowHue),
    glass: daylight({ h: f.traits.atmHue, s: 0.3, l: solveL(f.traits.atmHue, 0.3, 0.14) }, f.sky, light.shadowHue),
    // Lamplight is not daylight and must not be dimmed by it: this is the one colour on a facade that gets
    // BRIGHTER after dark, which is what makes a village read as inhabited at night.
    lit: atLuminance({ h: (light.colour.h + 42) % 360, s: 0.62, l: 0.7 }, 0.78),
    ink: { h: hue, s: 0.3, l: solveL(hue, 0.3, 0.05) },
    snow: daylight({ h: f.traits.atmHue, s: 0.06, l: 0.94 }, f.sky, light.shadowHue),
  };
}

/** One window opening, in the planet's own silhouette. */
function windowPath(ctx: CanvasRenderingContext2D, shape: Window, motif: Motif, x: number, y: number, w: number, h: number): void {
  const hw = w / 2;
  const hh = h / 2;
  switch (shape) {
    case 'square':
    case 'tall':
      ctx.rect(x - hw, y - hh, w, h);
      return;
    case 'slit':
      ctx.rect(x - w * 0.16, y - hh, w * 0.32, h);
      return;
    case 'round':
    case 'roundel':
      ctx.arc(x, y, Math.min(hw, hh), 0, Math.PI * 2);
      return;
    case 'arched':
      ctx.moveTo(x - hw, y + hh);
      ctx.lineTo(x - hw, y - hh * 0.1);
      ctx.quadraticCurveTo(x, y - hh * 1.5, x + hw, y - hh * 0.1);
      ctx.lineTo(x + hw, y + hh);
      ctx.closePath();
      return;
    case 'lancet':
      ctx.moveTo(x - hw, y + hh);
      ctx.lineTo(x - hw, y);
      ctx.lineTo(x, y - hh);
      ctx.lineTo(x + hw, y);
      ctx.lineTo(x + hw, y + hh);
      ctx.closePath();
      return;
    case 'trapezoid':
      ctx.moveTo(x - hw, y + hh);
      ctx.lineTo(x - hw * 0.62, y - hh);
      ctx.lineTo(x + hw * 0.62, y - hh);
      ctx.lineTo(x + hw, y + hh);
      ctx.closePath();
      return;
    case 'motif':
      // The emblem of the world, cut into the wall. This is the cue that lands hardest of the six.
      ctx.save();
      ctx.translate(x, y);
      motifPath(ctx, motif, Math.min(hw, hh) * 1.15);
      ctx.restore();
      return;
  }
}

/** The roof mass, as it reads from the side. `pitch` is rise over half-span. */
function roofPath(
  ctx: CanvasRenderingContext2D,
  shape: Roof,
  cx: number,
  eaveY: number,
  half: number,
  pitch: number,
  over: number,
): void {
  const l = cx - half - over;
  const r = cx + half + over;
  const rise = half * pitch;
  switch (shape) {
    case 'gable':
      ctx.moveTo(l, eaveY);
      ctx.lineTo(cx, eaveY - rise);
      ctx.lineTo(r, eaveY);
      ctx.closePath();
      return;
    case 'hip':
      ctx.moveTo(l, eaveY);
      ctx.lineTo(cx - half * 0.34, eaveY - rise);
      ctx.lineTo(cx + half * 0.34, eaveY - rise);
      ctx.lineTo(r, eaveY);
      ctx.closePath();
      return;
    case 'flat':
      // A parapet: the roof you can stand on, which is what a dry world builds.
      ctx.rect(l, eaveY - Math.max(2, half * 0.16), r - l, Math.max(2, half * 0.16));
      return;
    case 'stepped':
      ctx.moveTo(l, eaveY);
      for (let i = 0; i < 3; i++) {
        const t = i / 3;
        const y = eaveY - rise * (0.3 + t * 0.7);
        ctx.lineTo(l + (r - l) * t * 0.28, y);
        ctx.lineTo(l + (r - l) * (t + 0.33) * 0.28, y);
      }
      ctx.lineTo(r - (r - l) * 0.06, eaveY - rise);
      ctx.lineTo(r, eaveY);
      ctx.closePath();
      return;
    case 'dome':
      ctx.moveTo(l, eaveY);
      ctx.quadraticCurveTo(cx - half * 0.9, eaveY - rise * 1.5, cx, eaveY - rise * 1.35);
      ctx.quadraticCurveTo(cx + half * 0.9, eaveY - rise * 1.5, r, eaveY);
      ctx.closePath();
      return;
    case 'barrel':
      ctx.moveTo(l, eaveY);
      ctx.quadraticCurveTo(cx, eaveY - rise * 2.1, r, eaveY);
      ctx.closePath();
      return;
    case 'conical':
      ctx.moveTo(l, eaveY);
      ctx.lineTo(cx, eaveY - rise * 2.2);
      ctx.lineTo(r, eaveY);
      ctx.closePath();
      return;
    case 'mansard':
      ctx.moveTo(l, eaveY);
      ctx.lineTo(cx - half * 0.72, eaveY - rise * 0.62);
      ctx.lineTo(cx - half * 0.3, eaveY - rise);
      ctx.lineTo(cx + half * 0.3, eaveY - rise);
      ctx.lineTo(cx + half * 0.72, eaveY - rise * 0.62);
      ctx.lineTo(r, eaveY);
      ctx.closePath();
      return;
    case 'sawtooth':
      ctx.moveTo(l, eaveY);
      for (let i = 0; i < 3; i++) {
        const x0 = l + ((r - l) * i) / 3;
        const x1 = l + ((r - l) * (i + 1)) / 3;
        ctx.lineTo(x0, eaveY - rise);
        ctx.lineTo(x1, eaveY - rise * 0.15);
      }
      ctx.lineTo(r, eaveY);
      ctx.closePath();
      return;
  }
}

/** A person, at eight to fourteen percent of a building's height. Five shapes, no face. */
function figure(ctx: CanvasRenderingContext2D, x: number, groundY: number, h: number, colour: string, phase: number): void {
  if (h < 5) return;
  const w = h * 0.3;
  ctx.fillStyle = colour;
  // Head.
  ctx.beginPath();
  ctx.arc(x, groundY - h * 0.86, h * 0.13, 0, Math.PI * 2);
  ctx.fill();
  // Body.
  ctx.beginPath();
  ctx.moveTo(x - w * 0.42, groundY - h * 0.32);
  ctx.lineTo(x - w * 0.34, groundY - h * 0.72);
  ctx.lineTo(x + w * 0.34, groundY - h * 0.72);
  ctx.lineTo(x + w * 0.42, groundY - h * 0.32);
  ctx.closePath();
  ctx.fill();
  // Two legs, one of which swings. A six-second walk cycle out of one sine is all this needs.
  const swing = Math.sin(phase) * h * 0.14;
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1, h * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - w * 0.15, groundY - h * 0.34);
  ctx.lineTo(x - w * 0.15 - swing, groundY);
  ctx.moveTo(x + w * 0.15, groundY - h * 0.34);
  ctx.lineTo(x + w * 0.15 + swing, groundY);
  ctx.stroke();
}

/**
 * The whole elevation, standing on the ground at `groundY`, `half` pixels to either side of `cx`.
 *
 * Returns the height it reached, so the caller can place a lamp or a tree against it.
 */
export function drawFacade(ctx: CanvasRenderingContext2D, cx: number, groundY: number, half: number, f: Facade): number {
  const p = palette(f);
  const { look, arch } = f;
  const cold = needsHeating(f.climate.temp);
  const pitch = pitchAt(arch, f.climate.temp);

  /**
   * EVERY PART OF A BUILDING ARRIVES, none of them appears.
   *
   * A facade is a stack of a dozen elements each of which used to have its own hard size gate -- a sign at
   * sixteen pixels of half-width, ornament at twenty, a chimney at eight -- so approaching a street was a series
   * of small simultaneous snaps, every house on it crossing each threshold in the same frame. `part` is the ramp
   * every one of them now uses: the element is at nothing when it would be too small to read and fully there a
   * doubling later, which is the same rule the bands in bands.ts apply to whole representations.
   */
  const base = ctx.globalAlpha;
  const part = (v: number, lo: number, hi: number): number => base * smoothstep(lo, hi, v);

  /**
   * Height from the world's grammar, not from the building: `verticality` is how tall this world builds for a
   * given footprint, and the storey count is one of the three things a building is allowed to choose for
   * itself. A village therefore has one skyline rather than a random one.
   */
  const storeyH = half * 2 * arch.verticality * 0.42;
  const height = storeyH * look.storeys;
  const eaveY = groundY - height;
  const over = half * arch.eave;
  const w = Math.max(0.9, Math.min(3, half * 0.055));

  // 1. Cast shadow along the ground, thrown away from the star. Flat, offset, no blur -- drawn before the
  //    building so the building sits on top of its own shadow.
  if (Math.abs(f.sky.elevation) > 0.04 && f.sky.elevation > 0) {
    const lean = -f.sky.azimuthLean * (1 / Math.max(0.18, f.sky.elevation)) * height * 0.5;
    ctx.fillStyle = css(shade(p.wall, f.traits.starLight.shadowHue, 1.5), 0.3);
    ctx.beginPath();
    ctx.moveTo(cx - half, groundY);
    ctx.lineTo(cx - half + lean, groundY - Math.min(height, half) * 0.1);
    ctx.lineTo(cx + half + lean, groundY - Math.min(height, half) * 0.1);
    ctx.lineTo(cx + half, groundY);
    ctx.closePath();
    ctx.fill();
  }

  // 2. Wall.
  ctx.fillStyle = css(p.wall);
  ctx.fillRect(cx - half, eaveY, half * 2, height);

  // 3. Wall division. What a world does with a blank wall, and it is a strong per-planet signature.
  ctx.fillStyle = css(p.trim);
  switch (arch.wall) {
    case 'banded':
      for (let i = 1; i < look.storeys * 2; i++) {
        ctx.fillRect(cx - half, eaveY + (height * i) / (look.storeys * 2) - w * 0.6, half * 2, w * 1.2);
      }
      break;
    case 'timbered':
      ctx.strokeStyle = css(p.ink, 0.7);
      ctx.lineWidth = w;
      ctx.beginPath();
      for (let i = 0; i <= look.storeys; i++) {
        const y = eaveY + (height * i) / look.storeys;
        ctx.moveTo(cx - half, y);
        ctx.lineTo(cx + half, y);
      }
      for (let i = -1; i <= 1; i += 2) {
        ctx.moveTo(cx + i * half, groundY);
        ctx.lineTo(cx, eaveY + height * 0.45);
      }
      ctx.stroke();
      break;
    case 'pilaster':
      for (let i = 0; i <= look.bays; i++) {
        ctx.fillRect(cx - half + ((half * 2 * i) / look.bays) - w, eaveY, w * 2, height);
      }
      break;
    case 'battened':
      for (let i = 0; i < 7; i++) {
        ctx.fillRect(cx - half + ((half * 2 * (i + 0.5)) / 7) - w * 0.4, eaveY, w * 0.8, height);
      }
      break;
    case 'plinth':
    case 'none':
      break;
  }

  // 4. Plinth, and a snow skirt where snow lies against a wall all winter.
  const plinthH = arch.plinth * storeyH;
  if (plinthH > 0.85) {
    ctx.globalAlpha = part(plinthH, 0.8, 2);
    ctx.fillStyle = css(arch.snowSkirt && cold ? p.snow : p.trim);
    ctx.fillRect(cx - half, groundY - plinthH, half * 2, plinthH);
    ctx.globalAlpha = base;
  }

  // 5. Windows, in the world's own silhouette and the world's own rhythm.
  const winW = half * 2 * Math.sqrt(arch.windowArea) * 0.7;
  const winH = winW * (look.window === 'tall' || look.window === 'slit' ? 1.7 : look.window === 'square' ? 1 : 1.28);
  if (winW > 1.6 && winH < storeyH * 0.86) {
    ctx.globalAlpha = part(winW, 1.6, 3.4);
    const cols = Math.max(1, look.bays * (arch.rhythm === 'grouped' ? 2 : 1));
    for (let s = 0; s < look.storeys; s++) {
      // The ground floor gives its middle bay to the door.
      const rowY = groundY - storeyH * (s + 0.58);
      for (let c = 0; c < cols; c++) {
        let fx = (c + 0.5) / cols;
        if (arch.rhythm === 'paired') fx = (Math.floor(c / 2) + (c % 2) * 0.34 + 0.33) / Math.ceil(cols / 2);
        if (arch.rhythm === 'irregular') fx += (f01(hash3(f.id, s, c)) - 0.5) * 0.12;
        const x = cx - half + half * 2 * Math.min(0.92, Math.max(0.08, fx));
        if (s === 0 && Math.abs(x - (cx + (look.doorRight ? 1 : -1) * half * 0.5)) < winW) continue;
        const lit = f.sky.night > 0.3 && f01(hash3(f.id, 0x11 + s, c)) < 0.55 * f.sky.night;
        ctx.fillStyle = css(lit ? p.lit : p.glass);
        ctx.beginPath();
        windowPath(ctx, look.window, f.motif, x, rowY, winW, winH);
        ctx.fill();
      }
    }
    ctx.globalAlpha = base;
  }

  // 6. Door, and the plant beside it: the biosphere, at the smallest scale it appears.
  const doorW = Math.min(half * 0.5, storeyH * 0.5);
  const doorH = Math.min(storeyH * 0.72, half * 1.1);
  const doorX = cx + (look.doorRight ? 1 : -1) * half * 0.5;
  if (doorW > 1.4) {
    ctx.globalAlpha = part(doorW, 1.4, 3);
    ctx.fillStyle = css(atLuminance(p.trim, Math.max(0.04, luminanceOf(p.trim) * 0.42)));
    ctx.fillRect(doorX - doorW / 2, groundY - doorH, doorW, doorH);
    if (arch.ornament > 0.4 && doorW > 4.5) {
      // A bracket or hood over the door, which is where a world puts its ornament first.
      ctx.globalAlpha = part(doorW, 4.5, 8);
      ctx.fillStyle = css(p.trim);
      ctx.fillRect(doorX - doorW * 0.8, groundY - doorH - w * 1.6, doorW * 1.6, w * 1.6);
      ctx.globalAlpha = part(doorW, 1.4, 3);
    }
    potPlant(ctx, f, doorX + doorW * (look.doorRight ? -1.1 : 1.1), groundY, Math.min(doorH * 0.42, half * 0.3));
    ctx.globalAlpha = base;
  }

  // 7. Roof, its texture, and its eaves.
  ctx.fillStyle = css(p.roof);
  ctx.beginPath();
  roofPath(ctx, look.roof, cx, eaveY, half, pitch, over);
  ctx.fill();
  // Snow lies on the roof of a cold world. One flat wedge along the top: the cheapest possible statement of
  // climate, and it reads from across the street.
  if (cold && look.roof !== 'flat' && f.climate.temp < 268) {
    ctx.save();
    ctx.beginPath();
    roofPath(ctx, look.roof, cx, eaveY, half, pitch, over);
    ctx.clip();
    ctx.fillStyle = css(p.snow, 0.92);
    ctx.beginPath();
    roofPath(ctx, look.roof, cx, eaveY - half * pitch * 0.22, half, pitch, over);
    ctx.fill();
    ctx.restore();
  }
  if (over > 0.8) {
    // The eave line, in ink: a deep overhang is a wet world's signature and it needs an edge to read.
    ctx.globalAlpha = part(over, 0.8, 2);
    ctx.strokeStyle = css(p.ink, 0.6);
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(cx - half - over, eaveY);
    ctx.lineTo(cx + half + over, eaveY);
    ctx.stroke();
    ctx.globalAlpha = base;
  }

  // 8. Chimney and smoke, on any world cold enough to need heating.
  if (cold && half > 6) {
    ctx.globalAlpha = part(half, 6, 11);
    const chX = cx + (look.doorRight ? -1 : 1) * half * 0.55;
    const chW = Math.max(2, half * 0.16);
    const chTop = eaveY - half * pitch * 0.8 - storeyH * 0.3;
    ctx.fillStyle = css(p.trim);
    ctx.fillRect(chX - chW / 2, chTop, chW, groundY - chTop - height * 0.02);
    ctx.fillStyle = css(p.wallShade);
    ctx.fillRect(chX - chW * 0.7, chTop, chW * 1.4, chW * 0.5);
    smoke(ctx, f, chX, chTop, chW);
    ctx.globalAlpha = base;
  }

  // 9. The sign, in this world's own writing, spelling this building's own name.
  if (arch.sign !== 'none' && half > 12) {
    const h = Math.min(storeyH * 0.3, half * 0.24);
    const width = scriptWidth(f.script, f.sign, h);
    if (width > 3 && width < half * 2.4) {
      ctx.globalAlpha = Math.min(part(half, 12, 20), part(width, 3, 6));
      const y = arch.sign === 'fascia' ? eaveY - h * 0.4 : groundY - doorH - h * 1.5;
      const boardX = arch.sign === 'pier' ? cx - half - width * 0.5 : cx - width / 2;
      ctx.fillStyle = css(atLuminance(p.trim, Math.max(0.06, luminanceOf(p.trim) * 0.55)));
      ctx.fillRect(boardX - h * 0.4, y - h * 1.25, width + h * 0.8, h * 1.7);
      drawScript(ctx, f.script, f.sign, boardX, y, h, css(p.snow, 0.9));
      if (arch.sign === 'hanging') {
        ctx.strokeStyle = css(p.ink, 0.7);
        ctx.lineWidth = w * 0.8;
        ctx.beginPath();
        ctx.moveTo(cx, y - h * 1.25);
        ctx.lineTo(cx, y - h * 2.1);
        ctx.stroke();
      }
      ctx.globalAlpha = base;
    }
  }

  // 10. Ornament: a row of marks under the eaves, count from the world's own ornament density.
  const marks = Math.round(arch.ornament * 9);
  if (marks > 0 && half > 15) {
    ctx.globalAlpha = part(half, 15, 26);
    ctx.fillStyle = css(p.trim, 0.8);
    for (let i = 0; i < marks; i++) {
      const x = cx - half + (half * 2 * (i + 0.5)) / marks;
      ctx.beginPath();
      ctx.arc(x, eaveY + w * 2.4, w * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = base;
  }

  // 11. Ink, over everything: the silhouette is the read, and the interior edges are lighter than it.
  ctx.strokeStyle = css(p.ink);
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(cx - half, groundY);
  ctx.lineTo(cx - half, eaveY);
  ctx.lineTo(cx + half, eaveY);
  ctx.lineTo(cx + half, groundY);
  ctx.stroke();
  ctx.beginPath();
  roofPath(ctx, look.roof, cx, eaveY, half, pitch, over);
  ctx.stroke();

  // 12. People, so the whole thing has a scale you can feel.
  const people = half > 18 ? 1 + Math.floor(f01(hash2(f.id, 0x5e)) * 2.4) : 0;
  if (people > 0) ctx.globalAlpha = part(half, 18, 30);
  for (let i = 0; i < people; i++) {
    const t = f01(hash3(f.id, 0x5f, i));
    const walk = f01(hash3(f.id, 0x60, i)) < 0.5;
    const drift = walk ? Math.sin(f.sky.clock / 6 + i * 2) * half * 0.7 : 0;
    figure(
      ctx,
      cx + (t - 0.5) * half * 1.9 + drift,
      groundY,
      Math.max(5, height * (0.09 + f01(hash3(f.id, 0x61, i)) * 0.05)),
      css(atLuminance(p.ink, 0.14)),
      walk ? f.sky.clock * 1.05 + i : 0,
    );
  }
  ctx.globalAlpha = base;

  return height + half * pitch;
}

/** Smoke, rising and drifting. Three flat blobs on a slow sine: the whole of a chimney's animation budget. */
function smoke(ctx: CanvasRenderingContext2D, f: Facade, x: number, y: number, w: number): void {
  if (w < 2) return;
  ctx.fillStyle = css(f.sky.colour, 0.34);
  for (let i = 0; i < 3; i++) {
    const t = ((f.sky.clock / 5 + i / 3) % 1);
    const r = w * (0.6 + t * 1.6);
    ctx.beginPath();
    ctx.arc(x + Math.sin(t * 4 + i) * w * 1.4, y - t * w * 7, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * The plant by the door.
 *
 * The smallest appearance of the planet's biosphere, and the one that most rewards noticing: the crown shape
 * beside a doorway is the same crown shape on the forested hills three levels up, because both come from the
 * same five numbers rolled once for the world.
 */
function potPlant(ctx: CanvasRenderingContext2D, f: Facade, x: number, groundY: number, h: number): void {
  if (h < 4) return;
  const bio = biosphereOf(f.planetId);
  const stand = standingIn(bio, f.climate.biome);
  if (stand.heightM <= 0) return;
  const potH = h * 0.32;
  ctx.fillStyle = css(shade({ h: f.oreHue, s: 0.28, l: 0.4 }, f.traits.starLight.shadowHue, 0.6));
  ctx.beginPath();
  ctx.moveTo(x - potH * 0.62, groundY - potH);
  ctx.lineTo(x + potH * 0.62, groundY - potH);
  ctx.lineTo(x + potH * 0.44, groundY);
  ctx.lineTo(x - potH * 0.44, groundY);
  ctx.closePath();
  ctx.fill();
  const leaf = leafColour(bio, stand.tone, f.sky, f.traits.starLight.shadowHue);
  ctx.fillStyle = css(leaf);
  ctx.strokeStyle = css(leaf);
  cropCrown(ctx, bio.crown, x, groundY - potH, h * 0.34, h * 0.7);
}

/** The crown shapes again, small. Kept local so a pot plant cannot drag the whole flora module in. */
function cropCrown(ctx: CanvasRenderingContext2D, shape: string, x: number, y: number, w: number, h: number): void {
  if (shape === 'cone' || shape === 'conical') {
    ctx.beginPath();
    ctx.moveTo(x, y - h);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x - w, y);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (shape === 'tuft' || shape === 'wisp' || shape === 'candelabra') {
    ctx.lineWidth = Math.max(0.9, w * 0.4);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = -1; i <= 1; i++) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + i * w * 0.9, y - h);
    }
    ctx.stroke();
    return;
  }
  ctx.beginPath();
  ctx.ellipse(x, y - h * 0.55, w, h * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
}
