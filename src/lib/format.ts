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

/**
 * Format a last-synced timestamp for display. Returns 'Never synced' for null.
 * Delegates to formatTimestamp with 'relative' style for non-null values.
 */
export function formatLastSynced(syncedAt: string | null): string {
  if (!syncedAt) return 'Never synced'
  return formatTimestamp(syncedAt, 'relative')
}

/** Truncate a string (typically a block/device ID) for display. */
export function truncateId(id: string, len = 12): string {
  if (id.length <= len) return id
  return `${id.slice(0, len)}...`
}

/** Crockford base32 alphabet used by ULIDs. */
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Decode a ULID to a Date by extracting the 48-bit millisecond timestamp
 * encoded in the first 10 Crockford base32 characters.
 * Returns null if the ULID is malformed or the timestamp is invalid.
 */
export function ulidToDate(ulid: string): Date | null {
  if (!ulid || ulid.length < 10) return null
  try {
    const timeChars = ulid.slice(0, 10).toUpperCase()
    let timestamp = 0
    for (const ch of timeChars) {
      const val = CROCKFORD_BASE32.indexOf(ch)
      if (val === -1) return null
      timestamp = timestamp * 32 + val
    }
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime()) || date.getTime() < 0) return null
    return date
  } catch {
    return null
  }
}
