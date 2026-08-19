// A world as a ring.
//
// The planet is a cross-section: one angle theta runs all the way round, and every point on the rim
// has an altitude. Theta IS latitude -- equator at theta=0 and pi, poles at pi/2 and 3pi/2 -- so ice
// caps land at the top and bottom of the circle without being placed there by hand.
//
// Everything here is pure and deterministic. Nothing knows how it will be drawn.

export const R = 6.05e6;          // planet radius, metres
export const SEA = 0;             // sea level datum
export const ATM = 130e3;         // top of the drawn atmosphere
export const ORBIT = 520e3;       // where the stations ride

import { TAU, mod } from './util.js';

// --- hashing ---------------------------------------------------------------------------------------

function h2(a, b) {
  let x = (a | 0) * 0x27d4eb2d ^ (b | 0) * 0x165667b1;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// Value noise on the circle. The lattice has an integer number of cells, so it wraps exactly -- no
// seam at theta=0, which a naive 1D noise would leave as a cliff you could navigate to.
function ring(seed, freq, t) {
  const x = t * freq, i = Math.floor(x), f = x - i;
  const a = h2(seed, mod(i, freq)), b = h2(seed, mod(i + 1, freq));
  return a + (b - a) * f * f * (3 - 2 * f);
}
function fbm(seed, freq, oct, t) {
  let v = 0, amp = 1, norm = 0, fr = freq;
  for (let k = 0; k < oct; k++) {
    v += amp * ring(seed + k * 7919, fr, t);
    norm += amp; amp *= 0.5; fr *= 2;
  }
  return v / norm;
}
function ridged(seed, freq, oct, t) {
  let v = 0, amp = 1, norm = 0, fr = freq;
  for (let k = 0; k < oct; k++) {
    v += amp * (1 - Math.abs(2 * ring(seed + k * 6151, fr, t) - 1));
    norm += amp; amp *= 0.5; fr *= 2;
  }
  return v / norm;
}

// --- terrain ---------------------------------------------------------------------------------------

export function makeWorld(seed = 7) {
  const sC = seed * 1013 + 1, sM = seed * 1013 + 2, sB = seed * 1013 + 3, sR = seed * 1013 + 4,
    sD = seed * 1013 + 5;

  // The waterline is SOLVED, not assumed. A three-cell continent field is nearly a constant offset
  // per seed, so a fixed sea level gave one world 85% land and the next almost none. Sampling the
  // field and taking the quantile that hits this world's land target keeps every world legible while
  // still letting them differ.
  const landTarget = 0.24 + h2(sC, 999) * 0.3;
  const [waterline, contHi, contLo] = (() => {
    const N = 2048, v = new Float64Array(N);
    for (let i = 0; i < N; i++) v[i] = fbm(sC, 3, 4, i / N);
    const sorted = Float64Array.from(v).sort();
    return [sorted[Math.floor((1 - landTarget) * (N - 1))], sorted[N - 1], sorted[0]];
  })();
  const upSpan = Math.max(1e-4, contHi - waterline), downSpan = Math.max(1e-4, waterline - contLo);

  // Elevation in metres. Continents are a low-frequency field cut at the waterline; mountains are
  // ridged noise gated by a belt mask, so ranges cluster instead of spattering evenly round the rim.
  function coarse(theta) {
    const t = mod(theta, TAU) / TAU;
    const cont = fbm(sC, 3, 4, t) - waterline;
    // Normalised against this world's own range, so a seed with a flat continent field gets a full
    // set of altitudes rather than a rim you cannot tell from a circle.
    let e = cont > 0 ? Math.pow(cont / upSpan, 1.25) * 3600 : -Math.pow(-cont / downSpan, 0.8) * 5400;
    if (e > 0) {
      const belt = Math.max(0, fbm(sB, 5, 2, t) - 0.42) / 0.58;
      const r = ridged(sR, 21, 4, t);
      e += belt * belt * Math.pow(r, 1.7) * 5200;
      // Coastal shelf: flatten the first kilometre inland so cities have somewhere to sit.
      e *= 1 - 0.45 * Math.exp(-e / 1100);
    }
    return e;
  }

  // Detail is damped in deep water and on the high ice, and full strength around the coasts and
  // lowlands where anything is ever built.
  function elevation(theta) {
    const e = coarse(theta);
    const gate = Math.exp(-Math.max(0, -e) / 2200) * (0.4 + 0.6 * Math.exp(-Math.max(0, e) / 2600));
    return e + detail(mod(theta, TAU) / TAU) * gate;
  }

  // Detail, all the way down. The continent and ridge fields stop at 168 cycles round the world --
  // a 226 km wavelength -- so magnifying a few hundred metres of coast showed a perfectly smooth arc
  // with nothing on it. Fourteen more octaves take it down to a 23 m wavelength.
  //
  // The amplitudes are deliberately rougher than nature: at a true Hurst exponent a 100 m stretch of
  // ground varies by a couple of centimetres, which is correct and reads as a dead straight line.
  function detail(t) {
    let v = 0, amp = 60, fr = 200;
    for (let k = 0; k < 14; k++) {
      v += amp * (ring(sD + k * 4211, fr, t) - 0.5) * 2;
      amp *= 0.62; fr *= 2;
    }
    return v;
  }

  const moisture = (theta) => fbm(sM, 7, 3, mod(theta, TAU) / TAU);

  // Latitude is theta -- but the ring is an INCLINED great circle, not a polar one. Cutting exactly
  // through both poles put 40% of the rim inside the ice caps; tilting the section to reach 66 deg
  // leaves caps that read as caps.
  const MAXLAT = 0.94;
  function temperature(theta, elev) {
    const lat = Math.abs(Math.sin(theta)) * MAXLAT;
    return 1 - Math.pow(lat, 1.5) - Math.max(0, elev) / 9000 * 0.62;
  }

  function biome(theta) {
    const e = elevation(theta);
    const T = temperature(theta, e), m = moisture(theta);
    if (e <= SEA) return T < 0.1 ? 'seaIce' : (e < -3200 ? 'abyss' : 'shelf');
    if (T < 0.13) return 'ice';
    if (T < 0.3) return 'tundra';
    if (m < 0.3) return 'desert';
    if (T > 0.72 && m > 0.55) return 'jungle';
    if (m > 0.45) return 'forest';
    return 'grass';
  }

  // --- settlements -------------------------------------------------------------------------------
  //
  // Sites are found, not scattered: score the whole rim for buildability, keep the local maxima. So a
  // city is always somewhere a city would be -- low, temperate, and within reach of a coast.

  const sites = (() => {
    const N = 8192, score = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const th = i / N * TAU, e = coarse(th);
      if (e <= 20) continue;
      const T = temperature(th, e), m = moisture(th);
      if (T < 0.16) continue;
      // distance to water, sampled outward in both directions
      let coast = 0;
      for (let d = 1; d <= 40; d++) {
        if (coarse(th + d / N * TAU) <= SEA || coarse(th - d / N * TAU) <= SEA) { coast = 1 - d / 40; break; }
      }
      const low = Math.exp(-e / 1400);
      const wet = Math.min(1, m / 0.55);
      score[i] = (0.35 + 0.65 * coast) * low * wet * (0.45 + 0.55 * T) * (0.7 + 0.6 * h2(9001, i));
    }
    const found = [];
    for (let i = 0; i < N; i++) {
      const s = score[i];
      if (s < 0.02) continue;
      let peak = true;
      for (let d = -26; d <= 26; d++) if (score[mod(i + d, N)] > s) { peak = false; break; }
      if (peak) found.push({ i, s });
    }
    found.sort((a, b) => b.s - a.s);
    return found.slice(0, 22).map((f, k) => {
      const th = f.i / N * TAU;
      const weight = f.s;
      // Half-extent along the surface: a hamlet is 400 m of frontage, a capital 14 km.
      const half = 420 + Math.pow(weight, 1.5) * 26000 * (0.5 + h2(4441, f.i));
      return {
        id: k, theta: th, half, weight,
        seed: 5000 + f.i,
        // Tall downtowns only where the weight is really there.
        tallness: Math.pow(weight, 1.3) * (0.55 + 0.9 * h2(4442, f.i)),
        biome: biome(th),
      };
    });
  })();

  // Buildings for a site, in metres of offset along the surface from its centre. Cached: a site is
  // rebuilt only once however many frames look at it.
  const plotCache = new Map();
  function plots(site) {
    let list = plotCache.get(site.id);
    if (list) return list;
    list = [];
    const span = site.half * 2;
    let x = -site.half;
    let n = 0;
    while (x < site.half && n < 900) {
      const r1 = h2(site.seed, n * 3), r2 = h2(site.seed, n * 3 + 1), r3 = h2(site.seed, n * 3 + 2);
      const w = 9 + r1 * 26;
      // Height falls off from the centre -- one downtown, then blocks, then sheds at the edge.
      const core = 1 - Math.min(1, Math.abs(x) / (site.half * 0.55));
      const tall = Math.pow(core, 1.8) * site.tallness;
      let h = 5 + r2 * 9 + tall * 70;
      if (r3 > 0.985) h *= 2.6 + r3;                    // the occasional tower
      list.push({ x, w, h, kind: r3 > 0.985 ? 'tower' : (h > 26 ? 'block' : 'low'), seed: site.seed + n });
      x += w + (2 + r3 * 7) * (1 + 3 * (1 - core));      // gaps widen towards the outskirts
      n++;
    }
    plotCache.set(site.id, list);
    // Remember the true span so the lens can know how wide the built-up strip really is.
    return list;
  }

  // Trees on demand over a metre range: a lattice with jitter, so the same tree is the same tree
  // whatever window asks for it.
  function trees(theta0, theta1, spacing, limit = 4000) {
    const out = [];
    const x0 = theta0 * R, x1 = theta1 * R;
    let n0 = Math.floor(x0 / spacing), n1 = Math.ceil(x1 / spacing);
    if (n1 - n0 > limit) return out;
    for (let n = n0; n <= n1; n++) {
      const j = h2(31337, n);
      const x = (n + (j - 0.5) * 0.8) * spacing;
      out.push({ theta: x / R, h: 1, seed: n });
    }
    return out;
  }

  // A weather DECK, not weather. Thirty-four short clouds scattered through four kilometres of air
  // read as debris floating near a planet; the same budget spent on long clouds in a narrow band
  // reads as cloud. Broken, not continuous -- you have to be able to see the ground through it.
  const clouds = Array.from({ length: 26 }, (_, i) => ({
    theta: h2(sM + 77, i) * TAU,
    alt: 400 + h2(sM + 78, i) * 900,
    len: (0.02 + h2(sM + 79, i) * 0.1),             // radians
    thick: 500 + h2(sM + 80, i) * 900,
    drift: (0.4 + h2(sM + 81, i)) * 3.2e-6 * (h2(sM + 82, i) < 0.5 ? -1 : 1),
    seed: i,
  }));

  const stations = Array.from({ length: 5 }, (_, i) => ({
    theta: h2(sM + 91, i) * TAU,
    alt: ORBIT * (0.72 + 0.5 * h2(sM + 92, i)),
    drift: 1.1e-5 * (0.6 + h2(sM + 93, i)),
  }));

  /**
   * The waterline nearest a longitude, to a metre.
   *
   * The default view wants variety in one window, not a uniform picket of downtown: a shoreline puts
   * sea, beach, buildings and forest in the same few hundred metres, which is the only place on a
   * planet where every scale is legible at once.
   */
  function coastNear(theta) {
    let best = null, bestD = Infinity;
    const N = 4096;
    for (let i = 0; i < N; i++) {
      for (const sgn of [1, -1]) {
        const t = theta + sgn * i / N * 0.3;
        if (Math.sign(coarse(t)) !== Math.sign(coarse(t + 0.3 / N))) {
          const d = Math.abs(i);
          if (d < bestD) { bestD = d; best = t; }
        }
      }
      if (best !== null) break;
    }
    if (best === null) return theta;
    // bisect to a metre
    let lo = best, hi = best + 0.3 / N;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      (Math.sign(coarse(lo)) === Math.sign(coarse(m)) ? (lo = m) : (hi = m));
    }
    return (lo + hi) / 2;
  }

  return { seed, elevation, coarse, coastNear, moisture, temperature, biome, sites, plots, trees, clouds, stations, R, SEA, ATM, ORBIT };
}

// --- names -----------------------------------------------------------------------------------------

const ON = ['t', 'k', 's', 'm', 'n', 'r', 'l', 'v', 'th', 'sh', 'br', 'dr', 'gl', 'p', 'h'];
const NU = ['a', 'e', 'i', 'o', 'u', 'ai', 'ei', 'ou', 'ae'];
const CO = ['', '', 'n', 'r', 'l', 's', 'm', 'th', 'sk', 'nd'];

export function nameOf(seed) {
  const pick = (arr, k) => arr[Math.floor(h2(seed, k) * arr.length)];
  let s = '';
  const syll = 2 + (h2(seed, 90) > 0.62 ? 1 : 0);
  for (let i = 0; i < syll; i++) s += pick(ON, i * 3) + pick(NU, i * 3 + 1) + pick(CO, i * 3 + 2);
  return s[0].toUpperCase() + s.slice(1);
}
