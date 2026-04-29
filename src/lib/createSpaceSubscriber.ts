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
 * Semantics (preserved verbatim from the three call sites):
 *   1. First fire after boot: invoke `onChange(newKey, newKey)` so the
 *      caller can seed its per-space slice from the just-rehydrated
 *      flat fields (or pull the slice into the flat fields, in the
 *      journal store's case). Detect via `prevKey === newKey`.
 *   2. Subsequent fire with the same key: suppressed (no-op).
 *   3. Subsequent fire with a different key: invoke
 *      `onChange(prevKey, newKey)` so the caller can flush the
 *      outgoing slice and pull the incoming one.
 *
 * `prevSpaceKey` is initialised lazily on the first subscriber fire so
 * we don't sample `useSpaceStore.getState().currentSpaceId` at module-
 * load time (which races with Zustand's async persist rehydration —
 * the space store may rehydrate AFTER a consumer store and would
 * otherwise trigger a spurious flush of the just-rehydrated flat
 * fields into the `__legacy__` slice).
 */

import { LEGACY_SPACE_KEY, useSpaceStore } from '../stores/space'

/**
 * Subscribe to `useSpaceStore` and forward space changes to `onChange`.
 *
 * @param onChange Invoked once on the first subscriber fire with
 *   `(newKey, newKey)` so callers can seed, then again on every
 *   distinct space change with `(prevKey, newKey)`. Callers
 *   distinguish the two cases by checking `prevKey === newKey`.
 * @returns The Zustand `unsubscribe` function. Call sites typically
 *   ignore this — module-level subscribers live for the process
 *   lifetime — but it is exposed for tests.
 */
export function createSpaceSubscriber(
  onChange: (prevSpaceKey: string, newSpaceKey: string) => void,
): () => void {
  let prevSpaceKey: string | undefined
  return useSpaceStore.subscribe((state) => {
    const newKey = state.currentSpaceId ?? LEGACY_SPACE_KEY
    if (prevSpaceKey === undefined) {
      onChange(newKey, newKey)
      prevSpaceKey = newKey
      return
    }
    if (newKey === prevSpaceKey) return
    onChange(prevSpaceKey, newKey)
    prevSpaceKey = newKey
  })
}
