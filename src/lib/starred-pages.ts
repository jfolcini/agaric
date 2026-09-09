/**
 * The bookmark list — a localStorage-backed array of page ids.
 *
 * This is the ONE list behind every bookmark affordance: the page header's
 * button, the Pages browser's row toggles and batch action, the command
 * palette's recents rows, and the sidebar's Bookmarks section. There is no
 * second list; the `pinned` flag on recent pages that used to back the
 * sidebar is gone.
 *
 * The stored key is still `starred-pages`, and so are the identifiers in this
 * module. Renaming the key means migrating everyone's bookmarks for a string
 * no user ever sees, so the seam stops here: everything above this file says
 * bookmark.
 */

import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'

/** Read the starred page IDs from localStorage. */
export function getStarredPages(): string[] {
  return readPreference(PREFERENCES.starredPages)
}

/** Check whether a page is currently starred. */
export function isStarred(pageId: string): boolean {
  return getStarredPages().includes(pageId)
}

/**
 * Toggle the starred state of a page — adds if absent, removes if present.
 * Storage-unavailable write failures are logged and swallowed by
 * `writePreference` rather than thrown into the click handler.
 */
export function toggleStarred(pageId: string): void {
  const pages = getStarredPages()
  const index = pages.indexOf(pageId)
  if (index === -1) {
    pages.push(pageId)
  } else {
    pages.splice(index, 1)
  }
  writePreference(PREFERENCES.starredPages, pages)
}

/**
 * Bulk-set the starred state of many pages in one write.
 *
 * Adds every id in `ids` when `starred` is true, or removes every id when
 * `starred` is false, then persists the resulting array to localStorage
 * ONCE (not per id). Duplicate ids and no-op ids (already starred / already
 * absent) are handled idempotently; an empty `ids` list is a no-op that
 * still rewrites the unchanged array. Shares the silent-degrade-on-failure
 * behavior of the single-page writers above.
 */
export function setStarred(ids: string[], starred: boolean): void {
  const set = new Set(getStarredPages())
  if (starred) {
    for (const id of ids) set.add(id)
  } else {
    for (const id of ids) set.delete(id)
  }
  // Storage-unavailable write failures (private mode / quota / locked-down
  // webview) are logged and swallowed by writePreference rather than thrown
  // into the click handler — same silent-degrade as the single-page writers.
  writePreference(PREFERENCES.starredPages, [...set])
}
