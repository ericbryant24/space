import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { test } from 'node:test';

/**
 * The test suite runs under Node's type-stripping loader, which supports only syntax that erases to
 * nothing. Parameter properties (`constructor(private readonly x: T)`) declare a field as a side
 * effect of a type annotation, so they cannot be stripped -- and they fail at import time with a
 * SyntaxError, which reads like a broken test rather than a language restriction.
 *
 * This has bitten three times. Catch it as a test instead of as a confusing crash.
 */
const BANNED: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s+\w+\s*:/s,
    why: 'parameter property in a constructor (declare the field explicitly instead)',
  },
  { pattern: /^\s*(?:export\s+)?enum\s+\w+/m, why: 'enum (use a const object plus a union type)' },
  { pattern: /^\s*(?:export\s+)?namespace\s+\w+/m, why: 'namespace (use a module)' },
  { pattern: /\w+!\s*[:=]/, why: 'definite assignment assertion' },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (extname(full) === '.ts') out.push(full);
  }
  return out;
}

test('no TypeScript syntax that Node cannot strip', () => {
  const files = [...walk('src'), ...walk('test'), ...walk('tools')];
  assert.ok(files.length > 15, `expected to scan the project, found only ${files.length} files`);

  const failures: string[] = [];
  for (const file of files) {
    if (file.endsWith('syntax.test.ts')) continue;
    const source = readFileSync(file, 'utf8');
    for (const { pattern, why } of BANNED) {
      if (pattern.test(source)) failures.push(`${file}: ${why}`);
    }
  }
  assert.deepEqual(failures, [], `unstrippable syntax found:\n  ${failures.join('\n  ')}`);
});

test('the guard actually catches what it claims to', () => {
  // A guard that cannot fail is worse than no guard.
  const bad = 'class A {\n  constructor(private readonly x: number) {}\n}';
  assert.ok(BANNED[0]!.pattern.test(bad), 'parameter-property pattern is broken');
  assert.ok(BANNED[1]!.pattern.test('export enum Colour { Red }'), 'enum pattern is broken');
  assert.ok(!BANNED[0]!.pattern.test('constructor(x: number) {}'), 'pattern flags plain parameters');
  assert.ok(!BANNED[0]!.pattern.test('constructor(readonly: number) {}'), 'pattern flags a plain name');
});
