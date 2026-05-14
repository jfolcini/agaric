/**
 * createSpaceSubscriber — shared `useSpaceStore` subscriber helper.
 *
 * MAINT-122: navigation, journal, and recent-pages stores all carry the
 * same "flush outgoing slice → swap currentSpaceId → pull incoming
 * slice" pattern, with identical first-fire-seed plumbing. This helper
 * centralizes the prevSpaceKey + first-fire-seed + diff detection so
 * each store only provides the `onChange` callback that runs flush+pull
 * for ITS state.
 *
 * Semantics:
 *   1. First fire on subscribe: invoke `onChange(newKey, newKey)` so the
 *      caller can seed its per-space slice from the just-rehydrated
 *      flat fields (or pull the slice into the flat fields, in the
 *      journal store's case). Detect via `prevKey === newKey`. Achieved
 *      via `fireImmediately: true`.
 *   2. Subsequent fire with the same key: suppressed by zustand's
 *      `equalityFn` (Object.is) on the selector output — listener
 *      never fires when only `availableSpaces` or `isReady` change.
 *   3. Subsequent fire with a different key: invoke
 *      `onChange(prevKey, newKey)` so the caller can flush the
 *      outgoing slice and pull the incoming one.
 *
 * design-system-perf-review-2026-05-09 item 13: migrated from a
 * full-state `useSpaceStore.subscribe(state => …)` (which wakes on
 * every space-store write) to the `subscribeWithSelector` middleware
 * scoped to `currentSpaceId`. The four module-level subscribers
 * (journal, navigation, recent-pages, tabs) no longer pay a wakeup
 * cost on `availableSpaces` refreshes or `isReady` flips.
 *
 * Note on rehydration timing: the previous lazy-init implementation
 * deferred sampling `currentSpaceId` until the first store-write to
 * avoid racing zustand's async persist rehydrate. With
 * `subscribeWithSelector` + `fireImmediately: true` we read the
 * selector at subscribe time, which is safe here because all four
 * consumer stores subscribe at module-eval and the space store's
 * persist rehydrate either has already resolved (sync localStorage)
 * or will fire a fresh selector change when it does, replaying the
 * `(prevKey, newKey)` flush/pull path.
 */

import { LEGACY_SPACE_KEY, useSpaceStore } from '../stores/space'

/**
 * Subscribe to `useSpaceStore` and forward space changes to `onChange`.
 *
 * @param onChange Invoked once on subscribe with `(newKey, newKey)` so
 *   callers can seed, then again on every distinct `currentSpaceId`
 *   change with `(prevKey, newKey)`. Callers distinguish the two cases
 *   by checking `prevKey === newKey`.
 * @returns The Zustand `unsubscribe` function. Call sites typically
 *   ignore this — module-level subscribers live for the process
 *   lifetime — but it is exposed for tests.
 */
export function createSpaceSubscriber(
  onChange: (prevSpaceKey: string, newSpaceKey: string) => void,
): () => void {
  return useSpaceStore.subscribe(
    (state) => state.currentSpaceId ?? LEGACY_SPACE_KEY,
    (newKey, prevKey) => {
      // `fireImmediately: true` invokes this with `prevKey === newKey`
      // on subscribe (seed); subsequent calls always carry a real
      // change because `equalityFn` (Object.is) gates re-fires.
      onChange(prevKey, newKey)
    },
    { equalityFn: Object.is, fireImmediately: true },
  )
}
