/**
 * Optimistic structural-move core for the per-page block store: the
 * provisional splice, confirm and rollback every optimistic mover shares, and
 * the reconcile for a batched move. Callers live in `page-blocks-reducers.ts`.
 */

import type { MoveResponse } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { buildFlatTree, buildIndexById, getDragDescendants, type FlatBlock } from '@/lib/tree-utils'
import { cloneBlocksByIdWith } from '@/stores/page-blocks-map'
import type { PageBlockState } from '@/stores/page-blocks-types'

/**
 * Whether landing the moved run under `wantParent` would make a moved block
 * its own ancestor: `wantParent` is one of them or, in the pre-move tree, a
 * descendant of one (#3799). The presence check after the rebuild would catch
 * the same cases; this rejects before the work, and keeps the guarantee from
 * resting on `buildFlatTree` dropping unreachable cycles.
 */
export function wouldCreateMoveCycle(
  blocks: FlatBlock[],
  orderedIds: readonly string[],
  wantParent: string | null,
): boolean {
  if (wantParent == null) return false
  if (orderedIds.includes(wantParent)) return true
  // One index for every descendant walk, not an O(n) lookup per id.
  const indexById = buildIndexById(blocks)
  return orderedIds.some((id) => getDragDescendants(blocks, id, indexById).has(wantParent))
}

/**
 * Reconcile the flat tree after `move_blocks_batch` without a full `load()`
 * (#2274). The run lands contiguous, in destination order, at `newIndex` among
 * the target parent's other children (remove, then splice), matching the
 * backend: [A,B,C,D] moving [A,C] to 2 gives B,D,A,C.
 *
 * Every sibling group is dense-renumbered from its rendered array order, not
 * only the destination: the optimistic same-parent movers keep array order
 * authoritative but heal only the moved block's `position`, so other groups can
 * hold stale or out-of-order integers that `buildFlatTree`'s position sort
 * would scramble (#3320). The renumbering is frontend state only; the IPC has
 * already gone.
 *
 * Returns `null`, asking for a `load()`, when the backend echoed another parent
 * or a response is missing, when the move would form a cycle
 * ({@link wouldCreateMoveCycle}), or when a moved id is missing from the
 * rebuilt tree (it vanished mid-flight, or another divergence).
 */
export function reconcileBatchMove(
  state: PageBlockState,
  resp: MoveResponse[],
  orderedIds: string[],
  requestedParentId: string | null,
  newIndex: number,
): FlatBlock[] | null {
  const { blocks, rootParentId } = state
  const wantParent = requestedParentId ?? null

  // Every moved root must have landed under the parent asked for.
  if (resp.length !== orderedIds.length) return null
  for (const r of resp) {
    if ((r.new_parent_id ?? null) !== wantParent) return null
  }

  // Reject a cyclic request up front (see `wouldCreateMoveCycle`).
  if (wouldCreateMoveCycle(blocks, orderedIds, wantParent)) {
    logger.warn('page-blocks-move', 'moveBlocks: rejected — newParentId would create a cycle', {
      orderedIds,
      wantParent,
    })
    return null
  }

  const movedSet = new Set(orderedIds)
  // Pre-move parent of each block (for grouping the vacated source parents).
  const oldParentOf = new Map<string, string | null>(blocks.map((b) => [b.id, b.parent_id ?? null]))
  // Final parent + rank of every block, mutated below.
  const parentOf = new Map<string, string | null>(oldParentOf)
  const posOf = new Map<string, number | null>()

  /** Children of `parent` in rendered order, excluding the moved ids. */
  const remainingChildren = (parent: string | null) =>
    blocks
      .filter((b) => !movedSet.has(b.id) && (oldParentOf.get(b.id) ?? null) === parent)
      .map((b) => b.id)

  const base = remainingChildren(wantParent)
  const p = Math.max(0, Math.min(newIndex, base.length))
  const destGroup = [...base.slice(0, p), ...orderedIds, ...base.slice(p)]
  for (const id of orderedIds) parentOf.set(id, wantParent)
  destGroup.forEach((bid, i) => posOf.set(bid, i + 1))

  // Dense-renumber every other group, vacated sources included, by final parent
  // in rendered order, so stale positions from earlier movers cannot scramble a
  // group this move did not touch (#3320).
  const remainingByParent = new Map<string | null, string[]>()
  for (const b of blocks) {
    if (posOf.has(b.id)) continue
    const par = parentOf.get(b.id) ?? null
    let group = remainingByParent.get(par)
    if (!group) {
      group = []
      remainingByParent.set(par, group)
    }
    group.push(b.id)
  }
  for (const group of remainingByParent.values()) {
    group.forEach((bid, i) => posOf.set(bid, i + 1))
  }

  // Every block now has a rank; reuse the object when parent and rank match.
  const updatedBag: FlatBlock[] = []
  for (const b of blocks) {
    const par = parentOf.get(b.id) ?? null
    const pos = posOf.get(b.id) ?? null
    updatedBag.push(
      par === (b.parent_id ?? null) && pos === (b.position ?? null)
        ? b
        : { ...b, parent_id: par, position: pos },
    )
  }
  const flat = buildFlatTree(updatedBag, rootParentId)

  // A moved id missing from the rebuilt tree means divergence: reload.
  const present = new Set(flat.map((b) => b.id))
  for (const id of orderedIds) {
    if (!present.has(id)) return null
  }
  return flat
}

type MoveSet = (updater: (state: PageBlockState) => Partial<PageBlockState>) => void

/**
 * The objects for `touchedIds` from the spliced `blocks`, deduplicated and
 * skipping absent ids, so only touched keys re-allocate in `blocksById`.
 */
function deriveTouched(blocks: FlatBlock[], touchedIds: Iterable<string>): FlatBlock[] {
  const byId = new Map<string, FlatBlock>()
  for (const b of blocks) byId.set(b.id, b)
  const touched: FlatBlock[] = []
  const seen = new Set<string>()
  for (const id of touchedIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const b = byId.get(id)
    if (b) touched.push(b)
  }
  return touched
}

/** What the resolve path needs to heal or roll back a provisional move. */
export interface ProvisionalMoveHandle {
  /** The moved block's id. */
  blockId: string
  /** `blocks`/`blocksById` before the splice: the exact rollback target. */
  prevBlocks: FlatBlock[]
  prevById: Map<string, FlatBlock>
  /** The `blocks` the splice produced, for the reference-equality checks. */
  provBlocks: FlatBlock[]
  /** The moved block's flat index and parent after the splice. */
  provIndex: number
  provParent: string | null
}

/**
 * Apply an optimistic splice synchronously, before the caller's `move_block`
 * IPC (#2849). The moved block keeps its stored `position` (array order is
 * authoritative); `touchedIds` names the objects the splice re-allocated, empty
 * for a same-parent swap.
 *
 * Call it inside `enqueueMove`, with no await before it, so a queued second
 * press computes against this applied state (#774).
 */
export function applyProvisionalMove(
  set: MoveSet,
  blockId: string,
  computeSpliced: (state: PageBlockState) => {
    blocks: FlatBlock[]
    touchedIds: Iterable<string>
  },
): ProvisionalMoveHandle {
  let handle: ProvisionalMoveHandle | undefined
  set((state) => {
    const prevBlocks = state.blocks
    const prevById = state.blocksById
    const { blocks, touchedIds } = computeSpliced(state)
    const provIndex = blocks.findIndex((b) => b.id === blockId)
    handle = {
      blockId,
      prevBlocks,
      prevById,
      provBlocks: blocks,
      provIndex,
      provParent: (provIndex >= 0 ? blocks[provIndex]?.parent_id : null) ?? null,
    }
    return { blocks, blocksById: cloneBlocksByIdWith(prevById, deriveTouched(blocks, touchedIds)) }
  })
  // Zustand runs the updater synchronously, so `handle` is assigned.
  return handle as ProvisionalMoveHandle
}

/**
 * Confirm a provisional move the backend accepted, healing the moved block's
 * `position` to `newPosition` (`null` skips: `indent` keeps its `position: 1`).
 * If a concurrent write superseded the splice (the block is gone, or no longer
 * at its provisional slot and parent), reload instead; a write elsewhere, such
 * as an edit to another block, leaves the heal to proceed.
 */
export async function reconcileProvisionalMoveSuccess(
  set: MoveSet,
  get: () => PageBlockState,
  handle: ProvisionalMoveHandle,
  newPosition: number | null,
): Promise<void> {
  let needsReload = false
  set((state) => {
    const cur = state.blocksById.get(handle.blockId)
    if (!cur) {
      needsReload = true
      return {}
    }
    const stillInPlace =
      state.blocks === handle.provBlocks ||
      (state.blocks[handle.provIndex]?.id === handle.blockId &&
        (cur.parent_id ?? null) === handle.provParent)
    if (!stillInPlace) {
      needsReload = true
      return {}
    }
    if (newPosition == null || (cur.position ?? null) === newPosition) return {}
    const healed: FlatBlock = { ...cur, position: newPosition }
    const blocks = state.blocks.slice()
    blocks[handle.provIndex] = healed
    return { blocks, blocksById: cloneBlocksByIdWith(state.blocksById, [healed]) }
  })
  if (needsReload) await get().load()
}

/**
 * Roll back a provisional move whose IPC failed: restore the exact snapshot if
 * nothing landed since, else reload, so a concurrent write is not clobbered.
 */
export async function rollbackProvisionalMove(
  set: MoveSet,
  get: () => PageBlockState,
  handle: ProvisionalMoveHandle,
): Promise<void> {
  let needsReload = false
  set((state) => {
    if (state.blocks === handle.provBlocks) {
      return { blocks: handle.prevBlocks, blocksById: handle.prevById }
    }
    needsReload = true
    return {}
  })
  if (needsReload) await get().load()
}
