/**
 * Format a timestamp for display as an absolute date/time.
 *
 * For relative ("2 hours ago") strings use `formatRelativeTime` from
 * `format-relative-time.ts` — it is i18n-aware (#745). This function only
 * produces absolute, locale-formatted output; the app is pinned to English,
 * so `toLocaleDateString(undefined, …)` resolves consistently.
 *
 * @param value - either an ISO 8601 string or epoch-milliseconds number
 *   (#109 Phase 2 migrates several columns from ISO TEXT to INTEGER ms;
 *   `new Date(value)` accepts both forms)
 * @param style - 'full' (date + time) or 'date' (date only)
 */
export function formatTimestamp(value: string | number, style: 'full' | 'date' = 'full'): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)

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

/** Truncate a string (typically a block/device ID) for display. */
export function truncateId(id: string, len = 12): string {
  if (id.length <= len) return id
  return `${id.slice(0, len)}...`
}

/**
 * Format a byte count for human display. Uses 1024-based units
 * because file sizes coming from `File.size` are byte counts of file
 * content, and the import progress UI is comparing against on-disk
 * markdown that file managers also display in KB/MB.
 *
 *   formatBytes(0)         -> "0 B"
 *   formatBytes(512)       -> "512 B"
 *   formatBytes(2048)      -> "2.0 KB"
 *   formatBytes(5_242_880) -> "5.0 MB"
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
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
