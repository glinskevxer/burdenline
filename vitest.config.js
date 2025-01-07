import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: false,
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reporter: ['text-summary'],
    },
  },
});
