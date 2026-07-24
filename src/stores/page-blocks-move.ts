/**
 * Optimistic structural-move core for the per-page block store (#1077, #2274).
 *
 * Extracted from `page-blocks.ts` (#2254) — behavior-preserving move. Holds the
 * pre-await optimistic splice + resolve-path confirm/rollback core
 * (`applyProvisionalMove` / `reconcileProvisionalMoveSuccess` /
 * `rollbackProvisionalMove`, #2849) shared by every optimistic mover
 * (createBelow/reorder/indent/dedent/moveUp/moveDown) and the batched-move
 * surgical reconcile (`reconcileBatchMove`, used by moveBlocks). Callers live in
 * `page-blocks-reducers.ts`.
 */

import type { MoveResponse } from '@/lib/bindings'
import { buildFlatTree, type FlatBlock } from '@/lib/tree-utils'
import { cloneBlocksByIdWith } from '@/stores/page-blocks-map'
import type { PageBlockState } from '@/stores/page-blocks-types'

/**
 * #2274 — surgically reconcile the flat tree after a batched `move_blocks_batch`
 * IPC, WITHOUT a blind full `load()`.
 *
 * Contiguous-run semantics (Refs #914 / Closes #2305): the selection lands as
 * ONE contiguous run, in destination order, among the target parent's
 * NON-selected children — a remove-then-splice. Given the commit-time `state`,
 * the authoritative per-root `resp`, the moved ids (already in destination
 * order), the requested destination parent and the 0-based `newIndex` (the run's
 * base position among the non-selected children), this:
 *
 *  1. builds `base` = the destination parent's current children EXCLUDING the
 *     moved ids, in RENDERED FLAT-ARRAY ORDER (see the array-order rationale
 *     below), then splices the run in at `p = clamp(newIndex, 0, base.length)` —
 *     `base[0..p] ++ orderedIds ++ base[p..]`;
 *  2. dense-renumbers that destination group and each VACATED source group;
 *  3. rebuilds the flattened, depth-annotated tree via `buildFlatTree` (which
 *     recomputes each block's depth from its new parent chain — descendants of a
 *     moved root travel with it automatically because they still point at it via
 *     `parent_id`).
 *
 * This matches the backend's contiguous-run engine ground truth (e.g. [A,B,C,D]
 * move [A,C] at base position 2 → B,D,A,C), pinned by the Rust test
 * `move_blocks_batch_interleaved_same_parent_engine_ground_truth_2274`.
 *
 * The `base`/source groups are derived from the RENDERED flat-array order, not
 * the stored `position` integers: the optimistic same-parent movers (#404
 * `reorder`, `moveUp`, `moveDown`) keep the ARRAY order authoritative but rewrite
 * only the moved block's `position` to the backend's PROVISIONAL rank, leaving
 * sibling integers stale (duplicated, or even sorting out of order after stacked
 * moves). Within a sibling group ascending flat-array index IS the sibling order
 * (`state.blocks` is a DFS flatten and `buildFlatTree`'s position sort is
 * stable), so array order reproduces exactly the dense baseline the backend
 * splices against.
 *
 * Because every block in a page store belongs to the SAME page, an intra-page
 * batch move never changes any block's `page_id`, so it is left untouched.
 *
 * Returns the new flat array, or `null` to signal "fall back to `load()`":
 *   - the backend echoed a parent other than the one requested (or a response
 *     is missing) — a local splice would diverge from the backend tree;
 *   - a moved id vanished from the tree mid-flight (concurrent write);
 *   - a moved id fell out of the rebuilt tree (defensive: e.g. a `null`
 *     requested parent under a non-null page root).
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

  // Backend-echo guard (mirrors `indent`/`reorder`): every moved root must have
  // landed under the parent we asked for, and every root must have a response.
  if (resp.length !== orderedIds.length) return null
  for (const r of resp) {
    if ((r.new_parent_id ?? null) !== wantParent) return null
  }

  // Every moved id must still exist in the current (commit-time) tree.
  const byId = new Map(blocks.map((b) => [b.id, b] as const))
  for (const id of orderedIds) {
    if (!byId.has(id)) return null
  }

  const movedSet = new Set(orderedIds)
  // Pre-move parent of each block (for grouping the vacated source parents).
  const oldParentOf = new Map<string, string | null>(blocks.map((b) => [b.id, b.parent_id ?? null]))
  // Final parent + rank of every block, mutated below.
  const parentOf = new Map<string, string | null>(oldParentOf)
  const posOf = new Map<string, number | null>()

  /** Children of `parent` in RENDERED flat-array order, excluding the moved ids. */
  const remainingChildren = (parent: string | null) =>
    blocks
      .filter((b) => !movedSet.has(b.id) && (oldParentOf.get(b.id) ?? null) === parent)
      .map((b) => b.id)

  // Remove-then-splice: land the whole run at base position `p` among the
  // destination parent's non-selected children, in destination order.
  const base = remainingChildren(wantParent)
  const p = Math.max(0, Math.min(newIndex, base.length))
  const destGroup = [...base.slice(0, p), ...orderedIds, ...base.slice(p)]
  for (const id of orderedIds) parentOf.set(id, wantParent)
  destGroup.forEach((bid, i) => posOf.set(bid, i + 1))

  // Dense-renumber every VACATED source group (a parent a moved id left, other
  // than the destination — the destination was already renumbered above).
  const sourceParents = new Set<string | null>()
  for (const id of orderedIds) {
    const from = oldParentOf.get(id) ?? null
    if (from !== wantParent) sourceParents.add(from)
  }
  for (const sp of sourceParents) {
    remainingChildren(sp).forEach((bid, i) => posOf.set(bid, i + 1))
  }

  // Materialise the updated bag and rebuild. A block re-allocates when its
  // (parent, rank) changed — including blocks whose stored `position` was a
  // stale optimistic leftover, which this pass heals to the dense rank. Blocks
  // in untouched sibling groups keep their reference (posOf has no entry → the
  // stored position is preserved).
  const updatedBag: FlatBlock[] = []
  for (const b of blocks) {
    const par = parentOf.get(b.id) ?? null
    const pos = posOf.has(b.id) ? (posOf.get(b.id) ?? null) : (b.position ?? null)
    updatedBag.push(
      par === (b.parent_id ?? null) && pos === (b.position ?? null)
        ? b
        : { ...b, parent_id: par, position: pos },
    )
  }
  const flat = buildFlatTree(updatedBag, rootParentId)

  // Defensive: if a moved id fell out of the rebuilt tree, reload instead.
  const present = new Set(flat.map((b) => b.id))
  for (const id of orderedIds) {
    if (!present.has(id)) return null
  }
  return flat
}

// ── Optimistic pre-await provisional move (#2849) ─────────────────────────

/** Zustand functional `set` shape the provisional-move helpers use. */
type MoveSet = (updater: (state: PageBlockState) => Partial<PageBlockState>) => void

/**
 * Resolve the `FlatBlock` objects for `touchedIds` from the spliced `blocks`,
 * for the subtree-touch `cloneBlocksByIdWith` perf invariant (only touched keys
 * re-allocate). Perf (#2041): one id→object Map built once (O(n)) instead of a
 * per-id `blocks.find`. De-dups ids and skips any not present in `blocks`.
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

/**
 * #2849 — everything the resolve path needs to confirm/heal a provisional move
 * or roll it back. Returned by {@link applyProvisionalMove}.
 */
export interface ProvisionalMoveHandle {
  /** The moved block's id. */
  blockId: string
  /** `blocks`/`blocksById` BEFORE the provisional splice — exact rollback target. */
  prevBlocks: FlatBlock[]
  prevById: Map<string, FlatBlock>
  /** The `blocks` array reference the provisional splice produced. */
  provBlocks: FlatBlock[]
  /** The moved block's flat index + parent AFTER the provisional splice. */
  provIndex: number
  provParent: string | null
}

/**
 * #2849 — apply an optimistic structural splice SYNCHRONOUSLY, BEFORE the caller
 * dispatches its `move_block` IPC, so the UI updates instantly instead of after
 * the round-trip. Returns a {@link ProvisionalMoveHandle} the resolve path uses
 * to heal (`reconcileProvisionalMoveSuccess`) or roll back
 * (`rollbackProvisionalMove`).
 *
 * The splice keeps the moved block's stored `position` as-is — array order is
 * authoritative (see `reconcileBatchMove`'s array-order rationale); same-parent
 * movers heal it to the backend's dense rank on success. `indent`/`dedent`
 * rewrite `parent_id`/`depth` on the moved subtree (those objects re-allocate),
 * so their `touchedIds` cover the subtree; a same-parent swap changes no object
 * (only array order) and passes `touchedIds: []`.
 *
 * MUST be called inside the per-block `enqueueMove` serializer, synchronously
 * with the caller's context capture (no await between), so a queued second press
 * computes against this already-applied provisional state (#774 + #2849).
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
 * #2849 — resolve-path reconcile for a provisional move the backend CONFIRMED
 * (parent echo matched). Heals the moved block's `position` to the backend's
 * dense rank (`newPosition`; pass `null` to skip — `indent` keeps its
 * splice-assigned `position: 1`).
 *
 * Double-apply guard (trap 1): if a concurrent write superseded the provisional
 * splice — the block vanished (a racing sync `load()` / delete), or it no longer
 * sits at the provisional slot+parent (a stale `load()` that reverted the
 * move) — reconcile via `load()` instead of blindly healing. A benign
 * concurrent write that never reorders (an `edit` on another block) leaves the
 * block at the same slot+parent, so the heal proceeds and that edit survives.
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
 * #2849 — resolve-path rollback for a provisional move whose IPC REJECTED.
 * Restores the exact pre-op snapshot when nothing landed since (the common
 * case), or reconciles via `load()` when a concurrent write superseded the
 * provisional splice — restoring the stale snapshot would clobber it, mirroring
 * `edit`'s guarded rollback (only revert when the live state still equals what
 * this move wrote).
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
