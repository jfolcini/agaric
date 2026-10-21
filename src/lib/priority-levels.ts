/**
 * priority-levels — the priority levels, highest first: the built-in
 * `priority` options (#5841), the same in every vault.
 *
 * A block can still hold a level from before the levels were fixed. It keeps
 * it, and sorts after every level here.
 */

export const PRIORITY_LEVELS: readonly string[] = ['1', '2', '3']

/** The cycle `handleTogglePriority` steps through: none → 1 → 2 → 3 → none. */
export const PRIORITY_CYCLE: readonly (string | null)[] = [null, ...PRIORITY_LEVELS]

/**
 * Sort rank for a priority value. Lower = higher priority: the first level is
 * 0, and `null` or a level outside {@link PRIORITY_LEVELS} is
 * `PRIORITY_LEVELS.length`, after every level.
 */
export function priorityRank(priority: string | null): number {
  const idx = priority == null ? -1 : PRIORITY_LEVELS.indexOf(priority)
  return idx < 0 ? PRIORITY_LEVELS.length : idx
}
