// The example: files uploaded from the browser straight to S3 through the
// convex-s3 component. Anyone can upload here (the example has no users);
// a real app checks the caller in each callback.
import { ConvexError, v } from "convex/values"
import { S3 } from "convex-s3"
import { components } from "./_generated/api"
import type { DataModel } from "./_generated/dataModel"
import { mutation, query } from "./_generated/server"

export const s3 = new S3(components.s3)

const MiB = 1024 * 1024
export const MAX_FILE_SIZE = 2048 * MiB
const PREFIX = "uploads/"

export const {
  generateUploadUrl,
  syncMetadata,
  createMultipartUpload,
  signUploadParts,
  listUploadedParts,
  completeMultipartUpload,
  abortUpload,
  onSyncMetadata,
} = s3.clientApi<DataModel>({
  checkUpload: (_ctx, _bucket, request) => {
    if (request.size !== undefined && request.size > MAX_FILE_SIZE) {
      throw new ConvexError("Files can be 2 GB at most")
    }
    // Files over 8 MB go up in 5 MB parts, so the example shows multipart
    // with modest files (the component's default is 64 MB and 16 MB).
    return {
      prefix: PREFIX,
      maxSize: MAX_FILE_SIZE,
      multipartThreshold: 8 * MiB,
      partSize: 5 * MiB,
    }
  },
  onUpload: async (ctx, _bucket, key, metadata) => {
    if (!key.startsWith(PREFIX)) throw new ConvexError("Unexpected key")
    await ctx.db.insert("files", {
      key,
      name: key.split("/").pop() ?? key,
      size: metadata.size,
      contentType: metadata.contentType,
    })
  },
  callbacks: "files",
})

const vFile = v.object({
  _id: v.id("files"),
  _creationTime: v.number(),
  key: v.string(),
  name: v.string(),
  size: v.number(),
  contentType: v.optional(v.string()),
  url: v.string(),
})

/** The newest files, each with a download URL. */
export const list = query({
  args: {},
  returns: v.array(vFile),
  handler: async (ctx) => {
    const files = await ctx.db.query("files").order("desc").take(50)
    return await Promise.all(
      files.map(async (file) => ({
        ...file,
        url: await s3.getUrl(ctx, file.key, {
          expiresIn: 60 * 60,
          responseContentDisposition: `attachment; filename="${file.name}"`,
        }),
      }))
    )
  },
})

export const remove = mutation({
  args: { id: v.id("files") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const file = await ctx.db.get("files", id)
    if (file === null) throw new ConvexError("File not found")
    await ctx.db.delete("files", id)
    await s3.deleteObject(ctx, file.key)
    return null
  },
})
