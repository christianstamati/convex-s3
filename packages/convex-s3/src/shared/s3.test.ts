import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { FakeS3 } from "../testing/fakeS3"
import { copyObject, headObject } from "./s3"

let s3: FakeS3

beforeEach(() => {
  s3 = new FakeS3({ minPartSize: 1 })
  vi.stubGlobal("fetch", s3.fetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("copyObject", () => {
  test("copies part by part above the threshold, keeping the headers", async () => {
    const data = new Uint8Array(1000).map((_, i) => i % 251)
    s3.put("big.bin", data, "video/mp4")
    const source = await headObject(s3.config, "big.bin")
    if (source === null) throw new Error("no source")

    await copyObject(s3.config, "big.bin", "copy.bin", {
      source,
      multipartThreshold: 100,
      partSize: 300,
    })

    const copy = s3.objects.get("copy.bin")
    expect(copy?.data).toEqual(data)
    expect(copy?.contentType).toBe("video/mp4")
    // A multipart ETag: four parts of 300, 300, 300 and 100 bytes.
    expect(copy?.etag).toMatch(/-4$/)
    expect(s3.uploads.size).toBe(0)
  })

  test("aborts the multipart copy when a part fails", async () => {
    s3.put("src.bin", new Uint8Array(500))
    const source = await headObject(s3.config, "src.bin")
    if (source === null) throw new Error("no source")
    s3.objects.delete("src.bin")

    await expect(
      copyObject(s3.config, "src.bin", "dst.bin", {
        source,
        multipartThreshold: 100,
        partSize: 200,
      })
    ).rejects.toThrow("NoSuchKey")
    expect(s3.uploads.size).toBe(0)
    expect(s3.objects.has("dst.bin")).toBe(false)
  })

  test("copies in one request up to the threshold", async () => {
    s3.put("small.txt", "hello", "text/plain")
    const source = await headObject(s3.config, "small.txt")
    await copyObject(s3.config, "small.txt", "small-copy.txt", {
      source: source ?? undefined,
    })
    expect(s3.requests.filter((r) => r.url.includes("uploadId"))).toEqual([])
    expect(
      new TextDecoder().decode(s3.objects.get("small-copy.txt")?.data)
    ).toBe("hello")
  })
})
