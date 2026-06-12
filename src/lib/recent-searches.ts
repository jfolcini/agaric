/**
 * Recent searches — localStorage-backed list of recent search *terms*.
 *
 * Distinct from `recent-pages.ts` (which tracks visited pages): this is
 * the list of query strings the user has actually run, surfaced in the
 * mobile search sheet's empty state (#131) so tapping one re-runs it.
 *
 * Mirrors the `recent-pages` storage shape:
 *  - Per-space partition (`recent_searches:<spaceId>`) so different
 *    spaces never see each other's history.
 *  - Most-recent-first, deduplicated (a re-run term moves to the top
 *    rather than duplicating), capped at MAX_RECENT_SEARCHES.
 *  - Best-effort: every read/write is wrapped so a quota error or an
 *    unavailable `localStorage` (jsdom variants) degrades to "no
 *    history" rather than throwing.
 *
 * Terms are trimmed before storage; empty / whitespace-only terms are
 * ignored. Dedup is case-insensitive (searching "Foo" then "foo" keeps
 * a single entry, preserving the most-recent casing).
 */

import { activeSpaceKey } from './active-space'

const SPACE_KEY_PREFIX = 'recent_searches'
const MAX_RECENT_SEARCHES = 8

function storageKey(): string {
  return `${SPACE_KEY_PREFIX}:${activeSpaceKey()}`
}

/**
 * Read the recent search terms for the active space, most-recent first.
 * Returns `[]` on any read/parse failure.
 */
export function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(storageKey())
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Defensive: drop any non-string / empty entries a hand-edited or
    // corrupted store might contain.
    return parsed.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
  } catch {
    return []
  }
}

/**
 * Record a search term at the top of the active-space list.
 *
 * - Trims the term; ignores empty / whitespace-only input.
 * - Case-insensitive dedup: an existing entry (any casing) is removed
 *   so the new casing lands at position 0.
 * - Caps the list at MAX_RECENT_SEARCHES, evicting the oldest.
 */
export function addRecentSearch(term: string): void {
  const trimmed = term.trim()
  if (trimmed.length === 0) return
  const lower = trimmed.toLowerCase()
  const existing = getRecentSearches().filter((t) => t.toLowerCase() !== lower)
  const next = [trimmed, ...existing].slice(0, MAX_RECENT_SEARCHES)
  try {
    localStorage.setItem(storageKey(), JSON.stringify(next))
  } catch {
    // Quota / unavailable — the MRU strip is a convenience, drop silently.
  }
}

/**
 * Clear the active-space recent-search list (the empty-state's
 * "Clear" affordance).
 */
export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(storageKey())
  } catch {
    // Unavailable — nothing to clear.
  }
}
