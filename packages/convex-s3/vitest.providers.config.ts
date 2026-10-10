import { defineConfig } from "vitest/config"

/** The provider suite only: real S3-compatible endpoints, from S3_* env vars. */
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["src/providers.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
