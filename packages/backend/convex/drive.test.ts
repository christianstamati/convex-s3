import { describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import { setup, type TestConvex } from "./test.setup"

/** What the browser does: ask for a ticket, PUT, sync. */
async function upload(
  t: TestConvex,
  path: string,
  fileName: string,
  body = "x"
) {
  const data = new TextEncoder().encode(body)
  const ticket = await t.mutation(api.drive.generateUploadUrl, {
    fileName,
    size: data.length,
    contentType: "text/plain",
    prefix: path,
  })
  if (ticket.method !== "single") throw new Error("single expected")
  const response = await fetch(ticket.url, {
    method: "PUT",
    headers: ticket.headers,
    body: data,
  })
  if (!response.ok) throw new Error(`PUT ${response.status}`)
  await t.action(api.drive.syncMetadata, {
    key: ticket.key,
    token: ticket.token,
  })
  return ticket.key
}

const names = async (t: TestConvex, path: string) => {
  const listing = await t.query(api.drive.list, { path })
  return {
    folders: listing.folders.map((f) => f.name),
    files: listing.files.map((f) => f.name),
  }
}

describe("drive", () => {
  test("folders are prefixes; uploads keep their names", async () => {
    const { t, s3 } = setup()
    expect(
      await t.action(api.drive.createFolder, { path: "", name: "Docs" })
    ).toBe("Docs/")
    expect(await upload(t, "Docs/", "Q3 report.pdf")).toBe(
      "drive/Docs/Q3 report.pdf"
    )
    await upload(t, "", "notes.txt")

    expect(await names(t, "")).toEqual({
      folders: ["Docs"],
      files: ["notes.txt"],
    })
    expect(await names(t, "Docs/")).toEqual({
      folders: [],
      files: ["Q3 report.pdf"],
    })
    expect(s3.objects.has("drive/Docs/")).toBe(true)
  })

  test("duplicate names are numbered", async () => {
    const { t } = setup()
    await upload(t, "", "report.pdf")
    expect(await upload(t, "", "report.pdf")).toBe("drive/report (2).pdf")
    await t.action(api.drive.createFolder, { path: "", name: "Photos" })
    expect(
      await t.action(api.drive.createFolder, { path: "", name: "Photos" })
    ).toBe("Photos (2)/")
  })

  test("a nested folder makes its parents appear", async () => {
    const { t } = setup()
    await upload(t, "a/b/c/", "deep.txt")
    expect(await names(t, "")).toEqual({ folders: ["a"], files: [] })
    expect(await names(t, "a/b/")).toEqual({ folders: ["c"], files: [] })
  })

  test("renaming a folder moves every key under it", async () => {
    const { t, s3 } = setup()
    await t.action(api.drive.createFolder, { path: "", name: "Old" })
    await upload(t, "Old/", "a.txt", "aaa")
    await upload(t, "Old/sub/", "b.txt")
    expect(
      await t.action(api.drive.renameFolder, { path: "Old/", name: "New" })
    ).toBe("New/")
    expect([...s3.objects.keys()].sort()).toEqual([
      "drive/New/",
      "drive/New/a.txt",
      "drive/New/sub/b.txt",
    ])
    expect(await names(t, "")).toEqual({ folders: ["New"], files: [] })
    expect(await names(t, "New/")).toEqual({
      folders: ["sub"],
      files: ["a.txt"],
    })
  })

  test("moves files and folders, refusing collisions and cycles", async () => {
    const { t } = setup()
    await t.action(api.drive.createFolder, { path: "", name: "A" })
    await t.action(api.drive.createFolder, { path: "", name: "B" })
    const key = await upload(t, "", "x.txt")
    await t.action(api.drive.moveFileTo, { key, path: "A/" })
    expect(await names(t, "A/")).toEqual({ folders: [], files: ["x.txt"] })

    await upload(t, "B/", "x.txt")
    await expect(
      t.action(api.drive.moveFileTo, { key: "drive/B/x.txt", path: "A/" })
    ).rejects.toThrow("already there")

    await expect(
      t.action(api.drive.moveFolderTo, { path: "A/", to: "A/" })
    ).rejects.toThrow("inside itself")
    expect(
      await t.action(api.drive.moveFolderTo, { path: "A/", to: "B/" })
    ).toBe("B/A/")
    expect(await names(t, "B/")).toEqual({ folders: ["A"], files: ["x.txt"] })
  })

  test("a folder move that stopped halfway can be run again", async () => {
    const { t, s3 } = setup()
    await t.action(api.drive.createFolder, { path: "", name: "Old" })
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await upload(t, "Old/", name, name)
    }
    // S3 fails copying b.txt and deleting a.txt's source: the move stops
    // with some keys moved, a.txt copied but its source still there, and b
    // not copied. (Parts run in parallel, so which of the others finished
    // varies; the second run must finish from any of those states.)
    s3.failWhen = (request) =>
      (request.headers.get("x-amz-copy-source")?.endsWith("/Old/b.txt") ??
        false) ||
      (request.method === "DELETE" && request.url.endsWith("/Old/a.txt"))
    await expect(
      t.action(api.drive.renameFolder, { path: "Old/", name: "New" })
    ).rejects.toThrow()

    s3.failWhen = undefined
    expect(
      await t.action(api.drive.renameFolder, { path: "Old/", name: "New" })
    ).toBe("New/")
    expect([...s3.objects.keys()].sort()).toEqual([
      "drive/New/",
      "drive/New/a.txt",
      "drive/New/b.txt",
      "drive/New/c.txt",
    ])
    expect(await names(t, "")).toEqual({ folders: ["New"], files: [] })
  })

  test("a file uploaded in parts doesn't block resuming its folder's move", async () => {
    const { t, s3 } = setup()
    const size = 9 * 1024 * 1024
    const ticket = await t.mutation(api.drive.generateUploadUrl, {
      fileName: "big.bin",
      size,
      prefix: "Old/",
    })
    if (ticket.method !== "multipart") throw new Error("multipart expected")
    const keyToken = { key: ticket.key, token: ticket.token }
    const { partSize, partCount } = await t.action(
      api.drive.createMultipartUpload,
      keyToken
    )
    const urls = await t.mutation(api.drive.signUploadParts, {
      ...keyToken,
      partNumbers: Array.from({ length: partCount }, (_, i) => i + 1),
    })
    const parts: { partNumber: number; etag: string }[] = []
    for (const { partNumber, url } of urls) {
      const length = Math.min(partSize, size - (partNumber - 1) * partSize)
      const response = await fetch(url, {
        method: "PUT",
        body: new Uint8Array(length),
      })
      parts.push({ partNumber, etag: response.headers.get("etag") ?? "" })
    }
    await t.action(api.drive.completeMultipartUpload, { ...keyToken, parts })

    // The copy lands, deleting the source fails: the move stops.
    s3.failWhen = (request) =>
      request.method === "DELETE" && request.url.endsWith("/Old/big.bin")
    await expect(
      t.action(api.drive.renameFolder, { path: "Old/", name: "New" })
    ).rejects.toThrow()
    s3.failWhen = undefined
    // The copy's ETag differs from the multipart source's; it still resumes.
    expect(
      await t.action(api.drive.renameFolder, { path: "Old/", name: "New" })
    ).toBe("New/")
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect([...s3.objects.keys()]).toEqual(["drive/New/big.bin"])
  })

  test("an upload never recorded doesn't block its name", async () => {
    const { t } = setup()
    // Someone takes a ticket for cv.pdf and PUTs, but never syncs.
    const squat = await t.mutation(api.drive.generateUploadUrl, {
      fileName: "cv.pdf",
      size: 1,
      prefix: "",
    })
    if (squat.method !== "single") throw new Error("single expected")
    await fetch(squat.url, {
      method: "PUT",
      headers: squat.headers,
      body: new Uint8Array(1),
    })
    // The next cv.pdf gets a numbered name instead of a refused PUT.
    expect(await upload(t, "", "cv.pdf")).toBe("drive/cv (2).pdf")
  })

  test("a file can be renamed away and back while its ticket lives", async () => {
    const { t } = setup()
    const key = await upload(t, "", "a.txt")
    await t.action(api.drive.renameFile, { key, name: "b.txt" })
    await t.action(api.drive.renameFile, { key: "drive/b.txt", name: "a.txt" })
    expect(await names(t, "")).toEqual({ folders: [], files: ["a.txt"] })
  })

  test("a move onto an existing folder is refused", async () => {
    const { t } = setup()
    await upload(t, "A/", "x.txt")
    await upload(t, "B/", "y.txt")
    await expect(
      t.action(api.drive.renameFolder, { path: "A/", name: "B" })
    ).rejects.toThrow("already there")
  })

  test("opens only safe types in place", async () => {
    const { t } = setup()
    const page = new TextEncoder().encode("<script>alert(1)</script>")
    const ticket = await t.mutation(api.drive.generateUploadUrl, {
      fileName: "page.html",
      size: page.length,
      contentType: "text/html",
      prefix: "",
    })
    if (ticket.method !== "single") throw new Error("single expected")
    await fetch(ticket.url, {
      method: "PUT",
      headers: ticket.headers,
      body: page,
    })
    await t.action(api.drive.syncMetadata, {
      key: ticket.key,
      token: ticket.token,
    })
    const html = await t.mutation(api.drive.fileUrl, {
      key: ticket.key,
      download: false,
    })
    expect(html).toContain("response-content-disposition=attachment")

    const text = await upload(t, "", "notes.txt", "hi")
    const open = await t.mutation(api.drive.fileUrl, {
      key: text,
      download: false,
    })
    expect(open).toContain("response-content-disposition=inline")
  })

  test("renames a file", async () => {
    const { t } = setup()
    const key = await upload(t, "", "draft.txt")
    await t.action(api.drive.renameFile, { key, name: "final.txt" })
    expect(await names(t, "")).toEqual({ folders: [], files: ["final.txt"] })
    await expect(
      t.action(api.drive.renameFile, { key: "drive/final.txt", name: "a/b" })
    ).rejects.toThrow("/")
  })

  test("deleting a folder deletes its prefix", async () => {
    const { t, s3 } = setup()
    await upload(t, "Trash/", "1.txt")
    await upload(t, "Trash/deep/", "2.txt")
    await upload(t, "", "keep.txt")
    await t.mutation(api.drive.removeFolder, { path: "Trash/" })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect([...s3.objects.keys()]).toEqual(["drive/keep.txt"])
    expect(await names(t, "")).toEqual({ folders: [], files: ["keep.txt"] })
    await expect(
      t.mutation(api.drive.removeFolder, { path: "" })
    ).rejects.toThrow("can't be deleted")
  })

  test("signs a fresh URL to open or download a file", async () => {
    const { t } = setup()
    const key = await upload(t, "", "a b.txt", "hello")
    const open = await t.mutation(api.drive.fileUrl, { key, download: false })
    expect(await (await fetch(open)).text()).toBe("hello")
    const download = await t.mutation(api.drive.fileUrl, {
      key,
      download: true,
    })
    expect(download).toContain("response-content-disposition=attachment")
    await expect(
      t.mutation(api.drive.fileUrl, {
        key: "drive/missing.txt",
        download: false,
      })
    ).rejects.toThrow("gone")
  })

  test("caps Drive writes", async () => {
    const { t } = setup()
    const attempts = Array.from({ length: 61 }, (_, i) =>
      t.mutation(api.drive.removeFile, { key: `drive/none-${i}.txt` })
    )
    const results = await Promise.allSettled(attempts)
    const refused = results.filter(
      (r) =>
        r.status === "rejected" &&
        String(r.reason).includes("Too many requests")
    )
    expect(refused.length).toBeGreaterThan(0)
  })

  test("refuses paths outside the Drive", async () => {
    const { t } = setup()
    await expect(
      t.query(api.drive.list, { path: "../uploads" })
    ).rejects.toThrow("isn't valid")
    await expect(
      t.mutation(api.drive.removeFile, { key: "uploads/x" })
    ).rejects.toThrow("isn't a file")
  })
})
