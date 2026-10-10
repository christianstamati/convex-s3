/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import schema from "./schema"

// Every Convex module except tests, configs and this file (names with extra
// dots). Vite 8 globs don't support extglobs like `!(*.*.*)`, hence the array.
export const modules = import.meta.glob(["./**/*.*s", "!./**/*.*.*s"])

export function setup() {
  return convexTest(schema, modules)
}

export type TestConvex = ReturnType<typeof setup>
