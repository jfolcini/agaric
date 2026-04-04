/**
 * Strip markdown formatting and wiki-link brackets, then truncate.
 */
export function truncateContent(
  content: string | null,
  max = 120,
  emptyFallback = '(empty)',
): string {
  if (!content) return emptyFallback
  const plain = content.replace(/\[\[([^\]]*)\]\]/g, '$1').replace(/[#*_~`]/g, '')
  return plain.length > max ? `${plain.slice(0, max)}...` : plain
}
