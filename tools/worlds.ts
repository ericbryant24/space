/**
 * Screenshot a spread of DIFFERENT worlds, at whatever depth you ask for.
 *
 * `tools/shots.ts` proves the ladder still works; this exists to review the art, which needs variety rather
 * than one continuous descent. A single planet tells you almost nothing about a generator: the first one the
 * dive happens to land on was 94% desert, where land and sea are nearly the same colour by design, and it
 * would have been easy to conclude the terrain was broken when it was merely dull.
 *
 *   node tools/worlds.ts            # eight planets
 *   node tools/worlds.ts region 6   # six regions, one on each of six worlds
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173/space/';
const OUT = process.env.SHOT_OUT ?? 'shots/worlds';

const LEVEL = process.argv[2] ?? 'planet';
const COUNT = Number(process.argv[3] ?? 8);

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

const state = (page: Page) =>
  page.evaluate(() => {
    const cam = (window as unknown as { __cam: { node: { kind: string; path: unknown[] } } }).__cam;
    return { kind: cam.node.kind, depth: cam.node.path.length };
  });

const settle = async (page: Page, frames = 10) => {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
};

const dive = (page: Page, steps = 1) =>
  page.evaluate((n: number) => {
    const w = window as unknown as { __diveStep(dz?: number): void };
    for (let i = 0; i < n; i++) w.__diveStep(0.5);
  }, steps);

/** Descend to the first node of a kind, nudging off centre at galaxy level so the route varies. */
async function descendTo(page: Page, kind: string, aim: readonly [number, number]): Promise<boolean> {
  let aimed = false;
  for (let i = 0; i < 900; i++) {
    const s = await state(page);
    if (s.kind === kind) return true;
    if (s.kind === 'galaxy' && !aimed) {
      aimed = true;
      await page.evaluate(([dx, dy]: number[]) => {
        const cam = (window as unknown as { __cam: { fx: number; fy: number } }).__cam;
        cam.fx += dx!;
        cam.fy += dy!;
      }, [aim[0], aim[1]]);
    }
    await dive(page, 1);
  }
  return false;
}

/** Offsets applied at galaxy level, so each run falls through a different arm and finds a different world. */
const AIM: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.1, 0.06],
  [-0.09, 0.11],
  [0.14, -0.12],
  [-0.15, -0.07],
  [0.05, 0.17],
  [-0.18, 0.03],
  [0.02, -0.19],
  [0.21, 0.09],
  [-0.06, -0.22],
  [0.17, 0.19],
  [-0.23, 0.13],
];

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  let found = 0;
  for (let attempt = 0; attempt < AIM.length && found < COUNT; attempt++) {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction('window.__diveStep !== undefined', null, { timeout: 20000 });
    await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));

    /**
     * Stop at the system first and pick a DIFFERENT planet each run.
     *
     * Diving straight down always enters whatever is under the centre of the system, which is the innermost
     * orbit -- so the first eight worlds this printed were five greenhouses and a scorched rock, and it read
     * as a generator with no range. Sampled properly the classes come out ice 25%, gas giant 22%, temperate
     * 7%, greenhouse 4%. The harness was the thing lacking variety, not the universe.
     */
    if (LEVEL !== 'field' && LEVEL !== 'cluster' && LEVEL !== 'galaxy' && LEVEL !== 'system') {
      if (!(await descendTo(page, 'system', AIM[attempt]!))) {
        console.log(`  aim ${attempt}: never reached a system`);
        continue;
      }
      await settle(page, 14);
      const planets = await page.evaluate(() => {
        const hits = (window as unknown as {
          __hits(): { kind: string; x: number; y: number }[];
        }).__hits();
        return hits.filter((h) => h.kind === 'planet').map((h) => ({ x: h.x, y: h.y }));
      });
      if (planets.length === 0) {
        console.log(`  aim ${attempt}: that system is barren`);
        continue;
      }
      const pick = planets[attempt % planets.length]!;
      await page.mouse.click(pick.x, pick.y);
      // A single click waits out the double-click window before it acts, then flies.
      await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
      for (let i = 0; i < 400; i++) {
        if ((await state(page)).kind === 'planet') break;
        await settle(page, 6);
      }
    }

    if (!(await descendTo(page, LEVEL, AIM[attempt]!))) {
      console.log(`  aim ${attempt}: never reached ${LEVEL}`);
      continue;
    }
    await settle(page, 18);

    const label = await page.evaluate(() => {
      const el = document.querySelector('.hud');
      return el ? (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 76) : '';
    });
    const name = `${String(found).padStart(2, '0')}-${LEVEL}`;
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`${name}  ${label}`);
    found++;
  }

  await browser.close();
  if (errors.length) {
    console.error('\nPage errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log(`\n${found} ${LEVEL}s written to ${OUT}/`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
