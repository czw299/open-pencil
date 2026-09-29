import { bytesToHex } from './node-change/bytes'

/**
 * Inspect the serialized payload, not just scene fills: imported schemas retain
 * image sources in styles, overrides, thumbnails and fields unknown to our model.
 * Exact matches anywhere are conservatively retained, including opaque string IDs.
 */
export function collectImageReferences(
  value: unknown,
  available: ReadonlySet<string>
): Set<string> {
  const referenced = new Set<string>()
  const byteLengths = new Set(
    [...available].filter((hash) => /^(?:[a-f0-9]{2})+$/i.test(hash)).map((hash) => hash.length / 2)
  )
  function visit(value: unknown): void {
    if (typeof value === 'string') {
      if (available.has(value)) referenced.add(value)
      return
    }
    if (value instanceof Uint8Array) {
      if (byteLengths.has(value.length)) {
        const hash = bytesToHex(value)
        if (available.has(hash)) referenced.add(hash)
      }
      return
    }
    if (Array.isArray(value)) {
      // Kiwi normally decodes bytes as Uint8Array; retain ordinary byte arrays too.
      if (
        byteLengths.has(value.length) &&
        value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
      ) {
        const hash = bytesToHex(new Uint8Array(value))
        if (available.has(hash)) referenced.add(hash)
      }
      for (const item of value) visit(item)
    } else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item)
    }
  }
  visit(value)
  return referenced
}
