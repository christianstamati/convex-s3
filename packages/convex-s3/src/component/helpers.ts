import { ConvexError } from "convex/values"
import { configFromEnv, publicUrl, type S3Config } from "../shared/config"
import { keyProblem } from "../shared/keys"
import { presignGet } from "../shared/s3"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { type ActionCtx, env } from "./_generated/server"
import type {
  ObjectInfoValue,
  ObjectMetadata,
  PutOptionsValue,
  SyncResult,
} from "./validators"

/**
 * The user metadata name of an upload ticket's marker
 * (`x-amz-meta-upload-ticket`). Reserved, and not recorded with the object.
 */
export const UPLOAD_MARKER = "upload-ticket"

/** Download URLs last 15 minutes unless asked otherwise. */
export const DEFAULT_GET_EXPIRES_IN = 15 * 60

export function s3Config(): S3Config {
  return configFromEnv(env)
}

export function checkKey(key: string) {
  const problem = keyProblem(key)
  if (problem !== null) throw new ConvexError(problem)
}

const PRINTABLE_ASCII = /^[ -~]*$/

/**
 * Header values must be printable ASCII: a browser or fetch sends others in
 * another encoding than the one signed, and S3 refuses the signature.
 */
export function checkPutOptions(put: PutOptionsValue | undefined) {
  const headers = {
    contentType: put?.contentType,
    cacheControl: put?.cacheControl,
    contentDisposition: put?.contentDisposition,
    contentEncoding: put?.contentEncoding,
    contentLanguage: put?.contentLanguage,
    storageClass: put?.storageClass,
    serverSideEncryption: put?.serverSideEncryption,
    kmsKeyId: put?.kmsKeyId,
    checksumSha256: put?.checksumSha256,
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !PRINTABLE_ASCII.test(value)) {
      throw new ConvexError(`${name} must be printable ASCII`)
    }
  }
  for (const [name, value] of Object.entries(put?.metadata ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      throw new ConvexError(`Metadata names use letters, digits and -: ${name}`)
    }
    if (name.toLowerCase() === UPLOAD_MARKER) {
      throw new ConvexError(`The metadata name ${name} is reserved`)
    }
    if (!PRINTABLE_ASCII.test(value)) {
      throw new ConvexError(`Metadata values must be printable ASCII: ${name}`)
    }
  }
}

export async function toMetadata(
  config: S3Config,
  row: Doc<"objects">,
  options: { expiresIn?: number | undefined } = {}
): Promise<ObjectMetadata> {
  const { _id, _creationTime, ...stored } = row
  return {
    ...stored,
    url: await presignGet(config, row.key, {
      expiresIn: options.expiresIn ?? DEFAULT_GET_EXPIRES_IN,
      date: new Date(),
    }),
    publicUrl: publicUrl(config, row.key),
  }
}

/** The object's user metadata without the component's own marker. */
function userMetadata(metadata: Record<string, string>) {
  const { [UPLOAD_MARKER]: _marker, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

/**
 * Writes what a HEAD saw as the object's row. With `upload`, the same
 * mutation ends that ticket, so a recorded object never has a live ticket.
 */
export async function recordObject(
  ctx: ActionCtx,
  config: S3Config,
  info: ObjectInfoValue,
  upload?: Id<"uploads">
): Promise<SyncResult> {
  const stored = {
    bucket: config.bucket,
    key: info.key,
    size: info.size,
    contentType: info.contentType,
    etag: info.etag,
    lastModified: info.lastModified,
    versionId: info.versionId,
    checksumSha256: info.checksumSha256,
    metadata: userMetadata(info.metadata),
  }
  const isNew: boolean = await ctx.runMutation(internal.lib.upsertMetadata, {
    object: stored,
    finishUpload: upload,
  })
  const metadata = await toMetadata(config, {
    ...stored,
    _id: "" as Id<"objects">,
    _creationTime: 0,
  })
  return { metadata, isNew }
}
