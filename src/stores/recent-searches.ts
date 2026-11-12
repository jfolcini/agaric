/**
 * Recent search terms, per space, for the mobile search sheet's empty state
 * (#131), where tapping one re-runs it. Most recent first, capped at
 * `MAX_RECENT_SEARCHES`, trimmed, deduplicated case-insensitively (the latest
 * casing wins). Storage failures degrade to no history.
 */

import { PREFERENCES, readPreference, removePreference, writePreference } from '@/lib/preferences'
import { activeSpaceKey } from '@/stores/active-space'

const MAX_RECENT_SEARCHES = 8

/** The active space's recent terms, most recent first; `[]` on any read failure. */
export function getRecentSearches(): string[] {
  return readPreference(PREFERENCES.recentSearches, activeSpaceKey())
}

/** Put a term at the top of the active space's list; empty input is ignored. */
export function addRecentSearch(term: string): void {
  const trimmed = term.trim()
  if (trimmed.length === 0) return
  const lower = trimmed.toLowerCase()
  const existing = getRecentSearches().filter((t) => t.toLowerCase() !== lower)
  const next = [trimmed, ...existing].slice(0, MAX_RECENT_SEARCHES)
  // `writePreference` logs and swallows storage failures.
  writePreference(PREFERENCES.recentSearches, next, activeSpaceKey())
}

/** Clear the active space's list (the empty state's "Clear"). */
export function clearRecentSearches(): void {
  removePreference(PREFERENCES.recentSearches, activeSpaceKey())
}
