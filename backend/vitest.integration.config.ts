import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests need a real PostgreSQL, a real Redis, and a real browser.
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["src/testing/setup-env.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // A shared database means these must not run concurrently.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
