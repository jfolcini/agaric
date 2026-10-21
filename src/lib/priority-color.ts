/**
 * Badge color class for a given priority level (theme-aware).
 *
 * The three levels get distinct semantic tokens (urgent / high / normal). A
 * level from before the levels were fixed (#5841) gets the neutral muted
 * tokens, so it never reads as one of the three.
 *
 * `null` → empty string so callers can spread without conditionals.
 */

import { PRIORITY_LEVELS } from '@/lib/priority-levels'

const LEVEL_COLORS = [
  'bg-priority-urgent text-priority-urgent-foreground',
  'bg-priority-high text-priority-high-foreground',
  'bg-priority-normal text-priority-normal-foreground',
] as const

const OUT_OF_RANGE_COLOR = 'bg-muted text-muted-foreground'

export function priorityColor(p: string | null): string {
  if (p == null) return ''
  return LEVEL_COLORS[PRIORITY_LEVELS.indexOf(p)] ?? OUT_OF_RANGE_COLOR
}
