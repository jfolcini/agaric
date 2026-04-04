/**
 * Recent pages — localStorage-backed list of recently visited pages.
 *
 * Stores up to MAX_RECENT entries, most-recent first.
 * Used by SearchPanel to show quick-navigation links when the query is empty.
 */

const STORAGE_KEY = 'recent_pages'
const MAX_RECENT = 10

export interface RecentPage {
  id: string
  title: string
  visitedAt: string
}

/** Read the recent-pages list from localStorage. */
export function getRecentPages(): RecentPage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as RecentPage[]
  } catch {
    return []
  }
}

/**
 * Add (or move) a page to the top of the recent list.
 *
 * - If the page already exists it is moved to position 0 with an updated timestamp.
 * - The list is capped at MAX_RECENT entries.
 */
export function addRecentPage(id: string, title: string): void {
  const pages = getRecentPages().filter((p) => p.id !== id)
  pages.unshift({ id, title, visitedAt: new Date().toISOString() })
  if (pages.length > MAX_RECENT) pages.length = MAX_RECENT
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pages))
}
