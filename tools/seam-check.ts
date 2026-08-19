/**
 * SEAM DETECTOR. Finds vertical anomalies in a rendered PNG that no landscape can account for.
 *
 * The ground below a planet is painted by hundreds of plates tiled edge to edge, and getting that wrong does not
 * look like a bug -- it looks like a faint vertical rule every few hundred pixels, at a contrast of about seven
 * percent, which is easy to look straight past in a screenshot and impossible to unsee once pointed out. Three
 * separate tiling schemes each produced their own version of it.
 *
 * Two detectors, because a boundary shows up in two shapes:
 *
 *   A HAIRLINE -- one column that disagrees with both its neighbours while they agree with each other. That is
 *   antialiasing against a fill drawn underneath, and it is what clipping to a strip produces.
 *
 *   A STEP -- everything to the right of a column drawn a shade differently from everything to the left, down
 *   most of the height of the picture. That is two plates disagreeing about a value, and no hillside does it:
 *   real ground varies smoothly in x, so a genuine edge is a spike in the column-to-column difference rather
 *   than a level in it.
 *
 *   node tools/seam-check.ts                       # every surface shot
 *   node tools/seam-check.ts shots/5-region.png
 */
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

interface Image {
  w: number;
  h: number;
  at(x: number, y: number): [number, number, number];
}

function decode(file: string): Image {
  const d = readFileSync(file);
  let pos = 8;
  const idat: Buffer[] = [];
  let w = 0;
  let h = 0;
  let ct = 0;
  while (pos < d.length) {
    const ln = d.readUInt32BE(pos);
    const typ = d.subarray(pos + 4, pos + 8).toString('latin1');
    if (typ === 'IHDR') {
      w = d.readUInt32BE(pos + 8);
      h = d.readUInt32BE(pos + 12);
      ct = d[pos + 17]!;
    }
    if (typ === 'IDAT') idat.push(d.subarray(pos + 8, pos + 8 + ln));
    pos += 12 + ln;
  }
  const bpp = ct === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++]!;
    const cur = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      if (f === 1) cur[i] = (cur[i]! + a) & 255;
      else if (f === 2) cur[i] = (cur[i]! + b) & 255;
      else if (f === 3) cur[i] = (cur[i]! + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        cur[i] = (cur[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return {
    w,
    h,
    at: (x, y) => {
      const o = y * stride + x * bpp;
      return [out[o]!, out[o + 1]!, out[o + 2]!];
    },
  };
}

/** Rows sampled down the picture. Enough that a seam cannot hide between them, few enough to be instant. */
const ROWS = 64;
/** A column offending in more than this fraction of rows is structural, not content. */
const LIMIT = 0.4;
/** How much bigger than its own neighbourhood a column difference has to be before it is an edge and not a slope. */
const STEP_SPIKE = 4;
/** And how many levels of 0-255 it has to move at all, so a dead-flat sky does not fire on rounding. */
const STEP_FLOOR = 2.2;
/** And how much of the height it has to run down, so the side of a building is not mistaken for a plate edge. */
const STEP_RUN = 0.45;
/**
 * Above this many levels an edge is a thing, not a seam.
 *
 * Two plates read the same field at the angle where they meet, so anything they disagree about is a rounding
 * error dressed up -- a few levels at most. A forty-level edge running half the height is the side of a house,
 * and at building zoom a house does run half the height. Catching those would make the detector cry wolf on
 * every picture worth taking, and a disagreement that large between plates would be visible from across the
 * room anyway.
 */
const STEP_CEILING = 12;

function rowsOf(h: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < ROWS; k++) out.push(Math.round(((k + 0.5) / ROWS) * (h - 4)) + 2);
  return out;
}

/** One column disagreeing with both neighbours while they agree with each other. */
function hairlines(img: Image): { seams: string[]; worst: number } {
  const { w, at } = img;
  const hits = new Int32Array(w);
  for (const y of rowsOf(img.h)) {
    for (let x = 2; x < w - 2; x++) {
      const l = at(x - 2, y);
      const m = at(x, y);
      const rr = at(x + 2, y);
      const nb = Math.max(...l.map((v, i) => Math.abs(v - rr[i]!)));
      const dev = Math.max(...m.map((v, i) => Math.abs(v - (l[i]! + rr[i]!) / 2)));
      if (nb <= 2 && dev > 3) hits[x]!++;
    }
  }
  const seams: string[] = [];
  for (let x = 0; x < w; x++) if (hits[x]! > ROWS * LIMIT) seams.push(`x=${x} (${hits[x]}/${ROWS} rows)`);
  return { seams, worst: Math.max(0, ...Array.from(hits)) };
}

/**
 * A level change that runs down the picture.
 *
 * `d(x)` is the average signed brightness step from x-1 to x+1 over the sampled rows. Ground shades smoothly in
 * x, so on a hillside `d` is small and varies slowly; at a plate boundary it spikes at one column. Comparing
 * each column against the median of its own neighbourhood rather than against a fixed threshold is what lets
 * this run on a picture of a cliff without crying wolf.
 */
function steps(img: Image): { seams: string[]; worst: number } {
  const { w, at } = img;
  const rows = rowsOf(img.h);
  const d = new Float64Array(w);
  const coherent = new Float64Array(w);
  for (let x = 2; x < w - 2; x++) {
    const each: number[] = [];
    let sum = 0;
    for (const y of rows) {
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const v = 0.2126 * (r[0] - l[0]) + 0.7152 * (r[1] - l[1]) + 0.0722 * (r[2] - l[2]);
      each.push(v);
      sum += v;
    }
    d[x] = sum / rows.length;
    /**
     * HOW MUCH OF THE PICTURE THE EDGE RUNS DOWN, which is the whole of what separates a seam from an object.
     *
     * The side of a building is a forty-level step and perfectly real; it covers a fifth of the height. A plate
     * boundary is a two-level step and a defect; it runs down everything the plate painted. So an edge only
     * counts if most of the sampled rows agree with it, in sign and in substance.
     */
    const sign = Math.sign(d[x]!);
    let agree = 0;
    for (const v of each) if (v * sign > 1) agree++;
    coherent[x] = agree / rows.length;
  }
  const seams: string[] = [];
  let worst = 0;
  const span = 12;
  for (let x = span + 2; x < w - span - 2; x++) {
    const near: number[] = [];
    for (let k = -span; k <= span; k++) if (k !== 0) near.push(Math.abs(d[x + k]!));
    near.sort((a, b) => a - b);
    const median = near[Math.floor(near.length / 2)]!;
    const mine = Math.abs(d[x]!);
    const ratio = mine / Math.max(0.35, median);
    const run = coherent[x]!;
    // An edge sitting next to a much bigger one is its antialiasing, not a seam of its own.
    let beside = false;
    for (let k = -6; k <= 6 && !beside; k++) if (Math.abs(d[x + k]!) >= STEP_CEILING) beside = true;
    if (!beside && mine > STEP_FLOOR && mine < STEP_CEILING && ratio > STEP_SPIKE && run > STEP_RUN) {
      seams.push(`x=${x} (${mine.toFixed(1)} levels, ${ratio.toFixed(1)}x its neighbourhood, down ${(run * 100) | 0}%)`);
    }
    if (mine > STEP_FLOOR && mine < STEP_CEILING && run > STEP_RUN) worst = Math.max(worst, ratio);
  }
  return { seams, worst };
}

const DEFAULTS = [
  'shots/5-region.png',
  'shots/6-settlement.png',
  'shots/7-building.png',
  ...['00', '01', '02', '03'].flatMap((i) => [
    `shots/worlds/${i}-region.png`,
    `shots/worlds/${i}-settlement.png`,
    `shots/worlds/${i}-building.png`,
  ]),
];

const files = (process.argv.length > 2 ? process.argv.slice(2) : DEFAULTS).filter((f) => existsSync(f));
if (files.length === 0) {
  console.error('nothing to check -- run `npm run shots` and `npm run worlds` first');
  process.exit(1);
}

let bad = 0;
for (const file of files) {
  const img = decode(file);
  const hair = hairlines(img);
  const step = steps(img);
  const all = [...hair.seams.map((s) => `hairline ${s}`), ...step.seams.map((s) => `step ${s}`)];
  console.log(
    `${file}: ${all.length} seam columns; worst hairline ${hair.worst}/${ROWS} rows, worst step ${step.worst.toFixed(1)}x`,
  );
  if (all.length) {
    bad++;
    console.error(`  ${all.slice(0, 8).join('\n  ')}${all.length > 8 ? '\n  ...' : ''}`);
  }
}
if (bad) {
  console.error(`\n${bad} of ${files.length} shots show seams.`);
  console.error('Plates are not tiling cleanly -- see the note on bounding fills in src/render/draw/ground.ts.');
  process.exit(1);
}
console.log(`\nno seams in ${files.length} shots`);
