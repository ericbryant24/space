/**
 * Representation bands.
 *
 * Thresholds are expressed as the ON-SCREEN RADIUS IN PIXELS of the thing being drawn -- a local,
 * scale-free quantity -- so one table serves a galaxy at z = -61 and a doorknob at z = +4.
 *
 * THE RULE THAT MAKES CROSSFADES INVISIBLE: adjacent bands share identical ramp endpoints, so their
 * alphas sum to exactly 1 (smoothstep(a,b,x) + (1 - smoothstep(a,b,x)) === 1). Perceived brightness
 * and mass then stay constant through every transition. Getting this wrong is the single biggest
 * source of visible popping.
 */
export function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface BandSpec {
  readonly rep: string;
  /** Fade in across [px, px]. */
  readonly in: readonly [number, number];
  /** Fade out across [px, px]. Infinity means "never fades out". */
  readonly out: readonly [number, number];
}

export interface ActiveRep {
  readonly rep: string;
  readonly alpha: number;
}

/**
 * Every band table must be a partition: band N's `out` equals band N+1's `in`, the first band fades
 * in from nothing, and the last never fades out. `validateBands` enforces exactly that.
 */
export const BANDS: Readonly<Record<string, readonly BandSpec[]>> = {
  galaxy: [
    { rep: 'blob', in: [0.45, 1.2], out: [26, 64] },
    // The wash hands over to live arms at 110-320 px rather than 900-2200. The old thresholds meant a
    // galaxy only resolved into structure once it was several screens wide, so at the size people
    // actually look at one they saw a baked picture whose stars were not places. Live arms then only
    // hold until 420 px, because past there the ribbon is bigger than the screen -- see 'deep'.
    { rep: 'wash', in: [26, 64], out: [110, 320] },
    { rep: 'arms', in: [110, 320], out: [420, 1700] },
    // Deep inside, the arm ribbons stop being a picture of a galaxy and become a flat wall of colour:
    // their edges are off screen, so all they contribute is fill. So they dissolve into `deep`, which
    // draws nothing itself -- the picture there is the interior wash and the unresolved starfield,
    // painted as the sky behind everything, plus the galaxy's own catalogued stars. That is the honest
    // view from inside a galaxy: no structure you could resolve at arm's length, and stars.
    //
    // 420 px is where the ribbons' outer edges leave an 800 px-tall viewport; by 1700 px, about two and
    // a half screens across, they are gone. The haze fades in over the same range -- see
    // MAX_LATTICE_LEVEL and ARMS_FADE_PX in draw/galaxy.ts, which must match these numbers.
    { rep: 'deep', in: [420, 1700], out: [Infinity, Infinity] },
  ],
  planet: [
    { rep: 'dot', in: [0.45, 1.2], out: [3, 9] },
    { rep: 'disc', in: [3, 9], out: [400, 1100] },
    { rep: 'regions', in: [400, 1100], out: [Infinity, Infinity] },
  ],
  generic: [{ rep: 'disc', in: [0.45, 1.2], out: [Infinity, Infinity] }],
};

/**
 * Which representations are live at this on-screen size, and how strongly.
 * `bias` above 1 promotes cheaper representations earlier; the adaptive-quality knob feeds it.
 */
export function activeReps(kind: string, radiusPx: number, bias = 1): ActiveRep[] {
  const table = BANDS[kind] ?? BANDS.generic!;
  const r = radiusPx / bias;
  const out: ActiveRep[] = [];
  for (const band of table) {
    const alpha = smoothstep(band.in[0], band.in[1], r) * (1 - smoothstep(band.out[0], band.out[1], r));
    if (alpha > 1 / 255) out.push({ rep: band.rep, alpha });
  }
  return out;
}

/** Total coverage at a given size. Must be 1 everywhere the object is visible at all. */
export function coverage(kind: string, radiusPx: number, bias = 1): number {
  let sum = 0;
  for (const r of activeRepsRaw(kind, radiusPx, bias)) sum += r.alpha;
  return sum;
}

function activeRepsRaw(kind: string, radiusPx: number, bias: number): ActiveRep[] {
  const table = BANDS[kind] ?? BANDS.generic!;
  const r = radiusPx / bias;
  return table.map((band) => ({
    rep: band.rep,
    alpha: smoothstep(band.in[0], band.in[1], r) * (1 - smoothstep(band.out[0], band.out[1], r)),
  }));
}

/** Structural check that a band table really is a partition. Called by the test suite. */
export function validateBands(table: readonly BandSpec[]): string[] {
  const problems: string[] = [];
  if (table.length === 0) return ['empty table'];
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (first.in[0] <= 0) problems.push('first band must fade in from a positive size');
  if (last.out[0] !== Infinity) problems.push('last band must never fade out');
  for (let i = 1; i < table.length; i++) {
    const prev = table[i - 1]!;
    const cur = table[i]!;
    if (prev.out[0] !== cur.in[0] || prev.out[1] !== cur.in[1]) {
      problems.push(`band ${prev.rep} -> ${cur.rep} ramps do not share endpoints`);
    }
  }
  for (const b of table) {
    if (b.in[0] > b.in[1]) problems.push(`${b.rep} has a reversed fade-in`);
    if (b.out[0] > b.out[1]) problems.push(`${b.rep} has a reversed fade-out`);
    if (b.in[1] > b.out[0]) problems.push(`${b.rep} fades out before it has faded in`);
  }
  return problems;
}

/**
 * Outline weight ramps with alpha instead of appearing at full width, because a thick cartoon outline
 * snapping into existence is the sneakiest popping artefact of the lot.
 */
export function outlineWidth(radiusPx: number, weight = 2): number {
  if (radiusPx < 6) return 0;
  const t = Math.min(1, (radiusPx - 6) / 10);
  return weight * t;
}
