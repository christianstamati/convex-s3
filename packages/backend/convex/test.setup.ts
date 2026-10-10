/// <reference types="vite/client" />

import { FakeS3, register } from "convex-s3/testing"
import { convexTest } from "convex-test"
import { vi } from "vitest"
import schema from "./schema"

// Every Convex module except tests, configs and this file (names with extra
// dots). Vite 8 globs don't support extglobs like `!(*.*.*)`, hence the array.
export const modules = import.meta.glob(["./**/*.*s", "!./**/*.*.*s"])

/** The backend with the S3 component, talking to an in-memory S3. */
export function setup() {
  const s3 = new FakeS3({ minPartSize: 1 })
  for (const [name, value] of Object.entries(s3.env())) vi.stubEnv(name, value)
  vi.stubGlobal("fetch", s3.fetch)
  const t = convexTest(schema, modules)
  register(t)
  return { t, s3 }
}

export type TestConvex = ReturnType<typeof setup>["t"]
