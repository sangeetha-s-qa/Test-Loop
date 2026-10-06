import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit and fixture tests only. Integration tests need PostgreSQL and Redis and run separately.
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts", "node_modules/**", "dist/**"],
    setupFiles: ["src/testing/setup-env.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    /**
     * Test files run one at a time.
     *
     * Three files launch real browsers (the fixture check across chromium/firefox/webkit, the step
     * runner, and URL validation). Run in parallel on this host they contend for CPU and memory, and
     * Firefox - the heaviest to start - went from 1.4s launched on its own to over 15s under a
     * parallel suite, failing intermittently. The timeout was never the problem: the contention was.
     * Serialising costs a little wall-clock and makes the browser tests deterministic.
     */
    fileParallelism: false,
  },
});
