/**
 * Just enough XML for S3's responses, which are flat documents of known
 * shape: the inner text of a tag, and the blocks of a repeated tag. No
 * attributes, no namespaces needed.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
}

export function decodeXml(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    }
    return ENTITIES[entity] ?? match
  })
}

export function encodeXml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function tagPattern(tag: string) {
  return new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<${tag}(?:\\s[^>]*)?/>`,
    "g"
  )
}

/** The inner XML of every `<tag>` block, in order. */
export function blocks(xml: string, tag: string) {
  return Array.from(xml.matchAll(tagPattern(tag)), (m) => m[1] ?? "")
}

/** The decoded text of the first `<tag>`, or undefined. */
export function text(xml: string, tag: string) {
  const first = blocks(xml, tag)[0]
  return first === undefined ? undefined : decodeXml(first)
}

/** The decoded text of every `<tag>`. */
export function texts(xml: string, tag: string) {
  return blocks(xml, tag).map(decodeXml)
}
