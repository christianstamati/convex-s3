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

/** Download URLs last 15 minutes unless asked otherwise. */
export const DEFAULT_GET_EXPIRES_IN = 15 * 60

export function s3Config(): S3Config {
  return configFromEnv(env)
}

export function checkKey(key: string) {
  const problem = keyProblem(key)
  if (problem !== null) throw new ConvexError(problem)
}

/** ASCII header values only: S3 can't store anything else in a header. */
export function checkPutOptions(put: PutOptionsValue | undefined) {
  for (const [name, value] of Object.entries(put?.metadata ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      throw new ConvexError(`Metadata names use letters, digits and -: ${name}`)
    }
    if (/[^ -~]/.test(value)) {
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

/** Writes what a HEAD saw as the object's row. */
export async function recordObject(
  ctx: ActionCtx,
  config: S3Config,
  info: ObjectInfoValue
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
    metadata: Object.keys(info.metadata).length > 0 ? info.metadata : undefined,
  }
  const isNew: boolean = await ctx.runMutation(
    internal.lib.upsertMetadata,
    stored
  )
  const metadata = await toMetadata(config, {
    ...stored,
    _id: "" as Id<"objects">,
    _creationTime: 0,
  })
  return { metadata, isNew }
}
