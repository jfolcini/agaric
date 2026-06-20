/**
 * graph-structure-events — module-level invalidation counter for mutations that
 * change the page-link GRAPH TOPOLOGY (the graph's nodes are pages, its edges
 * are `[[links]]`).
 *
 * #1530: `GraphView` previously keyed its module-level cache only on
 * (spaceId, tagIds) with a 5-minute TTL and a *property*-change signal
 * (`block:properties-changed`). That Tauri event fires ONLY on block-property
 * commands — never on page creation, block text edits that add/remove a
 * `[[link]]`, or block insert/delete/move. Those are exactly the mutations that
 * change the graph, so the graph stayed stale until the TTL elapsed.
 *
 * This counter is the correct axis: it is bumped from the app's own
 * local-mutation path (`src/stores/page-blocks.ts` — every CRUD op funnels
 * through `notifyUndoNewAction`, plus `appendBlock`) and on remote ops
 * (`sync:complete` in `src/hooks/useSyncEvents.ts`). Unlike
 * `block-property-events.ts` there is NO Tauri listener: the signal originates
 * in FE code, not a backend event, so a successful local op or an applied sync
 * batch increments it directly.
 *
 * Mirrors the lazy-subscriber-set / `useSyncExternalStore` shape of
 * `src/lib/block-property-events.ts`. The React adapter lives in
 * `src/hooks/useGraphStructureEvents.ts`.
 *
 * Like the property counter, this lives at MODULE scope so it survives any
 * consumer's mount/unmount: a mutation that fires while `GraphView` is unmounted
 * still advances the counter, so the next mount within the cache TTL reads a
 * higher key and refetches (same survives-unmount guarantee as #1818).
 */

/**
 * Debounce window: batch rapid consecutive structural mutations (e.g. a paste
 * that creates several blocks, or a burst of keystroke edits that each toggle a
 * `[[link]]`). Matches the property-counter debounce so the two signals behave
 * consistently.
 */
export const DEBOUNCE_MS = 150

let structureKey = 0
const subscribers = new Set<() => void>()
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function notify(): void {
  for (const cb of subscribers) cb()
}

/**
 * Synchronous snapshot of the current structure-mutation counter. This is the
 * snapshot fn used by `useSyncExternalStore`; it returns a primitive so
 * referential stability is automatic.
 */
export function getGraphStructureKey(): number {
  return structureKey
}

/**
 * Subscribe to structure-counter changes. Returns an unsubscribe fn. Used by the
 * React adapter via `useSyncExternalStore`.
 */
export function subscribeToGraphStructureEvents(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Record a graph-topology mutation (a local block/link/page CRUD op, or an
 * applied remote sync batch). Debounces rapid consecutive mutations
 * (`DEBOUNCE_MS`) and increments the module-level counter once the window
 * settles, notifying subscribers.
 */
export function recordGraphStructureChange(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    structureKey += 1
    notify()
  }, DEBOUNCE_MS)
}

/**
 * Test-only reset. Clears the counter, any pending debounce timer, and the
 * subscriber set so each test starts from a clean slate. Imported directly by
 * tests; not part of the public surface.
 */
export function _resetGraphStructureEventsForTest(): void {
  structureKey = 0
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  subscribers.clear()
}
