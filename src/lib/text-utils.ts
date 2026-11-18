import { readLinkLabels } from '@/editor/markdown-common'

/**
 * Strip markdown formatting and wiki-link brackets (a stored `[[ULID|label]]`
 * reads as its label, #5160 D9), then truncate.
 */
export function truncateContent(
  content: string | null,
  max = 120,
  emptyFallback = '(empty)',
): string {
  if (!content) return emptyFallback
  const plain = readLinkLabels(content)
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/[#*_~`]/g, '')
  return plain.length > max ? `${plain.slice(0, max)}...` : plain
}

/**
 * Cut `text` to at most `max` characters, ending in `…` when cut, so a name or
 * path fits a fixed-size toast. Counts code points, so it never splits a
 * surrogate pair (an emoji) in half.
 */
export function clampText(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

/** [`clampText`] keeping the end, for a path whose file name is at its end. */
export function clampTextEnd(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `…${chars.slice(chars.length - max + 1).join('')}` : text
}
