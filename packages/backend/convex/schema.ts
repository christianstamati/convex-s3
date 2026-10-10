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

  // Drive folder moves in progress, so one that stopped halfway can be run
  // again: the keys it already moved are expected at the destination.
  driveMoves: defineTable({
    from: v.string(),
    to: v.string(),
    startedAt: v.number(),
  }).index("by_from_to", ["from", "to"]),
})
