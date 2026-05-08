/**
 * useItemCount — reusable hook that polls a Tauri IPC command and
 * returns a count for a sidebar / tab badge.
 *
 * Uses the same `usePollingQuery` pattern as `useHasConflicts` in App.tsx.
 *
 * Accepts either:
 *  - a paginated command returning `{ items: unknown[] }` (legacy
 *    callsites whose backend doesn't yet have a count-only IPC — e.g.
 *    the trash badge polls `listBlocks({ showDeleted: true, limit: 100 })`),
 *  - a count-only command returning `number` (the cheaper shape — used
 *    by `useConflictCount` after PEND-35 Tier 2.11 routed the badge
 *    through `count_conflicts` instead of paginating
 *    `getConflicts({limit:100})` every 30 s for `data.items.length`).
 *
 * The two-shape contract lets per-callsite migrations land independently
 * without churning every consumer at once.
 */

import { usePollingQuery } from './usePollingQuery'

/**
 * Polls a Tauri command and returns the item count.
 *
 * @param queryFn - A stable (useCallback-wrapped) function that calls
 *                  the Tauri command and returns either a paginated
 *                  page envelope (`{ items: unknown[] }`) or a plain
 *                  `number` (a count-only IPC).
 * @param intervalMs - Polling interval in milliseconds.
 * @returns The count of items (0 if loading or error).
 */
export function useItemCount(
  queryFn: () => Promise<{ items: unknown[] } | number>,
  intervalMs: number,
): number {
  const { data } = usePollingQuery(queryFn, {
    intervalMs,
    refetchOnFocus: true,
  })
  if (data == null) return 0
  return typeof data === 'number' ? data : data.items.length
}
