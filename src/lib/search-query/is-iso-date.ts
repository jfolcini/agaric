/**
 * Calendar-aware `YYYY-MM-DD` validation shared by the search-query parser and
 * the filter-builder forms.
 *
 * A valid ISO date is exactly ten chars, `NNNN-NN-NN`, with a real calendar
 * day (rejects `2026-02-30`, `2026-13-01`, …). UTC parsing avoids timezone
 * skew shifting the day.
 *
 * Single shared implementation: both the recogniser (`register.ts`) and the
 * builder forms (`DateFilterForm`) import this module, so the parser and the
 * forms can never drift on what counts as a valid date. It is dependency-free
 * on purpose — the forms can use it without pulling in the recogniser module.
 */
export function isIsoDate(s: string): boolean {
  if (s.length !== 10) return false
  if (s[4] !== '-' || s[7] !== '-') return false
  for (let i = 0; i < s.length; i++) {
    if (i === 4 || i === 7) continue
    const c = s.charCodeAt(i)
    if (c < 0x30 || c > 0x39) return false
  }
  // Calendar-valid?
  const parts = s.split('-')
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (m < 1 || m > 12) return false
  if (d < 1 || d > 31) return false
  // Use Date for calendar validation (UTC parsing avoids TZ skew).
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
