/**
 * NOTHING ON SCREEN IS DECORATIVE.
 *
 * The rule, stated plainly: if it shows on the screen, it is real -- a node with an address, a name, and
 * somewhere you can travel to. What broke this before was point populations: a few thousand decorative
 * stars stippled over a galaxy's arms, and a second unresolved field behind them, none of which
 * corresponded to a place. Pointing at one and scrolling did nothing, and the reported symptoms were
 * exactly that: "stars just seem to shoot past at random", "it's like they are not 2D".
 *
 * Half of that rule is enforced by construction -- no painter emits a population of point-like marks any
 * more, and the only thing between the stars is diffuse light, which does not promise a discrete thing you
 * could aim at. The other half is what this checks, because it is the half that rots: EVERY MARK THE
 * RENDERER DRAWS MUST BE REACHABLE, at its centre and anywhere on the glyph you can plainly see.
 *
 * That gap is not hypothetical. Sizing stars from their galaxy's radius put a four-point sparkle two and a
 * half core radii out, while hit-testing still used a grab radius measured from the core -- so the tips of
 * every star you could see went nowhere. This check found it.
 *
 * Deliberately NOT a pixel scan. An earlier version looked for bright specks on the canvas and asked what
 * each one was; it found the sparkle bug, and then drowned it in false positives, because a ring-of-
 * neighbours test cannot tell an isolated dot from the lit edge of a cloud band or the seam where two arm
 * ribbons overlap. Those are form, not implied objects. Asking the renderer what it drew is exact.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173/space/';

/** Where to look. `extra` is additional half-doublings past the first frame focused on `kind`. */
const STOPS: readonly { label: string; kind: string; extra: number }[] = [
  { label: 'field', kind: 'field', extra: 0 },
  { label: 'cluster', kind: 'cluster', extra: 0 },
  { label: 'galaxy', kind: 'galaxy', extra: 0 },
  { label: 'galaxy +2', kind: 'galaxy', extra: 4 },
  { label: 'galaxy +4', kind: 'galaxy', extra: 4 },
  { label: 'galaxy +8', kind: 'galaxy', extra: 8 },
  { label: 'system', kind: 'system', extra: 0 },
  { label: 'planet', kind: 'planet', extra: 0 },
  { label: 'region', kind: 'region', extra: 0 },
  { label: 'settlement', kind: 'settlement', extra: 0 },
];

/**
 * How far out on a mark to probe, as a fraction of its radius. Not 1.0: the outermost pixel of a circle is
 * a rounding argument, not a usability one, and the point of the check is whether aiming at something works.
 */
const EDGE_FRACTION = 0.8;

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

const settle = async (page: Page, frames = 8) => {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
};

interface Report {
  marks: number;
  centreMisses: { path: string; kind: string; got: string }[];
  edgeMisses: { path: string; kind: string; r: number; got: string }[];
}

/** Ask the renderer what it drew, then aim at every part of it. Runs in the page. */
const probe = (page: Page, edgeFraction: number) =>
  page.evaluate((frac: number): Report => {
    const w = window as unknown as {
      __hits(): { path: string; kind: string; x: number; y: number; r: number }[];
      __pick(x: number, y: number): { kind: string; path: string; x: number; y: number } | null;
      __cam: { node: { path: { cx: number; cy: number }[] } };
    };
    const depthOf = (p: string) => p.split('/').filter(Boolean).length;
    const here = w.__cam.node.path.length;
    const focus = w.__cam.node.path.map((c) => `${c.cx}.${c.cy}`).join('/');
    /**
     * The focus node and its ancestors are excluded -- those are the place you are standing in, and "travel to
     * where you already are" is correctly not offered. SIBLINGS are not: they are at the same depth as the focus
     * and they are most of what is on screen below a planet, because a rim parent hands the painting over to its
     * children rather than drawing both. Filtering on depth alone reported zero marks at every surface level,
     * which made the check silently vacuous exactly where the newest art is.
     */
    const all = w.__hits();
    const marks = all.filter((m) => depthOf(m.path) >= here && m.path !== focus);

    const centreMisses: Report['centreMisses'] = [];
    const edgeMisses: Report['edgeMisses'] = [];

    for (const m of marks) {
      // 1. AIMING AT A THING GETS THAT THING. Probed at the mark's own centre, where there is no ambiguity
      //    to resolve, so the answer has to be this mark and nothing else.
      const c = w.__pick(m.x, m.y);
      if (!c || c.path !== m.path) {
        centreMisses.push({ path: m.path, kind: m.kind, got: c ? `${c.kind} ${c.path}` : 'nothing' });
        continue;
      }

      // 2. THE WHOLE GLYPH IS THE TARGET, not just its centre. Off-centre, an overlapping neighbour may
      //    legitimately win -- picking resolves to the nearest, and small marks pack closer than the grab
      //    radius -- so the assertion is only that SOMETHING at least as close as this mark answers. That
      //    is crowding-proof without this check re-implementing the picker it is checking.
      const d = m.r * frac;
      for (const [dx, dy] of [
        [d, 0],
        [-d, 0],
        [0, d],
        [0, -d],
      ] as const) {
        const px = m.x + dx;
        const py = m.y + dy;
        const e = w.__pick(px, py);
        const mine = Math.hypot(px - m.x, py - m.y);
        if (e && (e.path === m.path || Math.hypot(px - e.x, py - e.y) <= mine + 1)) continue;
        edgeMisses.push({
          path: m.path,
          kind: m.kind,
          r: Math.round(m.r * 10) / 10,
          got: e ? `${e.kind} ${e.path}, further away than this one` : 'nothing',
        });
        break;
      }
    }
    return { marks: marks.length, centreMisses, edgeMisses };
  }, edgeFraction);

function fail(msg: string): never {
  console.error(`\nFAIL ${msg}`);
  process.exit(1);
}

const main = async () => {
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction('window.__diveStep !== undefined', null, { timeout: 20000 });
  await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));
  await page.evaluate(() =>
    (window as unknown as { __recordAllHits(on: boolean): void }).__recordAllHits(true),
  );
  // Park the cursor off-canvas: the hover reticle is an extra ring around whatever it is over.
  await page.mouse.move(4, 4);

  let aimed = false;
  let bad = 0;
  let total = 0;
  console.log('level         marks   unreachable');
  for (const stop of STOPS) {
    for (let i = 0; i < 600; i++) {
      const s = await state(page);
      if (s.kind === stop.kind) break;
      if (s.kind === 'galaxy' && !aimed) {
        // Descend through an arm rather than straight down the galactic core: the same off-centre aim
        // tools/shots.ts uses, because the core is where scale bugs hide.
        aimed = true;
        await page.evaluate(() => {
          const cam = (window as unknown as { __cam: { fx: number; fy: number } }).__cam;
          cam.fx += 0.1;
          cam.fy += 0.06;
        });
      }
      await page.evaluate(() => (window as unknown as { __diveStep(dz?: number): void }).__diveStep(0.5));
    }
    for (let i = 0; i < stop.extra; i++) {
      await page.evaluate(() => (window as unknown as { __diveStep(dz?: number): void }).__diveStep(0.5));
    }
    await settle(page, 14);
    if ((await state(page)).kind !== stop.kind) {
      console.log(`${stop.label.padEnd(13)} (not reached on this descent, skipped)`);
      continue;
    }

    const r = await probe(page, EDGE_FRACTION);
    const misses = r.centreMisses.length + r.edgeMisses.length;
    total += r.marks;
    bad += misses;
    console.log(`${stop.label.padEnd(13)} ${String(r.marks).padStart(5)} ${String(misses).padStart(13)}`);
    for (const m of r.centreMisses.slice(0, 5)) {
      console.log(`              ${m.kind} ${m.path}: its own centre picks ${m.got}`);
    }
    for (const m of r.edgeMisses.slice(0, 5)) {
      console.log(`              ${m.kind} ${m.path} (r=${m.r}px): its edge picks ${m.got}`);
    }
  }

  await browser.close();
  if (errors.length) {
    console.error('\nPage errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  if (bad > 0) fail(`${bad} marks on screen cannot be travelled to`);
  console.log(`\nall ${total} marks across the ladder are places you can travel to`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
