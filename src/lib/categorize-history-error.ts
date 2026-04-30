/**
 * categorizeHistoryError — classify a `listPageHistory` failure into a
 * user-meaningful bucket so the History error banner can show
 * actionable context instead of a generic message.
 *
 *  - `network` — fetch / connectivity / timeout / offline
 *  - `server`  — backend error (HTTP 5xx, sqlx, IPC reject)
 *  - `unknown` — anything else
 *
 * Best-effort detection: inspects HTTP-shaped errors (`{ status: 5xx }`,
 * `{ code: '5xx...' }`) first, then falls back to substring matches
 * against the lower-cased message. UX-275 sub-fix 7.
 */

export type HistoryErrorCategory = 'network' | 'server' | 'unknown'

export function categorizeHistoryError(err: unknown): HistoryErrorCategory {
  if (err == null) return 'unknown'
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (typeof err === 'object' && err != null) {
    const obj = err as { status?: number; code?: string | number }
    if (typeof obj.status === 'number' && obj.status >= 500 && obj.status < 600) {
      return 'server'
    }
    if (typeof obj.code === 'string' && /^5\d\d/.test(obj.code)) {
      return 'server'
    }
  }
  if (
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('offline') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout')
  ) {
    return 'network'
  }
  if (
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('internal server') ||
    msg.includes('database') ||
    msg.includes('sqlx')
  ) {
    return 'server'
  }
  return 'unknown'
}
