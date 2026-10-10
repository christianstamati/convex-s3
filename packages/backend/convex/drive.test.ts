import { afterEach, describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import { setup, type TestConvex } from "./test.setup"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

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
    vi.useFakeTimers()
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
