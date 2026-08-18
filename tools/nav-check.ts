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
  // A single click is held for the length of the double-click window before it acts, so that a double click
  // does not also launch a flight it then has to cancel. Sampling before that elapses sees a camera that has
  // not moved yet and reads as "the click did nothing".
  await page.evaluate(() => new Promise((r) => setTimeout(r, 320)));
  await rest(page);
  const after = await state(page);
  console.log(`click     ${before.path || 'root'} -> ${after.path || 'root'}`);
  if (after.path !== target.path) fail(`click landed at "${after.path}", expected "${target.path}"`);

  // 8. Double click locks the view onto a thing, and it stays locked while the thing moves.
  //
  // This is the answer to "I should be able to zoom into anything, which is a problem with movement":
  // everything below a galaxy orbits, so a planet slides out from under the cursor while you scroll toward
  // it. Locked on, it cannot -- and the check is exactly that, with ambient motion running.
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction('window.__diveStep !== undefined', null, { timeout: 15000 });
  for (let i = 0; i < 600; i++) {
    if ((await state(page)).kind === 'system') break;
    await page.evaluate(() => (window as unknown as { __diveStep(dz?: number): void }).__diveStep(0.5));
  }
  await settle(page, 10);
  const orbiting = await page.evaluate(() => {
    const hits = (window as unknown as {
      __hits(): { path: string; kind: string; x: number; y: number }[];
    }).__hits();
    return hits.find((h) => h.kind === 'planet') ?? null;
  });
  if (!orbiting) fail('no planet was on screen at system level to lock onto');
  await page.mouse.dblclick(orbiting.x, orbiting.y);
  await settle(page, 8);
  const lockedTo = await page.evaluate(() =>
    (window as unknown as { __tracked(): string | null }).__tracked(),
  );
  if (lockedTo !== orbiting.path) fail(`double click locked onto "${lockedTo}", expected "${orbiting.path}"`);

  let drift = 0;
  for (let i = 0; i < 25; i++) {
    await settle(page, 12);
    const off = await page.evaluate((want: string) => {
      const w = window as unknown as {
        __pick(x: number, y: number): { path: string; x: number; y: number } | null;
      };
      const hit = w.__pick(window.innerWidth / 2, window.innerHeight / 2);
      if (!hit) return Number.POSITIVE_INFINITY;
      if (hit.path !== want && !want.startsWith(hit.path)) return Number.POSITIVE_INFINITY;
      return Math.hypot(hit.x - window.innerWidth / 2, hit.y - window.innerHeight / 2);
    }, orbiting.path);
    drift = Math.max(drift, off);
  }
  console.log(`lock      ${orbiting.path} held dead centre through 300 frames of orbit, drift ${drift.toFixed(1)}px`);
  if (!(drift <= 1)) fail(`the locked planet drifted ${drift} px off centre`);

  // Dragging is the user looking elsewhere, and has to let go of the lock.
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(700, 430, { steps: 4 });
  await page.mouse.up();
  await settle(page, 4);
  const afterDrag = await page.evaluate(() =>
    (window as unknown as { __tracked(): string | null }).__tracked(),
  );
  if (afterDrag !== null) fail(`dragging left the view still locked onto "${afterDrag}"`);

  // 9. Scrolling with the cursor on a star at galaxy level must take you INTO that star, not somewhere else.
  //
  // This is the check for the whole point of scattered placement -- a galaxy's visible stars are its
  // catalogued systems, so aiming at one and scrolling has to go there -- and for the zoom model that
  // replaced the old one. A notch used to hand the gesture straight to a two-second flight, which is what
  // made 13% of the screen a teleporter to somewhere you had not asked for. Now the star takes over the
  // middle of the screen and scrolling closes the distance, so the assertion is in two parts: the star is
  // centred, and continuing to scroll arrives.
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
    const w = window as unknown as {
      __pick(x: number, y: number): { kind: string; path: string; x: number; y: number; r: number } | null;
    };
    // Squarely ON a star, not merely within its assist radius -- that is what the zoom hook requires.
    for (let y = 80; y < 720; y += 7) {
      for (let x = 220; x < 1060; x += 7) {
        const h = w.__pick(x, y);
        if (h && h.kind === 'system' && Math.hypot(h.x - x, h.y - y) <= Math.max(3, h.r)) {
          return { x: h.x, y: h.y, path: h.path, r: h.r };
        }
      }
    }
    return null;
  });
  if (!star) fail('no catalogued star was pickable at galaxy focus');
  await page.mouse.move(star.x, star.y);
  await page.mouse.wheel(0, -120);
  await settle(page, 30);
  const took = await page.evaluate(() => (window as unknown as { __tracked(): string | null }).__tracked());
  if (took !== star.path) fail(`scrolling on a star took over "${took}", expected "${star.path}"`);
  const centred = await page.evaluate((want: string) => {
    const w = window as unknown as {
      __pick(x: number, y: number): { path: string; x: number; y: number } | null;
    };
    const h = w.__pick(window.innerWidth / 2, window.innerHeight / 2);
    if (!h || h.path !== want) return Number.POSITIVE_INFINITY;
    return Math.hypot(h.x - window.innerWidth / 2, h.y - window.innerHeight / 2);
  }, star.path);
  if (!(centred <= 1)) fail(`the star did not come to the middle of the screen (${centred}px off)`);

  // Keep scrolling: it has to arrive, and it has to arrive at that star.
  for (let i = 0; i < 40 && (await state(page)).kind === 'galaxy'; i++) {
    await page.mouse.wheel(0, -120);
    await settle(page, 6);
  }
  await rest(page);
  const arrived = await state(page);
  console.log(`star      r=${star.r.toFixed(1)}px  centred to ${centred.toFixed(2)}px, then scrolled into ${arrived.kind}`);
  if (arrived.kind !== 'system') fail(`scrolling into a star landed on ${arrived.kind}, expected system`);
  if (!star.path.startsWith(arrived.path)) fail(`landed in "${arrived.path}", which is not the star aimed at`);

  // 10. Finishing a pinch must not move the view.
  //
  // Playwright cannot pinch, so this dispatches the pointer events itself -- and deliberately lifts one
  // finger a moment before the other, then moves the survivor, because that asymmetry is what the bug
  // needed. A pinch takes the two-pointer path, which never updated the pan baseline, so the survivor's
  // first move measured itself against wherever the first finger had been before the pinch started and
  // panned by the whole gap in one frame, with an inertial fling behind it: "it's still snapping things off
  // screen when I finish zooming (pinch zoom)".
  //
  // Pinch zoom is centred, so the assertion is simply that whatever was in the middle of the screen is
  // still in the middle of the screen afterwards.
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction('window.__diveStep !== undefined', null, { timeout: 15000 });
  await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));
  await page.evaluate(() =>
    (window as unknown as { __recordAllHits(on: boolean): void }).__recordAllHits(true),
  );
  for (let i = 0; i < 400; i++) {
    if ((await state(page)).kind === 'galaxy') break;
    await page.evaluate(() => (window as unknown as { __diveStep(dz?: number): void }).__diveStep(0.5));
  }
  await settle(page, 12);
  // Step 9 reloaded the page, so this needs its own baseline rather than that step's.
  const pinchStart = await state(page);
  if (pinchStart.kind !== 'galaxy') fail(`could not reach galaxy focus for the pinch check`);

  const middle = await page.evaluate(() => {
    const hits = (window as unknown as {
      __hits(): { path: string; kind: string; x: number; y: number }[];
    }).__hits();
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    return (
      hits
        .filter((h) => h.kind === 'system')
        .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0] ?? null
    );
  });
  if (!middle) fail('no star near the middle of the screen to pinch around');
  const beforeOff = Math.hypot(middle.x - 640, middle.y - 400);

  await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const send = (type: string, id: number, x: number, y: number) => {
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          isPrimary: id === 1,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    // Two fingers down either side of the middle, then spread them to zoom in.
    send('pointerdown', 1, 540, 400);
    send('pointerdown', 2, 740, 400);
    for (let i = 1; i <= 10; i++) {
      send('pointermove', 1, 540 - i * 14, 400);
      send('pointermove', 2, 740 + i * 14, 400);
    }
    // One finger leaves first, and the other keeps reporting from where it already is for a few frames.
    // That asymmetry is the whole point: the survivor is not moving, so nothing may pan.
    send('pointerup', 1, 400, 400);
    for (let i = 0; i < 4; i++) send('pointermove', 2, 880, 400);
    send('pointerup', 2, 880, 400);
  });
  await settle(page, 30);

  const afterOff = await page.evaluate((want: string) => {
    const hits = (window as unknown as {
      __hits(): { path: string; x: number; y: number }[];
    }).__hits();
    const h = hits.find((m) => m.path === want);
    if (!h) return Number.POSITIVE_INFINITY;
    return Math.hypot(h.x - window.innerWidth / 2, h.y - window.innerHeight / 2);
  }, middle.path);

  const zoomed = (await state(page)).z;
  console.log(
    `pinch     zoomed to z=${zoomed.toFixed(2)}; the middle star sat ${beforeOff.toFixed(1)}px off centre ` +
      `before and ${Number.isFinite(afterOff) ? afterOff.toFixed(1) + 'px' : 'off screen'} after`,
  );
  // Centred zoom scales the offset with the scale, so compare against that rather than against zero.
  const expected = beforeOff * 2 ** (zoomed - pinchStart.z);
  if (!Number.isFinite(afterOff) || Math.abs(afterOff - expected) > 2) {
    fail(
      `finishing a pinch moved the view: the middle star is ${afterOff} px off centre, expected about ` +
        `${expected.toFixed(1)} px`,
    );
  }

  // 11. A garbage URL must not break the page.
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
