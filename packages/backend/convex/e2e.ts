// End-to-end checks against the deployment's real bucket:
// `bunx convex run e2e:run` in packages/backend. Everything is written under
// `e2e/<run>/` and deleted at the end. Internal only.
import { v } from "convex/values"
import { components } from "./_generated/api"
import { type ActionCtx, internalAction } from "./_generated/server"
import { s3 } from "./files"

const MiB = 1024 * 1024
const encoder = new TextEncoder()

type Check = { name: string; ok: boolean; detail: string }

function expectEqual(actual: unknown, expected: unknown, what: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

async function base64Sha256(data: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as Uint8Array<ArrayBuffer>
  )
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
}

async function put(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array
) {
  return await fetch(url, { method: "PUT", headers, body: body as BodyInit })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const run = internalAction({
  args: { keep: v.optional(v.boolean()) },
  returns: v.object({
    prefix: v.string(),
    passed: v.number(),
    failed: v.number(),
    checks: v.array(
      v.object({ name: v.string(), ok: v.boolean(), detail: v.string() })
    ),
  }),
  handler: async (ctx, { keep }) => {
    const prefix = `e2e/${Date.now()}/`
    const checks: Check[] = []
    const check = async (
      name: string,
      fn: () => Promise<string | undefined>
    ) => {
      try {
        checks.push({ name, ok: true, detail: (await fn()) ?? "" })
      } catch (error) {
        checks.push({
          name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const component = components.s3

    await check("store, then read back through a presigned URL", async () => {
      const key = await s3.store(ctx, encoder.encode("hello from convex"), {
        prefix,
        fileName: "hello.txt",
        contentType: "text/plain",
        metadata: { source: "e2e" },
      })
      const metadata = await s3.getMetadata(ctx, key)
      expectEqual(metadata?.size, 17, "size")
      expectEqual(metadata?.metadata, { source: "e2e" }, "metadata")
      const body = await (await fetch(await s3.getUrl(ctx, key))).text()
      expectEqual(body, "hello from convex", "body")
      return key
    })

    await check("a presigned PUT takes only the signed size", async () => {
      const ticket = await s3.generateUploadUrl(ctx, {
        prefix,
        fileName: "sized.bin",
        size: 5,
        contentType: "application/octet-stream",
      })
      if (ticket.method !== "single") throw new Error("single expected")
      const wrong = await put(ticket.url, ticket.headers, new Uint8Array(6))
      expectEqual(wrong.status, 403, "wrong size")
      const right = await put(ticket.url, ticket.headers, new Uint8Array(5))
      expectEqual(right.status, 200, "right size")
      const { metadata } = await ctx.runAction(component.uploads.syncMetadata, {
        key: ticket.key,
        token: ticket.token,
      })
      expectEqual(metadata.size, 5, "synced size")
      return `wrong size: ${wrong.status}`
    })

    await check("a checksum S3 verifies", async () => {
      const body = encoder.encode("checked")
      const good = await s3.generateUploadUrl(ctx, {
        prefix,
        fileName: "sum.txt",
        size: body.length,
        checksumSha256: await base64Sha256(body),
      })
      if (good.method !== "single") throw new Error("single expected")
      expectEqual(
        (await put(good.url, good.headers, body)).status,
        200,
        "matching checksum"
      )
      const bad = await s3.generateUploadUrl(ctx, {
        prefix,
        fileName: "bad.txt",
        size: body.length,
        checksumSha256: await base64Sha256(encoder.encode("other!!")),
      })
      if (bad.method !== "single") throw new Error("single expected")
      const refused = await put(bad.url, bad.headers, body)
      expectEqual(refused.status >= 400, true, "mismatching checksum refused")
      return `mismatch: ${refused.status}`
    })

    await check("If-None-Match refuses to overwrite", async () => {
      const key = `${prefix}taken.txt`
      await s3.store(ctx, encoder.encode("first"), { key })
      const ticket = await s3.generateUploadUrl(ctx, {
        key,
        size: 6,
        ifNoneMatch: true,
      })
      if (ticket.method !== "single") throw new Error("single expected")
      const response = await put(
        ticket.url,
        ticket.headers,
        encoder.encode("second")
      )
      expectEqual(response.status, 412, "status")
      return undefined
    })

    await check("multipart: parts, resume listing, complete", async () => {
      const size = 5 * MiB + 1234
      const data = new Uint8Array(size).map((_, i) => i % 251)
      const ticket = await s3.generateUploadUrl(ctx, {
        prefix,
        fileName: "multi.bin",
        size,
        multipartThreshold: MiB,
        partSize: 5 * MiB,
        contentType: "application/octet-stream",
      })
      if (ticket.method !== "multipart") throw new Error("multipart expected")
      const keyToken = { key: ticket.key, token: ticket.token }
      const { partSize, partCount } = await ctx.runAction(
        component.uploads.createMultipartUpload,
        keyToken
      )
      expectEqual(partCount, 2, "parts")
      const urls = await ctx.runMutation(component.uploads.signUploadParts, {
        ...keyToken,
        partNumbers: [1, 2],
      })
      const parts: { partNumber: number; etag: string }[] = []
      for (const { partNumber, url } of urls) {
        const start = (partNumber - 1) * partSize
        const response = await put(url, {}, data.slice(start, start + partSize))
        expectEqual(response.status, 200, `part ${partNumber}`)
        parts.push({ partNumber, etag: response.headers.get("etag") ?? "" })
      }
      const listed = await ctx.runAction(
        component.uploads.listUploadedParts,
        keyToken
      )
      expectEqual(
        listed.map((p) => p.partNumber),
        [1, 2],
        "listed parts"
      )
      const { metadata } = await ctx.runAction(
        component.uploads.completeMultipartUpload,
        { ...keyToken, parts }
      )
      expectEqual(metadata.size, size, "size")
      const tail = await s3.getObject(ctx, ticket.key, {
        range: `bytes=${size - 4}-`,
      })
      expectEqual(
        Array.from(new Uint8Array(tail?.data ?? new ArrayBuffer(0))),
        Array.from(data.slice(size - 4)),
        "last bytes"
      )
      return `etag ${metadata.etag}`
    })

    await check("multipart: abort", async () => {
      const ticket = await s3.generateUploadUrl(ctx, {
        prefix,
        fileName: "aborted.bin",
        size: 6 * MiB,
        multipartThreshold: MiB,
        partSize: 5 * MiB,
      })
      if (ticket.method !== "multipart") throw new Error("multipart expected")
      const keyToken = { key: ticket.key, token: ticket.token }
      await ctx.runAction(component.uploads.createMultipartUpload, keyToken)
      await s3.abortUpload(ctx, ticket.key, ticket.token)
      try {
        await ctx.runAction(component.uploads.listUploadedParts, keyToken)
      } catch {
        return undefined
      }
      throw new Error("the upload is still there")
    })

    await check("POST policy caps the size", async () => {
      const ticket = await s3.generateUploadPost(ctx, {
        prefix,
        fileName: "form.png",
        maxSize: 10,
        contentType: "image/png",
      })
      if (ticket.method !== "post") throw new Error("post expected")
      const post = async (size: number) => {
        const form = new FormData()
        for (const [name, value] of Object.entries(ticket.fields))
          form.append(name, value)
        form.append(
          "file",
          new Blob([new Uint8Array(size)], { type: "image/png" })
        )
        return await fetch(ticket.url, { method: "POST", body: form })
      }
      const tooBig = await post(11)
      const tooBigBody = await tooBig.text()
      expectEqual(tooBig.status, 400, "too big")
      expectEqual(tooBigBody.includes("EntityTooLarge"), true, "EntityTooLarge")
      const ok = await post(8)
      expectEqual(ok.status, 204, "within the limit")
      const { metadata } = await ctx.runAction(component.uploads.syncMetadata, {
        key: ticket.key,
        token: ticket.token,
      })
      expectEqual(metadata.contentType, "image/png", "content type")
      return undefined
    })

    await check("list the bucket with folders", async () => {
      await s3.store(ctx, encoder.encode("a"), { key: `${prefix}folder/a.txt` })
      const listing = await s3.listObjects(ctx, { prefix, delimiter: "/" })
      expectEqual(listing.prefixes.includes(`${prefix}folder/`), true, "folder")
      return `${listing.objects.length} objects, ${listing.prefixes.length} folders`
    })

    await check("copy and move", async () => {
      const source = await s3.store(ctx, encoder.encode("copy me"), {
        prefix,
        fileName: "source.txt",
        contentType: "text/plain",
      })
      const copy = await s3.copyObject(ctx, source, `${prefix}copy.txt`)
      expectEqual(copy.metadata.contentType, "text/plain", "copy keeps headers")
      const moved = await s3.moveObject(
        ctx,
        `${prefix}copy.txt`,
        `${prefix}moved.md`,
        { contentType: "text/markdown" }
      )
      expectEqual(
        moved.metadata.contentType,
        "text/markdown",
        "move replaces headers"
      )
      expectEqual(
        await s3.headObject(ctx, `${prefix}copy.txt`),
        null,
        "source gone"
      )
      return undefined
    })

    await check("tags", async () => {
      const key = await s3.store(ctx, encoder.encode("t"), {
        prefix,
        fileName: "tagged.txt",
        tagging: { stage: "upload" },
      })
      await s3.putObjectTagging(ctx, key, { stage: "tagged" })
      return undefined
    })

    if (!keep) {
      await check("delete the run's prefix", async () => {
        await s3.deletePrefix(ctx, prefix)
        return await waitUntilEmpty(ctx, prefix)
      })
    }

    const failed = checks.filter((c) => !c.ok).length
    return { prefix, passed: checks.length - failed, failed, checks }
  },
})

async function waitUntilEmpty(ctx: ActionCtx, prefix: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const listing = await s3.listObjects(ctx, { prefix })
    const rows = await s3.listMetadata(ctx, 10, null, prefix)
    if (listing.objects.length === 0 && rows.page.length === 0) {
      return `empty after ${attempt} checks`
    }
    await sleep(500)
  }
  throw new Error("objects remain under the prefix")
}
