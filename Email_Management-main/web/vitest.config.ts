import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const setupFile = fileURLToPath(new URL('./src/test/setup.ts', import.meta.url));

// Separate from vite.config.ts — intentionally excludes `root: 'src'` so Vitest
// discovers test files from the project root and resolves imports normally.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [setupFile],
    css: false, // skip CSS processing — class names are still present as strings
    // Exclude Playwright E2E tests — they use @playwright/test, not Vitest
    exclude: ['**/node_modules/**', 'e2e/**'],
  },
});
