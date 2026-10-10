import { describe, expect, test } from "vitest"
import { attachment } from "./attachment"
import {
  cleanName,
  folderPrefix,
  nameOf,
  nameProblem,
  normalizePath,
  numbered,
  parentOf,
  pathOf,
} from "./drivePaths"

describe("drive paths", () => {
  test("normalizes folder paths", () => {
    expect(normalizePath("")).toBe("")
    expect(normalizePath("/Docs//2026")).toBe("Docs/2026/")
    expect(normalizePath("a/../b")).toBeNull()
    expect(folderPrefix("Docs")).toBe("drive/Docs/")
    expect(() => folderPrefix("..")).toThrow()
  })

  test("names", () => {
    expect(nameProblem("ok name.txt")).toBeNull()
    expect(nameProblem("a/b")).toContain("/")
    expect(nameProblem(" ")).toBe("Give it a name")
    expect(cleanName("  a/b\\c\u0007.txt ")).toBe("a-b-c.txt")
    expect(cleanName("..")).toBe("Untitled")
  })

  test("splits keys and prefixes", () => {
    expect(nameOf("drive/Docs/report.pdf")).toBe("report.pdf")
    expect(nameOf("drive/Docs/2026/")).toBe("2026")
    expect(parentOf("drive/Docs/report.pdf")).toBe("drive/Docs/")
    expect(parentOf("drive/Docs/2026/")).toBe("drive/Docs/")
    expect(pathOf("drive/Docs/2026/")).toBe("Docs/2026/")
  })

  test("numbers duplicates before the extension", () => {
    expect(numbered("report.pdf", 1)).toBe("report.pdf")
    expect(numbered("report.pdf", 2)).toBe("report (2).pdf")
    expect(numbered(".env", 2)).toBe(".env (2)")
    expect(numbered("v1.2", 3, true)).toBe("v1.2 (3)")
  })

  test("download names survive non-ASCII", () => {
    expect(attachment('Résumé "final".pdf')).toBe(
      `attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`
    )
  })
})
