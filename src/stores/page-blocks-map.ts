/**
 * `blocksById` Map derivation helpers for the per-page block store.
 *
 * Extracted from `page-blocks.ts` (#2254). Shared by the store core (`load`,
 * external `setState`), the reducers module and the optimistic structural-move
 * core — see the perf invariant documented on `buildBlocksById`.
 */

import type { FlatBlock } from '@/lib/tree-utils'

// ── blocksById helpers (G) ───────────────────────────────────────

/**
 * Build a fresh `blocksById` Map from a `blocks` array.
 *
 * Always returns a NEW Map instance — Zustand requires a new reference for
 * selector subscribers (e.g. `usePageBlockStore((s) => s.blocksById)`) to fire.
 * Last-write-wins on duplicate ids; in practice the loader and reducers never
 * produce duplicates, but a defensive `set()` keeps the contract explicit.
 *
 * **Perf invariant (Tier 1 #2, perf-review 2026-05-09).** This is a full O(n)
 * scan of `blocks`. Hot single-block-edit paths (`edit()` and other reducers
 * that touch one or a handful of entries) MUST NOT call this helper — instead,
 * derive the next Map from the previous one via `cloneBlocksByIdWith()` or
 * `cloneBlocksByIdWithout()` so only the touched keys allocate. Reserve
 * `buildBlocksById` for true bulk paths (`load`, external `setState`).
 */
export function buildBlocksById(blocks: FlatBlock[]): Map<string, FlatBlock> {
  const map = new Map<string, FlatBlock>()
  for (const b of blocks) map.set(b.id, b)
  return map
}

/**
 * Clone `prev` and `.set()` one or more touched entries — returns a new Map
 * reference (so Zustand selector subscribers still fire) but only allocates
 * O(k) work for the touched keys plus O(n) for the structural clone of the
 * underlying Map (which is much cheaper than the per-entry object-property
 * access of a fresh `blocks.map()` walk in `buildBlocksById`).
 *
 * Used by single/few-block-edit reducers (`edit`, `createBelow`, `appendBlock`,
 * `reorder`, etc.) — see the perf invariant comment on `buildBlocksById`.
 */
export function cloneBlocksByIdWith(
  prev: Map<string, FlatBlock>,
  touched: readonly FlatBlock[],
): Map<string, FlatBlock> {
  const next = new Map(prev)
  for (const b of touched) next.set(b.id, b)
  return next
}

/**
 * Field-wise equality over two flat block rows.
 *
 * `BlockRow` (and therefore `FlatBlock`) is a flat record of primitives, so an
 * own-key shallow compare is EXACT — not a heuristic. It is written
 * generically rather than field-by-field on purpose: a future `BlockRow` field
 * is compared automatically, and if one is ever added that holds an object,
 * the compare simply reports "not equal" (a fresh row, the pre-#3321
 * behaviour) instead of silently reusing a stale object.
 */
function sameBlockFields(a: FlatBlock, b: FlatBlock): boolean {
  const recordA = a as unknown as Record<string, unknown>
  const recordB = b as unknown as Record<string, unknown>
  const keysA = Object.keys(recordA)
  if (keysA.length !== Object.keys(recordB).length) return false
  for (const key of keysA) {
    if (!Object.hasOwn(recordB, key)) return false
    if (!Object.is(recordA[key], recordB[key])) return false
  }
  return true
}

/**
 * #3321 — reconcile a freshly built flat tree against the previous
 * `blocksById`, reusing the PREVIOUS object reference for every row whose
 * fields (including `depth`) are all unchanged.
 *
 * Why: `buildFlatTree` allocates a fresh object per block from the backend
 * snapshot (`{ ...child, depth }`), so a `load()` replaced every object
 * reference even when only one row actually changed. Those objects are the
 * memo key downstream — `BlockListRenderer` passes `block={block}` into the
 * `React.memo`-wrapped `SortableBlockWrapper`, where every other prop is a
 * primitive or deliberately identity-stabilised — so a remote edit to ONE
 * block on a 1,000-block page memo-missed all ~500 mounted rows, each
 * re-running `useRowDragState`, the viewport observe-ref, a
 * `useSyncExternalStore` subscription and the drop-indicator computation.
 * `load()` is on the remote-write hot path (`reloadChangedPageStores` calls it
 * per changed page on every `sync:complete` / MCP `blocks:changed` tick), so
 * with a peer typing this repeated every sync debounce (~3 s).
 *
 * Returns a NEW array (Zustand subscribers still see a changed `blocks`
 * reference); only the ENTRIES are shared with the previous state. One extra
 * O(n) pass on a path that already does two.
 */
export function reuseUnchangedBlocks(next: FlatBlock[], prev: Map<string, FlatBlock>): FlatBlock[] {
  if (prev.size === 0) return next
  return next.map((block) => {
    const previous = prev.get(block.id)
    return previous !== undefined && sameBlockFields(previous, block) ? previous : block
  })
}

/**
 * Clone `prev` and `.delete()` the given ids — counterpart to
 * `cloneBlocksByIdWith` for the `remove` reducer path.
 */
export function cloneBlocksByIdWithout(
  prev: Map<string, FlatBlock>,
  removedIds: Iterable<string>,
): Map<string, FlatBlock> {
  const next = new Map(prev)
  for (const id of removedIds) next.delete(id)
  return next
}
