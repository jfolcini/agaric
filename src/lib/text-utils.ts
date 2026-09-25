/**
 * Strip markdown formatting and wiki-link brackets (a `[[x|label]]` reads as
 * its label, #5160 D9), then truncate.
 */
export function truncateContent(
  content: string | null,
  max = 120,
  emptyFallback = '(empty)',
): string {
  if (!content) return emptyFallback
  const plain = content
    .replace(
      /\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g,
      (_m, inner: string, label?: string) => label || inner,
    )
    .replace(/[#*_~`]/g, '')
  return plain.length > max ? `${plain.slice(0, max)}...` : plain
}
