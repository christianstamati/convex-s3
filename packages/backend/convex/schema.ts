import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  // Example feature. Delete it (and convex/tasks.ts) once you have your own.
  tasks: defineTable({
    text: v.string(),
    completed: v.boolean(),
  }),
})
