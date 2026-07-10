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
