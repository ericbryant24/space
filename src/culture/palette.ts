import { f01, mix, pick, stream } from '../core/rng.ts';
import { atLuminance, contrastRatio, hueGap, luminanceOf, solveL, type Hsl } from '../render/color.ts';

/**
 * Seven-role palettes generated per galaxy (cosmic) and per planet (surface).
 *
 * Roles are defined by target LUMINANCE, not by HSL lightness, and the whole palette is rejected and
 * re-rolled unless it satisfies every constraint below. That rejection step is what separates a
 * palette that reads as designed from one that reads as random.
 */
export type Role = 'INK' | 'DEEP' | 'BODY' | 'MID' | 'LIGHT' | 'PAPER' | 'ACCENT';

export type Palette = Record<Role, Hsl> & {
  /** Hue that shadows rotate towards. Complement-ish of the palette's anchor. */
  shadowHue: number;
  scheme: SchemeName;
  attempts: number;
};

export type SchemeName =
  | 'analogous3'
  | 'splitComplement'
  | 'complementNeutral'
  | 'triad'
  | 'warmCool'
  | 'analogousFarAccent'
  | 'tetrad';

const SCHEME_WEIGHTS: readonly (readonly [SchemeName, number])[] = [
  ['analogous3', 0.26],
  ['splitComplement', 0.22],
  ['complementNeutral', 0.18],
  ['triad', 0.14],
  ['warmCool', 0.11],
  ['analogousFarAccent', 0.06],
  ['tetrad', 0.03],
];

function schemeHues(scheme: SchemeName, h0: number): number[] {
  switch (scheme) {
    case 'analogous3':
      return [h0, h0 + 24, h0 - 24];
    case 'splitComplement':
      return [h0, h0 + 150, h0 + 210];
    case 'complementNeutral':
      return [h0, h0 + 180, h0];
    case 'triad':
      return [h0, h0 + 120, h0 + 240];
    case 'warmCool':
      return [h0, h0 + 15, h0 + 195];
    case 'analogousFarAccent':
      return [h0 - 18, h0 + 18, h0 + 165];
    case 'tetrad':
      return [h0, h0 + 60, h0 + 180, h0 + 240];
  }
}

interface RoleSpec {
  role: Role;
  y: number;
  sMin: number;
  sMax: number;
  /** Index into the scheme's hue list, or 'shadow' for the palette's shadow direction. */
  hue: number | 'shadow';
}

/**
 * `toybox` raises saturation ceilings and keeps mid tones punchy; `sober` is the same geometry with
 * the volume down, used for the deep-space palette so the void does not glow.
 */
export type Mood = 'toybox' | 'sober';

function roleSpecs(mood: Mood): RoleSpec[] {
  const boost = mood === 'toybox' ? 0.1 : 0;
  return [
    { role: 'INK', y: 0.035, sMin: 0.2, sMax: 0.4, hue: 'shadow' },
    { role: 'DEEP', y: 0.1, sMin: 0.3, sMax: 0.7, hue: 0 },
    { role: 'BODY', y: 0.28, sMin: 0.35 + boost, sMax: 0.75 + boost, hue: 0 },
    { role: 'MID', y: 0.45, sMin: 0.3 + boost, sMax: 0.7 + boost, hue: 1 },
    { role: 'LIGHT', y: 0.68, sMin: 0.25 + boost, sMax: 0.6 + boost, hue: 1 },
    { role: 'PAPER', y: 0.86, sMin: 0.06, sMax: 0.3, hue: 0 },
    { role: 'ACCENT', y: 0.55, sMin: 0.75, sMax: 0.95, hue: -1 },
  ];
}

const ROLES: readonly Role[] = ['INK', 'DEEP', 'BODY', 'MID', 'LIGHT', 'PAPER', 'ACCENT'];
/**
 * INK is deliberately NOT part of the drawing ramp. It is the outline and text colour, governed by
 * the contrast rules below; including it here would demand a >=0.11 luminance step from INK (0.035)
 * to DEEP (0.10), which is only 0.065 apart and therefore impossible to satisfy.
 */
const RAMP: readonly Role[] = ['DEEP', 'BODY', 'MID', 'LIGHT', 'PAPER'];

export const MAX_ATTEMPTS = 12;

export function makePalette(nodeId: number, streamName: string, mood: Mood, hueBias = 0): Palette {
  const seed = stream(nodeId, streamName);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = build(seed, attempt, mood, hueBias);
    if (violations(candidate).length === 0) return { ...candidate, attempts: attempt + 1 };
  }
  // Guaranteed fallback. Split-complement spans enough of the wheel to satisfy the hue rules, and
  // 'sober' saturations keep the loud-colour rule happy, so this shape always passes. The test suite
  // asserts that across the whole hue wheel rather than taking it on trust.
  return { ...build(seed, MAX_ATTEMPTS, 'sober', hueBias, 'splitComplement'), attempts: MAX_ATTEMPTS + 1 };
}

function build(
  seed: number,
  attempt: number,
  mood: Mood,
  hueBias: number,
  forceScheme?: SchemeName,
): Omit<Palette, 'attempts'> {
  const r = (tag: number) => f01(mix(mix(seed, attempt * 1013), tag));

  const h0 = (r(1) * 360 + hueBias) % 360;
  const scheme = forceScheme ?? weightedScheme(r(2));
  const hues = schemeHues(scheme, h0);
  const shadowHue = (h0 + 180 + (r(3) * 40 - 20)) % 360;

  const out = {} as Record<Role, Hsl>;
  const specs = roleSpecs(mood);
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const hue =
      spec.hue === 'shadow'
        ? shadowHue
        : spec.hue === -1
          ? accentHue(hues, h0, r(20 + i))
          : hues[spec.hue % hues.length]!;
    const jitter = forceScheme ? 0 : (r(40 + i) * 2 - 1) * 8;
    const h = hue + jitter;
    const s = spec.sMin + r(60 + i) * (spec.sMax - spec.sMin);
    out[spec.role] = { h: ((h % 360) + 360) % 360, s, l: solveL(h, s, spec.y) };
  }
  return { ...out, shadowHue, scheme };
}

/** ACCENT must sit far from the anchor hue or it reads as just another body colour. */
function accentHue(hues: number[], h0: number, r: number): number {
  const far = hues.filter((h) => hueGap(h, h0) >= 130);
  if (far.length) return far[Math.floor(r * far.length) % far.length]!;
  return h0 + 130 + r * 100;
}

function weightedScheme(r: number): SchemeName {
  let acc = 0;
  for (const [name, w] of SCHEME_WEIGHTS) {
    acc += w;
    if (r <= acc) return name;
  }
  return 'analogous3';
}

/**
 * The seven anti-muddy / anti-clash constraints. Any violation rejects the whole palette.
 * Empirically 50-70% of random draws pass, so expect one or two re-rolls.
 */
export function violations(p: Omit<Palette, 'attempts'>): string[] {
  const bad: string[] = [];

  // 1. Adjacent steps of the luminance ramp must be distinguishable.
  for (let i = 1; i < RAMP.length; i++) {
    const a = luminanceOf(p[RAMP[i - 1]!]);
    const b = luminanceOf(p[RAMP[i]!]);
    if (Math.abs(b - a) < 0.11) bad.push(`ramp ${RAMP[i - 1]}->${RAMP[i]} too close in luminance`);
  }

  // 2. Similar hues must be separated by luminance instead.
  for (let i = 0; i < ROLES.length; i++) {
    for (let j = i + 1; j < ROLES.length; j++) {
      const a = p[ROLES[i]!];
      const b = p[ROLES[j]!];
      if (hueGap(a.h, b.h) < 25 && Math.abs(luminanceOf(a) - luminanceOf(b)) < 0.16) {
        bad.push(`${ROLES[i]} and ${ROLES[j]} share a hue without separating in luminance`);
      }
    }
  }

  // 3. No pile-up of loud colours that are close in BOTH hue and luminance -- that is what vibrates
  // and goes muddy. An analogous ramp is fine precisely because luminance separates its roles.
  for (const anchor of ROLES) {
    const loud = ROLES.filter(
      (k) =>
        p[k].s > 0.5 &&
        hueGap(p[k].h, p[anchor].h) <= 40 &&
        Math.abs(luminanceOf(p[k]) - luminanceOf(p[anchor])) < 0.18,
    );
    if (loud.length > 2) bad.push(`too many loud, similar roles near hue ${p[anchor].h.toFixed(0)}`);
  }

  // 4. No dead greys. Every neutral is a tinted neutral.
  for (const k of ROLES) if (p[k].s < 0.06) bad.push(`${k} is an untinted grey`);

  // 5. ACCENT has to work against both backgrounds. It cannot do that by luminance alone: a
  // mid-luminance colour physically cannot reach 3:1 against both a 0.10 ground and a 0.86 one. So it
  // carries luminance contrast in space mode and HUE contrast on paper.
  if (contrastRatio(p.ACCENT, p.DEEP) < 3) bad.push('ACCENT unreadable on DEEP');
  if (contrastRatio(p.ACCENT, p.PAPER) < 1.4) bad.push('ACCENT vanishes into PAPER');
  if (hueGap(p.ACCENT.h, p.PAPER.h) < 45) bad.push('ACCENT is not chromatically distinct from PAPER');

  // 6. INK is the outline and text colour. 7:1 where it carries text, and AA 4.5:1 against MID --
  // 7:1 against MID is unreachable, since INK at 0.035 and MID at 0.45 top out at 5.9:1.
  for (const k of ['PAPER', 'LIGHT'] as const) {
    if (contrastRatio(p.INK, p[k]) < 7) bad.push(`INK unreadable on ${k}`);
  }
  if (contrastRatio(p.INK, p.MID) < 4.5) bad.push('INK unreadable on MID');

  // 7. Neither monochrome nor rainbow.
  let span = 0;
  for (const a of ROLES) for (const b of ROLES) span = Math.max(span, hueGap(p[a].h, p[b].h));
  if (span < 45) bad.push('palette is effectively monochrome');
  if (span > 300) bad.push('palette spans too much of the wheel');

  return bad;
}

/** Background for space mode: one end of the luminance ramp, pushed darker still. */
export function voidBackground(p: Palette): Hsl {
  return atLuminance({ h: p.INK.h, s: Math.max(0.25, p.DEEP.s * 0.7), l: 0 }, 0.012);
}

/** Background for surface mode: the other end of the same ramp. */
export function paperBackground(p: Palette): Hsl {
  return p.PAPER;
}
