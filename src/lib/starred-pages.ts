/**
 * Starred pages — localStorage-backed list of user-starred (favorited) pages.
 *
 * Stores a JSON array of page IDs under the `starred-pages` key.
 * Used by PageBrowser to let users pin frequently-used pages and filter to show only starred ones.
 */

import { getPref, PREFS, setPref } from './preferences'

/** Read the starred page IDs from localStorage. */
export function getStarredPages(): string[] {
  return getPref(PREFS.starredPages)
}

/** Check whether a page is currently starred. */
export function isStarred(pageId: string): boolean {
  return getStarredPages().includes(pageId)
}

/** Toggle the starred state of a page — adds if absent, removes if present. */
export function toggleStarred(pageId: string): void {
  const pages = getStarredPages()
  const index = pages.indexOf(pageId)
  if (index === -1) {
    pages.push(pageId)
  } else {
    pages.splice(index, 1)
  }
  // Storage-unavailable write failures are logged and swallowed by setPref
  // rather than thrown into the click handler.
  setPref(PREFS.starredPages, pages)
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
  // webview) are logged and swallowed by setPref rather than thrown into
  // the click handler — same silent-degrade as the single-page writers.
  setPref(PREFS.starredPages, [...set])
}
