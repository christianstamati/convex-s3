/// <reference types="vite/client" />

import rateLimiter from "@convex-dev/rate-limiter/test"
import { FakeS3, register } from "@cstack-dev/convex-s3/testing"
import { convexTest } from "convex-test"
import { afterEach, vi } from "vitest"
import schema from "./schema"

// Every Convex module except tests, configs and this file (names with extra
// dots). Vite 8 globs don't support extglobs like `!(*.*.*)`, hence the array.
export const modules = import.meta.glob(["./**/*.*s", "!./**/*.*.*s"])

const running: ReturnType<typeof convexTest>[] = []

// Background work a test scheduled (deletes, cleanups) finishes before the
// fake S3 and env vars go away, so it can't fail later or leak.
afterEach(async () => {
  for (const t of running.splice(0)) {
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  }
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/**
 * The backend with the S3 component, talking to an in-memory S3, on fake
 * timers (so scheduled work can be run to the end).
 */
export function setup() {
  vi.useFakeTimers()
  const s3 = new FakeS3({ minPartSize: 1 })
  for (const [name, value] of Object.entries(s3.env())) vi.stubEnv(name, value)
  vi.stubGlobal("fetch", s3.fetch)
  const t = convexTest(schema, modules)
  register(t)
  rateLimiter.register(t)
  running.push(t)
  return { t, s3 }
}

export type TestConvex = ReturnType<typeof setup>["t"]
