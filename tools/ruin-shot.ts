/**
 * Photograph a town that stands empty, at the three sizes it gets drawn at.
 *
 * One settlement in a hundred and twenty is a ruin (see src/universe/rarity.ts), so reviewing one by hand means
 * a hundred and twenty descents. Rarity is a pure function of address and the generators are pure, so the search
 * happens HERE, in Node, with no browser and no rendering -- and the browser is only asked to go to the address
 * that came out. That is the same property that makes a rare place shareable at all.
 *
 * The three shots are the point. An empty town is drawn as marks from its region, as blocks from the settlement,
 * and as full elevations from a building's distance, and the three are crossfaded rather than switched -- so what
 * has to be checked is that they agree: the same broken wall head, the same missing roof off the same end, no lit
 * window at any size.
 *
 *   node tools/ruin-shot.ts
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

import { DEFAULT_SEED, encodeState } from '../src/ui/router.ts';
import {
  childrenNear,
  isInhabited,
  makeChild,
  orbitalChildren,
  rimChildren,
  rootNode,
  scatterChildren,
  type Cell,
  type Node,
} from '../src/universe/node.ts';
import { isRuin, ruinDecay } from '../src/universe/rarity.ts';
import { LEVELS } from '../src/universe/schema.ts';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173/space/';
const OUT = process.env.SHOT_OUT ?? 'shots/ruins';
const WANT = Number(process.env.RUIN_COUNT ?? 3);

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

const refsOf = (n: Node) => {
  const placement = LEVELS[n.kind].placement;
  if (placement === 'cells') return childrenNear(n, 0, 0, 64);
  if (placement === 'scatter') return scatterChildren(n);
  if (placement === 'orbits') return orbitalChildren(n);
  return rimChildren(n);
};

interface Ruin {
  readonly path: Cell[];
  readonly building: Cell | null;
  readonly id: number;
  readonly decay: number;
  /**
   * The ACTUAL logSpan of the region, the settlement and the building, rather than the level's nominal one.
   *
   * A rim child is sized by the slot it tiles and not by the level table (see `rimChild`), so the two differ by
   * up to half a doubling -- and the zoom in a permalink is `log2(radius) - logSpan`. Taking the nominal value
   * put the first run of these shots two rungs too far out, which looked exactly like the ruin not being drawn.
   */
  readonly spans: { region: number; settlement: number; building: number };
}

/** Depth-first through real addresses until enough empty towns turn up. Pure, so the answer never varies. */
function findRuins(want: number): Ruin[] {
  const out: Ruin[] = [];
  let regionSpan = 0;
  const visit = (node: Node, path: Cell[]): void => {
    if (out.length >= want) return;
    if (node.kind === 'settlement') {
      if (!isInhabited(node) || !isRuin(node.id)) return;
      // One of its own buildings, for the closest shot. It has to be an inhabited slot or nothing is drawn.
      let building: Cell | null = null;
      let buildingSpan = node.logSpan - 6;
      for (const ref of rimChildren(node)) {
        if (!isInhabited(makeChild(node, ref))) continue;
        building = ref.cell;
        buildingSpan = ref.logSpan;
        break;
      }
      out.push({
        path,
        building,
        id: node.id,
        decay: ruinDecay(node.id),
        spans: { region: regionSpan, settlement: node.logSpan, building: buildingSpan },
      });
      return;
    }
    if (node.kind === 'region') regionSpan = node.logSpan;
    for (const ref of refsOf(node)) {
      if (out.length >= want) return;
      visit(makeChild(node, ref), [...path, ref.cell]);
    }
  };
  visit(rootNode(DEFAULT_SEED), []);
  return out;
}

/**
 * `fy` is negative to look UP.
 *
 * A rim node's frame origin sits on the ground line rather than at its centre, so a building stands entirely in
 * negative y and a camera at the origin has its roof off the top of the window. Lifting the camera is what puts
 * the roof -- where a world states its climate, and where a ruin states that it has none left -- in shot.
 */
const link = (path: Cell[], logSpan: number, radiusPx: number, fy = 0): string =>
  `#${encodeState({
    seed: DEFAULT_SEED,
    path,
    k: 0,
    cx: 0,
    cy: 0,
    fx: 0,
    fy,
    z: Math.log2(radiusPx) - logSpan,
  })}`;

const settle = (page: Page, frames: number) =>
  page.evaluate(async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
  }, frames);

const main = async (): Promise<void> => {
  const ruins = findRuins(WANT);
  if (ruins.length === 0) {
    console.log('FAIL: no empty town found in the addresses walked');
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 1200, height: 750 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('  page error:', e.message));

  for (let i = 0; i < ruins.length; i++) {
    const ruin = ruins[i]!;
    const views: [string, string][] = [
      ['far', link(ruin.path.slice(0, -1), ruin.spans.region, 460, -0.2)],
      ['town', link(ruin.path, ruin.spans.settlement, 700, -0.35)],
      [
        'close',
        ruin.building
          ? link([...ruin.path, ruin.building], ruin.spans.building, 150, -1.1)
          : link(ruin.path, ruin.spans.settlement, 900),
      ],
    ];
    console.log(`  ruin ${ruin.id}, decay ${ruin.decay.toFixed(2)}${ruin.building ? '' : ' (no inhabited building slot)'}`);
    for (const [name, hash] of views) {
      if (process.env.RUIN_LINKS) console.log(`    ${name} ${hash}`);
      /**
       * A blank page in between, because changing only the fragment does not reload a single-page app -- it fires
       * a hashchange, and the router answers that by FLYING to the new address rather than snapping to it. The
       * first version of this took every shot mid-flight from the previous one, which looked exactly like the
       * camera landing in the wrong place. A real load applies the address in one step.
       */
      await page.goto('about:blank');
      await page.goto(BASE + hash, { waitUntil: 'load' });
      // Freeze after dusk, because the loudest thing an empty town does is fail to light its windows.
      await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(1_000_060));
      await settle(page, 20);
      await page.screenshot({ path: join(OUT, `ruin-${i}-${name}.png`) });
    }
  }
  await browser.close();
  console.log(`wrote ${ruins.length * 3} shots to ${OUT}`);
};

void main();
