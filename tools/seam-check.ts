/**
 * SEAM DETECTOR. Counts isolated one-pixel-wide vertical anomalies in a rendered PNG.
 *
 * The ground below a planet is painted by hundreds of plates tiled edge to edge, and getting that wrong does not
 * look like a bug -- it looks like a faint vertical rule every seventeen pixels, at a contrast of about seven
 * percent, which is easy to look straight past in a screenshot and impossible to unsee once pointed out. Three
 * separate tiling schemes each produced their own version of it. This finds them in one number.
 *
 *   node tools/seam-check.ts shots/5-region.png
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
const file = process.argv[2] ?? 'shots/5-region.png';
const d = readFileSync(file);
let pos = 8, idat: Buffer[] = [], w = 0, h = 0, ct = 0;
while (pos < d.length) {
  const ln = d.readUInt32BE(pos), typ = d.subarray(pos + 4, pos + 8).toString('latin1');
  if (typ === 'IHDR') { w = d.readUInt32BE(pos + 8); h = d.readUInt32BE(pos + 12); ct = d[pos + 17]!; }
  if (typ === 'IDAT') idat.push(d.subarray(pos + 8, pos + 8 + ln));
  pos += 12 + ln;
}
const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
const raw = inflateSync(Buffer.concat(idat));
const out = Buffer.alloc(h * stride);
let prev = Buffer.alloc(stride), p = 0;
for (let y = 0; y < h; y++) {
  const f = raw[p++]!;
  const cur = Buffer.from(raw.subarray(p, p + stride)); p += stride;
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? cur[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
    if (f === 1) cur[i] = (cur[i]! + a) & 255;
    else if (f === 2) cur[i] = (cur[i]! + b) & 255;
    else if (f === 3) cur[i] = (cur[i]! + ((a + b) >> 1)) & 255;
    else if (f === 4) {
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      cur[i] = (cur[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
  }
  cur.copy(out, y * stride); prev = cur;
}
const at = (x: number, y: number) => [
  out[y * stride + x * bpp]!,
  out[y * stride + x * bpp + 1]!,
  out[y * stride + x * bpp + 2]!,
];

/**
 * A seam is a column that is anomalous over MANY rows.
 *
 * Scoring single rows independently was useless: a label's letters and the near-vertical stretches of the coastline
 * are isolated one-pixel anomalies too, and they drowned the signal completely -- a run reported a delta of 111 for
 * the word "Downs". What distinguishes a tiling seam is that it runs the full height of the picture, so counting how
 * many sampled rows each column offends in separates the two cleanly with no thresholds to tune.
 */
const ROWS = 48;
const hits = new Int32Array(w);
for (let k = 0; k < ROWS; k++) {
  const y = Math.round(((k + 0.5) / ROWS) * (h - 4)) + 2;
  for (let x = 2; x < w - 2; x++) {
    const l = at(x - 2, y), m = at(x, y), rr = at(x + 2, y);
    // An isolated column: both neighbours agree with each other and disagree with this one.
    const nb = Math.max(...l.map((v, i) => Math.abs(v - rr[i]!)));
    const dev = Math.max(...m.map((v, i) => Math.abs(v - (l[i]! + rr[i]!) / 2)));
    if (nb <= 2 && dev > 3) hits[x]!++;
  }
}
/** A column offending in more than this fraction of rows is structural, not content. */
const LIMIT = 0.4;
const seams: string[] = [];
for (let x = 0; x < w; x++) {
  if (hits[x]! > ROWS * LIMIT) seams.push(`x=${x} (${hits[x]}/${ROWS} rows)`);
}
const worst = Math.max(0, ...Array.from(hits));
console.log(`${file}: ${seams.length} seam columns; busiest column offends ${worst}/${ROWS} rows`);
if (seams.length) {
  console.error(`\nSEAMS at ${seams.slice(0, 12).join(', ')}${seams.length > 12 ? ', ...' : ''}`);
  console.error('Plates are not tiling cleanly -- see the note on bounding fills in src/render/draw/ground.ts.');
  process.exit(1);
}
console.log('no seams');
