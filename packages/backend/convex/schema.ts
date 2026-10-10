import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  // The example's uploaded files. The bytes are in S3 under `key`; the
  // component keeps its own record of the object.
  files: defineTable({
    key: v.string(),
    name: v.string(),
    size: v.number(),
    contentType: v.optional(v.string()),
  }).index("by_key", ["key"]),
})
