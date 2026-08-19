// Lenses.
//
// A lens is the ONLY thing that differs between the prototypes. It answers three questions about a
// point on the rim -- which way is up, how far out is a given altitude, and how many pixels a metre
// of ground is worth right there -- and the renderer knows nothing else. That is the whole point of
// the exercise: same world, same paint, three different ways of skewing the scale.

import { R, ATM, ORBIT } from './world.js';
import { clamp, smooth, wrap } from './util.js';
const L = (a) => Math.sign(a) * Math.log1p(Math.abs(a));

// --- the radial scale ------------------------------------------------------------------------------
//
// The skew, art-directed. Read it as: sea level sits at 0.64 of the disc, and the 40 metres above it
// -- the height of a decent building -- is worth as much screen as the 500 km below it. Interpolation
// happens in log-altitude, so the curve is smooth and monotone and there is no rung in it.

const ANCHORS = [
  [-R, 0.0], [-1.9e6, 0.26], [-4.2e5, 0.40], [-6.0e4, 0.505], [-5.4e3, 0.585],
  [0, 0.640], [40, 0.666], [900, 0.702], [3.6e3, 0.742], [12e3, 0.774],
  [4.0e4, 0.800], [ATM, 0.848], [ORBIT, 0.906],
];
const AL = ANCHORS.map(([a, f]) => [L(a), f]);
export const SEA_FRAC = 0.640;

function artFrac(alt) {
  const x = L(clamp(alt, -R, ORBIT));
  for (let i = 1; i < AL.length; i++) {
    if (x <= AL[i][0]) {
      const [x0, f0] = AL[i - 1], [x1, f1] = AL[i];
      return f0 + (f1 - f0) * (x - x0) / (x1 - x0);
    }
  }
  return AL[AL.length - 1][1];
}
const trueFrac = (alt) => (R + clamp(alt, -R, ORBIT)) / (R + ORBIT) * 0.962;

/**
 * Fraction of the disc radius for an ALTITUDE. Pure art direction, no local magnification anywhere in
 * it -- which is what makes every shell outside the ground a true circle at every zoom.
 *
 * `relief` blends the skew away: at 0 the planet is a true-scale disc, which is a featureless circle
 * with a hairline of sky, and at 1 it is the art-directed ramp above.
 */
export function radialFrac(alt, relief = 1) {
  return trueFrac(alt) + (artFrac(alt) - trueFrac(alt)) * relief;
}

/**
 * How tall an object of `h` metres standing at altitude `base` is drawn, in pixels.
 *
 * Heights are measured from the thing's OWN GROUND, never from sea level, and this is the correction
 * that made the whole idea work. Feeding absolute altitude through a locally-isotropic scale put a
 * town sitting at 400 m elevation 180 px outside the disc, buildings floating in the sky above a
 * coastline they belonged to. Terrain keeps the art-directed ramp -- that is the skew, and it is what
 * makes a mountain legible from orbit -- while an object's own height takes whichever is larger, the
 * ramp or a locally true scale. So a building is 9 px tall on a whole planet and correctly
 * proportioned on a street, and the ground never moves under it either way.
 *
 * The isotropic part fades out between 60 and 600 metres. Left to run at every height it magnified
 * cloud decks into 275-px slabs the moment you zoomed in on a street.
 */
export function heightPx(alt, h, along, diskR, relief = 1) {
  const art = (radialFrac(alt + h, relief) - radialFrac(alt, relief)) * diskR;
  const w = 1 - smooth(Math.abs(h), 60, 600);
  if (w <= 0) return art;
  const K = 0.20 * diskR;
  // Capped: nothing a person builds gets to be a fifth of the planet on screen.
  const iso = Math.sign(h) * Math.min(0.17 * diskR, K * Math.log1p(Math.abs(h) * along / K));
  return art + (Math.max(Math.abs(art), Math.abs(iso)) * Math.sign(h || 1) - art) * w;
}


// --- 1. RIM: one true circle, altitude exaggerated -------------------------------------------------

export function rimLens({ cx, cy, diskR, focus = 0, relief = 1, scale = 1 }) {
  const dR = diskR * scale;
  const iso0 = (SEA_FRAC * dR) / R;
  const off = -focus - Math.PI / 2;                    // the focus rides at the top of the disc
  return {
    kind: 'rim', cx, cy, diskR: dR, focus, mag: scale, relief,
    angleOf: (t) => t + off,
    along: () => iso0,
    rho(alt) { return radialFrac(alt, relief) * dR; },
    height(alt, h) { return heightPx(alt, h, iso0, dR, relief); },
    window: () => [focus - Math.PI, focus + Math.PI],
    seaPx: SEA_FRAC * dR,
  };
}

// --- 2. FISHEYE: one circle, longitude redistributed -----------------------------------------------
//
// The disc never changes size and never leaves the screen. Instead the angles are redistributed: a
// window of `w` radians around the focus is spread across a fixed screen arc `W`, and the whole rest
// of the planet is compressed logarithmically into what is left. Every decade of distance from the
// focus is therefore worth a constant slice of screen -- which is what lets one circle hold both a
// street and the far side of the world.
//
// `a` is solved, not tuned: it is the value that makes the derivative continuous across the edge of
// the focus window. Guess at it and there is a visible kink in the coastline where the two halves of
// the map meet.

function solveFalloff(w, W) {
  const target = (Math.PI - W) * w / W;
  let lo = 1e-14, hi = Math.PI;
  for (let i = 0; i < 90; i++) {
    const a = Math.sqrt(lo * hi);
    (a * Math.log1p((Math.PI - w) / a) < target ? (lo = a) : (hi = a));
  }
  return Math.sqrt(lo * hi);
}

export function fisheyeLens({ cx, cy, diskR, focus = 0, relief = 1, zoom = 0 }) {
  // zoom is in decades of magnification at the focus.
  const w = Math.PI * Math.pow(10, -zoom);
  // How much SCREEN ARC the focus window is allowed. It has to shrink as the zoom grows, and this is
  // the difference between a place and a novelty: held at 114 deg, a 200 m street was bent through
  // 114 deg of circle and its buildings splayed outward like the teeth of a crown. Tapering to 46 deg
  // keeps the ground gently curved where you are looking, and hands the other 314 deg back to the
  // rest of the planet, which reads better for it.
  const Wmax = 0.40 + 0.55 * (1 - smooth(zoom, 0.6, 3.6));
  const W = Wmax + (Math.PI - Wmax) * Math.sqrt(Math.min(1, w / Math.PI));
  const a = solveFalloff(w, W);
  const Lg = Math.log1p((Math.PI - w) / a);
  const seaPx = SEA_FRAC * diskR;
  const g = (d) => {
    const x = Math.abs(d);
    return Math.sign(d) * (x <= w ? W * x / w : W + (Math.PI - W) * Math.log1p((x - w) / a) / Lg);
  };
  const gp = (d) => {
    const x = Math.abs(d);
    return x <= w ? W / w : (Math.PI - W) / (Lg * (a + x - w));
  };
  return {
    kind: 'fisheye', cx, cy, diskR, focus, relief, mag: W / w, w, W,
    angleOf: (t) => g(wrap(t - focus)) - Math.PI / 2,
    along: (t) => seaPx * gp(wrap(t - focus)) / R,
    rho(alt) { return radialFrac(alt, relief) * diskR; },
    height(alt, h, t) { return heightPx(alt, h, this.along(t), diskR, relief); },
    window: () => [focus - Math.PI, focus + Math.PI],
    seaPx,
  };
}

// --- 3. LADDER: the scales as concentric rings -----------------------------------------------------
//
// The planet stays a small undistorted disc in the middle. Each ring outside it is one arc of the
// ring within, unrolled all the way round and magnified. Ground sits on a ring's INNER edge and the
// sky fills outward, so "up is outward" holds everywhere, planet included.

export function ladderRing({ cx, cy, rIn, rOut, focus, arc, relief = 1 }) {
  // `arc` is the half-width in radians of the slice of the world this ring unrolls.
  const mag = Math.PI / arc;
  const r0 = rIn + (rOut - rIn) * 0.22;                // sea level, a fifth of the way up the ring
  const band = rOut - r0;
  const along = r0 * mag / R;                          // px per metre along the ring's ground
  // A ring's altitude scale is the same art-directed ramp, squeezed to fit the ring's thickness: the
  // sea-level-to-space span becomes 90% of the band. Doing it isotropically instead -- which is what
  // an unrolled strip wants -- flattened every mountain on the wide inner rings to a pixel and a half.
  const dv = 0.9 * band / (radialFrac(ATM) - SEA_FRAC);
  return {
    kind: 'ring', cx, cy, diskR: dv, focus, relief, mag, arc, rIn, rOut, r0, band,
    angleOf: (t) => wrap(t - focus) * mag - Math.PI / 2,
    along: () => along,
    rho(alt) {
      const v = (radialFrac(alt, relief) - SEA_FRAC) * dv;
      return r0 + clamp(v, -(r0 - rIn) * 0.92, band * 0.99);
    },
    // Nothing standing on a rung may outgrow its rung: at 0.9 the outermost ring's towers climbed
    // straight through the ring above and were sheared off by its clip.
    height(alt, h) { return Math.min(band * 0.45, heightPx(alt, h, along, dv, relief)); },
    window: () => [focus - arc, focus + arc],
    seaPx: r0,
    ringGround: true,
  };
}
