/** `attachment` with the name, ASCII-safe and in full for browsers. */
export function attachment(name: string) {
  const ascii = name.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "_")
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
