const UNITS = ["B", "KB", "MB", "GB", "TB"]

/** `1.5 MB`: binary sizes, one decimal above a kilobyte. */
export function formatBytes(bytes: number) {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`
}
