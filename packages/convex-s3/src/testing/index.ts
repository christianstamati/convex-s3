/// <reference types="vite/client" />
import type { GenericSchema, SchemaDefinition } from "convex/server"
import schema from "../component/schema"

export { type FakeObject, FakeS3, type FakeS3Options } from "./fakeS3"

const modules = import.meta.glob([
  "../component/**/*.ts",
  "!../component/**/*.test.ts",
])

/**
 * Registers the component with a convex-test instance:
 * `register(t)` after `convexTest(schema, modules)`. Pair it with a
 * `FakeS3`: `vi.stubGlobal("fetch", s3.fetch)` and its `env()`.
 */
export function register(
  t: {
    registerComponent: (
      name: string,
      schema: SchemaDefinition<GenericSchema, boolean>,
      modules: Record<string, () => Promise<unknown>>
    ) => void
  },
  name = "s3"
) {
  t.registerComponent(name, schema, modules)
}
