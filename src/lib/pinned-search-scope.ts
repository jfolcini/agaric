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

import type { SearchSheetMode } from '@/stores/useSearchSheetStore'

const STORAGE_KEY = 'pinned_search_scope'

function isSearchSheetMode(v: unknown): v is SearchSheetMode {
  return v === 'in-page' || v === 'all-pages'
}

/**
 * Read the pinned scope, or `null` when none is pinned / the value is
 * unreadable or invalid.
 */
export function getPinnedSearchScope(): SearchSheetMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isSearchSheetMode(raw) ? raw : null
  } catch {
    return null
  }
}

/** Pin `mode` as the default search scope. */
export function setPinnedSearchScope(mode: SearchSheetMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // Quota / unavailable — best-effort preference, drop silently.
  }
}

/** Remove any pinned scope (returns to context-aware defaults). */
export function clearPinnedSearchScope(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Unavailable — nothing to clear.
  }
}
