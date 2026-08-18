import { f01, fnv1a, hash2, hash3, mix } from '../core/rng.ts';
import type { Language } from './language.ts';

/**
 * A WRITING SYSTEM PER PLANET.
 *
 * The highest style-payoff-per-line item in the whole project, and the argument for it is short: every sign,
 * banner and boundary marker on a world can be written in that world's own script, spelling that place's
 * actual name. It costs a lookup table of line segments.
 *
 * The design is deliberately not "draw squiggles". A glyph is a small set of strokes on a 3x3 grid, and the
 * grid is what makes the output read as WRITING rather than as decoration: strokes meet at shared points, so
 * letters have joins and stems and a consistent x-height, and a row of them has the rhythm of a line of text.
 *
 * The mapping is from the planet's own PHONEME INVENTORY, not from Latin letters. A language with no voiced
 * stops has no glyphs for them; a language with eight vowels has eight vowel marks. So the script is a
 * portrait of the language rather than a cipher on top of English, and two worlds whose languages differ in
 * shape produce scripts that differ in shape too.
 *
 * NO TEXT IS EVER DRAWN. These are strokes on a canvas. The project shows no words -- see src/ui/hud.ts --
 * and a generated script is not a word, it is a pattern that happens to be a real one.
 */

/**
 * Grid points, 0-8, in reading order:
 *
 *   0 1 2      top
 *   3 4 5      middle
 *   6 7 8      baseline
 *
 * A glyph is a list of point pairs. Kept as small integers so a glyph is cheap to store and cheap to compare.
 */
export type Glyph = readonly (readonly [number, number])[];

const GX = [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1] as const;
const GY = [0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1] as const;

/**
 * The stroke vocabulary a script draws from.
 *
 * Every entry connects two grid points, and the set is closed under the joins that make writing look written:
 * verticals, horizontals, both diagonals, and the half-length strokes that give a glyph a serif or a tail. A
 * script picks a SUBSET of these -- which is what makes one world's writing all verticals and hard corners and
 * another's all diagonals.
 */
const STROKES: readonly (readonly [number, number])[] = [
  [0, 3], [3, 6], [1, 4], [4, 7], [2, 5], [5, 8], // verticals
  [0, 1], [1, 2], [3, 4], [4, 5], [6, 7], [7, 8], // horizontals
  [0, 4], [4, 8], [2, 4], [4, 6], // long diagonals
  [1, 3], [1, 5], [3, 7], [5, 7], // short diagonals
  [0, 2], [6, 8], [0, 6], [2, 8], // full spans
];

export interface Script {
  /** Glyph for each onset, coda and vowel of the language, keyed by the phoneme's own spelling. */
  readonly glyphs: ReadonlyMap<string, Glyph>;
  /** Marks that ride above a consonant to spell its vowel, keyed by vowel. Empty if vowels get full glyphs. */
  readonly marks: ReadonlyMap<string, Glyph>;
  /** True when vowels are written as marks above the consonant rather than as letters in the row. */
  readonly abjad: boolean;
  /** Strokes per glyph, before joins. Low is spare and angular, high is dense and woven. */
  readonly weight: number;
  /** Whether the baseline is a drawn rule the glyphs hang from, as Devanagari does. */
  readonly headline: boolean;
  /** Reading direction. -1 writes right to left, which is a real and cheap difference. */
  readonly direction: 1 | -1;
}

const cache = new Map<number, Script>();

function makeGlyph(seed: number, palette: readonly (readonly [number, number])[], count: number): Glyph {
  const out: [number, number][] = [];
  const used = new Set<number>();
  for (let i = 0; out.length < count && i < count * 6; i++) {
    const k = (hash2(seed, i) >>> 8) % palette.length;
    if (used.has(k)) continue;
    used.add(k);
    const s = palette[k]!;
    out.push([s[0], s[1]]);
  }
  /**
   * A glyph must be CONNECTED, or it reads as two marks rather than one letter.
   *
   * Rather than rejecting and re-rolling -- which would make the result depend on how many attempts it took,
   * the order dependence the named-stream rule exists to forbid -- any stroke that shares no point with the
   * rest is rewritten to start where the previous one ended. That always produces a connected figure and
   * never changes how many strokes a glyph has.
   */
  for (let i = 1; i < out.length; i++) {
    const before = out.slice(0, i);
    const touches = before.some((s) => s[0] === out[i]![0] || s[1] === out[i]![0] || s[0] === out[i]![1] || s[1] === out[i]![1]);
    if (!touches) out[i] = [out[i - 1]![1], out[i]![1]];
  }
  return out;
}

export function scriptOf(planetId: number, lang: Language): Script {
  let s = cache.get(planetId);
  if (s) return s;

  const seed = hash2(planetId, fnv1a('script'));
  /**
   * The script's own stroke palette: a subset of the vocabulary, sized so that a spare script is genuinely
   * spare. Six strokes to choose from produces writing with a strong family resemblance; eighteen produces
   * writing that looks like a font with too many ideas.
   */
  const paletteSize = 6 + Math.floor(f01(mix(seed, 1)) * 9);
  const palette: (readonly [number, number])[] = [];
  const taken = new Set<number>();
  for (let i = 0; palette.length < paletteSize && i < paletteSize * 8; i++) {
    const k = (hash2(seed, 100 + i) >>> 8) % STROKES.length;
    if (taken.has(k)) continue;
    taken.add(k);
    palette.push(STROKES[k]!);
  }

  const weight = 2 + Math.floor(f01(mix(seed, 2)) * 3);
  // An abjad only makes sense if there are consonants to hang the marks on, and it is the single change that
  // most alters how a line of writing looks, so it is worth a fair share of worlds.
  const abjad = lang.onsets.length >= 4 && f01(mix(seed, 3)) < 0.35;

  const glyphs = new Map<string, Glyph>();
  const marks = new Map<string, Glyph>();
  const letters = [...new Set([...lang.onsets, ...lang.codas])];
  for (const p of letters) {
    glyphs.set(p, makeGlyph(hash3(seed, 0x11, fnv1a(p)), palette, weight));
  }
  for (const v of lang.vowels) {
    if (abjad) {
      // A mark is one or two strokes in the TOP row only, so it sits over the letter rather than beside it.
      const top = palette.filter((st) => st[0] < 3 && st[1] < 6);
      marks.set(v, makeGlyph(hash3(seed, 0x22, fnv1a(v)), top.length ? top : palette, 1 + (fnv1a(v) & 1)));
    } else {
      glyphs.set(v, makeGlyph(hash3(seed, 0x33, fnv1a(v)), palette, Math.max(1, weight - 1)));
    }
  }

  s = {
    glyphs,
    marks,
    abjad,
    weight,
    headline: f01(mix(seed, 4)) < 0.3,
    direction: f01(mix(seed, 5)) < 0.22 ? -1 : 1,
  };
  if (cache.size > 256) cache.clear();
  cache.set(planetId, s);
  return s;
}

/**
 * Split a word in this language's own spelling into the phonemes the script has glyphs for.
 *
 * Longest match first, because a language with the digraph 'th' and the letters 't' and 'h' must spell 'th'
 * as one glyph or the writing contradicts the language. Anything unmatched -- an apostrophe, a hyphen, a
 * letter an orthography quirk introduced -- becomes a word break rather than a wrong glyph.
 */
export function segment(script: Script, word: string): string[] {
  const keys = [...script.glyphs.keys(), ...script.marks.keys()].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  const lower = word.toLowerCase();
  let i = 0;
  outer: while (i < lower.length) {
    for (const k of keys) {
      if (k && lower.startsWith(k, i)) {
        out.push(k);
        i += k.length;
        continue outer;
      }
    }
    i += 1;
  }
  return out;
}

/**
 * Draw a word in a planet's own writing, fitted into a box.
 *
 * `height` is the x-height in pixels: the glyph grid's own height. Everything else -- stroke width, spacing,
 * the headline rule -- is derived from it, so one call scales from a nameplate on a door to a banner across a
 * plaza. Returns the width actually drawn, so a caller can centre or right-align without measuring twice.
 *
 * Below about five pixels of x-height a glyph stops being a shape and becomes grit, so the whole line
 * collapses to a single rule: the honest mark for "there is writing here, too small to read".
 */
export function drawScript(
  ctx: CanvasRenderingContext2D,
  script: Script,
  word: string,
  x: number,
  baseline: number,
  height: number,
  colour: string,
): number {
  const phonemes = segment(script, word);
  if (phonemes.length === 0) return 0;

  const advance = height * 0.78;
  const width = phonemes.filter((p) => script.glyphs.has(p)).length * advance;
  if (height < 5) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(0.8, height * 0.3);
    ctx.beginPath();
    ctx.moveTo(x, baseline - height * 0.4);
    ctx.lineTo(x + width, baseline - height * 0.4);
    ctx.stroke();
    return width;
  }

  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(0.9, height * 0.13);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const gw = height * 0.58;
  let pen = script.direction === 1 ? x : x + width;
  let pendingMark: Glyph | null = null;

  const stroke = (glyph: Glyph, gx: number, top: number, w: number, h: number): void => {
    ctx.beginPath();
    for (const [a, b] of glyph) {
      ctx.moveTo(gx + GX[a]! * w, top + GY[a]! * h);
      ctx.lineTo(gx + GX[b]! * w, top + GY[b]! * h);
    }
    ctx.stroke();
  };

  for (const p of phonemes) {
    const mark = script.marks.get(p);
    if (mark) {
      pendingMark = mark;
      continue;
    }
    const glyph = script.glyphs.get(p);
    if (!glyph) continue;
    const gx = script.direction === 1 ? pen : pen - gw;
    stroke(glyph, gx, baseline - height, gw, height);
    if (pendingMark) {
      // The mark rides in the space above the x-height, at a third of the size: it is a diacritic, not a letter.
      stroke(pendingMark, gx + gw * 0.15, baseline - height * 1.42, gw * 0.7, height * 0.34);
      pendingMark = null;
    }
    pen += advance * script.direction;
  }

  if (script.headline) {
    ctx.lineWidth = Math.max(0.9, height * 0.1);
    ctx.beginPath();
    ctx.moveTo(x, baseline - height);
    ctx.lineTo(x + width, baseline - height);
    ctx.stroke();
  }
  ctx.restore();
  return width;
}

/** Width a word will occupy, for laying out a sign before drawing it. */
export function scriptWidth(script: Script, word: string, height: number): number {
  return segment(script, word).filter((p) => script.glyphs.has(p)).length * height * 0.78;
}

/** One line of English about a script, for the debug readout. Never shown in the default view. */
export function describeScript(s: Script): string {
  return (
    `${s.glyphs.size} glyphs of ${s.weight} strokes` +
    `${s.abjad ? `, ${s.marks.size} vowel marks` : ''}${s.headline ? ', hung from a headline' : ''}` +
    `${s.direction === -1 ? ', written right to left' : ''}`
  );
}
