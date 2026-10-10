import { type Infer, v } from "convex/values"

export const vPutOptions = v.object({
  contentType: v.optional(v.string()),
  cacheControl: v.optional(v.string()),
  contentDisposition: v.optional(v.string()),
  contentEncoding: v.optional(v.string()),
  contentLanguage: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.string())),
  tagging: v.optional(v.record(v.string(), v.string())),
  storageClass: v.optional(v.string()),
  serverSideEncryption: v.optional(v.string()),
  kmsKeyId: v.optional(v.string()),
  checksumSha256: v.optional(v.string()),
  ifNoneMatch: v.optional(v.boolean()),
})
export type PutOptionsValue = Infer<typeof vPutOptions>

/** A stored object as the `objects` table keeps it. */
export const vStoredObject = {
  bucket: v.string(),
  key: v.string(),
  size: v.number(),
  contentType: v.optional(v.string()),
  etag: v.optional(v.string()),
  lastModified: v.number(),
  versionId: v.optional(v.string()),
  checksumSha256: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.string())),
}

/** An object's metadata, with a presigned download URL. */
export const vObjectMetadata = v.object({
  ...vStoredObject,
  /** A presigned GET, valid for `expiresIn` (15 minutes by default). */
  url: v.string(),
  /** The URL under `S3_PUBLIC_URL`, or null without one. */
  publicUrl: v.union(v.string(), v.null()),
})
export type ObjectMetadata = Infer<typeof vObjectMetadata>

/** What S3 reports about an object (HEAD). */
export const vObjectInfo = v.object({
  key: v.string(),
  size: v.number(),
  contentType: v.optional(v.string()),
  etag: v.optional(v.string()),
  lastModified: v.number(),
  versionId: v.optional(v.string()),
  storageClass: v.optional(v.string()),
  cacheControl: v.optional(v.string()),
  contentDisposition: v.optional(v.string()),
  contentEncoding: v.optional(v.string()),
  contentLanguage: v.optional(v.string()),
  serverSideEncryption: v.optional(v.string()),
  kmsKeyId: v.optional(v.string()),
  checksumSha256: v.optional(v.string()),
  metadata: v.record(v.string(), v.string()),
})
export type ObjectInfoValue = Infer<typeof vObjectInfo>

/**
 * How the browser uploads a file: one PUT, multipart, or a form POST. The
 * token proves the follow-up calls come from whoever got the ticket.
 */
export const vUploadTicket = v.union(
  v.object({
    method: v.literal("single"),
    key: v.string(),
    token: v.string(),
    url: v.string(),
    headers: v.record(v.string(), v.string()),
    expiresAt: v.number(),
  }),
  v.object({
    method: v.literal("multipart"),
    key: v.string(),
    token: v.string(),
    partSize: v.number(),
    partCount: v.number(),
    expiresAt: v.number(),
  }),
  v.object({
    method: v.literal("post"),
    key: v.string(),
    token: v.string(),
    url: v.string(),
    fields: v.record(v.string(), v.string()),
    expiresAt: v.number(),
  })
)
export type UploadTicket = Infer<typeof vUploadTicket>

export const vPart = v.object({ partNumber: v.number(), etag: v.string() })

export const vSyncResult = v.object({
  metadata: vObjectMetadata,
  isNew: v.boolean(),
})
export type SyncResult = Infer<typeof vSyncResult>

export const vGetUrlOptions = {
  expiresIn: v.optional(v.number()),
  versionId: v.optional(v.string()),
  responseContentDisposition: v.optional(v.string()),
  responseContentType: v.optional(v.string()),
  responseCacheControl: v.optional(v.string()),
}
