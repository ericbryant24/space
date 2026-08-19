/**
 * POP DETECTOR: does the picture change more than the zoom accounts for?
 *
 * This is the one promise a zoomer like this makes -- that nothing snaps -- and it was the only promise with
 * no harness behind it. Screenshots prove each rung looks right; the pops live BETWEEN the rungs, in the
 * moments where one representation hands over to another, and they are exactly what a reviewer flicking
 * through eight PNGs cannot see.
 *
 * HOW IT WORKS. Wheel zoom is anchored at the screen centre, so a zoom of `dz` doublings transforms the
 * image by a scale of 2^dz about that centre, with no translation -- and, through the arrival at a world, a
 * turn as well, because the scene rotates to put the ground the right way up (see src/camera/orientation.ts).
 * So take the frame before, scale AND turn it by what the camera actually did, and subtract the frame after.
 * The turn is read from the renderer rather than guessed; without it, coming upright reads as the biggest pop
 * in the run, which is exactly the sort of false positive that makes a detector useless.
 * What is left is everything the camera does NOT explain:
 * something appearing, something vanishing, a fill changing colour, an outline snapping to full weight.
 * Resampling leaves a floor of residual that grows with local contrast, so the test is not an absolute
 * threshold but a SPIKE against the run's own median -- which is what a pop is, in one number.
 *
 * The camera must not translate while measuring, which is why this drives `__zoomStep` rather than
 * `__diveStep`, and re-aims only on its own schedule, discarding the frame either side of an aim.
 *
 *   node tools/pop-check.ts
 *   POP_STEP=0.125 POP_STEPS=500 node tools/pop-check.ts
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173/space/';
const OUT = process.env.POP_OUT ?? 'shots/pops';
/** Zoom per measured step, in doublings. Small enough that the scale model holds well. */
const STEP = Number(process.env.POP_STEP ?? 0.25);
const STEPS = Number(process.env.POP_STEPS ?? 420);
/** Re-aim every this many steps, so a pure zoom down the middle does not stall in the void. */
const AIM_EVERY = Number(process.env.POP_AIM_EVERY ?? 8);
/**
 * A step is a pop if its residual is this many times the local median AND clears an absolute floor.
 *
 * Both halves are needed. The ratio alone fires all over the empty levels, where the median residual is
 * nearly zero and any change at all is a hundred times it; the floor alone fires on every high-contrast
 * view, where honest resampling error is larger than a real pop elsewhere.
 */
const SPIKE = Number(process.env.POP_SPIKE ?? 3.2);
const FLOOR = Number(process.env.POP_FLOOR ?? 0.012);
/**
 * How far a step has to stand above the steps either side of it before it is a discontinuity rather than part
 * of a transition.
 *
 * Two. A crossfade run at any sensible rate moves the picture by roughly the same amount on each of its steps,
 * so consecutive elevated steps are a ramp; a thing appearing moves one step and only one.
 */
const RAMP_MARGIN = Number(process.env.POP_RAMP ?? 2);
/** How many of the worst steps to write out as before/after PNGs. */
const KEEP = Number(process.env.POP_KEEP ?? 6);

function chromiumPath(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  for (const dir of ['chromium', ...(existsSync(root) ? readdirSync(root) : [])]) {
    if (!dir.startsWith('chromium')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * Everything pixel-side runs INSIDE the page.
 *
 * A 320x200 luma frame is 64,000 numbers, and shipping two of those across the CDP boundary for each of
 * four hundred steps is most of the run time. Keeping the previous frame in a page-side variable and
 * returning one float per step costs nothing.
 */
const INSTALL = () => {
  const w = window as unknown as {
    __pop: {
      grab(): void;
      residual(dz: number, dUp: number): number;
      reset(): void;
    };
  };
  const W = 320;
  const H = 200;
  const scratch = document.createElement('canvas');
  scratch.width = W;
  scratch.height = H;
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
  const view = document.getElementById('view') as HTMLCanvasElement;
  let prev: Float32Array | null = null;
  let cur: Float32Array | null = null;

  const read = (): Float32Array => {
    sctx.drawImage(view, 0, 0, W, H);
    const data = sctx.getImageData(0, 0, W, H).data;
    const out = new Float32Array(W * H);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      // Rec.709 luma. One channel is enough: a pop that preserves luma exactly is not a pop you can see.
      out[i] = 0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!;
    }
    return out;
  };

  w.__pop = {
    reset() {
      prev = null;
      cur = null;
    },
    grab() {
      prev = cur;
      cur = read();
    },
    residual(dz: number, dUp: number) {
      if (!prev || !cur) return -1;
      const s = 2 ** dz;
      const cx = (W - 1) / 2;
      const cy = (H - 1) / 2;
      // Inverse of the turn, because this walks the AFTER image and samples the BEFORE one.
      const kc = Math.cos(-dUp) / s;
      const ks = Math.sin(-dUp) / s;
      let sum = 0;
      let n = 0;
      for (let y = 0; y < H; y++) {
        const dy = y - cy;
        for (let x = 0; x < W; x++) {
          const dx = x - cx;
          const sx = cx + dx * kc - dy * ks;
          const sy = cy + dy * kc + dx * ks;
          if (sx < 0 || sx > W - 1 || sy < 0 || sy > H - 1) continue;
          const y0 = Math.floor(sy);
          const fy = sy - y0;
          const y1 = Math.min(H - 1, y0 + 1);
          const x0 = Math.floor(sx);
          const fx = sx - x0;
          const x1 = Math.min(W - 1, x0 + 1);
          const a = prev[y0 * W + x0]!;
          const b = prev[y0 * W + x1]!;
          const c = prev[y1 * W + x0]!;
          const d = prev[y1 * W + x1]!;
          const want = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
          sum += Math.abs(cur[y * W + x]! - want);
          n++;
        }
      }
      return n === 0 ? -1 : sum / n / 255;
    },
  };
};

interface Sample {
  step: number;
  kind: string;
  z: number;
  dz: number;
  residual: number;
  ratio: number;
}

const state = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __cam: { node: { kind: string }; z: number };
      __lastStats?: { up?: number };
    };
    return { kind: w.__cam.node.kind, z: w.__cam.z, up: w.__lastStats?.up ?? 0 };
  });

const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction('window.__zoomStep !== undefined', null, { timeout: 20000 });
  // Ambient motion is a change the zoom does not account for, and a real one -- but it is not a pop, and it
  // would swamp everything. Freezing the clock is what makes the residual mean only what it should.
  await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));
  await page.evaluate(INSTALL);

  const samples: Sample[] = [];
  const recent: number[] = [];
  let skipNext = true;

  for (let step = 0; step < STEPS; step++) {
    const before = await state(page);
    if (before.kind === 'building' && before.z > 7.5) break;

    const aiming = step > 0 && step % AIM_EVERY === 0;
    if (aiming) {
      await page.evaluate(() => (window as unknown as { __aimStep(): void }).__aimStep());
      skipNext = true;
    }
    await page.evaluate((dz: number) => (window as unknown as { __zoomStep(d: number): void }).__zoomStep(dz), STEP);
    await frame(page);
    await frame(page);
    const after = await state(page);
    await page.evaluate(() => (window as unknown as { __pop: { grab(): void } }).__pop.grab());

    if (skipNext) {
      skipNext = false;
      continue;
    }
    const dz = after.z - before.z;
    const dUp = after.up - before.up;
    const residual = await page.evaluate(
      ([d, u]: [number, number]) =>
        (window as unknown as { __pop: { residual(d: number, u: number): number } }).__pop.residual(d, u),
      [dz, dUp] as [number, number],
    );
    if (residual < 0) continue;

    // The median of the last twenty steps, so the baseline tracks the view rather than the whole run: a
    // galaxy full of stipple has a legitimately higher resampling floor than an empty field.
    const window20 = recent.slice(-20).slice().sort((a, b) => a - b);
    const median = window20.length >= 6 ? window20[Math.floor(window20.length / 2)]! : residual;
    recent.push(residual);
    samples.push({
      step,
      kind: after.kind,
      z: after.z,
      dz,
      residual,
      ratio: median > 1e-9 ? residual / median : 1,
    });
  }

  /**
   * A POP IS AN ISOLATED SPIKE. A RAMP IS A CROSSFADE DOING ITS JOB.
   *
   * The three tests above -- above the floor, and well above the local median -- catch every step where the
   * picture changed more than the zoom accounts for. That is not the same as a pop. Arriving at a world is
   * MEANT to change the picture for a while: the sky fades in, the daylight comes up, the ground turns upright,
   * a galaxy's arms resolve out of its wash. Those run for six or eight consecutive steps and each one of them
   * clears the median by ten times, because everything either side of the transition is so quiet.
   *
   * What you can SEE is a discontinuity, and a discontinuity is a step that stands out from the steps either
   * side of it as well as from the run. So a spike is only reported as a pop when it is a local maximum by a
   * clear margin. The plateaus are still counted and still printed -- a transition that takes eight steps is
   * worth knowing about -- they are just not called pops, because calling them pops is what would make the
   * number stop meaning anything.
   */
  const isolated = (i: number): boolean => {
    const r = samples[i]!.residual;
    const before = samples[i - 1];
    const after = samples[i + 1];
    const near = Math.max(before?.residual ?? 0, after?.residual ?? 0);
    return r > near * RAMP_MARGIN;
  };
  const flagged = samples.map((s, i) => ({ s, i })).filter(({ s }) => s.residual > FLOOR && s.ratio > SPIKE);
  const pops = flagged
    .filter(({ i }) => isolated(i))
    .map(({ s }) => s)
    .sort((a, b) => b.ratio * b.residual - a.ratio * a.residual);
  const ramps = flagged.filter(({ i }) => !isolated(i)).map(({ s }) => s);

  const all = samples.map((s) => s.residual).sort((a, b) => a - b);
  const q = (f: number) => all[Math.min(all.length - 1, Math.floor(f * all.length))] ?? 0;

  console.log(`${samples.length} measured steps of ${STEP} doublings each, ${AIM_EVERY - 1} in every ${AIM_EVERY}`);
  console.log(`residual  p50 ${q(0.5).toFixed(4)}  p90 ${q(0.9).toFixed(4)}  p99 ${q(0.99).toFixed(4)}  max ${q(1).toFixed(4)}`);

  const byKind = new Map<string, Sample[]>();
  for (const s of samples) {
    const list = byKind.get(s.kind) ?? [];
    list.push(s);
    byKind.set(s.kind, list);
  }
  console.log('\nlevel         steps   p50      worst    at z');
  for (const [kind, list] of byKind) {
    const sorted = list.map((s) => s.residual).sort((a, b) => a - b);
    const worst = list.reduce((a, b) => (b.residual > a.residual ? b : a));
    console.log(
      `${kind.padEnd(12)} ${String(list.length).padStart(5)}   ` +
        `${sorted[Math.floor(sorted.length / 2)]!.toFixed(4)}   ${worst.residual.toFixed(4)}   ${worst.z.toFixed(2)}`,
    );
  }

  if (ramps.length) {
    // Grouped by the level they happen at: a run of them at one level is one transition, not eight faults.
    const at = new Map<string, { n: number; lo: number; hi: number; worst: number }>();
    for (const r of ramps) {
      const e = at.get(r.kind) ?? { n: 0, lo: r.z, hi: r.z, worst: 0 };
      e.n++;
      e.lo = Math.min(e.lo, r.z);
      e.hi = Math.max(e.hi, r.z);
      e.worst = Math.max(e.worst, r.residual);
      at.set(r.kind, e);
    }
    console.log(`\n${ramps.length} steps inside a transition (elevated, but not a step change):`);
    for (const [kind, e] of at) {
      console.log(
        `  ${kind.padEnd(11)} ${String(e.n).padStart(2)} steps over z ${e.lo.toFixed(2)}..${e.hi.toFixed(2)}, worst ${e.worst.toFixed(4)}`,
      );
    }
  }

  if (pops.length) {
    console.log(`\n${pops.length} POP${pops.length === 1 ? '' : 'S'} (isolated: residual > ${FLOOR}, > ${SPIKE}x the local median, and ${RAMP_MARGIN}x its own neighbours):`);
    for (const p of pops.slice(0, 14)) {
      console.log(
        `  ${p.kind.padEnd(11)} z=${p.z.toFixed(2)}  residual ${p.residual.toFixed(4)}  ${p.ratio.toFixed(1)}x median`,
      );
    }

    // Replay to the worst spikes and write the frames either side, because a number does not tell you WHAT
    // appeared. Replaying is exact: the clock is frozen and every step is deterministic.
    const wanted = new Set(pops.slice(0, KEEP).map((p) => p.step));
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction('window.__zoomStep !== undefined', null, { timeout: 20000 });
    await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));
    for (let step = 0; step < STEPS && wanted.size > 0; step++) {
      if (step > 0 && step % AIM_EVERY === 0) {
        await page.evaluate(() => (window as unknown as { __aimStep(): void }).__aimStep());
      }
      if (wanted.has(step)) {
        const s = await state(page);
        await page.screenshot({ path: `${OUT}/${String(step).padStart(3, '0')}-a-${s.kind}-z${s.z.toFixed(1)}.png` });
      }
      await page.evaluate((dz: number) => (window as unknown as { __zoomStep(d: number): void }).__zoomStep(dz), STEP);
      await frame(page);
      await frame(page);
      if (wanted.has(step)) {
        const s = await state(page);
        await page.screenshot({ path: `${OUT}/${String(step).padStart(3, '0')}-b-${s.kind}-z${s.z.toFixed(1)}.png` });
        wanted.delete(step);
      }
    }
    console.log(`\nbefore/after pairs for the worst ${KEEP} written to ${OUT}/`);
  } else {
    console.log('\nno pops: every step changed the picture by no more than the zoom accounts for');
  }

  await browser.close();
  if (errors.length) {
    console.error('\nPage errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  // Deliberately not a gate. The residual floor depends on content, and failing a build on it would mean
  // failing on how stippled a galaxy happens to be. The spike list is the finding; a human reads it.
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
