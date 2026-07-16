/**
 * Pinned search scope — localStorage-backed default segment for the
 * mobile search sheet (#135).
 *
 * A long-press on a search scope (the "This page" / "All pages" segment
 * toggle) pins it as the user's preferred default. When set, the pinned
 * scope overrides the context-aware `defaultModeForView` default the
 * trigger would otherwise pick, so a user who always wants "All pages"
 * gets it regardless of which view they open the sheet from.
 *
 * Global (not per-space): the preference is about *how you like to
 * search*, not about a space's content, so it follows the user across
 * spaces. A single key keeps it simple.
 *
 * Validated on read so a corrupted / stale value degrades to "no pin"
 * (null) rather than feeding an invalid mode into the store.
 */

import { PREFERENCES, readPreference, removePreference, writePreference } from '@/lib/preferences'
import type { SearchSheetMode } from '@/stores/useSearchSheetStore'

/**
 * Read the pinned scope, or `null` when none is pinned / the value is
 * unreadable or invalid.
 */
export function getPinnedSearchScope(): SearchSheetMode | null {
  return readPreference(PREFERENCES.pinnedSearchScope)
}

/** Pin `mode` as the default search scope. */
export function setPinnedSearchScope(mode: SearchSheetMode): void {
  writePreference(PREFERENCES.pinnedSearchScope, mode)
}

/** Remove any pinned scope (returns to context-aware defaults). */
export function clearPinnedSearchScope(): void {
  removePreference(PREFERENCES.pinnedSearchScope)
}
