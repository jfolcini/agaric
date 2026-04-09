/**
 * Tag colors — localStorage-backed map of tag ID → CSS color string.
 *
 * Stores a JSON object under the `tag-colors` key for fast rendering.
 * Also persists to block properties via `setProperty()` for cross-device sync.
 *
 * Pattern follows starred-pages.ts.
 */

const STORAGE_KEY = 'tag-colors'

/** Preset color palette — 8 colors that work in both light and dark mode. */
export const TAG_COLOR_PRESETS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'green', value: '#22c55e' },
  { name: 'teal', value: '#14b8a6' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'purple', value: '#a855f7' },
  { name: 'pink', value: '#ec4899' },
] as const

/** Read all tag colors from localStorage. */
export function getTagColors(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') result[k] = v
    }
    return result
  } catch {
    return {}
  }
}

/** Get the color for a specific tag. Returns undefined if not set. */
export function getTagColor(tagId: string): string | undefined {
  return getTagColors()[tagId]
}

/** Set the color for a tag in localStorage. */
export function setTagColor(tagId: string, color: string): void {
  const colors = getTagColors()
  colors[tagId] = color
  localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
}

/** Remove the color for a tag from localStorage. */
export function clearTagColor(tagId: string): void {
  const colors = getTagColors()
  delete colors[tagId]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
}
