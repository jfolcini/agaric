/**
 * Format a timestamp string for display.
 * @param isoString - ISO 8601 timestamp string
 * @param style - 'full' (date + time), 'date' (date only), 'relative' (e.g. "2 hours ago")
 */
export function formatTimestamp(
  isoString: string,
  style: 'full' | 'date' | 'relative' = 'full',
): string {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return isoString

  if (style === 'relative') {
    const now = Date.now()
    const diffMs = now - date.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return 'Just now'
    if (diffMin < 60) return `${diffMin}m ago`
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return `${diffHr}h ago`
    const diffDay = Math.floor(diffHr / 24)
    if (diffDay < 30) return `${diffDay}d ago`
    return date.toLocaleDateString()
  }

  if (style === 'date') {
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }

  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
