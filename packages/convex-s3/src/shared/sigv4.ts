/**
 * AWS Signature Version 4 for S3, on Web Crypto only, so it runs in Convex
 * queries, mutations and actions alike. Covers the three ways S3 takes a
 * signature: the Authorization header, presigned URLs (query parameters) and
 * presigned POST policies.
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */

export type Credentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | undefined
}

export const ALGORITHM = "AWS4-HMAC-SHA256"
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"
export const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
/** The longest a presigned URL may live: 7 days. */
export const MAX_EXPIRES_IN = 604_800

const encoder = new TextEncoder()

/** RFC 3986 encoding, as SigV4 wants it: everything but `A-Za-z0-9-._~`. */
export function uriEncode(value: string, encodeSlash = true) {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return encodeSlash ? encoded : encoded.replaceAll("%2F", "/")
}

/** `20130524T000000Z` */
export function amzDate(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
}

function toBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof data === "string") return encoder.encode(data)
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")
}

export function base64(data: string | ArrayBuffer | Uint8Array) {
  const bytes = toBytes(data)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function sha256(data: string | ArrayBuffer | Uint8Array) {
  return await crypto.subtle.digest(
    "SHA-256",
    toBytes(data) as Uint8Array<ArrayBuffer>
  )
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array) {
  return hex(await sha256(data))
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBytes(key) as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data))
}

/** The key for one day, region and service, derived from the secret. */
export async function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
) {
  const date = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp)
  const regionKey = await hmac(date, region)
  const serviceKey = await hmac(regionKey, service)
  return await hmac(serviceKey, "aws4_request")
}

/** `key=value&…`, sorted by key and value, both RFC 3986 encoded. */
export function canonicalQuery(params: Iterable<[string, string]>) {
  return Array.from(params, ([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&")
}

/** Lowercase names, sorted, values trimmed with inner whitespace folded. */
function canonicalHeaders(headers: Record<string, string>) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [
      name.toLowerCase(),
      String(value).trim().replace(/\s+/g, " "),
    ])
    .sort(([a], [b]) => ((a ?? "") < (b ?? "") ? -1 : 1))
  return {
    text: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signed: entries.map(([name]) => name).join(";"),
  }
}

export type SignatureInput = {
  method: string
  /** The URL's path, already encoded (S3 doesn't encode it again). */
  path: string
  query: Iterable<[string, string]>
  /** Every header to sign, `host` included. */
  headers: Record<string, string>
  payloadHash: string
  date: Date
  region: string
  service?: string
  secretAccessKey: string
}

/**
 * The signature for a canonical request. Used to sign and, by the fake S3,
 * to check.
 */
export async function signature(input: SignatureInput) {
  const service = input.service ?? "s3"
  const stamp = amzDate(input.date)
  const day = stamp.slice(0, 8)
  const headers = canonicalHeaders(input.headers)
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path || "/",
    canonicalQuery(input.query),
    headers.text,
    headers.signed,
    input.payloadHash,
  ].join("\n")
  const scope = `${day}/${input.region}/${service}/aws4_request`
  const stringToSign = [
    ALGORITHM,
    stamp,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")
  const key = await signingKey(
    input.secretAccessKey,
    day,
    input.region,
    service
  )
  return {
    signature: hex(await hmac(key, stringToSign)),
    signedHeaders: headers.signed,
    scope,
  }
}

function queryOf(url: URL): [string, string][] {
  return Array.from(url.searchParams.entries())
}

export type PresignInput = {
  method: string
  url: URL
  /** Headers the request must carry. `host` is added. */
  headers?: Record<string, string>
  credentials: Credentials
  region: string
  service?: string
  expiresIn: number
  date: Date
}

/**
 * A presigned URL. Its query carries the signature; the request must send
 * exactly the headers that were signed.
 */
export async function presignUrl(input: PresignInput) {
  const service = input.service ?? "s3"
  const expiresIn = Math.max(
    1,
    Math.min(MAX_EXPIRES_IN, Math.floor(input.expiresIn))
  )
  const headers: Record<string, string> = { host: input.url.host }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value
  }
  const stamp = amzDate(input.date)
  const day = stamp.slice(0, 8)
  const signedHeaders = Object.keys(headers).sort().join(";")
  const query = queryOf(input.url)
  query.push(
    ["X-Amz-Algorithm", ALGORITHM],
    [
      "X-Amz-Credential",
      `${input.credentials.accessKeyId}/${day}/${input.region}/${service}/aws4_request`,
    ],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(expiresIn)],
    ["X-Amz-SignedHeaders", signedHeaders]
  )
  if (input.credentials.sessionToken) {
    query.push(["X-Amz-Security-Token", input.credentials.sessionToken])
  }
  const { signature: sig } = await signature({
    method: input.method,
    path: input.url.pathname,
    query,
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
    date: input.date,
    region: input.region,
    service,
    secretAccessKey: input.credentials.secretAccessKey,
  })
  const base = `${input.url.origin}${input.url.pathname}`
  return `${base}?${canonicalQuery(query)}&X-Amz-Signature=${sig}`
}

export type SignRequestInput = {
  method: string
  url: URL
  headers?: Record<string, string>
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string
  credentials: Credentials
  region: string
  service?: string
  date: Date
}

/** Headers for a request signed in its Authorization header. */
export async function signRequest(input: SignRequestInput) {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value
  }
  headers.host = input.url.host
  headers["x-amz-date"] = amzDate(input.date)
  headers["x-amz-content-sha256"] = input.payloadHash
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken
  }
  const {
    signature: sig,
    signedHeaders,
    scope,
  } = await signature({
    method: input.method,
    path: input.url.pathname,
    query: queryOf(input.url),
    headers,
    payloadHash: input.payloadHash,
    date: input.date,
    region: input.region,
    service: input.service,
    secretAccessKey: input.credentials.secretAccessKey,
  })
  const { host: _host, ...sent } = headers
  return {
    ...sent,
    authorization: `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  }
}

export type PostPolicyInput = {
  /** Conditions besides the credential ones, which are added. */
  conditions: unknown[]
  /** Form fields the browser sends besides the signature ones. */
  fields: Record<string, string>
  credentials: Credentials
  region: string
  expiresIn: number
  date: Date
}

/**
 * The form fields of a presigned POST: its base64 policy and the policy's
 * signature. S3 checks every condition, `content-length-range` included.
 */
export async function presignPost(input: PostPolicyInput) {
  const stamp = amzDate(input.date)
  const day = stamp.slice(0, 8)
  const credential = `${input.credentials.accessKeyId}/${day}/${input.region}/s3/aws4_request`
  const expiresIn = Math.max(
    1,
    Math.min(MAX_EXPIRES_IN, Math.floor(input.expiresIn))
  )
  const signatureFields: Record<string, string> = {
    "x-amz-algorithm": ALGORITHM,
    "x-amz-credential": credential,
    "x-amz-date": stamp,
  }
  if (input.credentials.sessionToken) {
    signatureFields["x-amz-security-token"] = input.credentials.sessionToken
  }
  const policy = base64(
    JSON.stringify({
      expiration: new Date(
        input.date.getTime() + expiresIn * 1000
      ).toISOString(),
      conditions: [
        ...input.conditions,
        ...Object.entries(signatureFields).map(([name, value]) => ({
          [name]: value,
        })),
      ],
    })
  )
  const key = await signingKey(
    input.credentials.secretAccessKey,
    day,
    input.region,
    "s3"
  )
  return {
    ...input.fields,
    ...signatureFields,
    policy,
    "x-amz-signature": hex(await hmac(key, policy)),
  }
}

/** Checks a POST policy's signature (used by the fake S3). */
export async function postPolicySignature(
  policy: string,
  secretAccessKey: string,
  day: string,
  region: string
) {
  const key = await signingKey(secretAccessKey, day, region, "s3")
  return hex(await hmac(key, policy))
}
