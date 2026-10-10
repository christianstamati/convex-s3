/** What a Drive dialog acts on: a file by key, or a folder by path. */
export type DriveTarget =
  | { kind: "file"; key: string; name: string }
  | { kind: "folder"; path: string; name: string }

/** The path of the folder holding a target ("" for the root). */
export function parentPath(target: DriveTarget) {
  const full =
    target.kind === "file"
      ? target.key.replace(/^drive\//, "")
      : target.path.replace(/\/$/, "")
  return full.slice(0, full.lastIndexOf("/") + 1)
}
