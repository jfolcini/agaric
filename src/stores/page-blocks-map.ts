/**
 * `blocksById` Map derivation helpers for the per-page block store.
 *
 * Extracted from `page-blocks.ts` (#2254). Shared by the store core (`load`,
 * external `setState`), the reducers module and the optimistic structural-move
 * core — see the perf invariant documented on `buildBlocksById`.
 */

import type { FlatBlock } from '../lib/tree-utils'

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
