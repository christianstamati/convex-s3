import { describe, expect, test } from "vitest"
import { keyAfter, keyProblem, prefixEnd } from "./keys.js"

describe("keys", () => {
  test("prefixEnd is the next string in code point order", () => {
    expect(prefixEnd("a/")).toBe("a0")
    expect(prefixEnd("")).toBeNull()
    expect(prefixEnd("a\u{10FFFF}")).toBe("b")
    expect(prefixEnd("\u{10FFFF}")).toBeNull()
    expect(prefixEnd("퟿")).toBe("")
    // Above U+FFFF: "a/\u{1F600}" sorts before the bound.
    const end = prefixEnd("a/") ?? ""
    expect(
      new TextEncoder().encode("a/\u{1F600}") < new TextEncoder().encode(end)
    ).toBe(true)
  })

  test("keyAfter is just above the key", () => {
    expect(keyAfter("a") > "a").toBe(true)
    expect(keyAfter("a") < "a!").toBe(true)
  })

  test("keyProblem", () => {
    expect(keyProblem("ok/key name.txt")).toBeNull()
    expect(keyProblem("a/../b")).toContain("..")
    expect(keyProblem("/abs")).toContain("start")
    expect(keyProblem("")).toContain("empty")
  })
})
