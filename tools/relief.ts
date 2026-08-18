/**
 * How bumpy is the ground, at every level, in units of the frame you are looking at?
 *
 * This is the one number the rim design lives or dies by. Terrain has to read as terrain at planet, region,
 * settlement AND building zoom, and a fractal field only does that for a narrow range of persistence: too low
 * and every plate is a ruled line, too high and the ground swings clean out of frame by the time you are
 * standing on it.
 */
import { RELIEF, groundAt } from '../src/culture/terrain.ts';
import { planetTraits } from '../src/universe/gen/planet.ts';
import { LEVELS, type Kind } from '../src/universe/schema.ts';

const worlds = () => {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const id = (i * 2654435761 + 12345) >>> 0;
    out.push({ id, traits: planetTraits(id, (i * 40503 + 7) >>> 0, i % 5, 5) });
  }
  return out;
};

const spread = (v: number[]) => {
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)]! - s[Math.floor(s.length * 0.05)]!;
};

// Peak-to-peak of the planet's own outline, as a fraction of its radius.
let planetPP = 0;
for (const { id, traits } of worlds()) {
  const v: number[] = [];
  for (let i = 0; i < 2048; i++) v.push(groundAt(id, traits, (i / 2048) * Math.PI * 2, 11));
  planetPP += Math.max(...v) - Math.min(...v);
}
console.log(`planet outline peak-to-peak: ${((planetPP / 40) * 100).toFixed(1)}% of radius  (RELIEF=${RELIEF})`);

// Relief across one frame, in that frame's own local units, for each level below the planet.
for (const kind of ['region', 'settlement', 'building'] as Kind[]) {
  const span = 2 ** (LEVELS[kind].logSpan - LEVELS.planet.logSpan);
  const detail = Math.min(30, Math.round(Math.log2(1 / span)) + 8);
  const s: number[] = [];
  for (const { id, traits } of worlds()) {
    for (let t = 0; t < 8; t++) {
      const theta0 = (t / 8) * Math.PI * 2 + id * 1e-7;
      const base = groundAt(id, traits, theta0, detail);
      const v: number[] = [];
      for (let i = 0; i < 240; i++) {
        const u = -1 + (2 * i) / 239;
        v.push((groundAt(id, traits, theta0 + u * span, detail) - base) / span);
      }
      s.push(spread(v));
    }
  }
  s.sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)]!;
  console.log(
    `${kind.padEnd(11)} relief across frame: median ${med.toFixed(2)}  p90 ${s[Math.floor(s.length * 0.9)]!.toFixed(2)}  ` +
      `p99 ${s[Math.floor(s.length * 0.99)]!.toFixed(2)}  max ${s[s.length - 1]!.toFixed(2)}  (local radii)`,
  );
}
