/**
 * Path history — per-space MRU of `path:` / `not-path:` glob strings.
 *
 * Backs the caret-anchored autocomplete popover (PEND-60 Phase 2): when the
 * user types `path:` or `not-path:` in the search input we surface their
 * recently-used globs for that space, newest-first.
 */

const STORAGE_PREFIX = 'agaric:pathHistory:v1:'

export const PATH_HISTORY_LIMIT = 30

function storageKey(spaceId: string): string {
  return `${STORAGE_PREFIX}${spaceId}`
}

function readRaw(spaceId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(spaceId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

export function getPathHistory(spaceId: string | null): string[] {
  if (!spaceId) return []
  return readRaw(spaceId)
}

export function recordPathHistory(spaceId: string | null, glob: string): void {
  if (!spaceId) return
  const trimmed = glob.trim()
  if (!trimmed) return
  try {
    const existing = readRaw(spaceId).filter((g) => g !== trimmed)
    existing.unshift(trimmed)
    if (existing.length > PATH_HISTORY_LIMIT) existing.length = PATH_HISTORY_LIMIT
    localStorage.setItem(storageKey(spaceId), JSON.stringify(existing))
  } catch {
    // localStorage unavailable (private mode, quota exceeded) — silently no-op.
  }
}

export function clearPathHistory(spaceId: string | null): void {
  if (!spaceId) return
  try {
    localStorage.removeItem(storageKey(spaceId))
  } catch {
    // localStorage unavailable — silently no-op.
  }
}
