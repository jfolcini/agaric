/**
 * Starred pages — localStorage-backed list of user-starred (favorited) pages.
 *
 * Stores a JSON array of page IDs under the `starred-pages` key.
 * Used by PageBrowser to let users pin frequently-used pages and filter to show only starred ones.
 */

const STORAGE_KEY = 'starred-pages'

/** Read the starred page IDs from localStorage. */
export function getStarredPages(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pages))
}
