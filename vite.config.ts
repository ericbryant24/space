import { defineConfig } from 'vite';

// Served from https://<user>.github.io/space/ — every asset reference must be relative to this.
export default defineConfig({
  base: '/space/',
  build: { target: 'es2022', outDir: 'dist' },
});
