import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter"
import { ConvexError } from "convex/values"
import { components } from "../_generated/api"
import type { ActionCtx, MutationCtx } from "../_generated/server"

/**
 * The examples are public, with no users to key limits on, so these caps
 * are global. They bound how fast strangers can fill the bucket; a real app
 * keys them by user in `checkUpload`.
 */
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Room for dropping a folder tree of a few hundred files.
  uploads: { kind: "token bucket", rate: 300, period: MINUTE, capacity: 300 },
  // Creating, renaming, moving and deleting folders and files.
  driveWrites: {
    kind: "token bucket",
    rate: 120,
    period: MINUTE,
    capacity: 60,
  },
})

/** Takes one from the named limit, or throws a message people can read. */
export async function limit(
  ctx: MutationCtx | ActionCtx,
  name: "uploads" | "driveWrites"
) {
  const { ok, retryAfter } = await rateLimiter.limit(ctx, name)
  if (!ok) {
    throw new ConvexError(
      `Too many requests. Try again in ${Math.ceil(retryAfter / 1000)} s.`
    )
  }
}
