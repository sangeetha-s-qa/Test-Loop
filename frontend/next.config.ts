import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // The persistent Turbopack dev cache (.next/dev/cache/turbopack) went stale here after new routes
    // were added: every nested page under /test-runs/[id]/ answered 404 until the cache was deleted.
    // Off costs a slower first compile after each restart, in exchange for routes that always resolve.
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
