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
      // The migrations are schema text and the entry point is a process; neither
      // is worth chasing coverage on and both drag the number about.
      exclude: ['src/db/migrations/**', 'src/index.js'],
      reporter: ['text-summary', 'text'],
      // Floors, not targets. They are set a little under where the suite
      // actually sits, so a change that guts the tests fails and ordinary work
      // does not.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 88,
        statements: 95,
      },
    },
  },
});
