import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Vitest does not read .env on its own, and the suite needs TEST_DATABASE_URL.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Every suite talks to the same PostgreSQL schema and truncates it between
    // tests, so they must not overlap.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
