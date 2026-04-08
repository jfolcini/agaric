/**
 * useItemCount — reusable hook that polls a paginated Tauri IPC command
 * and returns the count of items in the first page.
 *
 * Uses the same `usePollingQuery` pattern as `useHasConflicts` in App.tsx.
 */

import { usePollingQuery } from './usePollingQuery'

/**
 * Polls a paginated command and returns the item count.
 *
 * @param queryFn - A stable (useCallback-wrapped) function that calls the Tauri command
 *                  and returns `{ items: unknown[] }`.
 * @param intervalMs - Polling interval in milliseconds.
 * @returns The count of items (0 if loading or error).
 */
export function useItemCount(
  queryFn: () => Promise<{ items: unknown[] }>,
  intervalMs: number,
): number {
  const { data } = usePollingQuery(queryFn, {
    intervalMs,
    refetchOnFocus: true,
  })
  return data?.items.length ?? 0
}
