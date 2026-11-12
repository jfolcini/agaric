/** `blocksById` derivation helpers for the per-page block store. */

import type { FlatBlock } from '@/lib/tree-utils'

/**
 * Build a fresh `blocksById` from `blocks`; always a new Map, so selector
 * subscribers fire. A full O(n) scan: single- and few-block writes derive the
 * next Map with `cloneBlocksByIdWith` / `cloneBlocksByIdWithout` instead, so
 * only touched keys allocate. Bulk paths only (`load`, external `setState`).
 */
export function buildBlocksById(blocks: FlatBlock[]): Map<string, FlatBlock> {
  const map = new Map<string, FlatBlock>()
  for (const b of blocks) map.set(b.id, b)
  return map
}

/** A copy of `prev` with the touched entries set: a new reference, O(k) entry work. */
export function cloneBlocksByIdWith(
  prev: Map<string, FlatBlock>,
  touched: readonly FlatBlock[],
): Map<string, FlatBlock> {
  const next = new Map(prev)
  for (const b of touched) next.set(b.id, b)
  return next
}

/**
 * Field-wise equality of two rows. `FlatBlock` is a flat record of primitives,
 * so an own-key shallow compare is exact; generic, so a new field is compared
 * automatically, and an object-valued one would only read as changed.
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
 * Reuse the previous object for every row whose fields, `depth` included, are
 * unchanged (#3321). `buildFlatTree` allocates a fresh object per block, and
 * rows memo on block identity, so a remote edit to one block otherwise
 * re-rendered every mounted row; `load()` runs on every sync tick. Returns a
 * new array, so subscribers still see a change.
 */
export function reuseUnchangedBlocks(next: FlatBlock[], prev: Map<string, FlatBlock>): FlatBlock[] {
  if (prev.size === 0) return next
  return next.map((block) => {
    const previous = prev.get(block.id)
    return previous !== undefined && sameBlockFields(previous, block) ? previous : block
  })
}

/** A copy of `prev` with `removedIds` deleted. */
export function cloneBlocksByIdWithout(
  prev: Map<string, FlatBlock>,
  removedIds: Iterable<string>,
): Map<string, FlatBlock> {
  const next = new Map(prev)
  for (const id of removedIds) next.delete(id)
  return next
}
