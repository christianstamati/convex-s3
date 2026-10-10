// The Drive example: folders are S3 prefixes under `drive/`. Opening a
// folder lists one level of it (`listFolder`), a new folder is a zero-byte
// marker object, uploads land in the open folder under their own names,
// renaming or moving a folder moves every key under its prefix, and
// deleting one deletes the prefix. Anyone can use it (the example has no
// users); a real app checks the caller in each function.
import { ConvexError, v } from "convex/values"
import { internal } from "./_generated/api"
import type { DataModel } from "./_generated/dataModel"
import {
  type ActionCtx,
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server"
import { attachment } from "./lib/attachment"
import {
  cleanName,
  DRIVE_ROOT,
  folderPrefix,
  isDriveKey,
  nameOf,
  nameProblem,
  normalizePath,
  numbered,
  parentOf,
  pathOf,
} from "./lib/drivePaths"
import { limit } from "./lib/rateLimits"
import { s3 } from "./lib/s3"

const MiB = 1024 * 1024
const MAX_FILE_SIZE = 2048 * MiB
/** A move record older than this is stale: it no longer allows resuming. */
const MOVE_RESUME_MS = 60 * 60 * 1000
/** Folders moved or renamed here hold this many objects at most. */
const MAX_MOVE = 500
/** Objects moved at once. */
const MOVE_CONCURRENCY = 8
const URL_LIFETIME = 5 * 60

/** Any context that can read: queries, mutations (checkUpload) and actions. */
/** Types opened in the browser rather than downloaded. */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
])

type ReadCtx = QueryCtx | MutationCtx | ActionCtx

function requirePath(path: string) {
  const normalized = normalizePath(path)
  if (normalized === null) throw new ConvexError("That folder path isn't valid")
  return normalized
}

function requireName(name: string) {
  const trimmed = name.trim()
  const problem = nameProblem(trimmed)
  if (problem !== null) throw new ConvexError(problem)
  return trimmed
}

function requireFileKey(key: string) {
  if (!isDriveKey(key) || key.endsWith("/")) {
    throw new ConvexError("That isn't a file in the Drive")
  }
}

/**
 * Whether anything is at a key, or under a folder prefix. A key counts while
 * an upload ticket holds it (its URL could still put a file there), so new
 * uploads are numbered rather than refused by S3.
 */
async function exists(ctx: ReadCtx, keyOrPrefix: string) {
  if (await s3.isKeyInUse(ctx, keyOrPrefix)) return true
  if (!keyOrPrefix.endsWith("/")) return false
  const inside = await s3.listFolder(ctx, keyOrPrefix, { limit: 1 })
  return inside.folders.length > 0 || inside.objects.length > 0
}

/** The first free `name`, `name (2)`, … in a folder. */
async function freeKey(
  ctx: ReadCtx,
  folder: string,
  name: string,
  isFolder: boolean
) {
  for (let n = 1; n <= 100; n++) {
    const key = `${folder}${numbered(name, n, isFolder)}${isFolder ? "/" : ""}`
    if (!(await exists(ctx, key))) return key
  }
  throw new ConvexError(`Too many items named "${name}" here`)
}

export const {
  generateUploadUrl,
  syncMetadata,
  createMultipartUpload,
  signUploadParts,
  listUploadedParts,
  completeMultipartUpload,
  abortUpload,
} = s3.clientApi<DataModel>({
  // The browser sends the open folder as `prefix`; the file keeps its name,
  // numbered when the folder already has one like it.
  checkUpload: async (ctx, _bucket, request) => {
    await limit(ctx, "uploads")
    if (request.size !== undefined && request.size > MAX_FILE_SIZE) {
      throw new ConvexError("Files can be 2 GB at most")
    }
    const folder = folderPrefix(requirePath(request.prefix ?? ""))
    const name = cleanName(request.fileName ?? "Untitled")
    return {
      key: await freeKey(ctx, folder, name, false),
      maxSize: MAX_FILE_SIZE,
      multipartThreshold: 8 * MiB,
      partSize: 5 * MiB,
      // Two uploads of one name at once: the second fails, not overwrites.
      put: { ifNoneMatch: true },
    }
  },
})

const vFolder = v.object({ name: v.string(), path: v.string() })
const vFile = v.object({
  key: v.string(),
  name: v.string(),
  size: v.number(),
  contentType: v.optional(v.string()),
  lastModified: v.number(),
})

/**
 * One folder: its subfolders and files, live. No URLs: a subscribed query
 * keeps its first result until the data changes, so URLs signed in it would
 * expire on screen. `fileUrl` signs one when a file is opened.
 */
export const list = query({
  args: { path: v.string() },
  returns: v.object({
    path: v.string(),
    folders: v.array(vFolder),
    files: v.array(vFile),
    isTruncated: v.boolean(),
  }),
  handler: async (ctx, { path }) => {
    const prefix = folderPrefix(requirePath(path))
    const listing = await s3.listFolder(ctx, prefix, {
      expiresIn: URL_LIFETIME,
    })
    return {
      path: pathOf(prefix),
      folders: listing.folders.map((folder) => ({
        name: nameOf(folder),
        path: pathOf(folder),
      })),
      files: listing.objects.map((object) => ({
        key: object.key,
        name: nameOf(object.key),
        size: object.size,
        contentType: object.contentType,
        lastModified: object.lastModified,
      })),
      isTruncated: listing.isTruncated,
    }
  },
})

/** A fresh URL to open or download a file, valid for 5 minutes. */
export const fileUrl = mutation({
  args: { key: v.string(), download: v.boolean() },
  returns: v.string(),
  handler: async (ctx, { key, download }) => {
    requireFileKey(key)
    const file = await s3.getMetadata(ctx, key)
    if (file === null) throw new ConvexError("That file is gone")
    // Anyone can upload here, so only types a browser shows safely open in
    // place; anything else (HTML, SVG, scripts) downloads.
    const type = file.contentType?.split(";")[0]?.trim().toLowerCase() ?? ""
    const inline = !download && INLINE_TYPES.has(type)
    return await s3.getUrl(ctx, key, {
      expiresIn: URL_LIFETIME,
      responseContentDisposition: inline ? "inline" : attachment(nameOf(key)),
      responseContentType: inline ? type : undefined,
    })
  },
})

/** Creates a folder (a marker object). Returns its path. */
export const createFolder = action({
  args: { path: v.string(), name: v.string() },
  returns: v.string(),
  handler: async (ctx, { path, name }): Promise<string> => {
    await limit(ctx, "writes")
    const parent = folderPrefix(requirePath(path))
    const key = await freeKey(ctx, parent, requireName(name), true)
    await s3.store(ctx, new Uint8Array(0), {
      key,
      contentType: "application/x-directory",
    })
    return pathOf(key)
  },
})

/** Moves a file to a new key, refusing to overwrite. */
async function moveFile(ctx: ActionCtx, key: string, destination: string) {
  if (destination === key) return
  if (await exists(ctx, destination)) {
    throw new ConvexError(`"${nameOf(destination)}" is already there`)
  }
  await s3.moveObject(ctx, key, destination)
}

/** Every object under a prefix, from S3's own listing. */
async function listAll(ctx: ActionCtx, prefix: string) {
  const objects: { key: string; size: number; etag?: string | undefined }[] = []
  let cursor: string | null = null
  do {
    const page = await s3.listObjects(ctx, { prefix, cursor })
    objects.push(...page.objects)
    if (objects.length > MAX_MOVE) {
      throw new ConvexError(
        `This example moves folders of up to ${MAX_MOVE} items`
      )
    }
    cursor = page.isDone ? null : page.cursor
  } while (cursor !== null)
  return objects
}

/**
 * Moves every object under one prefix to another: S3 has no folders, so a
 * folder moves key by key (copy, then delete). The move is recorded while
 * it runs, so one that stopped halfway can be run again within the hour:
 * the keys it moved are then expected at the destination, and a key there
 * of the same size as its source counts as copied (ETags differ between a
 * multipart upload and its copy). Without a recent record, any key at the
 * destination is a collision, refused before anything moves.
 */
async function moveFolder(ctx: ActionCtx, from: string, to: string) {
  if (to === from) return
  if (to.startsWith(from)) {
    throw new ConvexError("A folder can't go inside itself")
  }
  const resuming: boolean = await ctx.runQuery(internal.drive.moveRecorded, {
    from,
    to,
  })
  const sources = await listAll(ctx, from)
  const there = new Map((await listAll(ctx, to)).map((o) => [o.key, o]))
  const pending: { from: string; to: string }[] = []
  const alreadyMoved: string[] = []
  for (const source of sources) {
    const destination = to + source.key.slice(from.length)
    const copy = there.get(destination)
    there.delete(destination)
    if (copy === undefined) {
      pending.push({ from: source.key, to: destination })
    } else if (resuming && copy.size === source.size) {
      alreadyMoved.push(source.key)
    } else {
      throw new ConvexError(`"${nameOf(to)}" is already there`)
    }
  }
  // Keys at the destination no source accounts for: moved by this move
  // before it stopped, or another folder's.
  if (there.size > 0 && !resuming) {
    throw new ConvexError(`"${nameOf(to)}" is already there`)
  }
  await ctx.runMutation(internal.drive.recordMove, { from, to })
  for (let i = 0; i < pending.length; i += MOVE_CONCURRENCY) {
    await Promise.all(
      pending
        .slice(i, i + MOVE_CONCURRENCY)
        .map((move) => s3.moveObject(ctx, move.from, move.to))
    )
  }
  if (alreadyMoved.length > 0) await s3.deleteObjects(ctx, alreadyMoved)
  await ctx.runMutation(internal.drive.forgetMove, { from, to })
}

/** Whether this move was started within the hour (and can resume). */
export const moveRecorded = internalQuery({
  args: { from: v.string(), to: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { from, to }) => {
    const move = await ctx.db
      .query("driveMoves")
      .withIndex("by_from_to", (q) => q.eq("from", from).eq("to", to))
      .first()
    return move !== null && move.startedAt > Date.now() - MOVE_RESUME_MS
  },
})

export const recordMove = internalMutation({
  args: { from: v.string(), to: v.string() },
  returns: v.null(),
  handler: async (ctx, { from, to }) => {
    const existing = await ctx.db
      .query("driveMoves")
      .withIndex("by_from_to", (q) => q.eq("from", from).eq("to", to))
      .first()
    if (existing === null) {
      await ctx.db.insert("driveMoves", { from, to, startedAt: Date.now() })
    }
    return null
  },
})

export const forgetMove = internalMutation({
  args: { from: v.string(), to: v.string() },
  returns: v.null(),
  handler: async (ctx, { from, to }) => {
    const moves = await ctx.db
      .query("driveMoves")
      .withIndex("by_from_to", (q) => q.eq("from", from).eq("to", to))
      .collect()
    for (const move of moves) await ctx.db.delete("driveMoves", move._id)
    return null
  },
})

export const renameFile = action({
  args: { key: v.string(), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, name }) => {
    await limit(ctx, "writes")
    requireFileKey(key)
    await moveFile(ctx, key, parentOf(key) + requireName(name))
    return null
  },
})

export const moveFileTo = action({
  args: { key: v.string(), path: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, path }) => {
    await limit(ctx, "writes")
    requireFileKey(key)
    await moveFile(ctx, key, folderPrefix(requirePath(path)) + nameOf(key))
    return null
  },
})

/** Renames a folder. Returns its new path. */
export const renameFolder = action({
  args: { path: v.string(), name: v.string() },
  returns: v.string(),
  handler: async (ctx, { path, name }) => {
    await limit(ctx, "writes")
    const from = folderPrefix(requirePath(path))
    if (from === DRIVE_ROOT) throw new ConvexError("The Drive can't be renamed")
    const to = `${parentOf(from)}${requireName(name)}/`
    await moveFolder(ctx, from, to)
    return pathOf(to)
  },
})

/** Moves a folder into another. Returns its new path. */
export const moveFolderTo = action({
  args: { path: v.string(), to: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    await limit(ctx, "writes")
    const from = folderPrefix(requirePath(args.path))
    if (from === DRIVE_ROOT) throw new ConvexError("The Drive can't be moved")
    const to = `${folderPrefix(requirePath(args.to))}${nameOf(from)}/`
    await moveFolder(ctx, from, to)
    return pathOf(to)
  },
})

export const removeFile = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, { key }) => {
    await limit(ctx, "writes")
    requireFileKey(key)
    await s3.deleteObject(ctx, key)
    return null
  },
})

/** Deletes a folder and everything in it: one prefix delete. */
export const removeFolder = mutation({
  args: { path: v.string() },
  returns: v.null(),
  handler: async (ctx, { path }) => {
    await limit(ctx, "writes")
    const prefix = folderPrefix(requirePath(path))
    if (prefix === DRIVE_ROOT)
      throw new ConvexError("The Drive can't be deleted")
    await s3.deletePrefix(ctx, prefix)
    return null
  },
})
