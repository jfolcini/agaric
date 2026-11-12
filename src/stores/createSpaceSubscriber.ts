/**
 * Forward `currentSpaceId` changes to a per-space store's reconcile. Fires
 * once on subscribe with `(newKey, newKey)` to seed, then with
 * `(prevKey, newKey)` on each distinct change; scoped to `currentSpaceId`, so
 * `availableSpaces` refreshes and `isReady` flips wake nobody. Reading at
 * subscribe time is safe: consumers subscribe at module eval, and a later
 * persist rehydrate arrives as an ordinary change.
 */

import { LEGACY_SPACE_KEY, useSpaceStore } from '@/stores/space'

/**
 * Subscribe to `currentSpaceId`. `onChange` gets `(newKey, newKey)` once on
 * subscribe, then `(prevKey, newKey)` per change. Returns the unsubscribe,
 * which module-level callers ignore.
 */
export function createSpaceSubscriber(
  onChange: (prevSpaceKey: string, newSpaceKey: string) => void,
): () => void {
  return useSpaceStore.subscribe(
    (state) => state.currentSpaceId ?? LEGACY_SPACE_KEY,
    (newKey, prevKey) => {
      onChange(prevKey, newKey)
    },
    { equalityFn: Object.is, fireImmediately: true },
  )
}
