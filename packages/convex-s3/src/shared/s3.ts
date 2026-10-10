/**
 * S3's object API as plain functions over `fetch`: one function per
 * operation, signed with ./sigv4. Presigning needs no network and runs
 * anywhere; everything else runs in actions.
 */
import { bucketUrl, credentialsOf, objectUrl, type S3Config } from "./config"
import { md5 } from "./md5"
import {
  base64,
  EMPTY_SHA256,
  presignPost,
  presignUrl,
  sha256Hex,
  signRequest,
  uriEncode,
} from "./sigv4"
import { blocks, encodeXml, text, texts } from "./xml"

/** What an object is stored with. */
export type PutOptions = {
  contentType?: string | undefined
  cacheControl?: string | undefined
  contentDisposition?: string | undefined
  contentEncoding?: string | undefined
  contentLanguage?: string | undefined
  /** User metadata, sent as `x-amz-meta-<name>`. ASCII only. */
  metadata?: Record<string, string> | undefined
  tagging?: Record<string, string> | undefined
  storageClass?: string | undefined
  /** `AES256`, `aws:kms` or `aws:kms:dsse`. */
  serverSideEncryption?: string | undefined
  kmsKeyId?: string | undefined
  /** Base64 SHA-256 of the whole body; S3 refuses a body that differs. */
  checksumSha256?: string | undefined
  /** Refuse to overwrite an existing object (`If-None-Match: *`). */
  ifNoneMatch?: boolean | undefined
}

export type ObjectInfo = {
  key: string
  size: number
  contentType?: string | undefined
  etag?: string | undefined
  lastModified: number
  versionId?: string | undefined
  storageClass?: string | undefined
  cacheControl?: string | undefined
  contentDisposition?: string | undefined
  contentEncoding?: string | undefined
  contentLanguage?: string | undefined
  serverSideEncryption?: string | undefined
  kmsKeyId?: string | undefined
  checksumSha256?: string | undefined
  metadata: Record<string, string>
}

export type ListedObject = {
  key: string
  size: number
  etag?: string | undefined
  lastModified: number
  storageClass?: string | undefined
}

export type Part = { partNumber: number; etag: string }

/** An error S3 answered with. */
export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string
  ) {
    super(`S3 ${status} ${code}: ${message}`)
    this.name = "S3Error"
  }
}

async function errorFrom(response: Response) {
  const body = response.status === 204 ? "" : await response.text()
  return new S3Error(
    response.status,
    text(body, "Code") ?? response.statusText ?? "Error",
    text(body, "Message") ?? (body.slice(0, 200) || "no details"),
    response.headers.get("x-amz-request-id") ?? undefined
  )
}

/** S3 can answer 200 with an `<Error>` body (copy, complete multipart). */
function errorInBody(status: number, body: string) {
  if (!/<Error>/.test(body)) return null
  return new S3Error(
    status,
    text(body, "Code") ?? "Error",
    text(body, "Message") ?? "no details"
  )
}

const unquote = (etag: string | null | undefined) =>
  etag ? etag.replace(/^"|"$/g, "") : undefined

function contentMd5(body: string) {
  return base64(md5(new TextEncoder().encode(body)))
}

type SendOptions = {
  headers?: Record<string, string>
  body?: string | Uint8Array
  /** Statuses that aren't errors besides 2xx (404 for "already gone"). */
  allow?: number[]
}

async function send(
  config: S3Config,
  method: string,
  url: URL,
  options: SendOptions = {}
) {
  const payloadHash =
    options.body === undefined ? EMPTY_SHA256 : await sha256Hex(options.body)
  const headers = await signRequest({
    method,
    url,
    headers: options.headers,
    payloadHash,
    credentials: credentialsOf(config),
    region: config.region,
    date: new Date(),
  })
  const response = await fetch(url, {
    method,
    headers,
    body: options.body as BodyInit | undefined,
  })
  if (!response.ok && !options.allow?.includes(response.status)) {
    throw await errorFrom(response)
  }
  return response
}

/** The headers that store `options` with an object. */
export function putHeaders(options: PutOptions = {}) {
  const headers: Record<string, string> = {}
  const set = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== "") headers[name] = value
  }
  set("content-type", options.contentType)
  set("cache-control", options.cacheControl)
  set("content-disposition", options.contentDisposition)
  set("content-encoding", options.contentEncoding)
  set("content-language", options.contentLanguage)
  for (const [name, value] of Object.entries(options.metadata ?? {})) {
    set(`x-amz-meta-${name.toLowerCase()}`, value)
  }
  if (options.tagging && Object.keys(options.tagging).length > 0) {
    set("x-amz-tagging", encodeTags(options.tagging))
  }
  set("x-amz-storage-class", options.storageClass)
  set("x-amz-server-side-encryption", options.serverSideEncryption)
  set("x-amz-server-side-encryption-aws-kms-key-id", options.kmsKeyId)
  set("x-amz-checksum-sha256", options.checksumSha256)
  if (options.ifNoneMatch) headers["if-none-match"] = "*"
  return headers
}

function encodeTags(tags: Record<string, string>) {
  return Object.entries(tags)
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&")
}

/** What a multipart upload starts with: no checksum or condition yet. */
function multipartHeaders(options: PutOptions = {}) {
  const { checksumSha256: _c, ifNoneMatch: _i, ...rest } = options
  return putHeaders(rest)
}

// Presigning

export type PresignedRequest = {
  url: string
  /** Headers the request must send as they are. */
  headers: Record<string, string>
}

/**
 * A presigned PUT. With `size`, `Content-Length` is signed too, so S3
 * refuses a body of any other size. Browsers set that header themselves, so
 * it isn't in `headers`.
 */
export async function presignPut(
  config: S3Config,
  key: string,
  options: { size?: number; put?: PutOptions; expiresIn: number; date: Date }
): Promise<PresignedRequest> {
  const headers = putHeaders(options.put)
  const signed =
    options.size === undefined
      ? headers
      : { ...headers, "content-length": String(options.size) }
  const url = await presignUrl({
    method: "PUT",
    url: objectUrl(config, key),
    headers: signed,
    credentials: credentialsOf(config),
    region: config.region,
    expiresIn: options.expiresIn,
    date: options.date,
  })
  return { url, headers }
}

export type GetUrlOptions = {
  expiresIn: number
  versionId?: string | undefined
  responseContentDisposition?: string | undefined
  responseContentType?: string | undefined
  responseCacheControl?: string | undefined
}

export async function presignGet(
  config: S3Config,
  key: string,
  options: GetUrlOptions & { date: Date }
) {
  return await presignUrl({
    method: "GET",
    url: objectUrl(config, key, {
      versionId: options.versionId,
      "response-content-disposition": options.responseContentDisposition,
      "response-content-type": options.responseContentType,
      "response-cache-control": options.responseCacheControl,
    }),
    credentials: credentialsOf(config),
    region: config.region,
    expiresIn: options.expiresIn,
    date: options.date,
  })
}

/** A presigned PUT for one part, its exact size signed. */
export async function presignUploadPart(
  config: S3Config,
  key: string,
  options: {
    uploadId: string
    partNumber: number
    size: number
    expiresIn: number
    date: Date
  }
) {
  return await presignUrl({
    method: "PUT",
    url: objectUrl(config, key, {
      partNumber: String(options.partNumber),
      uploadId: options.uploadId,
    }),
    headers: { "content-length": String(options.size) },
    credentials: credentialsOf(config),
    region: config.region,
    expiresIn: options.expiresIn,
    date: options.date,
  })
}

/**
 * A presigned POST (an HTML form upload). Its policy pins the key and the
 * content type and caps the size with `content-length-range`, which S3
 * enforces. Cloudflare R2 doesn't support POST uploads.
 */
export async function presignPostUpload(
  config: S3Config,
  key: string,
  options: {
    minSize: number
    maxSize: number
    put?: PutOptions
    expiresIn: number
    date: Date
  }
) {
  const { "if-none-match": _ifNoneMatch, ...headers } = putHeaders(options.put)
  const fields: Record<string, string> = { key }
  for (const [name, value] of Object.entries(headers)) {
    fields[name === "content-type" ? "Content-Type" : name] = value
  }
  const conditions: unknown[] = [
    { bucket: config.bucket },
    ["content-length-range", options.minSize, options.maxSize],
    ...Object.entries(fields).map(([name, value]) => ["eq", `$${name}`, value]),
  ]
  const formFields = await presignPost({
    conditions,
    fields,
    credentials: credentialsOf(config),
    region: config.region,
    expiresIn: options.expiresIn,
    date: options.date,
  })
  return { url: bucketUrl(config).toString(), fields: formFields }
}

// Objects

function infoFrom(key: string, headers: Headers): ObjectInfo {
  const metadata: Record<string, string> = {}
  headers.forEach((value, name) => {
    if (name.startsWith("x-amz-meta-")) {
      metadata[name.slice("x-amz-meta-".length)] = value
    }
  })
  const lastModified = Date.parse(headers.get("last-modified") ?? "")
  return {
    key,
    size: Number(headers.get("content-length") ?? 0),
    contentType: headers.get("content-type") ?? undefined,
    etag: unquote(headers.get("etag")),
    lastModified: Number.isNaN(lastModified) ? Date.now() : lastModified,
    versionId: headers.get("x-amz-version-id") ?? undefined,
    storageClass: headers.get("x-amz-storage-class") ?? undefined,
    cacheControl: headers.get("cache-control") ?? undefined,
    contentDisposition: headers.get("content-disposition") ?? undefined,
    contentEncoding: headers.get("content-encoding") ?? undefined,
    contentLanguage: headers.get("content-language") ?? undefined,
    serverSideEncryption:
      headers.get("x-amz-server-side-encryption") ?? undefined,
    kmsKeyId:
      headers.get("x-amz-server-side-encryption-aws-kms-key-id") ?? undefined,
    checksumSha256: headers.get("x-amz-checksum-sha256") ?? undefined,
    metadata,
  }
}

/** The object's metadata, or null when there's no such object. */
export async function headObject(
  config: S3Config,
  key: string,
  options: { versionId?: string | undefined } = {}
) {
  const response = await send(
    config,
    "HEAD",
    objectUrl(config, key, { versionId: options.versionId }),
    { headers: { "x-amz-checksum-mode": "ENABLED" }, allow: [404] }
  )
  return response.status === 404 ? null : infoFrom(key, response.headers)
}

/** The object's bytes (or a range of them), or null when it doesn't exist. */
export async function getObject(
  config: S3Config,
  key: string,
  options: { range?: string | undefined; versionId?: string | undefined } = {}
) {
  const response = await send(
    config,
    "GET",
    objectUrl(config, key, { versionId: options.versionId }),
    {
      headers: options.range ? { range: options.range } : {},
      allow: [404],
    }
  )
  if (response.status === 404) return null
  const info = infoFrom(key, response.headers)
  const range = response.headers.get("content-range")
  if (range) {
    const total = Number(range.split("/")[1])
    if (!Number.isNaN(total)) info.size = total
  }
  return {
    info,
    contentRange: range ?? undefined,
    data: await response.arrayBuffer(),
  }
}

export async function putObject(
  config: S3Config,
  key: string,
  body: Uint8Array,
  options: PutOptions = {}
) {
  const response = await send(config, "PUT", objectUrl(config, key), {
    headers: putHeaders(options),
    body,
  })
  return {
    etag: unquote(response.headers.get("etag")),
    versionId: response.headers.get("x-amz-version-id") ?? undefined,
  }
}

/** Deletes one object. Deleting one that doesn't exist succeeds. */
export async function deleteObject(
  config: S3Config,
  key: string,
  options: { versionId?: string | undefined } = {}
) {
  await send(
    config,
    "DELETE",
    objectUrl(config, key, { versionId: options.versionId }),
    { allow: [404] }
  )
}

/** Deletes up to 1,000 objects in one request. */
export async function deleteObjects(config: S3Config, keys: string[]) {
  if (keys.length === 0) return { errors: [] }
  if (keys.length > 1000) throw new Error("S3 deletes 1,000 keys at most")
  const body = `<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${keys
    .map((key) => `<Object><Key>${encodeXml(key)}</Key></Object>`)
    .join("")}</Delete>`
  const response = await send(
    config,
    "POST",
    bucketUrl(config, { delete: "" }),
    {
      headers: {
        "content-type": "application/xml",
        "content-md5": contentMd5(body),
      },
      body,
    }
  )
  const xml = await response.text()
  return {
    errors: blocks(xml, "Error").map((error) => ({
      key: text(error, "Key") ?? "",
      code: text(error, "Code") ?? "Error",
      message: text(error, "Message") ?? "",
    })),
  }
}

/** One page of the bucket's objects (`ListObjectsV2`). */
export async function listObjects(
  config: S3Config,
  options: {
    prefix?: string | undefined
    delimiter?: string | undefined
    continuationToken?: string | undefined
    startAfter?: string | undefined
    maxKeys?: number | undefined
  } = {}
) {
  const response = await send(
    config,
    "GET",
    bucketUrl(config, {
      "list-type": "2",
      prefix: options.prefix || undefined,
      delimiter: options.delimiter || undefined,
      "continuation-token": options.continuationToken,
      "start-after": options.startAfter,
      "max-keys":
        options.maxKeys === undefined ? undefined : String(options.maxKeys),
    })
  )
  const xml = await response.text()
  const objects: ListedObject[] = blocks(xml, "Contents").map((entry) => {
    const lastModified = Date.parse(text(entry, "LastModified") ?? "")
    return {
      key: text(entry, "Key") ?? "",
      size: Number(text(entry, "Size") ?? 0),
      etag: unquote(text(entry, "ETag")),
      lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
      storageClass: text(entry, "StorageClass"),
    }
  })
  return {
    objects,
    prefixes: blocks(xml, "CommonPrefixes").flatMap((entry) =>
      texts(entry, "Prefix")
    ),
    isTruncated: text(xml, "IsTruncated") === "true",
    nextContinuationToken: text(xml, "NextContinuationToken"),
  }
}

const GiB = 1024 * 1024 * 1024
/** S3 copies up to 5 GB in one request; above that, part by part. */
export const MAX_COPY_SIZE = 5 * GiB
const COPY_PART_SIZE = GiB
const COPY_CONCURRENCY = 4

function copySource(
  config: S3Config,
  key: string,
  versionId: string | undefined
) {
  return `/${config.bucket}/${uriEncode(key, false)}${
    versionId ? `?versionId=${uriEncode(versionId)}` : ""
  }`
}

/**
 * The headers and metadata an object has, as options to store a copy
 * (without an upload ticket's marker). Tags aren't part of a HEAD.
 */
function putOptionsOf(info: ObjectInfo): PutOptions {
  const { "upload-ticket": _marker, ...metadata } = info.metadata
  return {
    contentType: info.contentType,
    cacheControl: info.cacheControl,
    contentDisposition: info.contentDisposition,
    contentEncoding: info.contentEncoding,
    contentLanguage: info.contentLanguage,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    storageClass: info.storageClass,
    serverSideEncryption: info.serverSideEncryption,
    kmsKeyId: info.kmsKeyId,
  }
}

export type CopyOptions = {
  /** Store the copy with these instead of the source's headers. */
  put?: PutOptions | undefined
  sourceVersionId?: string | undefined
  /**
   * What a HEAD of the source saw. Needed above `multipartThreshold`, where
   * the copy goes part by part (`UploadPartCopy`) and S3 copies no headers.
   */
  source?: ObjectInfo | undefined
  multipartThreshold?: number | undefined
  partSize?: number | undefined
}

/**
 * Copies an object inside the bucket. With `put`, the copy gets those
 * headers and metadata instead of the source's. Above 5 GB (with `source`
 * given), it copies part by part.
 */
export async function copyObject(
  config: S3Config,
  sourceKey: string,
  destinationKey: string,
  options: CopyOptions = {}
) {
  const threshold = Math.min(
    options.multipartThreshold ?? MAX_COPY_SIZE,
    MAX_COPY_SIZE
  )
  if (options.source !== undefined && options.source.size > threshold) {
    return await copyInParts(config, sourceKey, destinationKey, {
      ...options,
      source: options.source,
    })
  }
  const source = copySource(config, sourceKey, options.sourceVersionId)
  const headers: Record<string, string> = {
    ...(options.put ? putHeaders(options.put) : {}),
    "x-amz-copy-source": source,
    "x-amz-metadata-directive": options.put ? "REPLACE" : "COPY",
  }
  if (options.put?.tagging) headers["x-amz-tagging-directive"] = "REPLACE"
  delete headers["x-amz-checksum-sha256"]
  const response = await send(
    config,
    "PUT",
    objectUrl(config, destinationKey),
    {
      headers,
    }
  )
  const xml = await response.text()
  const error = errorInBody(response.status, xml)
  if (error) throw error
  return {
    etag: unquote(text(xml, "ETag")),
    versionId: response.headers.get("x-amz-version-id") ?? undefined,
  }
}

/** A multipart upload whose parts are server-side copies of byte ranges. */
async function copyInParts(
  config: S3Config,
  sourceKey: string,
  destinationKey: string,
  options: CopyOptions & { source: ObjectInfo }
) {
  const size = options.source.size
  const partSize = Math.min(
    Math.max(options.partSize ?? COPY_PART_SIZE, Math.ceil(size / 10_000)),
    MAX_COPY_SIZE
  )
  const partCount = Math.ceil(size / partSize)
  const put = options.put ?? putOptionsOf(options.source)
  const uploadId = await createMultipartUpload(config, destinationKey, put)
  try {
    const parts: Part[] = []
    const queue = Array.from({ length: partCount }, (_, i) => i + 1)
    const worker = async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        const start = (n - 1) * partSize
        const end = Math.min(start + partSize, size) - 1
        const response = await send(
          config,
          "PUT",
          objectUrl(config, destinationKey, {
            partNumber: String(n),
            uploadId,
          }),
          {
            headers: {
              "x-amz-copy-source": copySource(
                config,
                sourceKey,
                options.sourceVersionId
              ),
              "x-amz-copy-source-range": `bytes=${start}-${end}`,
            },
          }
        )
        const xml = await response.text()
        const error = errorInBody(response.status, xml)
        if (error) throw error
        parts.push({ partNumber: n, etag: text(xml, "ETag") ?? "" })
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(COPY_CONCURRENCY, partCount) }, worker)
    )
    return await completeMultipartUpload(
      config,
      destinationKey,
      uploadId,
      parts
    )
  } catch (error) {
    await abortMultipartUpload(config, destinationKey, uploadId).catch(
      () => undefined
    )
    throw error
  }
}

export async function putObjectTagging(
  config: S3Config,
  key: string,
  tags: Record<string, string>
) {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${Object.entries(
    tags
  )
    .map(
      ([k, v]) =>
        `<Tag><Key>${encodeXml(k)}</Key><Value>${encodeXml(v)}</Value></Tag>`
    )
    .join("")}</TagSet></Tagging>`
  await send(config, "PUT", objectUrl(config, key, { tagging: "" }), {
    headers: {
      "content-type": "application/xml",
      "content-md5": contentMd5(body),
    },
    body,
  })
}

// Multipart uploads

export async function createMultipartUpload(
  config: S3Config,
  key: string,
  options: PutOptions = {}
) {
  const response = await send(
    config,
    "POST",
    objectUrl(config, key, { uploads: "" }),
    { headers: multipartHeaders(options) }
  )
  const uploadId = text(await response.text(), "UploadId")
  if (!uploadId)
    throw new S3Error(response.status, "NoUploadId", "S3 returned no UploadId")
  return uploadId
}

/** The parts uploaded so far, in order. */
export async function listParts(
  config: S3Config,
  key: string,
  uploadId: string
) {
  const parts: (Part & { size: number })[] = []
  let marker: string | undefined
  for (;;) {
    const response = await send(
      config,
      "GET",
      objectUrl(config, key, {
        uploadId,
        "max-parts": "1000",
        "part-number-marker": marker,
      })
    )
    const xml = await response.text()
    for (const part of blocks(xml, "Part")) {
      parts.push({
        partNumber: Number(text(part, "PartNumber")),
        etag: text(part, "ETag") ?? "",
        size: Number(text(part, "Size") ?? 0),
      })
    }
    if (text(xml, "IsTruncated") !== "true") break
    marker = text(xml, "NextPartNumberMarker")
    if (!marker) break
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber)
}

export async function completeMultipartUpload(
  config: S3Config,
  key: string,
  uploadId: string,
  parts: Part[],
  options: { ifNoneMatch?: boolean | undefined } = {}
) {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber)
  const body = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${sorted
    .map((part) => {
      const etag = part.etag.startsWith('"') ? part.etag : `"${part.etag}"`
      return `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${encodeXml(etag)}</ETag></Part>`
    })
    .join("")}</CompleteMultipartUpload>`
  const response = await send(
    config,
    "POST",
    objectUrl(config, key, { uploadId }),
    {
      headers: {
        "content-type": "application/xml",
        ...(options.ifNoneMatch ? { "if-none-match": "*" } : {}),
      },
      body,
    }
  )
  const xml = await response.text()
  const error = errorInBody(response.status, xml)
  if (error) throw error
  return {
    etag: unquote(text(xml, "ETag")),
    versionId: response.headers.get("x-amz-version-id") ?? undefined,
  }
}

/** Aborts a multipart upload. Aborting one that's gone succeeds. */
export async function abortMultipartUpload(
  config: S3Config,
  key: string,
  uploadId: string
) {
  await send(config, "DELETE", objectUrl(config, key, { uploadId }), {
    allow: [404],
  })
}
