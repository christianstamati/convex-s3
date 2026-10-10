/**
 * The Drive example's paths. A folder is a key prefix under `drive/`: the
 * folder `Docs/2026/` is every key starting with `drive/Docs/2026/`, plus a
 * zero-byte marker at exactly that key so an empty folder exists. Paths
 * from the browser are relative to the root: "" or "Docs/2026/".
 */

export const DRIVE_ROOT = "drive/"

/** Why a file or folder name can't be used, or null. */
export function nameProblem(name: string): string | null {
  if (name.trim() === "") return "Give it a name"
  if (name.length > 200) return "Names can be 200 characters at most"
  if (name === "." || name === "..") return `"${name}" isn't a valid name`
  if (/[/\\]/.test(name)) return "Names can't contain / or \\"
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the check
  if (/[\u0000-\u001f\u007f]/.test(name))
    return "Names can't contain control characters"
  return null
}

/** A browser-given name made usable: slashes and control characters go. */
export function cleanName(name: string) {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]+/g, "-")
    .trim()
    .slice(0, 200)
  return cleaned === "" || cleaned === "." || cleaned === ".."
    ? "Untitled"
    : cleaned
}

/** "" or "a/b/", or null when a segment isn't a valid name. */
export function normalizePath(path: string): string | null {
  const segments = path.split("/").filter((segment) => segment !== "")
  if (segments.some((segment) => nameProblem(segment) !== null)) return null
  return segments.length === 0 ? "" : `${segments.join("/")}/`
}

/** The key prefix of a folder path. */
export function folderPrefix(path: string) {
  const normalized = normalizePath(path)
  if (normalized === null) throw new Error(`Invalid folder path: ${path}`)
  return `${DRIVE_ROOT}${normalized}`
}

/** A prefix or key back to a path relative to the root. */
export function pathOf(prefixOrKey: string) {
  return prefixOrKey.startsWith(DRIVE_ROOT)
    ? prefixOrKey.slice(DRIVE_ROOT.length)
    : prefixOrKey
}

/** The last segment: a file's name, or a folder's (without its slash). */
export function nameOf(prefixOrKey: string) {
  const trimmed = prefixOrKey.endsWith("/")
    ? prefixOrKey.slice(0, -1)
    : prefixOrKey
  return trimmed.slice(trimmed.lastIndexOf("/") + 1)
}

/** The prefix of the folder holding a key or a folder prefix. */
export function parentOf(prefixOrKey: string) {
  const trimmed = prefixOrKey.endsWith("/")
    ? prefixOrKey.slice(0, -1)
    : prefixOrKey
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1)
}

/** `report.pdf`, `report (2).pdf`, `report (3).pdf`…; folders have no extension. */
export function numbered(name: string, n: number, isFolder = false) {
  if (n <= 1) return name
  const dot = isFolder ? -1 : name.lastIndexOf(".")
  return dot > 0
    ? `${name.slice(0, dot)} (${n})${name.slice(dot)}`
    : `${name} (${n})`
}

/** Whether a key is inside the Drive (and isn't its root). */
export function isDriveKey(key: string) {
  return key.startsWith(DRIVE_ROOT) && key.length > DRIVE_ROOT.length
}

/** `attachment` with the name, ASCII-safe and in full for browsers. */
export function attachment(name: string) {
  const ascii = name.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "_")
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
