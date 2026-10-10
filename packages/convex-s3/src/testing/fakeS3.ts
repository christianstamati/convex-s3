/**
 * An S3 in memory, behind a `fetch` you stub in tests
 * (`vi.stubGlobal("fetch", s3.fetch)`). It checks what real S3 checks:
 * SigV4 signatures (header, presigned and POST policy), expiry, signed
 * sizes, `If-None-Match`, checksums and `Content-MD5`. Requests to other
 * hosts go to `passthrough` (the real fetch by default).
 */
import {
  bucketBase,
  configFromEnv,
  type S3Config,
  type S3Env,
} from "../shared/config"
import { md5 } from "../shared/md5"
import {
  base64,
  postPolicySignature,
  sha256,
  sha256Hex,
  signature,
  UNSIGNED_PAYLOAD,
} from "../shared/sigv4"
import { blocks, encodeXml, text } from "../shared/xml"

export type FakeObject = {
  data: Uint8Array
  contentType: string
  etag: string
  lastModified: number
  headers: Record<string, string>
  tags: Record<string, string>
}

type FakeUpload = {
  key: string
  headers: Record<string, string>
  parts: Map<number, { data: Uint8Array; etag: string }>
}

export type FakeS3Options = {
  bucket?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  /** An S3-compatible endpoint; unset, URLs look like AWS's. */
  endpoint?: string
  forcePathStyle?: boolean
  publicUrl?: string
  /** S3 refuses parts under 5 MiB but the last; tests can lower that. */
  minPartSize?: number
}

const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const xmlResponse = (
  status: number,
  body: string,
  headers: Record<string, string> = {}
) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { "content-type": "application/xml", ...headers },
  })

const errorResponse = (status: number, code: string, message: string) =>
  xmlResponse(
    status,
    `<Error><Code>${code}</Code><Message>${encodeXml(message)}</Message></Error>`
  )

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export class FakeS3 {
  readonly objects = new Map<string, FakeObject>()
  readonly uploads = new Map<string, FakeUpload>()
  /** Every request it answered, for assertions. */
  readonly requests: { method: string; url: string; status: number }[] = []
  readonly config: S3Config
  private readonly minPartSize: number
  private uploadCounter = 0
  passthrough: typeof fetch = globalThis.fetch

  constructor(options: FakeS3Options = {}) {
    this.config = configFromEnv(this.envFrom(options))
    this.minPartSize = options.minPartSize ?? 5 * 1024 * 1024
  }

  private envFrom(options: FakeS3Options): S3Env {
    return {
      S3_BUCKET: options.bucket ?? "test-bucket",
      S3_REGION: options.region ?? "eu-west-1",
      S3_ACCESS_KEY_ID: options.accessKeyId ?? "AKIAFAKE",
      S3_SECRET_ACCESS_KEY: options.secretAccessKey ?? "fake-secret",
      S3_ENDPOINT: options.endpoint,
      S3_FORCE_PATH_STYLE:
        options.forcePathStyle === undefined
          ? undefined
          : String(options.forcePathStyle),
      S3_PUBLIC_URL: options.publicUrl,
    }
  }

  /** The component's env vars for this fake: stub them with `vi.stubEnv`. */
  env(): Record<string, string> {
    const c = this.config
    const env: Record<string, string> = {
      S3_BUCKET: c.bucket,
      S3_REGION: c.region,
      S3_ACCESS_KEY_ID: c.accessKeyId,
      S3_SECRET_ACCESS_KEY: c.secretAccessKey,
      S3_FORCE_PATH_STYLE: String(c.forcePathStyle),
    }
    if (c.endpoint) env.S3_ENDPOINT = c.endpoint
    if (c.publicUrl) env.S3_PUBLIC_URL = c.publicUrl
    return env
  }

  /** Stores an object directly, as if it had been uploaded. */
  put(
    key: string,
    data: string | Uint8Array,
    contentType = "application/octet-stream"
  ) {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data
    this.objects.set(key, {
      data: bytes,
      contentType,
      etag: hexOf(md5(bytes)),
      lastModified: Date.now(),
      headers: {},
      tags: {},
    })
  }

  fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const base = new URL(bucketBase(this.config))
    if (
      url.host !== base.host ||
      !url.pathname.startsWith(base.pathname.replace(/\/$/, ""))
    ) {
      return await this.passthrough(input, init)
    }
    let response: Response
    try {
      response = await this.handle(request, url, base)
    } catch (error) {
      if (!(error instanceof Refusal)) throw error
      response = errorResponse(error.status, error.code, error.message)
    }
    this.requests.push({
      method: request.method,
      url: request.url,
      status: response.status,
    })
    return response
  }

  private keyOf(url: URL, base: URL) {
    const prefix = base.pathname.replace(/\/$/, "")
    const rest = url.pathname.slice(prefix.length).replace(/^\//, "")
    return decodeURIComponent(rest)
  }

  private async handle(request: Request, url: URL, base: URL) {
    const key = this.keyOf(url, base)
    const method = request.method
    const q = url.searchParams
    const isForm = (request.headers.get("content-type") ?? "").startsWith(
      "multipart/form-data"
    )

    if (method === "POST" && key === "" && isForm)
      return await this.postUpload(request)

    const body =
      method === "GET" || method === "HEAD"
        ? new Uint8Array()
        : new Uint8Array(await request.arrayBuffer())
    await this.authenticate(request, url, body)

    if (key === "") {
      if (method === "GET" && q.get("list-type") === "2") return this.list(q)
      if (method === "POST" && q.has("delete"))
        return await this.deleteMany(request, body)
      throw new Refusal(400, "NotImplemented", `${method} on the bucket`)
    }

    if (q.has("uploadId")) {
      const uploadId = q.get("uploadId") ?? ""
      const upload = this.uploads.get(uploadId)
      if (!upload || upload.key !== key)
        throw new Refusal(404, "NoSuchUpload", uploadId)
      if (method === "PUT" && request.headers.has("x-amz-copy-source")) {
        return this.copyPart(request, upload, Number(q.get("partNumber")))
      }
      if (method === "PUT")
        return await this.putPart(upload, Number(q.get("partNumber")), body)
      if (method === "GET") return this.listParts(upload)
      if (method === "DELETE") {
        this.uploads.delete(uploadId)
        return new Response(null, { status: 204 })
      }
      if (method === "POST")
        return this.complete(request, upload, uploadId, body)
    }

    if (method === "POST" && q.has("uploads")) {
      const uploadId = `upload-${++this.uploadCounter}`
      this.uploads.set(uploadId, {
        key,
        headers: storedHeaders(request.headers),
        parts: new Map(),
      })
      return xmlResponse(
        200,
        `<InitiateMultipartUploadResult><Key>${encodeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
      )
    }
    if (method === "PUT" && q.has("tagging")) {
      const object = this.require(key)
      this.checkMd5(request, body)
      const xml = new TextDecoder().decode(body)
      object.tags = Object.fromEntries(
        blocks(xml, "Tag").map((tag) => [
          text(tag, "Key") ?? "",
          text(tag, "Value") ?? "",
        ])
      )
      return new Response(null, { status: 200 })
    }
    if (method === "PUT" && request.headers.has("x-amz-copy-source"))
      return this.copy(request, key)
    if (method === "PUT") return await this.putObject(request, key, body)
    if (method === "HEAD" || method === "GET")
      return this.get(request, key, method)
    if (method === "DELETE") {
      this.objects.delete(key)
      return new Response(null, { status: 204 })
    }
    throw new Refusal(400, "NotImplemented", `${method} ${url.search}`)
  }

  private require(key: string) {
    const object = this.objects.get(key)
    if (!object) throw new Refusal(404, "NoSuchKey", key)
    return object
  }

  private async authenticate(request: Request, url: URL, body: Uint8Array) {
    const q = url.searchParams
    const auth = request.headers.get("authorization")
    let credential: string
    let signedHeaders: string[]
    let given: string
    let date: string
    let payloadHash: string
    const query: [string, string][] = []

    if (q.has("X-Amz-Signature")) {
      credential = q.get("X-Amz-Credential") ?? ""
      signedHeaders = (q.get("X-Amz-SignedHeaders") ?? "").split(";")
      given = q.get("X-Amz-Signature") ?? ""
      date = q.get("X-Amz-Date") ?? ""
      payloadHash = UNSIGNED_PAYLOAD
      const expires = Number(q.get("X-Amz-Expires"))
      if (parseAmzDate(date) + expires * 1000 < Date.now()) {
        throw new Refusal(403, "AccessDenied", "Request has expired")
      }
      for (const [k, v] of q) if (k !== "X-Amz-Signature") query.push([k, v])
    } else if (auth) {
      const match =
        /Credential=([^,]+), SignedHeaders=([^,]+), Signature=(\w+)/.exec(auth)
      if (!match)
        throw new Refusal(403, "AccessDenied", "Malformed Authorization")
      credential = match[1] ?? ""
      signedHeaders = (match[2] ?? "").split(";")
      given = match[3] ?? ""
      date = request.headers.get("x-amz-date") ?? ""
      payloadHash = request.headers.get("x-amz-content-sha256") ?? ""
      if (
        payloadHash !== UNSIGNED_PAYLOAD &&
        payloadHash !== (await sha256Hex(body))
      ) {
        throw new Refusal(
          400,
          "XAmzContentSHA256Mismatch",
          "The body doesn't match its hash"
        )
      }
      for (const [k, v] of q) query.push([k, v])
    } else {
      throw new Refusal(403, "AccessDenied", "Anonymous requests are refused")
    }

    const [accessKeyId, , region] = credential.split("/")
    if (accessKeyId !== this.config.accessKeyId) {
      throw new Refusal(403, "InvalidAccessKeyId", accessKeyId ?? "")
    }
    const headers: Record<string, string> = {}
    for (const name of signedHeaders) {
      const value =
        name === "host"
          ? url.host
          : name === "content-length"
            ? String(body.length)
            : request.headers.get(name)
      if (value === null)
        throw new Refusal(403, "AccessDenied", `Missing signed header ${name}`)
      headers[name] = value
    }
    const expected = await signature({
      method: request.method,
      path: url.pathname,
      query,
      headers,
      payloadHash,
      date: new Date(parseAmzDate(date)),
      region: region ?? "",
      secretAccessKey: this.config.secretAccessKey,
    })
    if (expected.signature !== given) {
      throw new Refusal(
        403,
        "SignatureDoesNotMatch",
        "The signature doesn't match"
      )
    }
  }

  private checkMd5(request: Request, body: Uint8Array) {
    const given = request.headers.get("content-md5")
    if (!given) throw new Refusal(400, "InvalidRequest", "Missing Content-MD5")
    if (given !== base64(md5(body)))
      throw new Refusal(400, "BadDigest", "Content-MD5 mismatch")
  }

  private async putObject(request: Request, key: string, body: Uint8Array) {
    if (request.headers.get("if-none-match") === "*" && this.objects.has(key)) {
      throw new Refusal(412, "PreconditionFailed", "The object exists")
    }
    const checksum = request.headers.get("x-amz-checksum-sha256")
    if (checksum && checksum !== base64(await sha256(body))) {
      throw new Refusal(400, "BadDigest", "SHA-256 checksum mismatch")
    }
    const object = this.store(key, body, storedHeaders(request.headers))
    return new Response(null, {
      status: 200,
      headers: { etag: `"${object.etag}"` },
    })
  }

  private store(
    key: string,
    data: Uint8Array,
    headers: Record<string, string>,
    etag?: string
  ) {
    const tagging = headers["x-amz-tagging"]
    const object: FakeObject = {
      data,
      contentType: headers["content-type"] ?? "application/octet-stream",
      etag: etag ?? hexOf(md5(data)),
      lastModified: Date.now(),
      headers,
      tags: tagging ? Object.fromEntries(new URLSearchParams(tagging)) : {},
    }
    this.objects.set(key, object)
    return object
  }

  private get(request: Request, key: string, method: string) {
    const object = this.objects.get(key)
    if (!object) {
      return method === "HEAD"
        ? new Response(null, { status: 404 })
        : errorResponse(404, "NoSuchKey", key)
    }
    const headers: Record<string, string> = {
      ...object.headers,
      "content-type": object.contentType,
      etag: `"${object.etag}"`,
      "last-modified": new Date(object.lastModified).toUTCString(),
    }
    delete headers["x-amz-tagging"]
    let data = object.data
    let status = 200
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "")
    if (range && method === "GET") {
      const start = Number(range[1])
      const end = range[2]
        ? Math.min(Number(range[2]), data.length - 1)
        : data.length - 1
      data = data.slice(start, end + 1)
      headers["content-range"] = `bytes ${start}-${end}/${object.data.length}`
      status = 206
    }
    headers["content-length"] = String(data.length)
    return new Response(method === "HEAD" ? null : (data as BodyInit), {
      status,
      headers,
    })
  }

  private copy(request: Request, key: string) {
    const source = decodeURIComponent(
      (request.headers.get("x-amz-copy-source") ?? "").split("?")[0] ?? ""
    )
    const sourceKey = source.replace(`/${this.config.bucket}/`, "")
    const original = this.require(sourceKey)
    const replace =
      request.headers.get("x-amz-metadata-directive") === "REPLACE"
    const object = this.store(
      key,
      original.data.slice(),
      replace ? storedHeaders(request.headers) : { ...original.headers }
    )
    if (!replace) object.contentType = original.contentType
    return xmlResponse(
      200,
      `<CopyObjectResult><ETag>&quot;${object.etag}&quot;</ETag><LastModified>${new Date(object.lastModified).toISOString()}</LastModified></CopyObjectResult>`
    )
  }

  private list(q: URLSearchParams) {
    const prefix = q.get("prefix") ?? ""
    const delimiter = q.get("delimiter")
    const maxKeys = Number(q.get("max-keys") ?? 1000)
    const after = q.get("continuation-token") ?? q.get("start-after") ?? ""
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && k > after)
      .sort()
    const contents: string[] = []
    const prefixes = new Set<string>()
    let last = ""
    let truncated = false
    for (const key of keys) {
      if (contents.length + prefixes.size >= maxKeys) {
        truncated = true
        break
      }
      last = key
      const rest = key.slice(prefix.length)
      const cut = delimiter ? rest.indexOf(delimiter) : -1
      if (delimiter && cut !== -1) {
        prefixes.add(prefix + rest.slice(0, cut + delimiter.length))
        continue
      }
      const object = this.objects.get(key) as FakeObject
      contents.push(
        `<Contents><Key>${encodeXml(key)}</Key><LastModified>${new Date(object.lastModified).toISOString()}</LastModified><ETag>&quot;${object.etag}&quot;</ETag><Size>${object.data.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`
      )
    }
    return xmlResponse(
      200,
      `<ListBucketResult><Name>${this.config.bucket}</Name><Prefix>${encodeXml(prefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>${contents.join("")}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${encodeXml(p)}</Prefix></CommonPrefixes>`).join("")}${truncated ? `<NextContinuationToken>${encodeXml(last)}</NextContinuationToken>` : ""}</ListBucketResult>`
    )
  }

  private async deleteMany(request: Request, body: Uint8Array) {
    this.checkMd5(request, body)
    const xml = new TextDecoder().decode(body)
    for (const object of blocks(xml, "Object"))
      this.objects.delete(text(object, "Key") ?? "")
    return xmlResponse(200, "<DeleteResult></DeleteResult>")
  }

  private async putPart(
    upload: FakeUpload,
    partNumber: number,
    body: Uint8Array
  ) {
    const etag = hexOf(md5(body))
    upload.parts.set(partNumber, { data: body, etag })
    return new Response(null, { status: 200, headers: { etag: `"${etag}"` } })
  }

  /** UploadPartCopy: a byte range of another object becomes a part. */
  private copyPart(request: Request, upload: FakeUpload, partNumber: number) {
    const source = decodeURIComponent(
      (request.headers.get("x-amz-copy-source") ?? "").split("?")[0] ?? ""
    ).replace(`/${this.config.bucket}/`, "")
    const original = this.require(source)
    const range = /^bytes=(\d+)-(\d+)$/.exec(
      request.headers.get("x-amz-copy-source-range") ?? ""
    )
    const data = range
      ? original.data.slice(Number(range[1]), Number(range[2]) + 1)
      : original.data.slice()
    const etag = hexOf(md5(data))
    upload.parts.set(partNumber, { data, etag })
    return xmlResponse(
      200,
      `<CopyPartResult><ETag>&quot;${etag}&quot;</ETag></CopyPartResult>`
    )
  }

  private listParts(upload: FakeUpload) {
    const parts = [...upload.parts.entries()].sort(([a], [b]) => a - b)
    return xmlResponse(
      200,
      `<ListPartsResult><IsTruncated>false</IsTruncated>${parts.map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>&quot;${p.etag}&quot;</ETag><Size>${p.data.length}</Size></Part>`).join("")}</ListPartsResult>`
    )
  }

  private complete(
    request: Request,
    upload: FakeUpload,
    uploadId: string,
    body: Uint8Array
  ) {
    if (
      request.headers.get("if-none-match") === "*" &&
      this.objects.has(upload.key)
    ) {
      throw new Refusal(412, "PreconditionFailed", "The object exists")
    }
    const xml = new TextDecoder().decode(body)
    const listed = blocks(xml, "Part").map((part) => ({
      partNumber: Number(text(part, "PartNumber")),
      etag: (text(part, "ETag") ?? "").replace(/"/g, ""),
    }))
    const chunks: Uint8Array[] = []
    listed.forEach((part, index) => {
      const stored = upload.parts.get(part.partNumber)
      if (!stored || stored.etag !== part.etag)
        throw new Refusal(400, "InvalidPart", `Part ${part.partNumber}`)
      if (index < listed.length - 1 && stored.data.length < this.minPartSize) {
        throw new Refusal(
          400,
          "EntityTooSmall",
          `Part ${part.partNumber} is too small`
        )
      }
      chunks.push(stored.data)
    })
    const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.length
    }
    const digests = new Uint8Array(listed.length * 16)
    listed.forEach((part, i) => {
      const bytes =
        part.etag.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? []
      digests.set(bytes, i * 16)
    })
    const object = this.store(
      upload.key,
      data,
      upload.headers,
      `${hexOf(md5(digests))}-${listed.length}`
    )
    this.uploads.delete(uploadId)
    return xmlResponse(
      200,
      `<CompleteMultipartUploadResult><Key>${encodeXml(upload.key)}</Key><ETag>&quot;${object.etag}&quot;</ETag></CompleteMultipartUploadResult>`
    )
  }

  private async postUpload(request: Request) {
    const form = await request.formData()
    const field = (name: string) => {
      for (const [k, v] of form)
        if (k.toLowerCase() === name.toLowerCase() && typeof v === "string")
          return v
      return undefined
    }
    const policy = field("policy") ?? ""
    const credential = field("x-amz-credential") ?? ""
    const [accessKeyId, day, region] = credential.split("/")
    if (accessKeyId !== this.config.accessKeyId)
      throw new Refusal(403, "InvalidAccessKeyId", "")
    const expected = await postPolicySignature(
      policy,
      this.config.secretAccessKey,
      day ?? "",
      region ?? ""
    )
    if (expected !== field("x-amz-signature"))
      throw new Refusal(403, "SignatureDoesNotMatch", "Policy signature")
    const decoded = JSON.parse(atob(policy)) as {
      expiration: string
      conditions: unknown[]
    }
    if (Date.parse(decoded.expiration) < Date.now())
      throw new Refusal(403, "AccessDenied", "Policy expired")
    const file = form.get("file")
    if (!(file instanceof Blob))
      throw new Refusal(400, "InvalidArgument", "No file")
    for (const condition of decoded.conditions) {
      if (Array.isArray(condition) && condition[0] === "content-length-range") {
        if (file.size < Number(condition[1]))
          throw new Refusal(400, "EntityTooSmall", "Below the policy's minimum")
        if (file.size > Number(condition[2]))
          throw new Refusal(400, "EntityTooLarge", "Above the policy's maximum")
      } else if (Array.isArray(condition) && condition[0] === "eq") {
        if (field(String(condition[1]).slice(1)) !== condition[2])
          throw new Refusal(403, "AccessDenied", `Condition ${condition[1]}`)
      }
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of form) {
      const name = k.toLowerCase()
      if (
        typeof v === "string" &&
        (name === "content-type" ||
          name === "cache-control" ||
          name === "content-disposition" ||
          name.startsWith("x-amz-meta-"))
      )
        headers[name] = v
    }
    const key = field("key") ?? ""
    const object = this.store(
      key,
      new Uint8Array(await file.arrayBuffer()),
      headers
    )
    return new Response(null, {
      status: 204,
      headers: { etag: `"${object.etag}"` },
    })
  }
}

function parseAmzDate(value: string) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)
  if (!m) throw new Refusal(403, "AccessDenied", "Bad X-Amz-Date")
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6])
  )
}

/** The headers S3 stores with an object and returns on HEAD. */
function storedHeaders(headers: Headers) {
  const stored: Record<string, string> = {}
  headers.forEach((value, name) => {
    if (
      name === "content-type" ||
      name === "cache-control" ||
      name === "content-disposition" ||
      name === "content-encoding" ||
      name === "content-language" ||
      name === "x-amz-tagging" ||
      name === "x-amz-checksum-sha256" ||
      name === "x-amz-storage-class" ||
      name.startsWith("x-amz-meta-")
    ) {
      stored[name] = value
    }
  })
  return stored
}
