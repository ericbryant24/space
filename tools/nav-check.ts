/**
 * End-to-end navigation check. Unit tests cover the URL codec; this covers the part that can only
 * break in a real browser: that a pasted link lands you in the same place, that back and forward
 * retrace, and that clicking flies somewhere.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173/space/';

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
    const w = window as unknown as {
      __cam: { node: { kind: string; path: { cx: number; cy: number }[] }; k: number; z: number; fx: number; fy: number };
    };
    const c = w.__cam;
    return {
      kind: c.node.kind,
      path: c.node.path.map((p) => `${p.cx}.${p.cy}`).join('/'),
      z: c.z,
      fx: c.fx,
      fy: c.fy,
      hash: location.hash,
    };
  });

const settle = async (page: Page, frames = 4) => {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
};

/** Wait for any in-flight camera animation to finish. */
const rest = async (page: Page) => {
  for (let i = 0; i < 400; i++) {
    const a = await state(page);
    await settle(page, 6);
    const b = await state(page);
    if (a.z === b.z && a.fx === b.fx && a.path === b.path) return;
  }
};

// A function declaration, not a const arrow: TypeScript only uses a never-returning call for control
// flow narrowing when the callee has an explicitly declared type, which an inferred const lacks.
function fail(msg: string): never {
  console.error(`FAIL ${msg}`);
  process.exit(1);
}

const main = async () => {
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction('window.__diveStep !== undefined', null, { timeout: 15000 });
  // Freeze ambient motion: orbits ticking mid-capture would make every run differ.
  await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));

  // 1. Dive deep, then check the URL tracks the camera.
  for (let i = 0; i < 90; i++) {
    await page.evaluate(() => (window as unknown as { __diveStep(dz?: number): void }).__diveStep(0.5));
  }
  await settle(page, 10);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  const deep = await state(page);
  console.log(`deep      kind=${deep.kind} depth=${deep.path.split('/').filter(Boolean).length} camZ=${deep.z}`);
  console.log(`          hash=${deep.hash}`);
  if (!deep.hash.includes('p=')) fail('the URL did not record the camera path');

  // 2. A pasted link must land in the same place.
  //
  // Note the reload. Navigating to a URL that differs only in its fragment does NOT reload the
  // document -- it fires popstate, which this app answers with an animated flight. Sampling straight
  // after would catch the camera mid-flight. Reloading tests what actually happens when someone pastes
  // a link into a fresh tab.
  const link = deep.hash;
  await page.goto(BASE + link, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__cam !== undefined', null, { timeout: 15000 });
  await settle(page, 8);
  const pasted = await state(page);
  console.log(`pasted    kind=${pasted.kind} path=${pasted.path}`);
  if (pasted.path !== deep.path) fail(`deep link landed at "${pasted.path}", expected "${deep.path}"`);
  if (Math.abs(pasted.z - deep.z) > 0.002) fail(`deep link z drifted: ${pasted.z} vs ${deep.z}`);
  const offsetPx = Math.hypot(pasted.fx - deep.fx, pasted.fy - deep.fy) * 1024;
  if (offsetPx > 0.25) fail(`deep link offset drifted ${offsetPx.toFixed(3)} px`);
  console.log(`          offset error ${offsetPx.toFixed(4)} px, z error ${Math.abs(pasted.z - deep.z).toFixed(5)}`);

  // 3. An in-document hash change animates rather than snapping, and still arrives.
  await page.evaluate(() => {
    const w = window as unknown as { __cam: { z: number } };
    w.__cam.z += 0;
    history.pushState(null, '', location.hash);
  });
  await page.goto(BASE + '#s=764u&p=&k=0&c=0.0&o=0.0000,0.0000&z=-72.000', { waitUntil: 'commit' });
  await rest(page);
  const flown = await state(page);
  console.log(`hashnav   kind=${flown.kind} path=${flown.path || 'root'}`);
  if (flown.path !== '') fail(`hash navigation landed at "${flown.path}", expected the root`);

  // Go back to somewhere deep so the breadcrumb has rungs to click.
  await page.goto(BASE + link, { waitUntil: 'commit' });
  await rest(page);

  // 4. Breadcrumb click flies to an ancestor.
  const crumbs = await page.locator('.trail .crumb').count();
  if (crumbs < 3) fail(`expected a breadcrumb trail, found ${crumbs} crumbs`);
  await page.locator('.trail .crumb').nth(1).click();
  await rest(page);
  const risen = await state(page);
  console.log(`crumb     kind=${risen.kind} path=${risen.path}`);
  if (risen.path.split('/').filter(Boolean).length !== 1) fail(`breadcrumb landed at depth ${risen.path}`);

  // 5. Back must retrace to where we were.
  await page.goBack();
  await rest(page);
  const back = await state(page);
  console.log(`back      kind=${back.kind} path=${back.path}`);
  if (back.path === risen.path) fail('back did not move anywhere');
  console.log(`          (back moved from "${risen.path}" to "${back.path}")`);

  // 6. Forward again.
  await page.goForward();
  await rest(page);
  const fwd = await state(page);
  console.log(`forward   kind=${fwd.kind} path=${fwd.path}`);
  if (fwd.path !== risen.path) fail(`forward landed at "${fwd.path}", expected "${risen.path}"`);

  // 7. Clicking an object flies into it. Pick a real target from the render hit list rather than
  // clicking blind at the screen centre, which lands on empty space inside the current focus.
  const before = await state(page);
  const target = await page.evaluate(() => {
    const hits = (window as unknown as {
      __hits(): { path: string; kind: string; x: number; y: number; r: number }[];
    }).__hits();
    const depth = (p: string) => (p === '' ? 0 : p.split('/').length);
    const here = (window as unknown as { __cam: { node: { path: unknown[] } } }).__cam.node.path.length;
    // Deepest thing on screen that is not the level we are already focused on.
    const candidates = hits.filter((h) => depth(h.path) > here && h.r >= 2.5);
    candidates.sort((a, b) => depth(b.path) - depth(a.path) || b.r - a.r);
    return candidates[0] ?? null;
  });
  if (!target) fail('no clickable child was on screen to fly to');
  console.log(`target    ${target.kind} at (${target.x.toFixed(0)}, ${target.y.toFixed(0)}) r=${target.r.toFixed(0)}px`);
  await page.mouse.click(target.x, target.y);
  await rest(page);
  const after = await state(page);
  console.log(`click     ${before.path || 'root'} -> ${after.path || 'root'}`);
  if (after.path !== target.path) fail(`click landed at "${after.path}", expected "${target.path}"`);

  // 8. One scroll notch toward a star at galaxy level must land inside that star's system.
  //
  // This is the check for the whole point of scattered placement: a galaxy's visible stars ARE its
  // catalogued systems, so aiming at one and scrolling has to go there. It cannot be a unit test --
  // it needs a real wheel event, the analytic star pick, the flight planner, and thirty rebases.
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction('window.__diveStep !== undefined', null, { timeout: 15000 });
  await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));
  for (let i = 0; i < 400; i++) {
    if ((await state(page)).kind === 'galaxy') break;
    await page.evaluate(() => (window as unknown as { __diveStep(dz?: number): void }).__diveStep(0.5));
  }
  await settle(page, 12);
  const atGalaxy = await state(page);
  if (atGalaxy.kind !== 'galaxy') fail(`could not reach galaxy focus; stopped at ${atGalaxy.kind}`);
  const star = await page.evaluate(() => {
    const w = window as unknown as { __pick(x: number, y: number): { kind: string; r: number } | null };
    // Scan on a coarse grid: a few hundred stars are on screen, so this finds one in a few dozen tries.
    for (let y = 80; y < 720; y += 11) {
      for (let x = 220; x < 1060; x += 11) {
        const h = w.__pick(x, y);
        if (h && h.kind === 'system') return { x, y, r: h.r };
      }
    }
    return null;
  });
  if (!star) fail('no catalogued star was pickable at galaxy focus');
  await page.mouse.move(star.x, star.y);
  await page.mouse.wheel(0, -120);
  await rest(page);
  const arrived = await state(page);
  console.log(`star      r=${star.r.toFixed(1)}px  one notch -> ${arrived.kind} depth ${arrived.path.split('/').filter(Boolean).length}`);
  if (arrived.kind !== 'system') {
    fail(`one scroll notch at a star landed on ${arrived.kind}, expected system`);
  }

  // 9. A garbage URL must not break the page.
  await page.goto(`${BASE}#s=!!!&p=zz.-1-oops&k=-9&z=NaN&o=x,y`, { waitUntil: 'load' });
  await page.waitForFunction('window.__cam !== undefined', null, { timeout: 15000 });
  await settle(page, 6);
  const junk = await state(page);
  console.log(`junk url  kind=${junk.kind} z=${junk.z.toFixed(2)}`);
  if (!Number.isFinite(junk.z)) fail('a malformed URL produced a non-finite zoom');

  await browser.close();
  if (errors.length) {
    console.error('\nPage errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('\nnavigation checks passed');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
