// Shots of the planet-scale prototypes, from the flattened single-file build (so what is captured is
// exactly what gets published).
//
//   node proto/bundle.mjs && node tools/proto-shots.mjs [outDir]

import { chromium } from 'playwright';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function chromiumPath() {
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

const out = process.argv[2] ?? 'shots/proto';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
await page.goto('file://' + process.cwd() + '/proto/dist/lenses.html', { waitUntil: 'load' });
await page.waitForTimeout(1500);

for (const lens of ['rim', 'fisheye', 'ladder']) {
  const plate = page.locator(`.plate[data-lens=${lens}]`);
  await plate.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await plate.locator('.stage').screenshot({ path: join(out, `${lens}.png`) });
  await plate.screenshot({ path: join(out, `${lens}-plate.png`) });
}
console.log(problems.length ? problems.join('\n') : `wrote ${out}/{rim,fisheye,ladder}.png`);
await browser.close();
