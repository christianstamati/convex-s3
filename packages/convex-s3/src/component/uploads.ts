/**
 * Uploads from browsers: a ticket (one presigned PUT, a multipart upload or
 * a form POST), then a call that checks what arrived and records it. An
 * upload row tracks each ticket until then; one left unfinished is cleaned
 * up when it expires.
 */
import { ConvexError, v } from "convex/values"
import type { S3Config } from "../shared/config"
import {
  abortMultipartUpload,
  completeMultipartUpload as completeInS3,
  createMultipartUpload as createInS3,
  deleteObject,
  headObject,
  listParts,
  presignPostUpload,
  presignPut,
  presignUploadPart,
  S3Error,
} from "../shared/s3"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
} from "./_generated/server"
import { checkKey, checkPutOptions, recordObject, s3Config } from "./helpers"
import {
  type SyncResult,
  vPart,
  vPutOptions,
  vSyncResult,
  vUploadTicket,
} from "./validators"

const MiB = 1024 * 1024
const GiB = 1024 * MiB
/** S3's limits: 5 GiB in one PUT, parts of 5 MiB to 5 GiB, 10,000 parts. */
const MAX_SINGLE_SIZE = 5 * GiB
const MIN_PART_SIZE = 5 * MiB
const MAX_PART_SIZE = 5 * GiB
const MAX_PARTS = 10_000
const MAX_OBJECT_SIZE = 5 * 1024 * GiB

export const DEFAULT_MULTIPART_THRESHOLD = 64 * MiB
const DEFAULT_PART_SIZE = 16 * MiB
/** Upload URLs last 5 minutes, part URLs an hour. */
const DEFAULT_UPLOAD_EXPIRES_IN = 5 * 60
const PART_EXPIRES_IN = 60 * 60
/** A single upload may be synced up to an hour after its URL expired. */
const SINGLE_GRACE_MS = 60 * 60 * 1000
const MULTIPART_TTL_MS = 24 * 60 * 60 * 1000
/** Part URLs signed per call. */
const MAX_PARTS_PER_SIGN = 100

function checkSize(name: string, value: number | undefined) {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConvexError(`${name} must be a whole number of bytes`)
  }
}

function megabytes(bytes: number) {
  return `${Math.round((bytes / MiB) * 10) / 10} MB`
}

function partSizeFor(size: number, requested: number | undefined) {
  const wanted = Math.max(requested ?? DEFAULT_PART_SIZE, MIN_PART_SIZE)
  const needed = Math.ceil(size / MAX_PARTS / MiB) * MiB
  return Math.min(Math.max(wanted, needed), MAX_PART_SIZE)
}

/**
 * A ticket to upload one object. With `size`, it is signed into the URLs, so
 * S3 refuses a file of any other size; above `multipartThreshold` the
 * ticket is a multipart upload.
 */
export const generateUploadUrl = mutation({
  args: {
    key: v.string(),
    size: v.optional(v.number()),
    maxSize: v.optional(v.number()),
    put: v.optional(vPutOptions),
    expiresIn: v.optional(v.number()),
    multipartThreshold: v.optional(v.number()),
    partSize: v.optional(v.number()),
  },
  returns: vUploadTicket,
  handler: async (ctx, args) => {
    checkKey(args.key)
    checkPutOptions(args.put)
    checkSize("size", args.size)
    checkSize("maxSize", args.maxSize)
    const { size, maxSize } = args
    if (size !== undefined && maxSize !== undefined && size > maxSize) {
      throw new ConvexError(`Files can be ${megabytes(maxSize)} at most`)
    }
    if (size !== undefined && size > MAX_OBJECT_SIZE) {
      throw new ConvexError("S3 stores objects of 5 TB at most")
    }
    const config = s3Config()
    const now = Date.now()
    const token = crypto.randomUUID()
    const threshold = Math.min(
      args.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD,
      MAX_SINGLE_SIZE
    )
    const base = {
      bucket: config.bucket,
      key: args.key,
      token,
      size,
      maxSize,
      put: args.put,
    }

    if (size !== undefined && size > threshold) {
      const partSize = partSizeFor(size, args.partSize)
      const partCount = Math.ceil(size / partSize)
      const expiresAt = now + MULTIPART_TTL_MS
      await insertUpload(ctx, {
        ...base,
        method: "multipart",
        partSize,
        expiresAt,
      })
      return {
        method: "multipart" as const,
        key: args.key,
        token,
        partSize,
        partCount,
        expiresAt,
      }
    }

    const expiresIn = args.expiresIn ?? DEFAULT_UPLOAD_EXPIRES_IN
    const expiresAt = now + expiresIn * 1000 + SINGLE_GRACE_MS
    const signed = await presignPut(config, args.key, {
      size,
      put: args.put,
      expiresIn,
      date: new Date(now),
    })
    await insertUpload(ctx, { ...base, method: "single", expiresAt })
    return {
      method: "single" as const,
      key: args.key,
      token,
      url: signed.url,
      headers: signed.headers,
      expiresAt,
    }
  },
})

/**
 * A ticket for an HTML form upload (a presigned POST), whose policy caps the
 * size: S3 itself refuses a bigger file. Not supported by Cloudflare R2.
 */
export const generateUploadPost = mutation({
  args: {
    key: v.string(),
    maxSize: v.number(),
    minSize: v.optional(v.number()),
    put: v.optional(vPutOptions),
    expiresIn: v.optional(v.number()),
  },
  returns: vUploadTicket,
  handler: async (ctx, args) => {
    checkKey(args.key)
    checkPutOptions(args.put)
    checkSize("maxSize", args.maxSize)
    checkSize("minSize", args.minSize)
    const config = s3Config()
    const now = Date.now()
    const token = crypto.randomUUID()
    const expiresIn = args.expiresIn ?? DEFAULT_UPLOAD_EXPIRES_IN
    const expiresAt = now + expiresIn * 1000 + SINGLE_GRACE_MS
    const signed = await presignPostUpload(config, args.key, {
      minSize: args.minSize ?? 0,
      maxSize: args.maxSize,
      put: args.put,
      expiresIn,
      date: new Date(now),
    })
    await insertUpload(ctx, {
      bucket: config.bucket,
      key: args.key,
      token,
      method: "post",
      maxSize: args.maxSize,
      put: args.put,
      expiresAt,
    })
    return {
      method: "post" as const,
      key: args.key,
      token,
      url: signed.url,
      fields: signed.fields,
      expiresAt,
    }
  },
})

async function insertUpload(
  ctx: MutationCtx,
  upload: Omit<Doc<"uploads">, "_id" | "_creationTime">
) {
  const id = await ctx.db.insert("uploads", upload)
  await ctx.scheduler.runAt(upload.expiresAt, internal.uploads.expire, { id })
}

/** The upload a ticket belongs to, or an error the user can read. */
async function requireUpload(
  ctx: ActionCtx,
  key: string,
  token: string
): Promise<Doc<"uploads">> {
  const upload: Doc<"uploads"> | null = await ctx.runQuery(
    internal.uploads.find,
    { key, token }
  )
  if (upload === null) {
    throw new ConvexError(
      "This upload has expired or was already completed. Start it again."
    )
  }
  return upload
}

/** Starts the multipart upload in S3 (or returns the one already started). */
export const createMultipartUpload = action({
  args: { key: v.string(), token: v.string() },
  returns: v.object({
    uploadId: v.string(),
    partSize: v.number(),
    partCount: v.number(),
  }),
  handler: async (
    ctx,
    { key, token }
  ): Promise<{ uploadId: string; partSize: number; partCount: number }> => {
    const upload = await requireUpload(ctx, key, token)
    if (
      upload.method !== "multipart" ||
      upload.size === undefined ||
      upload.partSize === undefined
    ) {
      throw new ConvexError("This upload isn't a multipart upload")
    }
    const partSize = upload.partSize
    const partCount = Math.ceil(upload.size / partSize)
    if (upload.uploadId !== undefined) {
      return { uploadId: upload.uploadId, partSize, partCount }
    }
    const config = s3Config()
    const created = await createInS3(config, key, upload.put)
    const uploadId: string = await ctx.runMutation(
      internal.uploads.setUploadId,
      {
        id: upload._id,
        uploadId: created,
      }
    )
    // Another call won the race: drop the upload this one started.
    if (uploadId !== created) await abortMultipartUpload(config, key, created)
    return { uploadId, partSize, partCount }
  },
})

/** Presigned URLs for some parts, each with its exact size signed. */
export const signUploadParts = mutation({
  args: {
    key: v.string(),
    token: v.string(),
    partNumbers: v.array(v.number()),
  },
  returns: v.array(v.object({ partNumber: v.number(), url: v.string() })),
  handler: async (ctx, { key, token, partNumbers }) => {
    const upload = await findUpload(ctx, key, token)
    if (
      upload === null ||
      upload.uploadId === undefined ||
      upload.size === undefined ||
      upload.partSize === undefined
    ) {
      throw new ConvexError(
        "This upload has expired or hasn't started. Start it again."
      )
    }
    if (partNumbers.length > MAX_PARTS_PER_SIGN) {
      throw new ConvexError(
        `Sign ${MAX_PARTS_PER_SIGN} parts at most at a time`
      )
    }
    const { size, partSize, uploadId } = upload
    const partCount = Math.ceil(size / partSize)
    const config = s3Config()
    const date = new Date()
    return await Promise.all(
      partNumbers.map(async (partNumber) => {
        if (
          !Number.isInteger(partNumber) ||
          partNumber < 1 ||
          partNumber > partCount
        ) {
          throw new ConvexError(`There is no part ${partNumber}`)
        }
        const partBytes =
          partNumber < partCount ? partSize : size - partSize * (partCount - 1)
        const url = await presignUploadPart(config, key, {
          uploadId,
          partNumber,
          size: partBytes,
          expiresIn: PART_EXPIRES_IN,
          date,
        })
        return { partNumber, url }
      })
    )
  },
})

/** The parts S3 has so far, to resume an interrupted upload. */
export const listUploadedParts = action({
  args: { key: v.string(), token: v.string() },
  returns: v.array(
    v.object({ partNumber: v.number(), etag: v.string(), size: v.number() })
  ),
  handler: async (
    ctx,
    { key, token }
  ): Promise<{ partNumber: number; etag: string; size: number }[]> => {
    const upload = await requireUpload(ctx, key, token)
    if (upload.uploadId === undefined) return []
    return await listParts(s3Config(), key, upload.uploadId)
  },
})

/**
 * Completes a multipart upload, checks the object's size and records it.
 * Throws (and removes the object) if it isn't what the ticket allowed.
 */
export const completeMultipartUpload = action({
  args: { key: v.string(), token: v.string(), parts: v.array(vPart) },
  returns: vSyncResult,
  handler: async (ctx, { key, token, parts }): Promise<SyncResult> => {
    const upload = await requireUpload(ctx, key, token)
    if (
      upload.uploadId === undefined ||
      upload.size === undefined ||
      upload.partSize === undefined
    ) {
      throw new ConvexError("This upload hasn't started")
    }
    const partCount = Math.ceil(upload.size / upload.partSize)
    const numbers = new Set(parts.map((part) => part.partNumber))
    if (parts.length !== partCount || numbers.size !== partCount) {
      throw new ConvexError(
        `Expected ${partCount} parts, got ${parts.length}. Resume the upload.`
      )
    }
    const config = s3Config()
    try {
      await completeInS3(config, key, upload.uploadId, parts, {
        ifNoneMatch: upload.put?.ifNoneMatch,
      })
    } catch (error) {
      if (error instanceof S3Error && error.status < 500) {
        throw new ConvexError(`S3 refused the upload: ${error.code}`)
      }
      throw error
    }
    return await recordUpload(ctx, config, upload)
  },
})

/**
 * Records an object after an upload: HEADs it and writes its row. With a
 * token, the object must match what that ticket allowed, or it is deleted;
 * without one (server code), any existing key is synced.
 */
export const syncMetadata = action({
  args: { key: v.string(), token: v.optional(v.string()) },
  returns: vSyncResult,
  handler: async (ctx, { key, token }): Promise<SyncResult> => {
    checkKey(key)
    const config = s3Config()
    if (token === undefined) {
      const info = await headObject(config, key)
      if (info === null) throw new ConvexError(`There is no object at ${key}`)
      return await recordObject(ctx, config, info)
    }
    const upload = await requireUpload(ctx, key, token)
    if (upload.method === "multipart") {
      throw new ConvexError("Complete a multipart upload instead")
    }
    return await recordUpload(ctx, config, upload)
  },
})

async function recordUpload(
  ctx: ActionCtx,
  config: S3Config,
  upload: Doc<"uploads">
): Promise<SyncResult> {
  const info = await headObject(config, upload.key)
  if (info === null) {
    throw new ConvexError("The upload didn't arrive. Try again.")
  }
  const problem =
    upload.size !== undefined && info.size !== upload.size
      ? `The file arrived with ${info.size} bytes instead of ${upload.size}`
      : upload.maxSize !== undefined && info.size > upload.maxSize
        ? `Files can be ${megabytes(upload.maxSize)} at most`
        : null
  if (problem !== null) {
    await deleteObject(config, upload.key)
    await ctx.runMutation(internal.uploads.remove, { id: upload._id })
    throw new ConvexError(problem)
  }
  const result = await recordObject(ctx, config, info)
  await ctx.runMutation(internal.uploads.remove, { id: upload._id })
  return result
}

/** Gives up on an upload: aborts it in S3 and removes what arrived. */
export const abortUpload = action({
  args: { key: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, token }): Promise<null> => {
    const upload: Doc<"uploads"> | null = await ctx.runQuery(
      internal.uploads.find,
      { key, token }
    )
    if (upload !== null) await cleanUp(ctx, upload)
    return null
  },
})

async function cleanUp(ctx: ActionCtx, upload: Doc<"uploads">): Promise<void> {
  const config = s3Config()
  if (upload.method === "multipart") {
    if (upload.uploadId !== undefined) {
      await abortMultipartUpload(config, upload.key, upload.uploadId)
    }
  } else {
    // The key was made for this upload, so anything there came from it.
    await deleteObject(config, upload.key)
  }
  await ctx.runMutation(internal.uploads.remove, { id: upload._id })
}

export const expire = internalAction({
  args: { id: v.id("uploads") },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    const upload: Doc<"uploads"> | null = await ctx.runQuery(
      internal.uploads.get,
      { id }
    )
    if (upload !== null) await cleanUp(ctx, upload)
    return null
  },
})

async function findUpload(
  ctx: QueryCtx,
  key: string,
  token: string
): Promise<Doc<"uploads"> | null> {
  const uploads = await ctx.db
    .query("uploads")
    .withIndex("key", (q) => q.eq("key", key))
    .collect()
  return (
    uploads.find(
      (upload) => upload.token === token && upload.expiresAt > Date.now()
    ) ?? null
  )
}

const vUploadDoc = v.object({
  _id: v.id("uploads"),
  _creationTime: v.number(),
  bucket: v.string(),
  key: v.string(),
  token: v.string(),
  method: v.union(
    v.literal("single"),
    v.literal("multipart"),
    v.literal("post")
  ),
  uploadId: v.optional(v.string()),
  size: v.optional(v.number()),
  maxSize: v.optional(v.number()),
  partSize: v.optional(v.number()),
  put: v.optional(vPutOptions),
  expiresAt: v.number(),
})

export const find = internalQuery({
  args: { key: v.string(), token: v.string() },
  returns: v.union(vUploadDoc, v.null()),
  handler: async (ctx, { key, token }) => await findUpload(ctx, key, token),
})

export const get = internalQuery({
  args: { id: v.id("uploads") },
  returns: v.union(vUploadDoc, v.null()),
  handler: async (ctx, { id }) => await ctx.db.get("uploads", id),
})

/** Stores the multipart upload id, unless one is already there. */
export const setUploadId = internalMutation({
  args: { id: v.id("uploads"), uploadId: v.string() },
  returns: v.string(),
  handler: async (ctx, { id, uploadId }) => {
    const upload = await ctx.db.get("uploads", id)
    if (upload === null) throw new ConvexError("This upload has expired")
    if (upload.uploadId !== undefined) return upload.uploadId
    await ctx.db.patch("uploads", id, { uploadId })
    return uploadId
  },
})

export const remove = internalMutation({
  args: { id: v.id("uploads") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if ((await ctx.db.get("uploads", id)) !== null) {
      await ctx.db.delete("uploads", id)
    }
    return null
  },
})
