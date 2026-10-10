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
| `S3_ENDPOINT` | S3-compatible providers, such as `https://<account>.r2.cloudflarestorage.com` or `http://localhost:9000`. Unset: AWS. The provider must support conditional writes (`If-None-Match: *` on PUT and on completing a multipart upload): AWS S3, R2 and MinIO do |
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
   (`<prefix><uuid>/<clean file name>`, or `checkUpload`'s `key`) and returns
   a ticket. The browser must declare the size, which is signed into the
   URL with the content type (`application/octet-stream` when none is
   given), so S3 refuses a file of any other size or type. The ticket
   refuses to overwrite an existing object (`If-None-Match: *`) unless
   `put.ifNoneMatch` is `false`, and signs a marker into the object's
   metadata (`x-amz-meta-upload-ticket`, reserved, not recorded).
2. Up to 64 MB (`multipartThreshold`), the browser PUTs the file. Above it,
   the upload is multipart: 16 MB parts (`partSize`), each part URL signed
   with its exact size, four parts at a time. An interrupted upload resumes
   after a reload (the hook keeps its ticket in `localStorage` for 24 hours).
3. `syncMetadata` or `completeMultipartUpload` claims the ticket (so it
   runs once), HEADs the object, checks it carries the ticket's marker and
   fits the ticket (size, `maxSize`), records it while ending the ticket,
   then runs `onUpload` in a mutation. If `onUpload` throws, the object is
   deleted.

A ticket's token proves the follow-up calls come from whoever got it.
`abortUpload` aborts the multipart upload and deletes the object only if it
carries the ticket's marker: what another upload put at the same key is
never touched. Since tickets refuse to overwrite, a PUT URL can't be
replayed while its object exists.

A presigned URL can't be revoked, so a ticket outlives its use. Recorded,
refused or aborted, it is closed but kept until its URLs have expired (an
hour after a single upload's URL, 24 hours for multipart). Then it cleans up
what an unfinished upload left and deletes anything a replayed URL put back
that nothing recorded. Until then its key counts as in use:
`isKeyInUse(ctx, key)` tells you whether a key is free to hand out.

**Recording happens before `onUpload`.** If `onUpload` throws, the object is
deleted. If the app's action dies between the two, the component has a row
the app never heard of: reconcile with `listMetadata` if that matters.

**The browser's prefix is only a request.** `request.prefix` counts only if
`checkUpload` returns it as `prefix` (after checking it).

**Prefixes are S3's, raw.** `listMetadata`, `listFolder` and `deletePrefix`
match keys that start with the string as given: `users/1` also matches
`users/12/…`. End folder prefixes with `/`.

**Serve uploads carefully.** Whoever uploads picks the content type
(unless `checkUpload` sets one), and can add `Content-Disposition`,
`Cache-Control` or `Content-Encoding` the app didn't set (only what the app
sets is signed). Opening an untrusted `text/html` or
`image/svg+xml` inline runs it on the bucket's origin (or your CDN's): pass
`responseContentDisposition: "attachment; ..."` to `getUrl`, or allow only
safe types inline, as the Drive example does.

**Rate-limit tickets.** Anyone who can call `generateUploadUrl` can make
the bucket hold up to `maxSize` per ticket until it expires, so
`checkUpload` should authenticate the caller and cap how many tickets they
get, for example with
[`@convex-dev/rate-limiter`](https://www.convex.dev/components/rate-limiter)
keyed by user (the examples cap globally, having no users).

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
| `generateUploadPost(ctx, options)` | mutation | A form POST whose policy caps the size (`maxSize`, `minSize`). Not on R2. A POST can't refuse to overwrite, so its form can be replayed while the policy is valid: use fresh keys and the default 5-minute lifetime |
| `store(ctx, blob, options)` | action | Uploads bytes from an action, in parts above `multipartThreshold` (64 MB). Returns the key |
| `syncMetadata(ctx, key)` | action | HEADs a key and records it |
| `getUrl(ctx, key, options)` | any | A presigned GET (15 minutes by default, 7 days at most), with `versionId` and `responseContentDisposition`, `responseContentType`, `responseCacheControl` |
| `getPublicUrl(ctx, key)` | any | The URL under `S3_PUBLIC_URL`, or null |
| `isKeyInUse(ctx, key)` | any | Whether a key is recorded or held by a live upload ticket: pick free keys with it |
| `getMetadata(ctx, key)` | any | The recorded object with a download URL, or null |
| `listMetadata(ctx, limit, cursor, prefix)`, `pageMetadata(ctx, paginationOpts, prefix)` | any | Recorded objects by key, under a prefix |
| `listFolder(ctx, prefix, { delimiter, limit, cursor })` | any | One level under a prefix: its objects and its folders (common prefixes), like S3's listing with a delimiter, but live. After each folder it reads one row, and runs of objects in growing batches. Returns a `cursor` past `limit`. A key equal to the prefix (a folder marker such as `photos/`) isn't listed |
| `deleteObject(ctx, key)`, `deleteObjects(ctx, keys)` | mutation | The rows at once, the objects in the background with retries |
| `deletePrefix(ctx, prefix)` | mutation | Everything under a non-empty prefix, in scheduled steps |
| `headObject(ctx, key)`, `getObject(ctx, key, { range })` | action | What S3 has now; bytes of a small object or a range |
| `listObjects(ctx, { prefix, delimiter, cursor, limit })` | action | The bucket's own listing (`ListObjectsV2`), with folders |
| `copyObject(ctx, from, to, put?)`, `moveObject(...)` | action | Server-side copy, part by part above 5 GB (`UploadPartCopy`); `put` replaces headers and metadata |
| `putObjectTagging(ctx, key, tags)` | action | Replaces the object's tags |

**URLs in queries expire on screen.** A query signs its URLs when it runs,
and a subscription keeps that result until the data changes, so a page left
open longer than `expiresIn` shows dead links. Return keys from list queries
and sign a URL when it's used, from a mutation (`getUrl` works there too),
or use public URLs. The examples do this (`files.downloadUrl`,
`drive.fileUrl`). `getMetadata` and `listMetadata` still include `url`, as the
R2 component's do, for one-off reads.

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
  or multipart / POST. `useUploadFile` handles all three. `generateUploadUrl`
  takes the file's `size` (required), and tickets refuse to overwrite by
  default.
- Signing is SigV4 on Web Crypto, with no AWS SDK in the bundle.
