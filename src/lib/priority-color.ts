/**
 * Badge color class for a given priority level (theme-aware, index-based).
 *
 * UX-201b: priority levels are user-configurable, so the color mapping is
 * index-based rather than keyed on the string value. The first three levels
 * get distinct semantic tokens (urgent / high / normal); level 4+ and any
 * unknown value (not in the current level set) fall back to `normal`.
 *
 * `null` → empty string so callers can spread without conditionals.
 */

import { getPriorityLevels } from './priority-levels'

const INDEX_COLORS = [
  'bg-priority-urgent text-priority-foreground',
  'bg-priority-high text-priority-foreground',
  'bg-priority-normal text-priority-foreground',
] as const

export function priorityColor(p: string | null): string {
  if (p == null) return ''
  const levels = getPriorityLevels()
  const idx = levels.indexOf(p)
  const safeIdx = idx < 0 ? INDEX_COLORS.length - 1 : Math.min(idx, INDEX_COLORS.length - 1)
  return INDEX_COLORS[safeIdx] as string
}
