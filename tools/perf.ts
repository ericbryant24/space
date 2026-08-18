/**
 * Steady-state frame timing at each rung of the ladder.
 *
 * Measures AFTER letting the view settle, so one-off sprite bakes are not counted as the running cost
 * -- but reports the settle cost separately, because a bake that stalls the first frame is still a
 * visible hitch and needs its own budget.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173/space/';
const FRAMES = Number(process.env.PERF_FRAMES ?? 300);
const BUDGET_MS = Number(process.env.PERF_BUDGET_MS ?? 16);

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

async function measure(page: Page, frames: number) {
  return page.evaluate(async (n: number) => {
    const w = window as unknown as { __renderOnce(): number };
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      samples.push(w.__renderOnce());
    }
    samples.sort((a, b) => a - b);
    const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
    return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: samples[samples.length - 1]!, n };
  }, frames);
}

const main = async () => {
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction('window.__renderOnce !== undefined', null, { timeout: 15000 });

  const rows: { kind: string; settle: number; p50: number; p99: number; max: number; draws: number }[] = [];
  const seen = new Set<string>();
  // Sampling only at rung transitions leaves a blind spot over the long stretches BETWEEN rungs -- and
  // inside a galaxy is where the most expensive drawing in the whole project happens.
  const MID_EVERY = Number(process.env.PERF_MID_EVERY ?? 12);

  for (let step = 0; step < 400; step++) {
    const state = await page.evaluate(() => {
      const w = window as unknown as { __cam: { node: { kind: string }; z: number }; __lastDraws?: number };
      return { kind: w.__cam.node.kind, z: w.__cam.z, draws: w.__lastDraws ?? 0 };
    });

    const isNewRung = !seen.has(state.kind);
    const isMidSample = MID_EVERY > 0 && step % MID_EVERY === 0;
    if (isNewRung || isMidSample) {
      const label = isNewRung ? state.kind : `  ${state.kind} z${state.z.toFixed(0)}`;
      seen.add(state.kind);
      // First render at this view pays for any sprite bake.
      const settle = await page.evaluate(() => (window as unknown as { __renderOnce(): number }).__renderOnce());
      const m = await measure(page, FRAMES);
      const draws = await page.evaluate(() => (window as unknown as { __lastDraws?: number }).__lastDraws ?? 0);
      rows.push({ kind: label, settle, p50: m.p50, p99: m.p99, max: m.max, draws });
    }
    if (state.kind === 'building') break;
    await page.evaluate(() => (window as unknown as { __diveStep(dz?: number): void }).__diveStep(0.5));
  }

  await browser.close();

  // `settle` is the first render at a new view, which pays for sprite bakes; `max` is the worst frame
  // seen afterwards, usually another bake finishing. Steady-state cost is p50.
  console.log(`level             settle     p50     p99     max   draws   (${FRAMES} frames each)`);
  for (const r of rows) {
    console.log(
      `${r.kind.padEnd(16)} ${r.settle.toFixed(1).padStart(6)}ms ${r.p50.toFixed(2).padStart(7)} ` +
        `${r.p99.toFixed(2).padStart(7)} ${r.max.toFixed(2).padStart(7)} ${String(r.draws).padStart(7)}`,
    );
  }

  const over = rows.filter((r) => r.p99 > BUDGET_MS);
  if (over.length) {
    console.error(`\nOVER BUDGET (${BUDGET_MS}ms p99): ${over.map((r) => `${r.kind.trim()} ${r.p99.toFixed(1)}ms`).join(', ')}`);
    process.exit(1);
  }
  console.log(`\nall levels within the ${BUDGET_MS}ms p99 budget`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
