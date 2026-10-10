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
    expiresAt: v.number(),
  }).index("key", ["key"]),
})
