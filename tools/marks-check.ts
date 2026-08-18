/**
 * BOOKMARKS ARE THE ONLY WAY TO HOLD A PLACE, so they get a real end-to-end check.
 *
 * Every word came off the screen, and the one honest job the labels did -- letting you keep hold of somewhere you
 * found -- moved here. If keeping silently failed, or a kept tile flew you to the wrong place, the app would have
 * lost the ability to remember anything and it would look like a styling bug.
 *
 *   node tools/marks-check.ts
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

const settle = async (page: Page, frames = 8) => {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
};

const where = (page: Page) =>
  page.evaluate(() => {
    const cam = (window as unknown as { __cam: { node: { kind: string; path: { cx: number; cy: number }[] }; z: number } }).__cam;
    return { kind: cam.node.kind, path: cam.node.path.map((c) => `${c.cx}.${c.cy}`).join('/'), z: cam.z };
  });

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const main = async () => {
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction('window.__diveStep !== undefined', null, { timeout: 20000 });
  await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));

  // NOTHING TO READ. The default view must not put a single word on screen.
  const words = await page.evaluate(() => (document.getElementById('overlay')?.innerText ?? '').trim());
  if (words.length > 0) fail(`the default view shows text: ${JSON.stringify(words.slice(0, 120))}`);

  // Somewhere worth keeping.
  for (let i = 0; i < 400; i++) {
    if ((await where(page)).kind === 'planet') break;
    await page.evaluate(() => (window as unknown as { __diveStep(dz?: number): void }).__diveStep(0.5));
  }
  const kept = await where(page);
  if (kept.kind !== 'planet') fail('never reached a planet to bookmark');
  await settle(page, 12);

  await page.keyboard.press('b');
  await settle(page);
  let tiles = await page.locator('.rail .mark').count();
  if (tiles !== 2) fail(`after keeping one view the rail holds ${tiles - 1} tiles plus the keep tile`);
  const shot = await page.evaluate(() => {
    const raw = localStorage.getItem('almanac.marks.v1');
    const marks = raw ? (JSON.parse(raw) as { shot: string }[]) : [];
    return marks[0]?.shot ?? '';
  });
  if (!shot.startsWith('data:image/jpeg')) fail(`the kept tile has no thumbnail (${shot.slice(0, 32)})`);
  if (shot.length < 600) fail(`the thumbnail is ${shot.length} bytes, which is a blank tile`);

  // It has to survive a reload -- a bookmark you lose on refresh is not a bookmark.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__diveStep !== undefined', null, { timeout: 20000 });
  await page.evaluate(() => (window as unknown as { __freezeTime(s: number): void }).__freezeTime(0));
  tiles = await page.locator('.rail .mark').count();
  if (tiles !== 2) fail(`the kept view did not survive a reload (${tiles - 1} tiles)`);

  // And it has to take you back. Start from the top so arriving means something.
  await page.keyboard.press('Home');
  await settle(page, 10);
  const home = await where(page);
  if (home.kind !== 'field') fail(`Home did not return to the top (${home.kind})`);

  await page.locator('.rail .mark').first().click();
  await settle(page, 20);
  const back = await where(page);
  if (back.path !== kept.path) fail(`a kept tile flew to ${back.path}, not ${kept.path}`);
  if (Math.abs(back.z - kept.z) > 0.01) fail(`a kept tile arrived at z=${back.z}, not ${kept.z}`);

  // Forgetting one has to work too, or the rail fills up with no way out.
  await page.locator('.rail .mark').first().hover();
  await page.locator('.rail .mark .drop').first().click();
  await settle(page);
  tiles = await page.locator('.rail .mark').count();
  if (tiles !== 1) fail(`forgetting a tile left ${tiles - 1} behind`);

  await browser.close();
  if (errors.length) {
    console.error('Page errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log(`no words on screen; kept ${kept.kind} ${kept.path}, survived a reload, flew back exactly, forgot cleanly`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
