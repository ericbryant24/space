import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/**
 * The build stamp, shown in the corner of the page.
 *
 * It exists because of a question that has no other answer: "it is possible I am in an old version though,
 * I can't tell." A static site behind a CDN can serve a stale page from cache for a while, and without a
 * visible build id there is no way to know whether a change is missing or merely not loaded yet.
 */
function buildStamp(): string {
  try {
    const sha = execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8' }).trim();
    const day = execSync('git show -s --format=%cs HEAD', { encoding: 'utf8' }).trim();
    return `${day} ${sha}`;
  } catch {
    return 'dev';
  }
}

// Served from https://<user>.github.io/space/ — every asset reference must be relative to this.
export default defineConfig({
  base: '/space/',
  build: { target: 'es2022', outDir: 'dist' },
  define: { __BUILD__: JSON.stringify(buildStamp()) },
});
