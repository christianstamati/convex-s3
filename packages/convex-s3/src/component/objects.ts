/**
 * Direct object operations for server code (actions): HEAD, GET, list,
 * copy, move, tags, and the background deletes the mutations schedule.
 */
import { ConvexError, v } from "convex/values"
import {
  copyObject as copyInS3,
  deleteObject,
  deleteObjects,
  getObject as getFromS3,
  headObject as headInS3,
  listObjects as listInS3,
  putObjectTagging as tagInS3,
} from "../shared/s3"
import { internal } from "./_generated/api"
import { type ActionCtx, action, internalAction } from "./_generated/server"
import { checkKey, checkPutOptions, recordObject, s3Config } from "./helpers"
import {
  type PutOptionsValue,
  type SyncResult,
  vObjectInfo,
  vPutOptions,
  vSyncResult,
} from "./validators"

/** Background deletes retry this many times, backing off 2^n seconds. */
const MAX_DELETE_ATTEMPTS = 6

/** What S3 has for the key right now, or null. */
export const headObject = action({
  args: { key: v.string(), versionId: v.optional(v.string()) },
  returns: v.union(vObjectInfo, v.null()),
  handler: async (_ctx, { key, versionId }) => {
    checkKey(key)
    return await headInS3(s3Config(), key, { versionId })
  },
})

/**
 * The object's bytes, or a range of them (`bytes=0-1023`). Action results
 * are limited in size: use `getUrl` for anything large.
 */
export const getObject = action({
  args: {
    key: v.string(),
    range: v.optional(v.string()),
    versionId: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      data: v.bytes(),
      info: vObjectInfo,
      contentRange: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (_ctx, { key, range, versionId }) => {
    checkKey(key)
    return await getFromS3(s3Config(), key, { range, versionId })
  },
})

/** One page of what's in the bucket (S3's listing, not the table's). */
export const listObjects = action({
  args: {
    prefix: v.optional(v.string()),
    delimiter: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    objects: v.array(
      v.object({
        key: v.string(),
        size: v.number(),
        etag: v.optional(v.string()),
        lastModified: v.number(),
        storageClass: v.optional(v.string()),
      })
    ),
    prefixes: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (_ctx, args) => {
    const page = await listInS3(s3Config(), {
      prefix: args.prefix,
      delimiter: args.delimiter,
      continuationToken: args.cursor ?? undefined,
      maxKeys: args.limit,
    })
    return {
      objects: page.objects,
      prefixes: page.prefixes,
      cursor: page.nextContinuationToken ?? null,
      isDone: !page.isTruncated,
    }
  },
})

async function copyAndRecord(
  ctx: ActionCtx,
  args: {
    sourceKey: string
    destinationKey: string
    put?: PutOptionsValue | undefined
  }
): Promise<SyncResult> {
  checkKey(args.sourceKey)
  checkKey(args.destinationKey)
  checkPutOptions(args.put)
  const config = s3Config()
  await copyInS3(config, args.sourceKey, args.destinationKey, { put: args.put })
  const info = await headInS3(config, args.destinationKey)
  if (info === null) throw new ConvexError("The copy didn't arrive")
  return await recordObject(ctx, config, info)
}

/** Copies an object inside the bucket and records the copy. Up to 5 GB. */
export const copyObject = action({
  args: {
    sourceKey: v.string(),
    destinationKey: v.string(),
    put: v.optional(vPutOptions),
  },
  returns: vSyncResult,
  handler: async (ctx, args): Promise<SyncResult> =>
    await copyAndRecord(ctx, args),
})

/** Copies, then deletes the source and its row. */
export const moveObject = action({
  args: {
    sourceKey: v.string(),
    destinationKey: v.string(),
    put: v.optional(vPutOptions),
  },
  returns: vSyncResult,
  handler: async (ctx, args): Promise<SyncResult> => {
    if (args.sourceKey === args.destinationKey) {
      throw new ConvexError("The source and destination are the same key")
    }
    const result = await copyAndRecord(ctx, args)
    await deleteObject(s3Config(), args.sourceKey)
    await ctx.runMutation(internal.lib.deleteMetadata, {
      keys: [args.sourceKey],
    })
    return result
  },
})

/** Replaces the object's tags. */
export const putObjectTagging = action({
  args: { key: v.string(), tags: v.record(v.string(), v.string()) },
  returns: v.null(),
  handler: async (_ctx, { key, tags }) => {
    checkKey(key)
    await tagInS3(s3Config(), key, tags)
    return null
  },
})

/** Deletes objects in S3, retrying what failed with backoff. */
export const deleteKeys = internalAction({
  args: { keys: v.array(v.string()), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { keys, attempt }) => {
    const config = s3Config()
    let failed: string[]
    try {
      failed =
        keys.length === 1 && keys[0] !== undefined
          ? await deleteObject(config, keys[0]).then(() => [])
          : (await deleteObjects(config, keys)).errors.map((e) => e.key)
    } catch (error) {
      console.warn(`Deleting ${keys.length} objects failed:`, error)
      failed = keys
    }
    if (failed.length > 0) {
      if (attempt + 1 >= MAX_DELETE_ATTEMPTS) {
        console.error(`Gave up deleting ${failed.length} objects`, failed)
        return null
      }
      await ctx.scheduler.runAfter(
        2 ** attempt * 1000,
        internal.objects.deleteKeys,
        { keys: failed, attempt: attempt + 1 }
      )
    }
    return null
  },
})

/** Deletes up to 1,000 objects under a prefix, then schedules the rest. */
export const deletePrefixStep = internalAction({
  args: { prefix: v.string(), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { prefix, attempt }) => {
    const config = s3Config()
    try {
      const page = await listInS3(config, { prefix, maxKeys: 1000 })
      const keys = page.objects.map((object) => object.key)
      if (keys.length > 0) {
        const { errors } = await deleteObjects(config, keys)
        if (errors.length > 0) throw new Error(`${errors.length} keys failed`)
        await ctx.runMutation(internal.lib.deleteMetadata, { keys })
      }
      if (page.isTruncated) {
        await ctx.scheduler.runAfter(0, internal.objects.deletePrefixStep, {
          prefix,
          attempt: 0,
        })
      }
    } catch (error) {
      if (attempt + 1 >= MAX_DELETE_ATTEMPTS) {
        console.error(`Gave up deleting the prefix ${prefix}:`, error)
        return null
      }
      await ctx.scheduler.runAfter(
        2 ** attempt * 1000,
        internal.objects.deletePrefixStep,
        { prefix, attempt: attempt + 1 }
      )
    }
    return null
  },
})
