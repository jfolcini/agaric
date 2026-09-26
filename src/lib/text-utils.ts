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
  const plain = content
    .replace(/\[\[[0-9A-Z]{26}\|([^\]\n]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/[#*_~`]/g, '')
  return plain.length > max ? `${plain.slice(0, max)}...` : plain
}
