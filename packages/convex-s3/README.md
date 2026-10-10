# convex-s3

A [Convex](https://convex.dev) component for S3-compatible object storage: AWS
S3, Cloudflare R2, MinIO, Tigris, Backblaze B2. It keeps the
[R2 component](https://www.convex.dev/components/cloudflare-r2)'s names and
adds what that one lacks: multipart uploads with resume, prefixes, size limits
S3 enforces, batch and prefix deletes, copies, and per-object S3 options.

Files go from the browser straight to the bucket; Convex only signs requests
and records what arrived. Credentials stay inside the component: every
signature is made there, so they never travel as function arguments.

## Install

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server"
import { v } from "convex/values"
import s3 from "convex-s3/convex.config"

const app = defineApp({
  env: {
    S3_BUCKET: v.string(),
    S3_REGION: v.string(),
    S3_ACCESS_KEY_ID: v.string(),
    S3_SECRET_ACCESS_KEY: v.string(),
    S3_ENDPOINT: v.optional(v.string()),
    S3_PUBLIC_URL: v.optional(v.string()),
  },
})
app.use(s3, {
  env: {
    S3_BUCKET: app.env.S3_BUCKET,
    S3_REGION: app.env.S3_REGION,
    S3_ACCESS_KEY_ID: app.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: app.env.S3_SECRET_ACCESS_KEY,
    S3_ENDPOINT: app.env.S3_ENDPOINT,
    S3_PUBLIC_URL: app.env.S3_PUBLIC_URL,
  },
})
export default app
```

| Env var | |
| --- | --- |
| `S3_BUCKET`, `S3_REGION` | The bucket and its region (`auto` for R2) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | An IAM user limited to the bucket (below) |
| `S3_SESSION_TOKEN` | Temporary credentials only |
| `S3_ENDPOINT` | S3-compatible providers, such as `https://<account>.r2.cloudflarestorage.com` or `http://localhost:9000`. Unset: AWS |
| `S3_FORCE_PATH_STYLE` | `true` for `<endpoint>/<bucket>/<key>` URLs. Default: `true` with an endpoint, `false` on AWS |
| `S3_PUBLIC_URL` | Base of public URLs, such as a CloudFront distribution |

One installation serves one bucket. For a second bucket, install it again
under another name: `app.use(s3, { name: "archive", env: { ... } })`.

### The bucket

- **CORS**: browsers upload directly, so allow your origins to `PUT`, `POST`,
  `GET` and `HEAD` with any header, and expose `ETag` (multipart uploads read
  each part's ETag):

  ```json
  [{ "AllowedOrigins": ["http://localhost:3000"], "AllowedMethods": ["PUT", "POST", "GET", "HEAD"],
     "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
  ```

- **Lifecycle**: abort incomplete multipart uploads after a day. The component
  aborts the ones it knows about, but the rule catches anything else.
- **IAM**: `s3:PutObject`, `GetObject`, `DeleteObject`, `AbortMultipartUpload`,
  `ListMultipartUploadParts`, `PutObjectTagging` on `arn:aws:s3:::<bucket>/*`,
  and `s3:ListBucket`, `ListBucketMultipartUploads` on the bucket. Nothing else.
- Keep Block Public Access on. Serve public files through CloudFront with
  origin access control, and set `S3_PUBLIC_URL` to it.

## Uploads from the browser

Export the browser API from one module, with a check for each function. A
function without its check refuses to run (pass `() => {}` to allow
everything):

```ts
// convex/files.ts
import { S3 } from "convex-s3"
import { components } from "./_generated/api"
import type { DataModel } from "./_generated/dataModel"

export const s3 = new S3(components.s3)

export const {
  generateUploadUrl, syncMetadata,
  createMultipartUpload, signUploadParts, listUploadedParts,
  completeMultipartUpload, abortUpload, onSyncMetadata,
} = s3.clientApi<DataModel>({
  checkUpload: async (ctx, bucket, request) => {
    const userId = await requireUser(ctx)       // throw to refuse
    return { prefix: `users/${userId}/`, maxSize: 100 * 1024 * 1024 }
  },
  onUpload: async (ctx, bucket, key, metadata) => {
    await ctx.db.insert("files", { key, size: metadata.size })
  },
  callbacks: "files", // this module's path, so onUpload runs in a mutation
})
```

```tsx
import { useUploadFile } from "convex-s3/react"

const uploadFile = useUploadFile(api.files)
const key = await uploadFile(file, {
  onProgress: ({ fraction }) => setProgress(fraction),
  signal: controller.signal, // aborting removes what arrived
})
```

What happens:

1. `generateUploadUrl` runs `checkUpload`, builds the key
   (`<prefix><uuid>/<clean file name>`; the browser never picks it) and
   returns a ticket. The file's size is signed into the URL, so S3 refuses a
   file of any other size.
2. Up to 64 MB (`multipartThreshold`), the browser PUTs the file. Above it,
   the upload is multipart: 16 MB parts (`partSize`), each part URL signed
   with its exact size, four parts at a time. An interrupted upload resumes
   after a reload (the hook keeps its ticket in `localStorage` for 24 hours).
3. `syncMetadata` or `completeMultipartUpload` HEADs the object, checks it
   against the ticket (size, `maxSize`), records it, then runs `onUpload` in
   a mutation. If `onUpload` throws, the object is deleted.

A ticket's token proves the follow-up calls come from whoever got it. Tickets
that are never completed are cleaned up when they expire: an hour after a
single upload's URL, 24 hours for multipart.

`checkUpload` can also return `key`, `contentType`, `put` (headers and
metadata to store) and the multipart settings. The other checks are
`checkReadKey` (`getMetadata`), `checkReadBucket` (`listMetadata`) and
`checkDelete` (`deleteObject`, then `onDelete`).

## Server API

Every method takes the function's `ctx` first, because signing happens in
the component.

| Method | Context | |
| --- | --- | --- |
| `generateUploadUrl(ctx, options)` | mutation | A ticket: `key` or `prefix` + `fileName`, `size`, `maxSize`, `contentType`, `cacheControl`, `contentDisposition`, `metadata`, `tagging`, `storageClass`, `serverSideEncryption`, `kmsKeyId`, `checksumSha256`, `ifNoneMatch`, `expiresIn` |
| `generateUploadPost(ctx, options)` | mutation | A form POST whose policy caps the size (`maxSize`, `minSize`). Not on R2 |
| `store(ctx, blob, options)` | action | Uploads bytes from an action. Returns the key |
| `syncMetadata(ctx, key)` | action | HEADs a key and records it |
| `getUrl(ctx, key, options)` | any | A presigned GET (15 minutes by default, 7 days at most), with `versionId` and `responseContentDisposition`, `responseContentType`, `responseCacheControl` |
| `getPublicUrl(ctx, key)` | any | The URL under `S3_PUBLIC_URL`, or null |
| `getMetadata(ctx, key)` | any | The recorded object with a download URL, or null |
| `listMetadata(ctx, limit, cursor, prefix)`, `pageMetadata(ctx, paginationOpts, prefix)` | any | Recorded objects by key, under a prefix |
| `deleteObject(ctx, key)`, `deleteObjects(ctx, keys)` | mutation | The rows at once, the objects in the background with retries |
| `deletePrefix(ctx, prefix)` | mutation | Everything under a non-empty prefix, in scheduled steps |
| `headObject(ctx, key)`, `getObject(ctx, key, { range })` | action | What S3 has now; bytes of a small object or a range |
| `listObjects(ctx, { prefix, delimiter, cursor, limit })` | action | The bucket's own listing (`ListObjectsV2`), with folders |
| `copyObject(ctx, from, to, put?)`, `moveObject(...)` | action | Server-side copy (up to 5 GB); `put` replaces headers and metadata |
| `putObjectTagging(ctx, key, tags)` | action | Replaces the object's tags |

A presigned URL from a query is signed when the query runs, and Convex may
serve that result from its cache for a while, so give URLs returned by
queries a comfortable `expiresIn`, or use public URLs.

## Testing

`convex-s3/testing` has `FakeS3`, an S3 in memory that checks what S3 checks
(signatures, expiry, signed sizes, POST policies, `If-None-Match`,
checksums), and `register` for convex-test:

```ts
import { FakeS3, register } from "convex-s3/testing"

const s3 = new FakeS3()
for (const [name, value] of Object.entries(s3.env())) vi.stubEnv(name, value)
vi.stubGlobal("fetch", s3.fetch)
const t = convexTest(schema, modules)
register(t)
```

## Differences from the R2 component

- Methods take `ctx` first (`getUrl(ctx, key)`), since credentials never leave
  the component.
- `clientApi()` needs a check for each function it exposes, and `callbacks` is
  the module's path (`"files"`): `internal.files` from inside that module is a
  circular type.
- Tickets replace bare upload URLs: `{ method, key, token, url, headers }`,
  or multipart / POST. `useUploadFile` handles all three.
- Signing is SigV4 on Web Crypto, with no AWS SDK in the bundle.
