import { afterEach, describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import { setup } from "./test.setup"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("files", () => {
  test("an upload lands under uploads/ and is listed", async () => {
    const { t, s3 } = setup()
    const ticket = await t.mutation(api.files.generateUploadUrl, {
      fileName: "Q3 report.pdf",
      contentType: "application/pdf",
      size: 3,
      prefix: "somewhere-else/",
    })
    if (ticket.method !== "single") throw new Error("single expected")
    expect(ticket.key).toMatch(/^uploads\/[0-9a-f-]{36}\/Q3-report\.pdf$/)

    await fetch(ticket.url, {
      method: "PUT",
      headers: ticket.headers,
      body: new Uint8Array([1, 2, 3]),
    })
    await t.action(api.files.syncMetadata, {
      key: ticket.key,
      token: ticket.token,
    })

    const files = await t.query(api.files.list, {})
    expect(files).toMatchObject([
      { name: "Q3-report.pdf", size: 3, contentType: "application/pdf" },
    ])
    expect(files[0]?.url).toContain("response-content-disposition=attachment")
    expect(s3.objects.has(ticket.key)).toBe(true)
  })

  test("large files get a multipart ticket", async () => {
    const { t } = setup()
    const ticket = await t.mutation(api.files.generateUploadUrl, {
      fileName: "movie.mp4",
      size: 20 * 1024 * 1024,
    })
    expect(ticket).toMatchObject({ method: "multipart", partCount: 4 })
  })

  test("refuses files over 2 GB", async () => {
    const { t } = setup()
    await expect(
      t.mutation(api.files.generateUploadUrl, { size: 3 * 1024 ** 3 })
    ).rejects.toThrow("2 GB at most")
  })

  test("removing a file deletes its object", async () => {
    vi.useFakeTimers()
    const { t, s3 } = setup()
    const ticket = await t.mutation(api.files.generateUploadUrl, {
      fileName: "a.txt",
      size: 1,
    })
    if (ticket.method !== "single") throw new Error("single expected")
    await fetch(ticket.url, {
      method: "PUT",
      headers: ticket.headers,
      body: new Uint8Array([1]),
    })
    await t.action(api.files.syncMetadata, {
      key: ticket.key,
      token: ticket.token,
    })
    const [file] = await t.query(api.files.list, {})
    if (!file) throw new Error("no file")
    await t.mutation(api.files.remove, { id: file._id })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await t.query(api.files.list, {})).toEqual([])
    expect(s3.objects.has(ticket.key)).toBe(false)
    vi.useRealTimers()
  })
})
