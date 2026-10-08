/**
 * An inline image's display width, carried in its alt text (#4712).
 *
 * Obsidian's convention: `![alt|300](url)` is 300 px wide, and Obsidian also
 * writes `![alt|300x200](url)`, whose height we ignore so the aspect ratio
 * holds. Keeping the size in the alt makes it document content that syncs and
 * survives reload, while the parser, serializer and Rust importer keep carrying
 * the alt as the opaque string they already treat it as.
 */

/** A trailing `|<width>` or `|<width>x<height>`; only the last `|` counts. */
const WIDTH_SUFFIX = /\|([1-9]\d*)(?:x\d+)?$/

export interface ImageAlt {
  /** The alt with any width suffix removed — what readers and the chip see. */
  text: string
  /** Display width in px, or `null` for the image's natural size. */
  width: number | null
}

export function parseImageAlt(alt: string): ImageAlt {
  const match = WIDTH_SUFFIX.exec(alt)
  if (match === null) return { text: alt, width: null }
  return { text: alt.slice(0, match.index), width: Number(match[1]) }
}

export function formatImageAlt(text: string, width: number | null): string {
  return width === null ? text : `${text}|${width}`
}
