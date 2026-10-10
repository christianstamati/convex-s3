/**
 * Uploads from browsers: a ticket (one presigned PUT, a multipart upload or
 * a form POST), then a call that checks what arrived and records it. An
 * upload row tracks each ticket until then; one left unfinished is cleaned
 * up when it expires.
 *
 * Every ticket signs a marker into the object's metadata, and refuses to
 * overwrite an existing object unless asked to. Cleanup deletes, and sync
 * records, only an object carrying the ticket's marker: what another upload
 * put at the same key is never touched. Sync, completion and abort first
 * claim the ticket, so each happens once.
 *
 * A presigned URL can't be revoked, so a ticket outlives its use: once
 * recorded, refused or aborted it is closed, and stays until its URLs have
 * expired. Then a final sweep deletes whatever a replayed URL put back that
 * nothing recorded. Until then the key counts as in use (`keyInUse`).
 */
import { ConvexError, v } from "convex/values"
import type { S3Config } from "../shared/config.js"
import {
  abortMultipartUpload,
  completeMultipartUpload as completeInS3,
  createMultipartUpload as createInS3,
  deleteObject,
  headObject,
  listParts,
  type ObjectInfo,
  presignPostUpload,
  presignPut,
  presignUploadPart,
  S3Error,
} from "../shared/s3.js"
import { MAX_EXPIRES_IN, sha256Hex } from "../shared/sigv4.js"
import { internal } from "./_generated/api.js"
import type { Doc } from "./_generated/dataModel.js"
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
} from "./_generated/server.js"
import {
  checkKey,
  checkPutOptions,
  recordObject,
  s3Config,
  UPLOAD_MARKER,
} from "./helpers.js"
import {
  type PutOptionsValue,
  type SyncResult,
  vPart,
  vPutOptions,
  vSyncResult,
  vUploadTicket,
} from "./validators.js"

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
/**
 * A claim older than this was abandoned and can be taken: longer than an
 * action can run (10 minutes), so a slow completion never loses its claim.
 */
const CLAIM_TIMEOUT_MS = 11 * 60 * 1000
/** A failed expiry tries again after this, this many times (an hour). */
const EXPIRE_RETRY_MS = 5 * 60 * 1000
const MAX_EXPIRE_ATTEMPTS = 12

const EXPIRED =
  "This upload has expired or was already completed. Start it again."

function checkSize(name: string, value: number | undefined) {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConvexError(`${name} must be a whole number of bytes`)
  }
}

/** Seconds a URL lives: the default, or the request clamped to S3's 7 days. */
function expiresInOf(requested: number | undefined) {
  if (requested === undefined) return DEFAULT_UPLOAD_EXPIRES_IN
  if (!Number.isFinite(requested)) {
    throw new ConvexError("expiresIn must be a number of seconds")
  }
  return Math.max(1, Math.min(MAX_EXPIRES_IN, Math.floor(requested)))
}

function megabytes(bytes: number) {
  return `${Math.round((bytes / MiB) * 10) / 10} MB`
}

function partSizeFor(size: number, requested: number | undefined) {
  const wanted = Math.max(requested ?? DEFAULT_PART_SIZE, MIN_PART_SIZE)
  const needed = Math.ceil(size / MAX_PARTS / MiB) * MiB
  return Math.min(Math.max(wanted, needed), MAX_PART_SIZE)
}

/** A ticket's marker: not its token (which stays a secret), but a hash. */
async function markerOf(token: string) {
  return (await sha256Hex(`upload:${token}`)).slice(0, 32)
}

/**
 * The options a ticket stores the object with: the marker added and, unless
 * the caller said `ifNoneMatch: false`, no overwriting.
 */
function ticketPut(put: PutOptionsValue | undefined, marker: string) {
  return {
    ...put,
    metadata: { ...put?.metadata, [UPLOAD_MARKER]: marker },
    ifNoneMatch: put?.ifNoneMatch ?? true,
  }
}

/** Whether the object at the key came from this upload. */
function isFromUpload(info: ObjectInfo | null, upload: Doc<"uploads">) {
  return (
    info !== null &&
    upload.marker !== undefined &&
    info.metadata[UPLOAD_MARKER] === upload.marker
  )
}

/**
 * A ticket to upload one object. With `size`, it is signed into the URLs, so
 * S3 refuses a file of any other size; above `multipartThreshold` the
 * ticket is a multipart upload. It refuses to overwrite an existing object
 * unless `put.ifNoneMatch` is false.
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
    const marker = await markerOf(token)
    const put = ticketPut(args.put, marker)
    const threshold = Math.min(
      args.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD,
      MAX_SINGLE_SIZE
    )
    const base = {
      bucket: config.bucket,
      key: args.key,
      token,
      marker,
      size,
      maxSize,
      put,
    }

    if (size !== undefined && size > threshold) {
      if (args.put?.checksumSha256 !== undefined) {
        throw new ConvexError(
          "checksumSha256 covers one PUT: it can't be checked on a multipart upload"
        )
      }
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

    const expiresIn = expiresInOf(args.expiresIn)
    const expiresAt = now + expiresIn * 1000 + SINGLE_GRACE_MS
    const signed = await presignPut(config, args.key, {
      size,
      put,
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
 * size: S3 itself refuses a bigger file. A POST can't refuse to overwrite,
 * so use it with keys made for the upload. Not supported by Cloudflare R2.
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
    if (args.put?.ifNoneMatch === true) {
      throw new ConvexError(
        "A POST upload can't refuse to overwrite: use generateUploadUrl"
      )
    }
    const config = s3Config()
    const now = Date.now()
    const token = crypto.randomUUID()
    const marker = await markerOf(token)
    const put = { ...ticketPut(args.put, marker), ifNoneMatch: false }
    const expiresIn = expiresInOf(args.expiresIn)
    const expiresAt = now + expiresIn * 1000 + SINGLE_GRACE_MS
    const signed = await presignPostUpload(config, args.key, {
      minSize: args.minSize ?? 0,
      maxSize: args.maxSize,
      put,
      expiresIn,
      date: new Date(now),
    })
    await insertUpload(ctx, {
      bucket: config.bucket,
      key: args.key,
      token,
      marker,
      method: "post",
      maxSize: args.maxSize,
      put,
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
  if (upload === null) throw new ConvexError(EXPIRED)
  return upload
}

/** Claims the ticket for this call, or throws if it's gone or taken. */
async function claimUpload(
  ctx: ActionCtx,
  key: string,
  token: string
): Promise<Doc<"uploads">> {
  return await ctx.runMutation(internal.uploads.claim, { key, token })
}

async function releaseClaim(ctx: ActionCtx, upload: Doc<"uploads">) {
  await ctx.runMutation(internal.uploads.release, { id: upload._id })
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
      { id: upload._id, uploadId: created }
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
    const upload = await claimUpload(ctx, key, token)
    try {
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
        // A completion that already happened (a retry after its caller
        // failed): S3 answers NoSuchUpload, or 412 to the condition, and the
        // object is there with our marker. Recording it finishes the job.
        if (!isFromUpload(await headObject(config, key), upload)) {
          if (error instanceof S3Error && error.status < 500) {
            throw new ConvexError(`S3 refused the upload: ${error.code}`)
          }
          throw error
        }
      }
      return await recordUpload(ctx, config, upload)
    } catch (error) {
      await releaseClaim(ctx, upload)
      throw error
    }
  },
})

/**
 * Records an object after an upload: HEADs it and writes its row. With a
 * token, the object must be the one that ticket uploaded, within its
 * limits, or it is deleted; without one (server code), any existing key is
 * synced.
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
    const upload = await claimUpload(ctx, key, token)
    try {
      if (upload.method === "multipart") {
        throw new ConvexError("Complete a multipart upload instead")
      }
      return await recordUpload(ctx, config, upload)
    } catch (error) {
      await releaseClaim(ctx, upload)
      throw error
    }
  },
})

/** Checks what arrived against the claimed ticket, then records it. */
async function recordUpload(
  ctx: ActionCtx,
  config: S3Config,
  upload: Doc<"uploads">
): Promise<SyncResult> {
  const info = await headObject(config, upload.key)
  if (info === null || !isFromUpload(info, upload)) {
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
    await ctx.runMutation(internal.uploads.close, { id: upload._id })
    throw new ConvexError(problem)
  }
  return await recordObject(ctx, config, info, {
    id: upload._id,
    claimedAt: upload.claimedAt ?? 0,
  })
}

/** Gives up on an upload: aborts it in S3 and removes what it uploaded. */
export const abortUpload = action({
  args: { key: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, token }): Promise<null> => {
    const upload: Doc<"uploads"> | null = await ctx.runQuery(
      internal.uploads.find,
      { key, token }
    )
    if (upload === null) return null
    const claimed = await claimUpload(ctx, key, token)
    try {
      await cleanUp(ctx, claimed)
    } catch (error) {
      await releaseClaim(ctx, claimed)
      throw error
    }
    await ctx.runMutation(internal.uploads.close, { id: claimed._id })
    return null
  },
})

/**
 * Removes what an unfinished upload left: aborts its multipart upload, and
 * deletes an object carrying its marker that nothing recorded (a single
 * upload's, or a multipart one S3 completed before recording failed).
 */
async function cleanUp(ctx: ActionCtx, upload: Doc<"uploads">): Promise<void> {
  const config = s3Config()
  if (upload.method === "multipart" && upload.uploadId !== undefined) {
    await abortMultipartUpload(config, upload.key, upload.uploadId)
  }
  await sweep(ctx, config, upload)
}

/** Deletes an object carrying the ticket's marker that nothing recorded. */
async function sweep(ctx: ActionCtx, config: S3Config, upload: Doc<"uploads">) {
  const info = await headObject(config, upload.key)
  if (!isFromUpload(info, upload)) return
  const recorded: boolean = await ctx.runQuery(internal.lib.isRecorded, {
    key: upload.key,
  })
  if (!recorded) await deleteObject(config, upload.key)
}

/**
 * At a ticket's expiry, when its URLs no longer work: cleans up an
 * unfinished upload, sweeps a closed one for what a replayed URL put back,
 * then forgets the ticket. Retries later if S3 fails.
 */
export const expire = internalAction({
  args: { id: v.id("uploads"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { id, attempt = 0 }): Promise<null> => {
    const upload: Doc<"uploads"> | null = await ctx.runMutation(
      internal.uploads.claimById,
      { id }
    )
    if (upload === null) return null
    if (upload.claimedAt === undefined) {
      // Busy with a sync right now: look again once that's had its time.
      await ctx.scheduler.runAfter(CLAIM_TIMEOUT_MS, internal.uploads.expire, {
        id,
        attempt,
      })
      return null
    }
    try {
      if (upload.closedAt === undefined) await cleanUp(ctx, upload)
      else await sweep(ctx, s3Config(), upload)
    } catch (error) {
      if (attempt + 1 >= MAX_EXPIRE_ATTEMPTS) {
        // S3 keeps refusing (credentials, permissions, object lock): give
        // up on this ticket, leaving its key's object as it is.
        console.error(`Gave up cleaning up the upload of ${upload.key}`, error)
        await ctx.runMutation(internal.uploads.remove, { id })
        return null
      }
      console.warn("Cleaning up an expired upload failed; retrying", error)
      await releaseClaim(ctx, upload)
      await ctx.scheduler.runAfter(EXPIRE_RETRY_MS, internal.uploads.expire, {
        id,
        attempt: attempt + 1,
      })
      return null
    }
    await ctx.runMutation(internal.uploads.remove, { id })
    return null
  },
})

async function findUpload(
  ctx: QueryCtx,
  key: string,
  token: string
): Promise<Doc<"uploads"> | null> {
  const upload = await ctx.db
    .query("uploads")
    .withIndex("key_token", (q) => q.eq("key", key).eq("token", token))
    .unique()
  return upload !== null &&
    upload.closedAt === undefined &&
    upload.expiresAt > Date.now()
    ? upload
    : null
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
  marker: v.optional(v.string()),
  claimedAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
  expiresAt: v.number(),
})

export const find = internalQuery({
  args: { key: v.string(), token: v.string() },
  returns: v.union(vUploadDoc, v.null()),
  handler: async (ctx, { key, token }) => await findUpload(ctx, key, token),
})

/** Takes the ticket for one sync, completion or abort. */
export const claim = internalMutation({
  args: { key: v.string(), token: v.string() },
  returns: vUploadDoc,
  handler: async (ctx, { key, token }) => {
    const upload = await findUpload(ctx, key, token)
    if (upload === null) throw new ConvexError(EXPIRED)
    const now = Date.now()
    if (
      upload.claimedAt !== undefined &&
      now - upload.claimedAt < CLAIM_TIMEOUT_MS
    ) {
      throw new ConvexError("This upload is already being completed")
    }
    await ctx.db.patch("uploads", upload._id, { claimedAt: now })
    return { ...upload, claimedAt: now }
  },
})

/**
 * Claims a ticket for cleanup when it expires. Null if it's gone; without
 * `claimedAt` if someone else holds it right now.
 */
export const claimById = internalMutation({
  args: { id: v.id("uploads") },
  returns: v.union(vUploadDoc, v.null()),
  handler: async (ctx, { id }) => {
    const upload = await ctx.db.get("uploads", id)
    if (upload === null) return null
    const now = Date.now()
    if (
      upload.claimedAt !== undefined &&
      now - upload.claimedAt < CLAIM_TIMEOUT_MS
    ) {
      const { claimedAt: _, ...unclaimed } = upload
      return unclaimed
    }
    await ctx.db.patch("uploads", id, { claimedAt: now })
    return { ...upload, claimedAt: now }
  },
})

/** Closes a ticket: done with, but kept until its URLs have expired. */
export const close = internalMutation({
  args: { id: v.id("uploads") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if ((await ctx.db.get("uploads", id)) !== null) {
      await ctx.db.patch("uploads", id, {
        closedAt: Date.now(),
        claimedAt: undefined,
      })
    }
    return null
  },
})

/** Gives a claimed ticket back, so the call can be tried again. */
export const release = internalMutation({
  args: { id: v.id("uploads") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if ((await ctx.db.get("uploads", id)) !== null) {
      await ctx.db.patch("uploads", id, { claimedAt: undefined })
    }
    return null
  },
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
