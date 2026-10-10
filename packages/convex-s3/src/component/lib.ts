/**
 * The component's metadata and URLs: reads of the `objects` table, signed
 * download URLs, and deletes (rows at once, objects in the background).
 */
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server"
import { ConvexError, v } from "convex/values"
import { paginator } from "convex-helpers/server/pagination"
import { publicUrl } from "../shared/config"
import { prefixEnd } from "../shared/keys"
import { presignGet } from "../shared/s3"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import {
  internalMutation,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server"
import {
  checkKey,
  DEFAULT_GET_EXPIRES_IN,
  s3Config,
  toMetadata,
} from "./helpers"
import schema from "./schema"
import { vGetUrlOptions, vObjectMetadata, vStoredObject } from "./validators"

/** Rows deleted per mutation when clearing a prefix. */
const DELETE_BATCH = 500

/** The bucket this installation serves, and where public URLs point. */
export const config = query({
  args: {},
  returns: v.object({
    bucket: v.string(),
    region: v.string(),
    publicUrl: v.union(v.string(), v.null()),
  }),
  handler: async () => {
    const config = s3Config()
    return {
      bucket: config.bucket,
      region: config.region,
      publicUrl: config.publicUrl ?? null,
    }
  },
})

/** A presigned download URL. It doesn't check that the object exists. */
export const getUrl = query({
  args: { key: v.string(), ...vGetUrlOptions },
  returns: v.string(),
  handler: async (_ctx, { key, ...options }) => {
    checkKey(key)
    return await presignGet(s3Config(), key, {
      ...options,
      expiresIn: options.expiresIn ?? DEFAULT_GET_EXPIRES_IN,
      date: new Date(),
    })
  },
})

/** The object's URL under `S3_PUBLIC_URL`, or null without one. */
export const getPublicUrl = query({
  args: { key: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (_ctx, { key }) => {
    checkKey(key)
    return publicUrl(s3Config(), key)
  },
})

export const getMetadata = query({
  args: { key: v.string(), expiresIn: v.optional(v.number()) },
  returns: v.union(vObjectMetadata, v.null()),
  handler: async (ctx, { key, expiresIn }) => {
    const config = s3Config()
    const row = await ctx.db
      .query("objects")
      .withIndex("bucket_key", (q) =>
        q.eq("bucket", config.bucket).eq("key", key)
      )
      .unique()
    return row === null ? null : await toMetadata(config, row, { expiresIn })
  },
})

/** A page of the bucket's objects, optionally under a prefix, by key. */
export const listMetadata = query({
  args: {
    prefix: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
    expiresIn: v.optional(v.number()),
  },
  returns: paginationResultValidator(vObjectMetadata),
  handler: async (ctx, { prefix, paginationOpts, expiresIn }) => {
    const config = s3Config()
    const result = await paginator(ctx.db, schema)
      .query("objects")
      .withIndex("bucket_key", (q) =>
        prefix
          ? q
              .eq("bucket", config.bucket)
              .gte("key", prefix)
              .lt("key", prefixEnd(prefix))
          : q.eq("bucket", config.bucket)
      )
      .paginate(paginationOpts)
    return {
      ...result,
      page: await Promise.all(
        result.page.map((row) => toMetadata(config, row, { expiresIn }))
      ),
    }
  },
})

/** Rows read per index query while walking a folder. */
const FOLDER_BATCH = 100

/**
 * One level of the bucket under `prefix`, like S3's listing with a
 * delimiter: the objects directly in it and the folders (common prefixes)
 * below it. Live, since it reads the recorded objects. A folder's own
 * marker (a key equal to `prefix`, such as `photos/`) isn't listed.
 */
export const listFolder = query({
  args: {
    prefix: v.optional(v.string()),
    delimiter: v.optional(v.string()),
    /** Folders and objects together, 1,000 at most (the default). */
    limit: v.optional(v.number()),
    expiresIn: v.optional(v.number()),
  },
  returns: v.object({
    folders: v.array(v.string()),
    objects: v.array(vObjectMetadata),
    isTruncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const config = s3Config()
    const prefix = args.prefix ?? ""
    const delimiter = args.delimiter ?? "/"
    const limit = Math.max(1, Math.min(args.limit ?? 1000, 1000))
    const end = prefixEnd(prefix)
    const folders: string[] = []
    const rows: Doc<"objects">[] = []
    // Walk the index in key order. On reaching a folder, skip past every key
    // in it with one new range, so a folder costs one read, not one per key.
    let after: string | null = null
    let isTruncated = false
    walk: for (;;) {
      const batch: Doc<"objects">[] = await ctx.db
        .query("objects")
        .withIndex("bucket_key", (q) => {
          const inBucket = q.eq("bucket", config.bucket)
          return after === null
            ? inBucket.gte("key", prefix).lt("key", end)
            : inBucket.gt("key", after).lt("key", end)
        })
        .take(FOLDER_BATCH)
      for (const row of batch) {
        if (folders.length + rows.length >= limit) {
          isTruncated = true
          break walk
        }
        const rest = row.key.slice(prefix.length)
        const cut = delimiter === "" ? -1 : rest.indexOf(delimiter)
        if (rest === "") {
          after = row.key
        } else if (cut === -1) {
          rows.push(row)
          after = row.key
        } else {
          const folder = prefix + rest.slice(0, cut + delimiter.length)
          folders.push(folder)
          after = prefixEnd(folder)
          continue walk
        }
      }
      if (batch.length < FOLDER_BATCH) break
    }
    return {
      folders,
      objects: await Promise.all(
        rows.map((row) =>
          toMetadata(config, row, { expiresIn: args.expiresIn })
        )
      ),
      isTruncated,
    }
  },
})

async function deleteRows(ctx: MutationCtx, bucket: string, keys: string[]) {
  for (const key of keys) {
    const row = await ctx.db
      .query("objects")
      .withIndex("bucket_key", (q) => q.eq("bucket", bucket).eq("key", key))
      .unique()
    if (row !== null) await ctx.db.delete("objects", row._id)
  }
}

/** Removes the row now and the object in the background, with retries. */
export const deleteObject = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, { key }) => {
    checkKey(key)
    const { bucket } = s3Config()
    await deleteRows(ctx, bucket, [key])
    await ctx.scheduler.runAfter(0, internal.objects.deleteKeys, {
      keys: [key],
      attempt: 0,
    })
    return null
  },
})

/** Like `deleteObject` for up to 1,000 keys. */
export const deleteObjects = mutation({
  args: { keys: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { keys }) => {
    if (keys.length > 1000) {
      throw new ConvexError("Delete 1,000 keys at most at a time")
    }
    for (const key of keys) checkKey(key)
    const { bucket } = s3Config()
    await deleteRows(ctx, bucket, keys)
    if (keys.length > 0) {
      await ctx.scheduler.runAfter(0, internal.objects.deleteKeys, {
        keys,
        attempt: 0,
      })
    }
    return null
  },
})

/**
 * Deletes every object whose key starts with `prefix`, rows and objects,
 * in scheduled steps until none is left. The prefix can't be empty.
 */
export const deletePrefix = mutation({
  args: { prefix: v.string() },
  returns: v.null(),
  handler: async (ctx, { prefix }) => {
    if (prefix.length === 0) {
      throw new ConvexError("Refusing to delete the whole bucket")
    }
    await ctx.scheduler.runAfter(0, internal.lib.deleteMetadataPrefix, {
      prefix,
    })
    await ctx.scheduler.runAfter(0, internal.objects.deletePrefixStep, {
      prefix,
      attempt: 0,
    })
    return null
  },
})

/** Writes what a HEAD saw. Returns whether the key was new. */
export const upsertMetadata = internalMutation({
  args: vStoredObject,
  returns: v.boolean(),
  handler: async (ctx, object) => {
    const row = await ctx.db
      .query("objects")
      .withIndex("bucket_key", (q) =>
        q.eq("bucket", object.bucket).eq("key", object.key)
      )
      .unique()
    if (row === null) {
      await ctx.db.insert("objects", object)
      return true
    }
    await ctx.db.replace("objects", row._id, object)
    return false
  },
})

export const deleteMetadata = internalMutation({
  args: { keys: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { keys }) => {
    await deleteRows(ctx, s3Config().bucket, keys)
    return null
  },
})

export const deleteMetadataPrefix = internalMutation({
  args: { prefix: v.string() },
  returns: v.null(),
  handler: async (ctx, { prefix }) => {
    const { bucket } = s3Config()
    const rows = await ctx.db
      .query("objects")
      .withIndex("bucket_key", (q) =>
        q.eq("bucket", bucket).gte("key", prefix).lt("key", prefixEnd(prefix))
      )
      .take(DELETE_BATCH)
    for (const row of rows) await ctx.db.delete("objects", row._id)
    if (rows.length === DELETE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.lib.deleteMetadataPrefix, {
        prefix,
      })
    }
    return null
  },
})
