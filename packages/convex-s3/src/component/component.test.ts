/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { FakeS3 } from "../testing/fakeS3"
import { api } from "./_generated/api"
import schema from "./schema"

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"])
const MiB = 1024 * 1024

let s3: FakeS3

function setup(options: ConstructorParameters<typeof FakeS3>[0] = {}) {
  s3 = new FakeS3({ minPartSize: 5 * MiB, ...options })
  for (const [name, value] of Object.entries(s3.env())) vi.stubEnv(name, value)
  vi.stubGlobal("fetch", s3.fetch)
  return convexTest(schema, modules)
}

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)

/** What a browser does with a single-PUT ticket. */
async function put(
  ticket: { url: string; headers: Record<string, string> },
  body: Uint8Array
) {
  return await fetch(ticket.url, {
    method: "PUT",
    headers: ticket.headers,
    body: body as BodyInit,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("single uploads", () => {
  test("upload, sync, read back through the signed URL", async () => {
    const t = setup()
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: "docs/hello.txt",
      size: 5,
      put: { contentType: "text/plain", metadata: { owner: "ada" } },
    })
    expect(ticket.method).toBe("single")
    if (ticket.method !== "single") return
    expect(ticket.headers).toMatchObject({
      "content-type": "text/plain",
      "x-amz-meta-owner": "ada",
    })

    expect((await put(ticket, new TextEncoder().encode("hello"))).status).toBe(
      200
    )
    const { metadata, isNew } = await t.action(api.uploads.syncMetadata, {
      key: ticket.key,
      token: ticket.token,
    })
    expect(isNew).toBe(true)
    expect(metadata).toMatchObject({
      bucket: "test-bucket",
      key: "docs/hello.txt",
      size: 5,
      contentType: "text/plain",
      metadata: { owner: "ada" },
      publicUrl: null,
    })

    const stored = await t.query(api.lib.getMetadata, { key: "docs/hello.txt" })
    const download = await fetch(stored?.url ?? "")
    expect(await download.text()).toBe("hello")
  })

  test("S3 refuses a body of another size than the signed one", async () => {
    const t = setup()
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: "a.bin",
      size: 4,
    })
    if (ticket.method !== "single") throw new Error("single expected")
    const response = await put(ticket, bytes(5))
    expect(response.status).toBe(403)
    expect(await response.text()).toContain("SignatureDoesNotMatch")
  })

  test("refuses a declared size above maxSize", async () => {
    const t = setup()
    await expect(
      t.mutation(api.uploads.generateUploadUrl, {
        key: "big.bin",
        size: 2 * MiB,
        maxSize: MiB,
      })
    ).rejects.toThrow("1 MB at most")
  })

  test("an unsized upload over maxSize is deleted at sync", async () => {
    const t = setup()
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: "u.bin",
      maxSize: 3,
    })
    if (ticket.method !== "single") throw new Error("single expected")
    await put(ticket, bytes(10))
    await expect(
      t.action(api.uploads.syncMetadata, {
        key: ticket.key,
        token: ticket.token,
      })
    ).rejects.toThrow("at most")
    expect(s3.objects.has("u.bin")).toBe(false)
  })

  test("a token works once, and only for its key", async () => {
    const t = setup()
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: "once.txt",
      size: 1,
    })
    if (ticket.method !== "single") throw new Error("single expected")
    await put(ticket, bytes(1))
    await expect(
      t.action(api.uploads.syncMetadata, { key: ticket.key, token: "forged" })
    ).rejects.toThrow("expired or was already completed")
    await t.action(api.uploads.syncMetadata, {
      key: ticket.key,
      token: ticket.token,
    })
    await expect(
      t.action(api.uploads.syncMetadata, {
        key: ticket.key,
        token: ticket.token,
      })
    ).rejects.toThrow("expired or was already completed")
  })

  test("If-None-Match refuses to overwrite", async () => {
    const t = setup()
    s3.put("taken.txt", "first")
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: "taken.txt",
      size: 6,
      put: { ifNoneMatch: true },
    })
    if (ticket.method !== "single") throw new Error("single expected")
    expect((await put(ticket, bytes(6))).status).toBe(412)
  })

  test("an upload never synced is removed when it expires", async () => {
    const t = setup()
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: "orphan.bin",
      size: 3,
    })
    if (ticket.method !== "single") throw new Error("single expected")
    await put(ticket, bytes(3))
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(s3.objects.has("orphan.bin")).toBe(false)
  })

  test("refuses keys that URLs would rewrite", async () => {
    const t = setup()
    await expect(
      t.mutation(api.uploads.generateUploadUrl, { key: "a/../b" })
    ).rejects.toThrow(". or .. segments")
  })
})

describe("multipart uploads", () => {
  async function startMultipart(t: ReturnType<typeof setup>, size: number) {
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: "video.bin",
      size,
      multipartThreshold: MiB,
      partSize: 5 * MiB,
      put: { contentType: "video/mp4" },
    })
    if (ticket.method !== "multipart") throw new Error("multipart expected")
    const keyToken = { key: ticket.key, token: ticket.token }
    const started = await t.action(api.uploads.createMultipartUpload, keyToken)
    return { ticket, keyToken, started }
  }

  test("parts, resume, complete", async () => {
    const t = setup()
    const size = 11 * MiB
    const data = bytes(size, 3)
    const { keyToken, started } = await startMultipart(t, size)
    expect(started).toMatchObject({ partSize: 5 * MiB, partCount: 3 })

    const urls = await t.mutation(api.uploads.signUploadParts, {
      ...keyToken,
      partNumbers: [1, 2, 3],
    })
    const etags: { partNumber: number; etag: string }[] = []
    for (const { partNumber, url } of urls.slice(0, 2)) {
      const start = (partNumber - 1) * started.partSize
      const response = await fetch(url, {
        method: "PUT",
        body: data.slice(start, start + started.partSize) as BodyInit,
      })
      expect(response.status).toBe(200)
      etags.push({ partNumber, etag: response.headers.get("etag") ?? "" })
    }

    // A reload: the browser asks what S3 already has.
    const uploaded = await t.action(api.uploads.listUploadedParts, keyToken)
    expect(uploaded.map((p) => p.partNumber)).toEqual([1, 2])
    // Starting again returns the same upload.
    expect(
      (await t.action(api.uploads.createMultipartUpload, keyToken)).uploadId
    ).toBe(started.uploadId)

    const last = urls[2]
    if (!last) throw new Error("no URL")
    const lastPart = await fetch(last.url, {
      method: "PUT",
      body: data.slice(10 * MiB) as BodyInit,
    })
    etags.push({ partNumber: 3, etag: lastPart.headers.get("etag") ?? "" })

    const { metadata } = await t.action(api.uploads.completeMultipartUpload, {
      ...keyToken,
      parts: etags,
    })
    expect(metadata).toMatchObject({
      key: "video.bin",
      size,
      contentType: "video/mp4",
    })
    expect(s3.objects.get("video.bin")?.data.length).toBe(size)
  })

  test("a part's URL only takes that part's exact size", async () => {
    const t = setup()
    const { keyToken } = await startMultipart(t, 6 * MiB)
    const [first] = await t.mutation(api.uploads.signUploadParts, {
      ...keyToken,
      partNumbers: [1],
    })
    const response = await fetch(first?.url ?? "", {
      method: "PUT",
      body: bytes(MiB) as BodyInit,
    })
    expect(response.status).toBe(403)
  })

  test("refuses to complete with parts missing", async () => {
    const t = setup()
    const { keyToken } = await startMultipart(t, 6 * MiB)
    await expect(
      t.action(api.uploads.completeMultipartUpload, {
        ...keyToken,
        parts: [{ partNumber: 1, etag: "x" }],
      })
    ).rejects.toThrow("Expected 2 parts")
  })

  test("abort removes the upload in S3", async () => {
    const t = setup()
    const { keyToken } = await startMultipart(t, 6 * MiB)
    expect(s3.uploads.size).toBe(1)
    await t.action(api.uploads.abortUpload, keyToken)
    expect(s3.uploads.size).toBe(0)
    await expect(
      t.action(api.uploads.listUploadedParts, keyToken)
    ).rejects.toThrow("expired")
  })

  test("signs no part beyond the last", async () => {
    const t = setup()
    const { keyToken } = await startMultipart(t, 6 * MiB)
    await expect(
      t.mutation(api.uploads.signUploadParts, { ...keyToken, partNumbers: [3] })
    ).rejects.toThrow("There is no part 3")
  })
})

describe("POST uploads", () => {
  async function postTicket(t: ReturnType<typeof setup>) {
    const ticket = await t.mutation(api.uploads.generateUploadPost, {
      key: "form/avatar.png",
      maxSize: 10,
      put: { contentType: "image/png" },
    })
    if (ticket.method !== "post") throw new Error("post expected")
    return ticket
  }

  async function post(
    ticket: { url: string; fields: Record<string, string> },
    size: number
  ) {
    const form = new FormData()
    for (const [name, value] of Object.entries(ticket.fields))
      form.append(name, value)
    form.append("file", new Blob([bytes(size)], { type: "image/png" }))
    return await fetch(ticket.url, { method: "POST", body: form })
  }

  test("S3 enforces the policy's size limit", async () => {
    const t = setup()
    const response = await post(await postTicket(t), 11)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("EntityTooLarge")
  })

  test("a file within the limit arrives and syncs", async () => {
    const t = setup()
    const ticket = await postTicket(t)
    expect((await post(ticket, 8)).status).toBe(204)
    const { metadata } = await t.action(api.uploads.syncMetadata, {
      key: ticket.key,
      token: ticket.token,
    })
    expect(metadata).toMatchObject({ size: 8, contentType: "image/png" })
  })
})

describe("objects", () => {
  async function seed(t: ReturnType<typeof setup>, keys: string[]) {
    for (const key of keys) {
      s3.put(key, key)
      await t.action(api.uploads.syncMetadata, { key })
    }
  }

  test("lists metadata under a prefix, in pages", async () => {
    const t = setup()
    await seed(t, ["p/1/a", "p/1/b", "p/1/c", "p/2/a", "q/a"])
    const first = await t.query(api.lib.listMetadata, {
      prefix: "p/1/",
      paginationOpts: { numItems: 2, cursor: null },
    })
    expect(first.page.map((o) => o.key)).toEqual(["p/1/a", "p/1/b"])
    const second = await t.query(api.lib.listMetadata, {
      prefix: "p/1/",
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    })
    expect(second.page.map((o) => o.key)).toEqual(["p/1/c"])
    expect(second.isDone).toBe(true)
  })

  test("lists the bucket itself, with folders", async () => {
    const t = setup()
    await seed(t, ["p/1/a", "p/2/a", "p/top"])
    const listing = await t.action(api.objects.listObjects, {
      prefix: "p/",
      delimiter: "/",
    })
    expect(listing.objects.map((o) => o.key)).toEqual(["p/top"])
    expect(listing.prefixes).toEqual(["p/1/", "p/2/"])
  })

  test("deletes one object: row now, object in the background", async () => {
    const t = setup()
    await seed(t, ["gone.txt"])
    await t.mutation(api.lib.deleteObject, { key: "gone.txt" })
    expect(await t.query(api.lib.getMetadata, { key: "gone.txt" })).toBeNull()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(s3.objects.has("gone.txt")).toBe(false)
  })

  test("deletes a prefix, objects and rows", async () => {
    const t = setup()
    await seed(t, ["team/1/a", "team/1/b", "team/2/a"])
    s3.put("team/1/untracked", "x")
    await t.mutation(api.lib.deletePrefix, { prefix: "team/1/" })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect([...s3.objects.keys()]).toEqual(["team/2/a"])
    const rows = await t.query(api.lib.listMetadata, {
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(rows.page.map((o) => o.key)).toEqual(["team/2/a"])
  })

  test("refuses to delete the whole bucket", async () => {
    const t = setup()
    await expect(
      t.mutation(api.lib.deletePrefix, { prefix: "" })
    ).rejects.toThrow("whole bucket")
  })

  test("copies and moves, keeping or replacing headers", async () => {
    const t = setup()
    s3.put("src.txt", "data", "text/plain")
    const copy = await t.action(api.objects.copyObject, {
      sourceKey: "src.txt",
      destinationKey: "copy.txt",
    })
    expect(copy.metadata).toMatchObject({
      key: "copy.txt",
      size: 4,
      contentType: "text/plain",
    })
    const moved = await t.action(api.objects.moveObject, {
      sourceKey: "copy.txt",
      destinationKey: "moved.md",
      put: { contentType: "text/markdown" },
    })
    expect(moved.metadata.contentType).toBe("text/markdown")
    expect(s3.objects.has("copy.txt")).toBe(false)
    expect(await t.query(api.lib.getMetadata, { key: "copy.txt" })).toBeNull()
  })

  test("reads a range", async () => {
    const t = setup()
    s3.put("r.txt", "0123456789")
    const result = await t.action(api.objects.getObject, {
      key: "r.txt",
      range: "bytes=2-4",
    })
    expect(new TextDecoder().decode(result?.data)).toBe("234")
    expect(result?.info.size).toBe(10)
    expect(await t.action(api.objects.getObject, { key: "missing" })).toBeNull()
  })

  test("tags an object", async () => {
    const t = setup()
    s3.put("t.txt", "x")
    await t.action(api.objects.putObjectTagging, {
      key: "t.txt",
      tags: { project: "demo" },
    })
    expect(s3.objects.get("t.txt")?.tags).toEqual({ project: "demo" })
  })
})

describe("addressing", () => {
  test("path-style endpoints (MinIO) and public URLs", async () => {
    const t = setup({
      endpoint: "http://localhost:9000",
      publicUrl: "https://cdn.example.com/",
    })
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: "dir/a b.txt",
      size: 2,
    })
    if (ticket.method !== "single") throw new Error("single expected")
    expect(
      ticket.url.startsWith("http://localhost:9000/test-bucket/dir/a%20b.txt?")
    ).toBe(true)
    await put(ticket, bytes(2))
    const { metadata } = await t.action(api.uploads.syncMetadata, {
      key: ticket.key,
      token: ticket.token,
    })
    expect(metadata.publicUrl).toBe("https://cdn.example.com/dir/a%20b.txt")
  })

  test("virtual-hosted URLs on AWS", async () => {
    const t = setup()
    const url = await t.query(api.lib.getUrl, {
      key: "x/y.png",
      responseContentDisposition: "attachment",
    })
    expect(
      url.startsWith("https://test-bucket.s3.eu-west-1.amazonaws.com/x/y.png?")
    ).toBe(true)
    expect(url).toContain("response-content-disposition=attachment")
  })
})
