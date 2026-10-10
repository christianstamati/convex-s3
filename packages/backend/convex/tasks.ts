// Example feature showing the patterns used across the stack: a query that the
// web app subscribes to live, and mutations that validate their input. Delete
// it (and the `tasks` table) once you have your own.
import { ConvexError, v } from "convex/values"
import { doc } from "convex-helpers/validators"
import type { Id } from "./_generated/dataModel"
import { type MutationCtx, mutation, query } from "./_generated/server"
import schema from "./schema"

const MAX_TEXT_LENGTH = 500
const MAX_TASKS = 100

export const list = query({
  args: {},
  returns: v.array(doc(schema, "tasks")),
  handler: async (ctx) => {
    return await ctx.db.query("tasks").order("desc").take(MAX_TASKS)
  },
})

export const create = mutation({
  args: { text: v.string() },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const text = args.text.trim()
    if (text.length === 0 || text.length > MAX_TEXT_LENGTH) {
      throw new ConvexError(
        `Tasks must be between 1 and ${MAX_TEXT_LENGTH} characters`
      )
    }
    return await ctx.db.insert("tasks", { text, completed: false })
  },
})

export const toggle = mutation({
  args: { id: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await getTask(ctx, args.id)
    await ctx.db.patch("tasks", task._id, { completed: !task.completed })
    return null
  },
})

export const remove = mutation({
  args: { id: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await getTask(ctx, args.id)
    await ctx.db.delete("tasks", task._id)
    return null
  },
})

async function getTask(ctx: MutationCtx, id: Id<"tasks">) {
  const task = await ctx.db.get("tasks", id)
  if (task === null) {
    throw new ConvexError("Task not found")
  }
  return task
}
