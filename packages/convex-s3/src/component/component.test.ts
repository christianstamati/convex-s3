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

describe("tickets own their objects", () => {
  async function ticket(
    t: ReturnType<typeof setup>,
    key: string,
    size: number
  ) {
    const result = await t.mutation(api.uploads.generateUploadUrl, {
      key,
      size,
    })
    if (result.method !== "single") throw new Error("single expected")
    return result
  }

  test("a refused upload at a taken key never deletes what's there", async () => {
    const t = setup()
    const a = await ticket(t, "shared.txt", 1)
    const b = await ticket(t, "shared.txt", 2)
    await put(a, bytes(1, 1))
    await t.action(api.uploads.syncMetadata, { key: a.key, token: a.token })

    expect((await put(b, bytes(2, 2))).status).toBe(412)
    await expect(
      t.action(api.uploads.syncMetadata, { key: b.key, token: b.token })
    ).rejects.toThrow("didn't arrive")
    await t.action(api.uploads.abortUpload, { key: b.key, token: b.token })
    expect(s3.objects.get("shared.txt")?.data).toEqual(bytes(1, 1))
  })

  test("an abandoned ticket's expiry leaves another upload's object", async () => {
    const t = setup()
    await ticket(t, "name.txt", 1)
    const b = await ticket(t, "name.txt", 1)
    await put(b, bytes(1))
    await t.action(api.uploads.syncMetadata, { key: b.key, token: b.token })
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(s3.objects.has("name.txt")).toBe(true)
  })

  test("a PUT URL can't be replayed after the upload", async () => {
    const t = setup()
    const a = await ticket(t, "once.bin", 4)
    await put(a, bytes(4))
    await t.action(api.uploads.syncMetadata, { key: a.key, token: a.token })
    expect((await put(a, bytes(4, 9))).status).toBe(412)
    expect(s3.objects.get("once.bin")?.data).toEqual(bytes(4))
  })

  test("two syncs at once record the upload once", async () => {
    const t = setup()
    const a = await ticket(t, "twice.txt", 1)
    await put(a, bytes(1))
    const results = await Promise.allSettled([
      t.action(api.uploads.syncMetadata, { key: a.key, token: a.token }),
      t.action(api.uploads.syncMetadata, { key: a.key, token: a.token }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  })

  test("a URL replayed after its object is deleted is swept at expiry", async () => {
    const t = setup()
    const a = await ticket(t, "gone.txt", 3)
    await put(a, bytes(3))
    await t.action(api.uploads.syncMetadata, { key: a.key, token: a.token })
    await t.mutation(api.lib.deleteObject, { key: "gone.txt" })
    // Run the background delete, not yet the ticket's expiry.
    vi.advanceTimersByTime(1)
    await t.finishInProgressScheduledFunctions()
    expect(s3.objects.has("gone.txt")).toBe(false)

    // The URL still works until it expires: the object comes back...
    expect((await put(a, bytes(3, 4))).status).toBe(200)
    // ...and the key stays in use until then, so nobody else collides.
    expect(await t.query(api.lib.keyInUse, { key: "gone.txt" })).toBe(true)

    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(s3.objects.has("gone.txt")).toBe(false)
    expect(await t.query(api.lib.keyInUse, { key: "gone.txt" })).toBe(false)
  })

  test("a ticket's key is in use until it expires", async () => {
    const t = setup()
    expect(await t.query(api.lib.keyInUse, { key: "held.txt" })).toBe(false)
    await ticket(t, "held.txt", 1)
    expect(await t.query(api.lib.keyInUse, { key: "held.txt" })).toBe(true)
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await t.query(api.lib.keyInUse, { key: "held.txt" })).toBe(false)
  })

  test("the marker is signed, kept out of the record, and reserved", async () => {
    const t = setup()
    const a = await ticket(t, "m.txt", 1)
    expect(Object.keys(a.headers)).toContain("x-amz-meta-upload-ticket")
    await put(a, bytes(1))
    const { metadata } = await t.action(api.uploads.syncMetadata, {
      key: a.key,
      token: a.token,
    })
    expect(metadata.metadata).toBeUndefined()
    await expect(
      t.mutation(api.uploads.generateUploadUrl, {
        key: "x",
        put: { metadata: { "Upload-Ticket": "forged" } },
      })
    ).rejects.toThrow("reserved")
  })

  test("refuses headers that can't be signed, and impossible options", async () => {
    const t = setup()
    await expect(
      t.mutation(api.uploads.generateUploadUrl, {
        key: "x",
        put: { contentDisposition: 'attachment; filename="é.txt"' },
      })
    ).rejects.toThrow("printable ASCII")
    await expect(
      t.mutation(api.uploads.generateUploadUrl, {
        key: "x",
        size: 10 * MiB,
        multipartThreshold: MiB,
        put: { checksumSha256: "abc" },
      })
    ).rejects.toThrow("multipart")
    await expect(
      t.mutation(api.uploads.generateUploadPost, {
        key: "x",
        maxSize: 10,
        put: { ifNoneMatch: true },
      })
    ).rejects.toThrow("can't refuse to overwrite")
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

  async function uploadAllParts(
    t: ReturnType<typeof setup>,
    keyToken: { key: string; token: string },
    size: number,
    partSize: number
  ) {
    const count = Math.ceil(size / partSize)
    const urls = await t.mutation(api.uploads.signUploadParts, {
      ...keyToken,
      partNumbers: Array.from({ length: count }, (_, i) => i + 1),
    })
    const parts: { partNumber: number; etag: string }[] = []
    for (const { partNumber, url } of urls) {
      const length = Math.min(partSize, size - (partNumber - 1) * partSize)
      const response = await fetch(url, {
        method: "PUT",
        body: bytes(length) as BodyInit,
      })
      parts.push({ partNumber, etag: response.headers.get("etag") ?? "" })
    }
    return parts
  }

  test("a completion S3 finished but that failed to record can be retried", async () => {
    const t = setup()
    const { keyToken, started } = await startMultipart(t, 6 * MiB)
    const parts = await uploadAllParts(t, keyToken, 6 * MiB, started.partSize)
    s3.failWhen = (request) => request.method === "HEAD"
    await expect(
      t.action(api.uploads.completeMultipartUpload, { ...keyToken, parts })
    ).rejects.toThrow()
    s3.failWhen = undefined
    // S3 already completed it: the retry records it instead of failing.
    const { metadata } = await t.action(api.uploads.completeMultipartUpload, {
      ...keyToken,
      parts,
    })
    expect(metadata.size).toBe(6 * MiB)
  })

  test("aborting after S3 completed but before recording removes the object", async () => {
    const t = setup()
    const { keyToken, started } = await startMultipart(t, 6 * MiB)
    const parts = await uploadAllParts(t, keyToken, 6 * MiB, started.partSize)
    s3.failWhen = (request) => request.method === "HEAD"
    await expect(
      t.action(api.uploads.completeMultipartUpload, { ...keyToken, parts })
    ).rejects.toThrow()
    s3.failWhen = undefined
    expect(s3.objects.has("video.bin")).toBe(true)
    await t.action(api.uploads.abortUpload, keyToken)
    expect(s3.objects.has("video.bin")).toBe(false)
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

  test("lists one folder level from the recorded objects", async () => {
    const t = setup()
    await seed(t, [
      "d/a.txt",
      "d/b/",
      "d/b/c.txt",
      "d/b/e/f.txt",
      "d/empty/",
      "d/z/1",
      "e/x",
    ])
    const top = await t.query(api.lib.listFolder, {})
    expect(top).toMatchObject({ folders: ["d/", "e/"], objects: [] })

    const d = await t.query(api.lib.listFolder, { prefix: "d/" })
    expect(d.folders).toEqual(["d/b/", "d/empty/", "d/z/"])
    expect(d.objects.map((o) => o.key)).toEqual(["d/a.txt"])

    // The folder's own marker isn't listed; an empty folder is empty.
    const b = await t.query(api.lib.listFolder, { prefix: "d/b/" })
    expect(b.folders).toEqual(["d/b/e/"])
    expect(b.objects.map((o) => o.key)).toEqual(["d/b/c.txt"])
    expect(
      await t.query(api.lib.listFolder, { prefix: "d/empty/" })
    ).toMatchObject({ folders: [], objects: [] })

    // In key order: d/a.txt, then the folder d/b/, then the limit.
    const limited = await t.query(api.lib.listFolder, {
      prefix: "d/",
      limit: 2,
    })
    expect(limited.folders).toEqual(["d/b/"])
    expect(limited.objects.map((o) => o.key)).toEqual(["d/a.txt"])
    expect(limited.isTruncated).toBe(true)
  })

  test("walks large folders in batches", async () => {
    const t = setup()
    const keys = Array.from(
      { length: 250 },
      (_, i) => `big/${String(i).padStart(3, "0")}.txt`
    )
    await t.run(async (ctx) => {
      for (const key of keys) {
        await ctx.db.insert("objects", {
          bucket: "test-bucket",
          key,
          size: 1,
          lastModified: 0,
        })
      }
      await ctx.db.insert("objects", {
        bucket: "test-bucket",
        key: "big/sub/x",
        size: 1,
        lastModified: 0,
      })
    })
    const listing = await t.query(api.lib.listFolder, { prefix: "big/" })
    expect(listing.objects).toHaveLength(250)
    expect(listing.folders).toEqual(["big/sub/"])
    expect(listing.isTruncated).toBe(false)
  })

  test("keys with characters above U+FFFF stay inside their prefixes", async () => {
    const t = setup()
    await seed(t, ["d/\u{1F600}.txt", "d/a/\u{1F600}.png", "d/z.txt", "e/x"])
    expect(await t.query(api.lib.listFolder, {})).toMatchObject({
      folders: ["d/", "e/"],
      isTruncated: false,
    })
    const d = await t.query(api.lib.listFolder, { prefix: "d/" })
    expect(d.folders).toEqual(["d/a/"])
    expect(d.objects.map((o) => o.key)).toEqual(["d/z.txt", "d/\u{1F600}.txt"])
    const rows = await t.query(api.lib.listMetadata, {
      prefix: "d/",
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(rows.page).toHaveLength(3)
    await t.mutation(api.lib.deletePrefix, { prefix: "d/" })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const left = await t.query(api.lib.listMetadata, {
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(left.page.map((o) => o.key)).toEqual(["e/x"])
  })

  test("listFolder pages with its cursor", async () => {
    const t = setup()
    const keys: string[] = []
    for (let i = 0; i < 20; i++)
      keys.push(`p/${String(i).padStart(2, "0")}.txt`)
    for (let i = 0; i < 5; i++) keys.push(`p/f${i}/a`, `p/f${i}/b`)
    await t.run(async (ctx) => {
      for (const key of keys) {
        await ctx.db.insert("objects", {
          bucket: "test-bucket",
          key,
          size: 1,
          lastModified: 0,
        })
      }
    })
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const result: {
        folders: string[]
        objects: { key: string }[]
        cursor: string | null
      } = await t.query(api.lib.listFolder, { prefix: "p/", limit: 7, cursor })
      seen.push(...result.folders, ...result.objects.map((o) => o.key))
      cursor = result.cursor
      if (cursor === null) break
    }
    const expected = [
      ...keys.filter((k) => !k.includes("/f")),
      ...[0, 1, 2, 3, 4].map((i) => `p/f${i}/`),
    ]
    expect(seen.sort()).toEqual(expected.sort())
    await expect(
      t.query(api.lib.listFolder, { prefix: "p/", cursor: "a" })
    ).rejects.toThrow("another prefix")
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
