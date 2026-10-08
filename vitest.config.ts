import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Need an SST platform: run with `npm run test:component`.
    exclude: ['tests/component/**', '**/node_modules/**'],
    root: __dirname,
  },
});
