import { f01, hash2, hash3 } from '../../core/rng.ts';
import { sunAt } from '../../culture/climate.ts';
import type { PlanetTraits } from '../../universe/gen/planet.ts';
import { atLuminance, css, hueDelta, luminanceOf, solveL, type Hsl } from '../color.ts';

/**
 * THE SKY ABOVE A FLAT WORLD.
 *
 * The surface views had no sky. They had a flat fill of the world's atmosphere colour, which is correct and
 * says nothing: no star, no time of day, no moons, no weather. That one absence was doing more damage than any
 * other single thing in the project, because a landscape with an empty sky reads as a diagram of a landscape.
 *
 * NOTHING HERE IS INVENTED. On a two-dimensional planet the star's place in the sky falls out of the geometry
 * with nothing left over: the planet turns, so the substellar angle sweeps round the rim, so at any instant half
 * the circumference is in daylight and half is in night and the terminator moves at the rotation rate. Walk
 * round the world and you walk into the evening. A tidally locked world has a permanent noon on one face and a
 * permanent midnight on the other, and that is the same formula with the rotation taken out. See `sunAt`.
 *
 * The sky is a STYLISED DOME mapped to the screen -- azimuth across, elevation up -- rather than a projection.
 * That is the honest choice twice over: the star is effectively at infinity, so it must not move as you zoom or
 * gain parallax as you walk a street, and there is no projection anywhere else in this project either.
 *
 * Flat fills throughout. The one concession is the star's bloom, which the art direction permits in exactly two
 * places, and even that is three flat rings rather than a gradient.
 */

export interface Moon {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** -1 to 1: which side the light is on, and how much of the disc it reaches. */
  readonly phase: number;
}

export interface Sky {
  /** The one flat colour of the sky at this instant. */
  readonly colour: Hsl;
  /** 0 in full day, 1 in deep night. Drives lit windows, and how dark the ground reads. */
  readonly night: number;
  /** Sine of the star's elevation. Negative when it is down. */
  readonly elevation: number;
  /** Where along the horizon the star sits, -1 to 1. Shadows lean the other way. */
  readonly azimuthLean: number;
  /** The clock, in seconds, for anything that moves. One value per frame, so a scene is one instant. */
  readonly clock: number;
  readonly sunX: number;
  readonly sunY: number;
  readonly sunR: number;
  readonly sunColour: Hsl;
  readonly moons: readonly Moon[];
  /** Cloud bands: screen y, thickness, and how far along they have drifted. */
  readonly clouds: readonly { readonly y: number; readonly h: number; readonly drift: number }[];
  /** How strongly the unresolved starlight of the galaxy shows through. 0 by day. */
  readonly starfield: number;
  readonly starSeed: number;
  /** Screen y of the horizon this dome was built around. */
  readonly horizonY: number;
  readonly halfWidth: number;
  readonly height: number;
  /**
   * How strongly daylight has taken over from the void behind it.
   *
   * Zero out in space, one once the planet is bigger than a couple of screens. Set by the renderer rather than
   * here, because it is a fact about the camera's distance rather than about the sky.
   */
  readonly groundAlpha: number;
}

/** How far up the screen the star climbs at its zenith, as a fraction of the viewport height. */
const DOME_RISE = 0.92;
/** How far to either side the star reaches at sunrise and sunset, as a fraction of the half-width. */
const DOME_REACH = 0.94;

/**
 * Twilight, in units of the elevation sine.
 *
 * Sunset is elevation 0 and it does not go dark at once: the band either side is where the sky is warm and the
 * shadows are long. Wide enough to be worth catching -- about a tenth of a day at each end -- because a
 * screenshot taken at dusk is the best one this project can produce.
 */
const DUSK = 0.22;

export function computeSky(
  planetId: number,
  traits: PlanetTraits,
  theta: number,
  seconds: number,
  viewW: number,
  viewH: number,
  horizonY: number,
): Sky {
  const { elevation, azimuth } = sunAt(planetId, traits, theta, seconds);
  const light = traits.starLight;

  /**
   * Day, dusk and night as three flat states with smooth interpolation between, not a gradient in space.
   *
   * Daylight is the world's own atmosphere colour lit by its own star. Dusk pulls hard toward the star's hue
   * and saturates -- which is what a low sun through a lot of air does -- and night falls to a dark tint of the
   * same hue rather than to black, because a black sky over a coloured world reads as a hole.
   */
  const day = clamp01((elevation + DUSK) / (DUSK * 2));
  const dusk = 1 - Math.abs(elevation) / DUSK;
  const night = 1 - day;

  const baseHue = traits.atmHue + hueDelta(traits.atmHue, light.colour.h) * 0.3 * light.cls.sat;
  const daySat = 0.16 + 0.34 * Math.min(1, traits.atmDensity) * (0.5 + 0.5 * light.cls.sat);
  const dayY = 0.1 + 0.62 * Math.min(1, traits.atmDensity * 1.4) * (0.55 + 0.45 * light.cls.rel);

  // The dusk hue is the star's own, which is why a red dwarf's evenings are a different colour from a blue
  // giant's -- and why the star's identity reaches the surface without anything having to say so.
  const duskHue = light.colour.h + hueDelta(light.colour.h, traits.atmHue) * 0.25;
  const warm = Math.max(0, dusk) * 0.75;
  const hue = baseHue + hueDelta(baseHue, duskHue) * warm;
  const sat = Math.min(0.95, daySat * (1 - warm * 0.3) + warm * 0.5);
  // Night is not black: a tenth of daylight, in the same hue, so the world still has a colour after dark.
  const y = dayY * (0.08 + 0.92 * day) + warm * 0.06;

  const halfWidth = viewW / 2;
  /**
   * The dome's height is the sky that is actually ON SCREEN, not the viewport's.
   *
   * The horizon is wherever the ground under the camera happens to be, and it is usually well down the frame. Using
   * the full viewport height put every star at its zenith several hundred pixels above the top of the window, which
   * is a sky with no sun in it -- the exact absence this module exists to fix.
   */
  const height = Math.max(80, Math.min(viewH * 1.1, horizonY * 0.92));
  const sunR = Math.max(3, viewH * (0.021 + 0.014 * Math.min(1.6, light.cls.rel)));

  const moons: Moon[] = [];
  const count = Math.min(4, traits.moonCount);
  for (let i = 0; i < count; i++) {
    /**
     * A moon's own period, and a phase offset, so a world with three moons does not have them in convoy.
     *
     * Periods are days rather than hours: a moon that crossed the sky in an afternoon would read as a bird.
     */
    const periodH = traits.dayLength * (4 + f01(hash3(planetId, 0x30a, i)) * 26);
    const turns = seconds / (periodH * 3600) + f01(hash3(planetId, 0x30b, i));
    const ang = turns * Math.PI * 2;
    const elev = Math.cos(ang);
    if (elev <= -0.05) continue; // below the horizon
    const az = Math.sin(ang);
    moons.push({
      x: viewW / 2 + az * halfWidth * DOME_REACH * 0.86,
      y: horizonY - elev * height * DOME_RISE * 0.78,
      r: Math.max(2, sunR * (0.45 + f01(hash3(planetId, 0x30c, i)) * 0.75)),
      // Lit from the star: the phase is just how far the moon is round the sky from it.
      phase: Math.max(-1, Math.min(1, Math.sin(ang) - azimuth)),
    });
  }

  const clouds: { y: number; h: number; drift: number }[] = [];
  const cloudCount = Math.round(Math.min(7, traits.cloudCover * 8));
  for (let i = 0; i < cloudCount; i++) {
    const lift = 0.14 + 0.68 * ((i + 0.5) / Math.max(1, cloudCount)) + f01(hash3(planetId, 0x31a, i)) * 0.1;
    const periodS = 900 + f01(hash3(planetId, 0x31b, i)) * 2600;
    clouds.push({
      y: horizonY - lift * height,
      // A cloud is about a twentieth of the sky tall and five or six times that wide, which is roughly what a
      // fair-weather cumulus looks like from underneath and, more to the point, is big enough to read.
      h: Math.max(3, viewH * (0.026 + f01(hash3(planetId, 0x31c, i)) * 0.04)),
      drift: ((seconds / periodS + f01(hash3(planetId, 0x31d, i))) % 1) * (viewW + 600) - 300,
    });
  }

  return {
    colour: { h: hue, s: sat, l: solveL(hue, sat, y) },
    night,
    elevation,
    azimuthLean: azimuth,
    clock: seconds,
    sunX: viewW / 2 + azimuth * halfWidth * DOME_REACH,
    sunY: horizonY - elevation * height * DOME_RISE,
    sunR,
    sunColour: atLuminance({ h: light.colour.h, s: Math.min(0.7, light.colour.s * 0.8), l: 0.7 }, 0.93),
    moons,
    clouds,
    // The night sky IS the galaxy you flew in through. Nothing here is a decorative speck: the same
    // unresolved starlight a galaxy view draws as diffuse glow is what a night sky shows as grain, and it
    // fades out in daylight for the same reason it does on Earth.
    starfield: Math.max(0, night - 0.35) / 0.65,
    starSeed: planetId,
    horizonY,
    halfWidth,
    height,
    groundAlpha: 1,
  };
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Paint everything overhead: the galaxy's starlight, the moons, the star, and the cloud.
 *
 * Called ONCE per frame, in unrotated screen space, BEFORE any ground is drawn. That ordering is doing three jobs
 * at once. The star is at infinity, so every part of the view must place it at the same point -- painted per plate
 * it gained a parallax a star cannot have, and overlapping plates drew it twice a pixel apart. It has to be
 * occluded by terrain and by rooftops, which comes free if the terrain is painted after it. And the whole sky is
 * then one pass over the screen rather than one pass per tiled plate.
 */
export function paintSky(ctx: CanvasRenderingContext2D, sky: Sky, x0: number, x1: number): void {
  const px = (x: number, _y: number): number => x;
  const py = (_x: number, y: number): number => y;
  const inStrip = (x: number, r: number): boolean => x + r >= x0 && x - r <= x1;

  // 1. The unresolved starlight of the galaxy, at night.
  if (sky.starfield > 0.02) {
    ctx.fillStyle = css({ h: sky.colour.h, s: 0.1, l: 0.92 }, 0.28 + sky.starfield * 0.5);
    const step = Math.max(18, sky.height * 0.045);
    const cols = Math.ceil((x1 - x0) / step) + 2;
    const rows = Math.ceil((sky.height * 0.9) / step) + 1;
    const i0 = Math.floor(x0 / step);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const h = hash3(sky.starSeed, i0 + i, j);
        if (f01(h) > 0.5) continue;
        // Jittered inside its cell so the field does not read as a grid, which is the one thing a night sky
        // must never look like.
        const sx = (i0 + i) * step + f01(hash2(h, 1)) * step;
        const sy = sky.horizonY - sky.height * 0.9 + j * step + f01(hash2(h, 2)) * step;
        if (sy > sky.horizonY) continue;
        const r = 0.5 + f01(hash2(h, 3)) * 1.1;
        ctx.fillRect(px(sx, sy) - r, py(sx, sy) - r, r * 2, r * 2);
      }
    }
  }

  // 2. Moons, behind the star and behind the clouds.
  for (const m of sky.moons) {
    if (!inStrip(m.x, m.r)) continue;
    const mx = px(m.x, m.y);
    const my = py(m.x, m.y);
    ctx.fillStyle = css(atLuminance({ h: sky.colour.h, s: 0.12, l: 0.8 }, 0.62 - sky.night * 0.14));
    ctx.beginPath();
    ctx.arc(mx, my, m.r, 0, Math.PI * 2);
    ctx.fill();
    /**
     * The phase, as a HARD-EDGED crescent: a reversed inner circle inside the disc, filled by the nonzero
     * winding rule. No feather. A soft terminator is the single quickest way to make flat art look like a
     * render that did not quite come off.
     */
    if (Math.abs(m.phase) > 0.12) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(mx, my, m.r, 0, Math.PI * 2);
      ctx.clip();
      ctx.beginPath();
      ctx.rect(mx - m.r, my - m.r, m.r * 2, m.r * 2);
      ctx.arc(mx + m.phase * m.r * 1.5, my, m.r * 1.05, 0, Math.PI * 2, true);
      ctx.fillStyle = css(atLuminance(sky.colour, Math.max(0.03, luminanceOf(sky.colour) * 0.65)));
      ctx.fill();
      ctx.restore();
    }
  }

  // 3. The star. Three flat rings for the bloom rather than a gradient.
  if (sky.elevation > -0.08 && inStrip(sky.sunX, sky.sunR * 4)) {
    const sx = px(sky.sunX, sky.sunY);
    const sy = py(sky.sunX, sky.sunY);
    for (let b = 3; b >= 1; b--) {
      ctx.fillStyle = css(sky.sunColour, 0.1 * (4 - b) * (0.4 + 0.6 * Math.max(0, sky.elevation)));
      ctx.beginPath();
      ctx.arc(sx, sy, sky.sunR * (1 + b * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = css(sky.sunColour);
    ctx.beginPath();
    ctx.arc(sx, sy, sky.sunR, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * 4. Cloud, as clusters of flat discs drifting across.
   *
   * Drawn last so they pass in front of the star, which is what cloud does, and which is the cheapest thing on
   * screen that makes weather read as weather. Discs rather than bands: a long rounded bar reads as a scrollbar,
   * which is exactly how the first version of this looked.
   */
  if (sky.clouds.length) {
    const tone = atLuminance(
      { h: sky.colour.h, s: sky.colour.s * 0.4, l: 0.7 },
      Math.min(0.95, luminanceOf(sky.colour) * 1.6 + 0.14),
    );
    ctx.fillStyle = css(tone, 0.5 + 0.28 * (1 - sky.night));
    /**
     * THE LOBES HAVE TO OVERLAP, which is the whole difference between a cloud and a handful of confetti.
     *
     * They did not. The lobes were spread over four radii of spacing and drawn at about one radius, so every
     * cloud came out as three or four separate circles scattered across the sky -- polka dots, at every zoom,
     * on every world. Spacing a little under the radius makes the discs merge into one lumpy mass, and since
     * they are filled as a single path the overlaps do not show even at partial alpha.
     */
    for (let ci = 0; ci < sky.clouds.length; ci++) {
      const c = sky.clouds[ci]!;
      const lobes = 4 + (ci % 4);
      const step = c.h * 0.74;
      const spanX = step * (lobes - 1) * 0.5 + c.h * 1.2;
      if (c.drift + spanX < x0 || c.drift - spanX > x1) continue;
      ctx.beginPath();
      for (let i = 0; i < lobes; i++) {
        const lx = c.drift + (i - (lobes - 1) / 2) * step;
        // A shallow arch: fatter and higher in the middle, thinning to the ends, which is the shape of a cloud
        // rather than a caterpillar.
        const t = 1 - Math.abs(i - (lobes - 1) / 2) / Math.max(0.5, (lobes - 1) / 2);
        const ly = c.y - t * c.h * 0.3 + Math.sin(i * 2.3 + ci) * c.h * 0.12;
        const lr = c.h * (0.5 + 0.62 * t) * (0.85 + 0.3 * Math.sin(i * 1.7 + ci * 2));
        ctx.moveTo(lx + lr, ly);
        ctx.arc(lx, ly, lr, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }
}
/**
 * How much a surface colour is dimmed and tinted by the time of day.
 *
 * Two-value shading, applied once at the top of the palette rather than per shape: at night the ground keeps
 * its hue and loses its light, which is what actually happens and what keeps a night scene readable. The
 * shadow hue is the star's complement, so a world under a red sun has blue nights.
 *
 * `weight` is how far the camera has arrived: out in space a planet is lit by whatever the picture says lights
 * it and has no local time of day at all, and close in it is midnight or noon where you are standing. Passing
 * the sky's own `groundAlpha` interpolates between the two over exactly the range where the daylight backdrop
 * fades in behind the disc, so the world does not change colour at the moment its regions take over the
 * painting. The plates leave it at 1: by then the arrival is long finished.
 */
export function daylight(c: Hsl, sky: Sky, shadowHue: number, weight = 1): Hsl {
  const night = sky.night * Math.min(1, Math.max(0, weight));
  if (night < 0.01) return c;
  const dim = 1 - night * 0.72;
  const h = c.h + hueDelta(c.h, shadowHue) * night * 0.4;
  const s = c.s * (1 - night * 0.25);
  return { h, s, l: solveL(h, s, Math.max(0.02, luminanceOf(c) * dim)) };
}
