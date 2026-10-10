import { uriEncode } from "./sigv4.js"

export type S3Config = {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | undefined
  endpoint?: string | undefined
  forcePathStyle: boolean
  publicUrl?: string | undefined
}

export type S3Env = {
  S3_BUCKET: string
  S3_REGION: string
  S3_ACCESS_KEY_ID: string
  S3_SECRET_ACCESS_KEY: string
  S3_SESSION_TOKEN?: string | undefined
  S3_ENDPOINT?: string | undefined
  S3_FORCE_PATH_STYLE?: string | undefined
  S3_PUBLIC_URL?: string | undefined
}

/**
 * Values are trimmed: a secret pasted with a trailing newline would
 * otherwise sign every request wrong (S3 answers `SignatureDoesNotMatch`).
 */
export function configFromEnv(env: S3Env): S3Config {
  const endpoint = env.S3_ENDPOINT?.trim().replace(/\/+$/, "") || undefined
  const pathStyle = env.S3_FORCE_PATH_STYLE?.trim().toLowerCase()
  return {
    bucket: env.S3_BUCKET.trim(),
    region: env.S3_REGION.trim(),
    accessKeyId: env.S3_ACCESS_KEY_ID.trim(),
    secretAccessKey: env.S3_SECRET_ACCESS_KEY.trim(),
    sessionToken: env.S3_SESSION_TOKEN?.trim() || undefined,
    endpoint,
    forcePathStyle:
      pathStyle === undefined || pathStyle === ""
        ? endpoint !== undefined
        : pathStyle === "true" || pathStyle === "1",
    publicUrl: env.S3_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined,
  }
}

export function credentialsOf(config: S3Config) {
  return {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
  }
}

/**
 * The bucket's base URL, without a trailing slash: virtual-hosted on AWS
 * (`https://<bucket>.s3.<region>.amazonaws.com`), path-style with an
 * endpoint (`<endpoint>/<bucket>`).
 */
export function bucketBase(config: S3Config) {
  const endpoint =
    config.endpoint ?? `https://s3.${config.region}.amazonaws.com`
  if (config.forcePathStyle) return `${endpoint}/${uriEncode(config.bucket)}`
  const url = new URL(endpoint)
  return `${url.protocol}//${config.bucket}.${url.host}`
}

function withQuery(base: string, query?: Record<string, string | undefined>) {
  const entries = Object.entries(query ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )
  if (entries.length === 0) return new URL(base)
  const search = entries
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&")
  return new URL(`${base}?${search}`)
}

/** The bucket itself, for listing and batch deletes. */
export function bucketUrl(
  config: S3Config,
  query?: Record<string, string | undefined>
) {
  const base = bucketBase(config)
  return withQuery(config.forcePathStyle ? base : `${base}/`, query)
}

/** One object. */
export function objectUrl(
  config: S3Config,
  key: string,
  query?: Record<string, string | undefined>
) {
  return withQuery(`${bucketBase(config)}/${uriEncode(key, false)}`, query)
}

/** The object's public URL under `S3_PUBLIC_URL`, or null without one. */
export function publicUrl(config: S3Config, key: string) {
  return config.publicUrl === undefined
    ? null
    : `${config.publicUrl}/${uriEncode(key, false)}`
}
