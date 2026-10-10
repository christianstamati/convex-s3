# Convex S3 Component

[![npm version](https://img.shields.io/npm/v/@cstack-dev/convex-s3)](https://www.npmjs.com/package/@cstack-dev/convex-s3)

Store and serve files in S3-compatible storage from Convex: AWS S3,
Cloudflare R2, MinIO. Browsers upload straight to the bucket; Convex signs
the requests, enforces your rules and records what arrived.

```ts
// convex/files.ts
import { S3 } from "@cstack-dev/convex-s3"

export const s3 = new S3(components.s3)

export const {
  generateUploadUrl, syncMetadata,
  createMultipartUpload, signUploadParts, listUploadedParts,
  completeMultipartUpload, abortUpload,
  onSyncMetadata,
} = s3.clientApi<DataModel>({
  checkUpload: async (ctx, bucket, request) => {
    const userId = await requireUser(ctx) // throw to refuse
    return { prefix: `users/${userId}/`, maxSize: 100 * 1024 * 1024 }
  },
  onUpload: async (ctx, bucket, key, metadata) => {
    await ctx.db.insert("files", { key, size: metadata.size })
  },
  callbacks: "files",
})
```

```tsx
// src/UploadButton.tsx
import { useUploadFile } from "@cstack-dev/convex-s3/react"

const uploadFile = useUploadFile(api.files)
const key = await uploadFile(file, { onProgress: ({ fraction }) => setProgress(fraction) })
```

**See the [example app](https://github.com/christianstamati/convex-s3/tree/main/apps/web)**: an uploads page, and a Google Drive clone where folders are S3 prefixes.

- **Any S3-compatible store.** AWS S3, Cloudflare R2, MinIO, Tigris, Backblaze B2.
- **The R2 component's API.** `clientApi`, `useUploadFile`, `store`, `getUrl`, `getMetadata`, `listMetadata`, `deleteObject` and the same callbacks.
- **Large files.** Multipart uploads in parallel parts, with progress, cancel and resume after a reload.
- **Limits S3 enforces.** The size and content type are signed into every upload, so S3 refuses anything else.
- **Safe by default.** Credentials never leave the component, the server picks every key, uploads never overwrite, and each browser-facing function needs your check.
- **Prefixes and folders.** List one level of a "folder" live, delete a whole prefix, copy and move objects (part by part above 5 GB).
- **No AWS SDK.** SigV4 on Web Crypto, so it runs in queries, mutations and actions.
- **Testable.** `FakeS3`, an in-memory S3 that checks signatures and limits as S3 does.

## Set it up with an AI agent

The package ships [`llms.txt`](https://github.com/christianstamati/convex-s3/blob/main/packages/convex-s3/llms.txt), a step-by-step integration guide written for coding agents: bucket setup with the AWS CLI, the Convex config, the code to write, and the pitfalls. In a Convex project, give your agent (Claude Code, Cursor, Codex) this prompt:

```
Add file uploads to this Convex app with S3 using @cstack-dev/convex-s3.
Install it, then read node_modules/@cstack-dev/convex-s3/llms.txt and follow
it end to end: create and configure the bucket and its IAM user with the AWS
CLI, install the component, write convex/files.ts with checks that use our
auth, and build the upload UI with useUploadFile.
```

## Prerequisites

### An S3 bucket

With the [AWS CLI](https://aws.amazon.com/cli/) signed in to your account (`aws sts get-caller-identity` works), in the region of your Convex deployment if you can:

```sh
BUCKET=my-app-files REGION=eu-west-1

# The bucket, private (Block Public Access stays on).
aws s3api create-bucket --bucket $BUCKET --region $REGION \
  --create-bucket-configuration LocationConstraint=$REGION   # omit this line in us-east-1

# CORS: browsers upload straight to the bucket. Add your production origin.
aws s3api put-bucket-cors --bucket $BUCKET --cors-configuration '{"CORSRules":[{
  "AllowedOrigins":["http://localhost:3000"],
  "AllowedMethods":["PUT","POST","GET","HEAD"],
  "AllowedHeaders":["*"],
  "ExposeHeaders":["ETag"],
  "MaxAgeSeconds":3600}]}'

# Abandoned multipart uploads go after a day.
aws s3api put-bucket-lifecycle-configuration --bucket $BUCKET --lifecycle-configuration '{"Rules":[{
  "ID":"abort-incomplete-multipart","Status":"Enabled","Filter":{"Prefix":""},
  "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'

# An IAM user for Convex, allowed this bucket only.
aws iam create-user --user-name $BUCKET-convex
aws iam put-user-policy --user-name $BUCKET-convex --policy-name bucket --policy-document '{
  "Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:DeleteObject",
    "s3:AbortMultipartUpload","s3:ListMultipartUploadParts","s3:PutObjectTagging","s3:GetObjectTagging"],
   "Resource":"arn:aws:s3:::'$BUCKET'/*"},
  {"Effect":"Allow","Action":["s3:ListBucket","s3:ListBucketMultipartUploads"],
   "Resource":"arn:aws:s3:::'$BUCKET'"}]}'
aws iam create-access-key --user-name $BUCKET-convex   # keep the two values for Installation
```

`ExposeHeaders: ["ETag"]` matters: multipart uploads read each part's ETag in the browser. To serve files publicly, put CloudFront in front of the bucket (origin access control) rather than opening the bucket.

### Other providers

| Provider | `S3_REGION` | `S3_ENDPOINT` | Notes |
| --- | --- | --- | --- |
| AWS S3 | the bucket's region | unset | Checked with the provider suite against a real bucket |
| Cloudflare R2 | `auto` | `https://<account id>.r2.cloudflarestorage.com` | No POST uploads, no object tags. Set CORS in the R2 dashboard |
| MinIO | `us-east-1` (or yours) | `http://localhost:9000` | Path-style addressing (the default with an endpoint). Tested in CI |
| Tigris, Backblaze B2 | theirs | theirs | Must support conditional writes (`If-None-Match: *`) |

### A Convex app

Convex 1.46 or later (components with their own env vars). [Create one](https://docs.convex.dev/quickstart) if you haven't.

## Installation

```sh
npm install @cstack-dev/convex-s3
```

Install the component and bind its env vars in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server"
import { v } from "convex/values"
import s3 from "@cstack-dev/convex-s3/convex.config"

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

Set them on your deployment (`env set NAME` without a value asks for it, which keeps secrets out of your shell history):

```sh
npx convex env set S3_BUCKET my-app-files
npx convex env set S3_REGION eu-west-1
npx convex env set S3_ACCESS_KEY_ID
npx convex env set S3_SECRET_ACCESS_KEY
```

The credentials stay inside the component: every signature is made there, so they never travel as function arguments. All env vars:

| Env var | |
| --- | --- |
| `S3_BUCKET`, `S3_REGION` | The bucket and its region (`auto` for R2) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | The IAM user's key |
| `S3_SESSION_TOKEN` | Temporary credentials only |
| `S3_ENDPOINT` | S3-compatible providers. Unset: AWS. The provider must support conditional writes (`If-None-Match: *` on PUT and on completing a multipart upload) |
| `S3_FORCE_PATH_STYLE` | `true` for `<endpoint>/<bucket>/<key>`. Default: `true` with an endpoint, `false` on AWS |
| `S3_PUBLIC_URL` | Base of public URLs, such as a CloudFront distribution |

Values are trimmed, so a secret pasted with a trailing newline still works.

### Using multiple buckets

One installation serves one bucket. Install the component again under another name, with its own env vars:

```ts
app.use(s3, { name: "archive", env: { S3_BUCKET: app.env.ARCHIVE_BUCKET, /* … */ } })
```

```ts
export const archive = new S3(components.archive)
```

## Uploading files

Uploads go from the browser straight to the bucket in three steps: your mutation hands out a **ticket**, the browser sends the file to S3, and your action checks and records it. `clientApi()` generates those functions; export them from one module:

```ts
// convex/files.ts
import { S3 } from "@cstack-dev/convex-s3"
import { ConvexError } from "convex/values"
import { components } from "./_generated/api"
import type { DataModel } from "./_generated/dataModel"
import { getAuthUserId } from "@convex-dev/auth/server" // or your auth

export const s3 = new S3(components.s3)

export const {
  generateUploadUrl,       // mutation: a ticket, after checkUpload
  syncMetadata,            // action: records a single or POST upload
  createMultipartUpload,   // action: starts a multipart upload
  signUploadParts,         // mutation: part URLs
  listUploadedParts,       // action: resume after a reload
  completeMultipartUpload, // action: records a multipart upload
  abortUpload,             // action: gives up and cleans up
  onSyncMetadata,          // internal: runs onUpload in a mutation
} = s3.clientApi<DataModel>({
  checkUpload: async (ctx, bucket, request) => {
    const userId = await getAuthUserId(ctx)
    if (userId === null) throw new ConvexError("Sign in to upload")
    return {
      prefix: `users/${userId}/`, // keys become users/<id>/<uuid>/<file name>
      maxSize: 100 * 1024 * 1024,
    }
  },
  onUpload: async (ctx, bucket, key, metadata) => {
    const userId = await getAuthUserId(ctx)
    await ctx.db.insert("files", {
      key,
      owner: userId!,
      name: key.split("/").pop()!,
      size: metadata.size,
      contentType: metadata.contentType,
    })
  },
  callbacks: "files", // this module's path, so onUpload runs in a mutation
})
```

```tsx
import { useUploadFile } from "@cstack-dev/convex-s3/react"
import { useState } from "react"
import { api } from "../convex/_generated/api"

export function UploadButton() {
  const uploadFile = useUploadFile(api.files)
  const [progress, setProgress] = useState(0)
  return (
    <input
      type="file"
      onChange={async (event) => {
        const file = event.target.files?.[0]
        if (!file) return
        const key = await uploadFile(file, {
          onProgress: ({ fraction }) => setProgress(fraction),
        })
        console.log("Uploaded to", key)
      }}
    />
  )
}
```

`uploadFile(file, options)` takes `onProgress`, an AbortSignal `signal` (aborting cancels and removes what arrived), `concurrency` (parts at once, 4) and `resume` (default true). Outside React, `uploadFile(client, api, file, options)` from the same entry point works with any Convex client.

What happens, in detail:

1. `generateUploadUrl` runs `checkUpload`, builds the key (`<prefix><uuid>/<clean file name>`, or the `key` it returns) and returns a ticket. The browser declares the file's size, and the size and content type are signed into the upload, so S3 refuses a different file.
2. Up to 64 MB (`multipartThreshold`) the browser sends one PUT. Above it, the upload is multipart: 16 MB parts (`partSize`), each URL signed with its part's exact size, four at a time, resumable after a reload for 24 hours.
3. `syncMetadata` or `completeMultipartUpload` checks the object (it must carry the ticket's marker and fit the ticket), records it in the component, then runs `onUpload` in a mutation. If `onUpload` throws, the object is deleted.

### Checks

Each browser-facing function refuses to run until you give it its check; pass `() => {}` to allow everything.

| Callback | Guards | Signature |
| --- | --- | --- |
| `checkUpload` | `generateUploadUrl` | `(ctx, bucket, { fileName, contentType, size, prefix })` → nothing, or `{ prefix, key, maxSize, contentType, put, multipartThreshold, partSize }`. Throw to refuse |
| `checkReadKey` | `getMetadata` | `(ctx, bucket, key)` |
| `checkReadBucket` | `listMetadata` | `(ctx, bucket, prefix)`: `""` for the whole bucket |
| `checkDelete` | `deleteObject` | `(ctx, bucket, key)`, then `onDelete(ctx, bucket, key)` |
| `onUpload` | after an upload | `(ctx, bucket, key, metadata)`, in a mutation |
| `onSyncMetadata` | after every sync | `(ctx, { bucket, key, isNew })` |

The browser's `prefix` is only a request: it counts when `checkUpload` returns it. `callbacks` is the module's path (`"files"`, `"storage/files"`): `internal.files` from inside that module would be a circular type.

### Choosing keys

Return `key` from `checkUpload` to pick it yourself (`avatars/${userId}.png`). A ticket refuses to overwrite an existing object (`If-None-Match: *`); pass `put: { ifNoneMatch: false }` to replace one. Before handing out a key of your own, `await s3.isKeyInUse(ctx, key)` tells you whether it's recorded or held by a live ticket.

### Form uploads (POST)

`s3.generateUploadPost(ctx, { prefix, fileName, maxSize, contentType })` returns a ticket with `url` and form `fields`; S3 itself refuses a bigger file (`content-length-range`). Send the fields, then the file last, then call `syncMetadata`. Not supported by R2. A POST can't refuse to overwrite, so use fresh keys.

## Storing files from actions

```ts
export const importFromUrl = action({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    const response = await fetch(url)
    return await s3.store(ctx, await response.blob(), {
      prefix: "imports/",
      fileName: "image.png",
      contentType: "image/png",
    })
  },
})
```

`store()` returns the key and records the object. Above `multipartThreshold` (64 MB) it uploads in parts. It accepts every upload option: `key`, `prefix`, `fileName`, `contentType`, `cacheControl`, `contentDisposition`, `metadata`, `tagging`, `storageClass`, `serverSideEncryption`, `kmsKeyId`, `checksumSha256`, `ifNoneMatch`.

## Serving files

### URLs when they're used

```ts
export const downloadUrl = mutation({
  args: { id: v.id("files") },
  handler: async (ctx, { id }) => {
    const file = await ctx.db.get(id)
    // …check the caller may read it…
    return await s3.getUrl(ctx, file!.key, {
      expiresIn: 5 * 60,
      responseContentDisposition: `attachment; filename="${file!.name}"`,
    })
  },
})
```

Sign URLs in a mutation or action when they're clicked, not in a list query: a subscribed query keeps its first result until the data changes, so URLs signed there expire on screen. `getUrl` lasts 15 minutes by default (7 days at most) and takes `versionId`, `responseContentDisposition`, `responseContentType` and `responseCacheControl`.

**Serve untrusted uploads as attachments.** Whoever uploads picks the content type (unless `checkUpload` sets it). Opening an uploaded `text/html` or `image/svg+xml` inline runs it on the bucket's origin: download it (`responseContentDisposition: "attachment; …"`), or allow only safe types inline.

### Public and CDN URLs

With `S3_PUBLIC_URL` set (a CloudFront distribution in front of the bucket, or an R2 custom domain), `await s3.getPublicUrl(ctx, key)` returns a stable URL that caches well. `getMetadata` and `listMetadata` include it as `publicUrl`.

## Listing files

```ts
// Recorded objects by key, under a prefix: for usePaginatedQuery.
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) =>
    await s3.pageMetadata(ctx, paginationOpts, "users/123/"),
})

// One level of a "folder", live: its objects and subfolders.
const { folders, objects, cursor } = await s3.listFolder(ctx, "photos/2026/")
```

- `listMetadata(ctx, limit, cursor, prefix)` and `pageMetadata(ctx, paginationOpts, prefix)`: recorded objects, by key.
- `listFolder(ctx, prefix, { delimiter, limit, cursor })`: one level under a prefix, like S3's listing with a delimiter, but live. A folder marker (a zero-byte key ending in `/`, as the S3 console makes) isn't listed. Up to 1,000 entries, then a `cursor`.
- `listObjects(ctx, { prefix, delimiter, cursor, limit })`: S3's own listing (`ListObjectsV2`), in actions, including objects the component never recorded.

Prefixes match raw: `users/1` also matches `users/12/…`, so end folder prefixes with `/`. Each result carries `key`, `size`, `contentType`, `etag`, `lastModified`, `metadata`, a 15-minute `url` and `publicUrl`.

## Deleting files

```ts
export const remove = mutation({
  args: { id: v.id("files") },
  handler: async (ctx, { id }) => {
    const file = await ctx.db.get(id)
    // …check the caller may delete it…
    await ctx.db.delete(id)
    await s3.deleteObject(ctx, file!.key)
  },
})
```

`deleteObject` removes the record at once and the object in the background, retrying for about 17 minutes. `deleteObjects(ctx, keys)` takes up to 1,000 keys; `deletePrefix(ctx, prefix)` deletes everything under a non-empty prefix in scheduled steps.

## Copying, moving and reading

In actions: `copyObject(ctx, from, to, put?)` and `moveObject(ctx, from, to, put?)` copy server-side (part by part above 5 GB) and record the copy; `put` replaces its headers and metadata. `headObject(ctx, key)` reads what S3 has; `getObject(ctx, key, { range })` returns the bytes of a small object or a range (`bytes=0-1023`); `putObjectTagging(ctx, key, tags)` replaces its tags.

## Security

- The server picks every key; the browser's prefix counts only if `checkUpload` returns it.
- Size and content type are signed into every browser upload, and S3 refuses anything else.
- A ticket's token is single-use and bound to its key. Sync, completion and abort each claim the ticket first, so they happen once.
- Every ticket signs a marker into the object's metadata (`x-amz-meta-upload-ticket`, reserved, never recorded). Cleanup deletes, and sync records, only an object carrying its ticket's marker: one person's failed or abandoned upload never touches another's file.
- A presigned URL can't be revoked, so a ticket is kept until its URLs expire (an hour after a single upload's URL, 24 hours for multipart). Then a sweep deletes whatever a replayed URL put back that nothing recorded.
- Rate-limit `generateUploadUrl` in `checkUpload`, for example with [`@convex-dev/rate-limiter`](https://www.convex.dev/components/rate-limiter): anyone who can call it can make the bucket hold up to `maxSize` per ticket until it expires.
- Recording happens before `onUpload`. If your action dies between the two, the component has a record your app never saw; reconcile with `listMetadata` if it matters.

## Testing

`@cstack-dev/convex-s3/testing` has `FakeS3`, an in-memory S3 behind a `fetch` you stub. It checks what S3 checks: signatures, expiry, signed sizes, POST policies, `If-None-Match`, checksums and `Content-MD5`. `register(t)` installs the component in convex-test:

```ts
// convex/test.setup.ts
import { FakeS3, register } from "@cstack-dev/convex-s3/testing"
import { convexTest } from "convex-test"
import { vi } from "vitest"
import schema from "./schema"

export const modules = import.meta.glob("./**/*.ts")

export function setup() {
  const s3 = new FakeS3()
  for (const [name, value] of Object.entries(s3.env())) vi.stubEnv(name, value)
  vi.stubGlobal("fetch", s3.fetch)
  const t = convexTest(schema, modules)
  register(t)
  return { t, s3 }
}
```

```ts
// vitest.config.ts: register() uses import.meta.glob, so inline the package.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test", "@cstack-dev/convex-s3"] } },
  },
})
```

`s3.put(key, data)` seeds an object, `s3.objects` and `s3.requests` let you assert, and `s3.failWhen = (request) => …` answers matching requests with a 500.

## API reference

`new S3(components.s3)` from `@cstack-dev/convex-s3`; every method takes the function's `ctx` first, because signing happens in the component.

| Method | In | Returns |
| --- | --- | --- |
| `generateUploadUrl(ctx, options)` | mutation | A ticket: `{ method: "single", key, token, url, headers }` or `{ method: "multipart", key, token, partSize, partCount }` |
| `generateUploadPost(ctx, options)` | mutation | `{ method: "post", key, token, url, fields }` |
| `store(ctx, data, options)` | action | The key |
| `syncMetadata(ctx, key)` | action | `{ metadata, isNew }`, after a HEAD |
| `abortUpload(ctx, key, token)` | action | |
| `getUrl(ctx, key, options)` | any | A presigned GET URL |
| `getPublicUrl(ctx, key)` | any | The URL under `S3_PUBLIC_URL`, or null |
| `isKeyInUse(ctx, key)` | any | Whether it's recorded or held by a live ticket |
| `getMetadata(ctx, key)` | any | The record with `url`, or null |
| `listMetadata(ctx, limit?, cursor?, prefix?)`, `pageMetadata(ctx, paginationOpts, prefix?)` | any | A page of records |
| `listFolder(ctx, prefix?, options?)` | any | `{ folders, objects, isTruncated, cursor }` |
| `deleteObject(ctx, key)`, `deleteObjects(ctx, keys)`, `deletePrefix(ctx, prefix)` | mutation | |
| `headObject(ctx, key, versionId?)` | action | What S3 has, or null |
| `getObject(ctx, key, { range?, versionId? })` | action | `{ data, info, contentRange }` or null |
| `listObjects(ctx, { prefix?, delimiter?, cursor?, limit? })` | action | `{ objects, prefixes, cursor, isDone }` |
| `copyObject(ctx, from, to, put?)`, `moveObject(…)` | action | `{ metadata, isNew }` for the copy |
| `putObjectTagging(ctx, key, tags)` | action | |
| `bucket(ctx)` | any | The bucket's name |

Upload options (for `generateUploadUrl`, `generateUploadPost`, `store` and `checkUpload`'s `put`): `key`, `prefix`, `fileName`, `size`, `maxSize`, `contentType`, `cacheControl`, `contentDisposition`, `contentEncoding`, `contentLanguage`, `metadata` (ASCII), `tagging`, `storageClass`, `serverSideEncryption`, `kmsKeyId`, `checksumSha256` (single uploads), `ifNoneMatch` (default true), `multipartThreshold`, `partSize`, `expiresIn` (seconds, 5 minutes by default).

Entry points: `@cstack-dev/convex-s3` (the `S3` class, types, validators), `@cstack-dev/convex-s3/react` (`useUploadFile`, `uploadFile`), `@cstack-dev/convex-s3/convex.config` (the component), `@cstack-dev/convex-s3/testing` (`FakeS3`, `register`). The types `UploadTicket`, `ObjectMetadata`, `ObjectInfo`, `PutOptions`, `UploadOptions`, `UploadPolicy`, `UploadRequest`, `GetUrlOptions` and `ClientApiOptions`, the validators `vObjectMetadata` and `vUploadTicket`, and `newKey`, `normalizePrefix` and `cleanFileName` come from the main entry point.

## Coming from the R2 component

- Methods take `ctx` first (`s3.getUrl(ctx, key)`): signing happens in the component, which keeps the credentials.
- `clientApi()` needs a check for each function it exposes, and `callbacks` is the module's path (`"files"`).
- Tickets replace bare upload URLs, and `generateUploadUrl` takes the file's `size`. `useUploadFile` handles single, multipart and POST tickets.
- Export the multipart functions too (`createMultipartUpload`, `signUploadParts`, `listUploadedParts`, `completeMultipartUpload`, `abortUpload`) for files above `multipartThreshold`.
- Uploads refuse to overwrite unless `ifNoneMatch: false`.

## License

MIT
