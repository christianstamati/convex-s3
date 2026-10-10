/** S3's limit on a key, in UTF-8 bytes. */
export const MAX_KEY_BYTES = 1024

/**
 * Why a key can't be used, or null. Keys are opaque to S3, but `.` and `..`
 * segments would be resolved away by URL parsing on the way.
 */
export function keyProblem(key: string): string | null {
  if (key.length === 0) return "A key can't be empty"
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) {
    return `A key can be ${MAX_KEY_BYTES} bytes at most`
  }
  if (key.startsWith("/")) return "A key can't start with /"
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    return "A key can't contain . or .. segments"
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the check
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    return "A key can't contain control characters"
  }
  return null
}

/** A prefix as keys start with it: no leading slash, one trailing slash. */
export function normalizePrefix(prefix: string | undefined) {
  const trimmed = (prefix ?? "").trim().replace(/^\/+/, "")
  if (trimmed === "") return ""
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`
}

/** A file name safe in a key and a URL: letters, digits, `.`, `_`, `-`. */
export function cleanFileName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? ""
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 120)
  return cleaned === "" ? "file" : cleaned
}

/** `<prefix><uuid>` or `<prefix><uuid>/<clean file name>`. */
export function newKey(prefix: string | undefined, fileName?: string) {
  const id = crypto.randomUUID()
  const start = `${normalizePrefix(prefix)}${id}`
  return fileName === undefined || fileName === ""
    ? start
    : `${start}/${cleanFileName(fileName)}`
}

/**
 * The smallest string after every string that starts with `prefix`: the
 * exclusive upper bound of a prefix range, or null for the empty prefix
 * (no bound). Convex orders strings by their UTF-8 bytes, which is code
 * point order, so this increments the last code point (`a/` → `a0`),
 * dropping maximal ones. `prefix + "\uffff"` would miss keys continuing
 * with characters above U+FFFF, such as emoji.
 */
export function prefixEnd(prefix: string): string | null {
  const points = Array.from(prefix)
  while (points.length > 0) {
    const last = points.pop()?.codePointAt(0) ?? 0
    if (last < 0x10ffff) {
      // Skip the surrogate range, which isn't a code point of its own.
      const next = last + 1 === 0xd800 ? 0xe000 : last + 1
      return points.join("") + String.fromCodePoint(next)
    }
  }
  return null
}

/** The smallest string after `key`, to continue a walk past it. */
export function keyAfter(key: string) {
  return `${key}\u0000`
}
