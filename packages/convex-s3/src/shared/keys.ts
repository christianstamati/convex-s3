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

/** The upper bound of a prefix range on an index: every key starting with it. */
export function prefixEnd(prefix: string) {
  return `${prefix}￿`
}
