/**
 * The provider suite: the component's flows against a real S3-compatible
 * endpoint, named by the S3_* env vars (as the component reads them).
 * `bun run test:providers`; skipped when S3_BUCKET isn't set. Everything is
 * written under `providers/<run>/` and deleted at the end.
 *
 * CI runs it against MinIO, and against Cloudflare R2 when the repo has R2
 * secrets. Set S3_PROVIDER_NO_POST=1 and S3_PROVIDER_NO_TAGGING=1 for
 * providers without POST uploads or object tags (R2).
 */
/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterAll, describe, expect, test } from "vitest"
import { api } from "./component/_generated/api"
import schema from "./component/schema"
import { configFromEnv } from "./shared/config"
import { copyObject, headObject } from "./shared/s3"
import { sha256 } from "./shared/sigv4"

const modules = import.meta.glob(["./component/**/*.ts", "!./**/*.test.ts"])
const enabled = Boolean(process.env.S3_BUCKET)
const noPost = process.env.S3_PROVIDER_NO_POST === "1"
const noTagging = process.env.S3_PROVIDER_NO_TAGGING === "1"
const MiB = 1024 * 1024
const prefix = `providers/${Date.now()}/`

const encoder = new TextEncoder()
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)

function setup() {
  return convexTest(schema, modules)
}

/**
 * Lets scheduled work (background deletes) run to the end. Real timers:
 * faking them would also fire the connect timeouts inside Node's fetch.
 */
async function settle(t: ReturnType<typeof setup>) {
  for (let round = 0; round < 10; round++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await t.finishInProgressScheduledFunctions()
  }
}

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

async function single(
  t: ReturnType<typeof setup>,
  key: string,
  size: number,
  put: Record<string, unknown> = {}
) {
  const ticket = await t.mutation(api.uploads.generateUploadUrl, {
    key,
    size,
    put,
  })
  if (ticket.method !== "single") throw new Error("single expected")
  return ticket
}

async function stored(t: ReturnType<typeof setup>, key: string, body: string) {
  const data = encoder.encode(body)
  const ticket = await single(t, key, data.length, {
    contentType: "text/plain",
  })
  const response = await put(ticket, data)
  if (!response.ok) throw new Error(`PUT ${response.status}`)
  await t.action(api.uploads.syncMetadata, {
    key: ticket.key,
    token: ticket.token,
  })
  return ticket
}

describe.skipIf(!enabled)("provider", () => {
  afterAll(async () => {
    const t = setup()
    await t.mutation(api.lib.deletePrefix, { prefix })
    await settle(t)
  })

  test("a presigned PUT takes only the signed size, then reads back", async () => {
    const t = setup()
    const ticket = await single(t, `${prefix}sized.txt`, 5, {
      contentType: "text/plain",
    })
    expect((await put(ticket, bytes(6))).status).toBe(403)
    expect((await put(ticket, encoder.encode("hello"))).status).toBe(200)
    const { metadata } = await t.action(api.uploads.syncMetadata, {
      key: ticket.key,
      token: ticket.token,
    })
    expect(metadata).toMatchObject({ size: 5, contentType: "text/plain" })
    expect(metadata.metadata).toBeUndefined()
    expect(await (await fetch(metadata.url)).text()).toBe("hello")
  })

  test("a SHA-256 checksum is verified", async () => {
    const t = setup()
    const body = encoder.encode("checked")
    const digest = btoa(
      String.fromCharCode(...new Uint8Array(await sha256(body)))
    )
    const good = await single(t, `${prefix}sum.txt`, body.length, {
      checksumSha256: digest,
    })
    expect((await put(good, body)).status).toBe(200)
    const bad = await single(t, `${prefix}bad-sum.txt`, body.length, {
      checksumSha256: digest,
    })
    expect(
      (await put(bad, encoder.encode("CHECKED"))).status
    ).toBeGreaterThanOrEqual(400)
  })

  test("conditional writes: a ticket at a taken key can't overwrite or delete it", async () => {
    const t = setup()
    const key = `${prefix}taken.txt`
    await stored(t, key, "mine")
    const second = await single(t, key, 6)
    expect((await put(second, encoder.encode("theirs"))).status).toBe(412)
    await t.action(api.uploads.abortUpload, {
      key: second.key,
      token: second.token,
    })
    const info = await t.action(api.objects.getObject, { key })
    expect(new TextDecoder().decode(info?.data)).toBe("mine")
  })

  test("a PUT URL can't be replayed after sync", async () => {
    const t = setup()
    const ticket = await stored(t, `${prefix}replay.txt`, "good")
    expect((await put(ticket, encoder.encode("evil"))).status).toBe(412)
  })

  test("multipart: parts, listing, conditional completion", async () => {
    const t = setup()
    const size = 5 * MiB + 1234
    const data = new Uint8Array(size).map((_, i) => i % 251)
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: `${prefix}multi.bin`,
      size,
      multipartThreshold: MiB,
      partSize: 5 * MiB,
    })
    if (ticket.method !== "multipart") throw new Error("multipart expected")
    const keyToken = { key: ticket.key, token: ticket.token }
    const { partSize, partCount } = await t.action(
      api.uploads.createMultipartUpload,
      keyToken
    )
    expect(partCount).toBe(2)
    const urls = await t.mutation(api.uploads.signUploadParts, {
      ...keyToken,
      partNumbers: [1, 2],
    })
    const parts: { partNumber: number; etag: string }[] = []
    for (const { partNumber, url } of urls) {
      const start = (partNumber - 1) * partSize
      const response = await fetch(url, {
        method: "PUT",
        body: data.slice(start, start + partSize) as BodyInit,
      })
      expect(response.status).toBe(200)
      const etag = response.headers.get("etag")
      expect(etag).toBeTruthy()
      parts.push({ partNumber, etag: etag ?? "" })
    }
    const listed = await t.action(api.uploads.listUploadedParts, keyToken)
    expect(listed.map((p) => p.partNumber)).toEqual([1, 2])
    const { metadata } = await t.action(api.uploads.completeMultipartUpload, {
      ...keyToken,
      parts,
    })
    expect(metadata.size).toBe(size)
    const tail = await t.action(api.objects.getObject, {
      key: ticket.key,
      range: `bytes=${size - 4}-`,
    })
    expect(
      Array.from(new Uint8Array(tail?.data ?? new ArrayBuffer(0)))
    ).toEqual(Array.from(data.slice(size - 4)))
  })

  test("multipart: abort", async () => {
    const t = setup()
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: `${prefix}aborted.bin`,
      size: 6 * MiB,
      multipartThreshold: MiB,
      partSize: 5 * MiB,
    })
    if (ticket.method !== "multipart") throw new Error("multipart expected")
    const keyToken = { key: ticket.key, token: ticket.token }
    await t.action(api.uploads.createMultipartUpload, keyToken)
    await t.action(api.uploads.abortUpload, keyToken)
    await expect(
      t.action(api.uploads.listUploadedParts, keyToken)
    ).rejects.toThrow()
  })

  test.skipIf(noPost)("POST policy caps the size", async () => {
    const t = setup()
    const ticket = await t.mutation(api.uploads.generateUploadPost, {
      key: `${prefix}form.png`,
      maxSize: 10,
      put: { contentType: "image/png" },
    })
    if (ticket.method !== "post") throw new Error("post expected")
    const post = async (size: number) => {
      const form = new FormData()
      for (const [name, value] of Object.entries(ticket.fields)) {
        form.append(name, value)
      }
      form.append("file", new Blob([bytes(size)], { type: "image/png" }))
      return await fetch(ticket.url, { method: "POST", body: form })
    }
    expect((await post(11)).status).toBe(400)
    expect([200, 204]).toContain((await post(8)).status)
    const { metadata } = await t.action(api.uploads.syncMetadata, {
      key: ticket.key,
      token: ticket.token,
    })
    expect(metadata).toMatchObject({ size: 8, contentType: "image/png" })
  })

  test("listing with folders, copy, move", async () => {
    const t = setup()
    await stored(t, `${prefix}folder/a.txt`, "a")
    await stored(t, `${prefix}src.txt`, "copy me")
    const listing = await t.action(api.objects.listObjects, {
      prefix,
      delimiter: "/",
    })
    expect(listing.prefixes).toContain(`${prefix}folder/`)

    const copy = await t.action(api.objects.copyObject, {
      sourceKey: `${prefix}src.txt`,
      destinationKey: `${prefix}copy.txt`,
    })
    expect(copy.metadata.contentType).toBe("text/plain")
    const moved = await t.action(api.objects.moveObject, {
      sourceKey: `${prefix}copy.txt`,
      destinationKey: `${prefix}moved.md`,
      put: { contentType: "text/markdown" },
    })
    expect(moved.metadata.contentType).toBe("text/markdown")
    expect(
      await t.action(api.objects.headObject, { key: `${prefix}copy.txt` })
    ).toBeNull()
  })

  test.skipIf(noTagging)("tags", async () => {
    const t = setup()
    await stored(t, `${prefix}tagged.txt`, "t")
    await t.action(api.objects.putObjectTagging, {
      key: `${prefix}tagged.txt`,
      tags: { stage: "tested" },
    })
  })

  test("a copy above the threshold goes part by part", async () => {
    const config = configFromEnv(process.env as never)
    const t = setup()
    const size = 6 * MiB
    const ticket = await t.mutation(api.uploads.generateUploadUrl, {
      key: `${prefix}big-source.bin`,
      size,
      multipartThreshold: 100 * MiB,
    })
    if (ticket.method !== "single") throw new Error("single expected")
    expect((await put(ticket, bytes(size, 3))).status).toBe(200)
    const source = await headObject(config, ticket.key)
    if (source === null) throw new Error("no source")
    await copyObject(config, ticket.key, `${prefix}big-copy.bin`, {
      source,
      multipartThreshold: MiB,
      partSize: 5 * MiB,
    })
    const copy = await headObject(config, `${prefix}big-copy.bin`)
    expect(copy?.size).toBe(size)
    expect(copy?.etag).toMatch(/-2$/)
  })

  test("deletes in batches and by prefix", async () => {
    const t = setup()
    for (const name of ["x1", "x2", "x3"]) {
      await stored(t, `${prefix}batch/${name}`, name)
    }
    await t.mutation(api.lib.deleteObjects, {
      keys: [`${prefix}batch/x1`, `${prefix}batch/x2`],
    })
    await settle(t)
    const left = await t.action(api.objects.listObjects, {
      prefix: `${prefix}batch/`,
    })
    expect(left.objects.map((o) => o.key)).toEqual([`${prefix}batch/x3`])

    await t.mutation(api.lib.deletePrefix, { prefix: `${prefix}batch/` })
    await settle(t)
    const none = await t.action(api.objects.listObjects, {
      prefix: `${prefix}batch/`,
    })
    expect(none.objects).toEqual([])
  })
})
