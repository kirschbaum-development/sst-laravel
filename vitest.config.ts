import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Need an SST platform (`npm run test:component`) or a container runtime (`npm run test:containers`).
    exclude: ['tests/component/**', 'tests/container/**', '**/node_modules/**'],
    root: __dirname,
  },
});
