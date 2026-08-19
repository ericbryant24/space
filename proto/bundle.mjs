// Flatten the prototype modules into one self-contained page.
//
// Concatenation rather than a bundler, which the modules were shaped for: every shared scalar lives in
// util.js precisely so that stripping the imports leaves no name declared twice.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ORDER = ['util.js', 'paint.js', 'world.js', 'lens.js', 'render.js', 'app.js'];

const body = ORDER.map((f) => {
  const src = readFileSync(join(here, 'planet', f), 'utf8');
  return src
    .split('\n')
    .filter((l) => !/^import\s.*from\s.*;$/.test(l.trim()))
    .join('\n')
    .replace(/^export (const|function|class|let) /gm, '$1 ')
    .trim();
}).join('\n\n');

const page = readFileSync(join(here, 'artifact.html'), 'utf8').replace('__BUNDLE__', body);
mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist', 'lenses.html'), page);
console.log('proto/dist/lenses.html', (page.length / 1024).toFixed(1) + ' KB');
