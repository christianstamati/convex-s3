import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { vPutOptions, vStoredObject } from "./validators"

export default defineSchema({
  /**
   * Objects known to be in the bucket: a row is written only after a HEAD
   * saw the object. Keyed by bucket, so a prefix is a range on `bucket_key`.
   */
  objects: defineTable(vStoredObject).index("bucket_key", ["bucket", "key"]),

  /**
   * Uploads handed out and not finished yet. The token proves a follow-up
   * call (sync, parts, complete) comes from whoever got the ticket; an
   * upload left unfinished is cleaned up at `expiresAt`.
   */
  uploads: defineTable({
    bucket: v.string(),
    key: v.string(),
    token: v.string(),
    method: v.union(
      v.literal("single"),
      v.literal("multipart"),
      v.literal("post")
    ),
    /** Set once S3 created the multipart upload. */
    uploadId: v.optional(v.string()),
    /** The exact size, when the client declared it (signed into the URLs). */
    size: v.optional(v.number()),
    maxSize: v.optional(v.number()),
    partSize: v.optional(v.number()),
    put: v.optional(vPutOptions),
    /**
     * Signed into the object's metadata (`x-amz-meta-upload-ticket`): an
     * object counts as this upload's only if it carries it, so cleanup never
     * deletes, and sync never records, an object another upload put there.
     */
    marker: v.optional(v.string()),
    /** Set while a sync, completion or abort runs, so only one does. */
    claimedAt: v.optional(v.number()),
    /**
     * Set once the ticket is done (recorded, refused or aborted). The row
     * stays until `expiresAt`, when its URLs have expired: a final sweep
     * then deletes anything a replayed URL put back that nothing recorded.
     */
    closedAt: v.optional(v.number()),
    expiresAt: v.number(),
  }).index("key_token", ["key", "token"]),
})
