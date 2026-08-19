/**
 * Drives the real page down the whole ladder and writes one PNG per level. Run after every
 * milestone: it is the quickest way to notice a regression at a level you were not working on, and
 * the images are the review artefact.
 *
 * Chromium is preinstalled in this environment (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers).
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173/';
const OUT = process.env.SHOT_OUT ?? 'shots';

/**
 * Rather than guessing how many doublings each level takes, dive one small step at a time and
 * snapshot the moment the focus node's kind changes. That directly demonstrates the thing the project
 * is for -- a single continuous descent through every rung -- and fails loudly if a rung is skipped.
 */

/**
 * Offsets, in frame units, applied once the dive reaches galaxy focus.
 *
 * Zooming straight through the middle of the screen lands wherever geometry puts it, and about one
 * system in twelve is barren -- an honest outcome the generator is meant to produce, but a dead end for
 * a harness that has to reach a building. So each attempt falls through a different star. Every attempt
 * is still one unbroken descent, which is what the precision assertions below are actually testing.
 */
const AIM: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.10, 0.06],
  [-0.09, 0.11],
  [0.14, -0.12],
  [-0.15, -0.07],
  [0.05, 0.17],
  [-0.18, 0.03],
  [0.02, -0.19],
];
const EXPECTED: readonly string[] = [
  'field',
  'cluster',
  'galaxy',
  'system',
  'planet',
  'region',
  'settlement',
  'building',
];

/**
 * The preinstalled Chromium may not match the exact build this Playwright version would download,
 * and downloading is disabled here, so point at the binary on disk instead of running
 * `playwright install`.
 */
function chromiumPath(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dirs = ['chromium', ...(existsSync(root) ? readdirSync(root) : [])];
  for (const dir of dirs) {
    if (!dir.startsWith('chromium')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction('window.__diveStep !== undefined', null, { timeout: 15000 });
  /**
   * Start at the TOP of the ladder, not where the app opens.
   *
   * The app opens one rung in, on a cluster -- see `openingState` in main.ts -- because the whole field is
   * thirty faint dots and a poor front door. A harness that walks the ladder wants the ladder's top, and Home
   * is what goes there.
   */
  await page.keyboard.press('Home');
  // Freeze ambient motion: orbits ticking mid-capture would make every run differ.
  await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));

  let seen = new Set<string>();
  let minHeadroom = Infinity;
  // Filmstrip mode also captures the stretches BETWEEN rungs, which is where "everything in between"
  // either holds up or turns out to be a dead void.
  const strip = process.env.SHOT_STRIP ? Number(process.env.SHOT_STRIP) : 0;

  for (let attempt = 0; attempt < AIM.length; attempt++) {
    if (attempt > 0) {
      console.log(`  (that descent ended at ${[...seen].pop()}; re-aiming and starting over)`);
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForFunction('window.__diveStep !== undefined', null, { timeout: 15000 });
      await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));
      seen = new Set<string>();
    }
    let index = 0;
    let aimed = false;

    for (let step = 0; step < 400; step++) {
      const state = await readState(page);

      if (state.r < 63.9 || state.r > 1024.1) throw new Error(`step ${step}: R left the window (${state.r})`);
      if (state.headroom < 30) throw new Error(`step ${step}: mantissa headroom ${state.headroom}`);
      minHeadroom = Math.min(minHeadroom, state.headroom);

      if (!seen.has(state.kind)) {
        seen.add(state.kind);
        const name = `${index++}-${state.kind}`;
        await page.screenshot({ path: `${OUT}/${name}.png` });
        console.log(
          `${name.padEnd(14)} depth=${state.depth} R=${state.r.toFixed(1)}px ` +
            `headroom=${state.headroom.toFixed(1)}b z=${state.z.toFixed(2)} draws=${state.draws}`,
        );
      }
      if (strip && step % strip === 0) {
        const label = `strip-${String(step).padStart(3, '0')}-${state.kind}-z${state.z.toFixed(0)}`;
        await page.screenshot({ path: `${OUT}/${label}.png` });
      }
      if (state.kind === 'building') break;
      // `updateFocus` clamps z at the bottom of the ladder, so once it stops moving the descent is over
      // whether or not it arrived. Without this the harness spends 300 more no-op steps finding out.
      if (state.z >= 7.99) break;

      if (state.kind === 'galaxy' && !aimed) {
        aimed = true;
        await page.evaluate(([dx, dy]: number[]) => {
          const cam = (window as unknown as { __cam: { fx: number; fy: number } }).__cam;
          cam.fx += dx!;
          cam.fy += dy!;
        }, [AIM[attempt]![0], AIM[attempt]![1]]);
      }

      await page.evaluate(() => (window as unknown as { __diveStep(dz?: number): void }).__diveStep(0.5));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    if (seen.has('building')) break;
  }

  await browser.close();

  const missing = EXPECTED.filter((k) => !seen.has(k));
  if (missing.length) {
    console.error(`\nnever reached: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (errors.length) {
    console.error('\nPage errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log(`\nall ${EXPECTED.length} rungs reached in one continuous descent`);
  console.log(`worst mantissa headroom across the whole descent: ${minHeadroom.toFixed(1)} bits`);
};

async function readState(page: import('playwright').Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __cam: { node: { kind: string; path: unknown[]; logSpan: number }; k: number; z: number; fx: number; fy: number };
    };
    const cam = w.__cam;
    const r = 2 ** (cam.z + cam.node.logSpan - cam.k);
    const off = Math.max(1, Math.abs(cam.fx), Math.abs(cam.fy));
    return {
      kind: cam.node.kind,
      depth: cam.node.path.length,
      draws: (window as unknown as { __lastDraws?: number }).__lastDraws ?? 0,
      r,
      z: cam.z,
      headroom: 52 - Math.log2(r) - Math.log2(off),
    };
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
