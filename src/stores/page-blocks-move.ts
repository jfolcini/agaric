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
import { logger } from '@/lib/logger'
import { buildFlatTree, buildIndexById, getDragDescendants, type FlatBlock } from '@/lib/tree-utils'
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
 *  3. dense-renumbers EVERY OTHER sibling group too, from its RENDERED
 *     flat-array order (#3320 — see below for why this step exists);
 *  4. rebuilds the flattened, depth-annotated tree via `buildFlatTree` (which
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
 * sibling integers stale (duplicated, or even out of order after stacked moves).
 *
 * #3320 — step 3 exists because that staleness is NOT harmless for sibling
 * groups this function would otherwise leave untouched. An earlier version of
 * this comment argued `buildFlatTree`'s SORT STABILITY rescues untouched
 * groups for free — that argument is wrong: stability only preserves relative
 * order among EQUAL keys, not among keys that are already out of order. Worked
 * counterexample, a dense run A=1,B=2,C=3,D=4: `reorder(C,0)` →
 * `reorder(D,0)` → `reorder(B,1)` (three legal, unrelated single-block
 * reorders, none of which touch this batch move) leaves the array as
 * [D,B,C,A] with STORED positions D=1,B=2,C=1,A=1. Handed to `buildFlatTree`
 * unchanged, its position-only sibling sort (stable) produces [D,C,A,B] — a
 * scramble of a group nobody in this move touched. Dense-renumbering every
 * sibling group from its rendered array order (step 3) makes `buildFlatTree`'s
 * sort a no-op for every group, not only destination/source, so the worked
 * counterexample above no longer reproduces.
 *
 * This renumbering is FE-optimistic state only: the `move_blocks_batch` IPC
 * already fired with `orderedIds`/`requestedParentId`/`newIndex` (see the
 * `moveBlocks` reducer, which calls this function AFTER that IPC resolves), so
 * re-deriving every group's `position` here cannot change what was sent to, or
 * already accepted by, the backend.
 *
 * Because every block in a page store belongs to the SAME page, an intra-page
 * batch move never changes any block's `page_id`, so it is left untouched.
 *
 * Returns the new flat array, or `null` to signal "fall back to `load()`":
 *   - the backend echoed a parent other than the one requested (or a response
 *     is missing) — a local splice would diverge from the backend tree;
 *   - the requested parent is the moved run itself or a descendant of one of
 *     the moved roots (see {@link wouldCreateMoveCycle}) — a cycle a flat
 *     splice cannot represent;
 *   - a moved id fell out of the rebuilt tree — the general catch-all: a
 *     moved id vanished from the tree mid-flight (concurrent write), a
 *     `null` requested parent under a non-null page root, or any other
 *     divergence the cycle guard above does not itself name.
 */

/**
 * #3799 — cycle guard for `reconcileBatchMove`/`moveBlocks`, mirroring
 * `moveToParent`'s `canSplice` (`page-blocks-reducers.ts`) for symmetry.
 * Landing the moved run under `wantParent` would make a moved block its own
 * ancestor when `wantParent` IS one of the moved ids, or a descendant (in the
 * PRE-move tree) of one of them — a cycle no flat splice can represent.
 *
 * For this exact input shape, this predicate and the post-rebuild presence
 * check below (`!present.has(id)`) are mathematically equivalent: a moved
 * block whose new parent is itself or its own descendant is ALWAYS part of
 * the cycle that results, so `buildFlatTree`'s DFS-from-root (which silently
 * drops any component it can never reach) always fails to reach it too — the
 * presence check would catch every case this guard does. This guard exists
 * to reject BEFORE paying for the destination-splice + dense-renumber +
 * rebuild this function would otherwise do only to discover the same
 * failure, and to make the safety property a LOCAL, explicit one instead of
 * an emergent side effect of `buildFlatTree`'s cycle-breaking `visited` set
 * that a future refactor of that unrelated utility could silently undo.
 * Exported for direct unit coverage.
 */
export function wouldCreateMoveCycle(
  blocks: FlatBlock[],
  orderedIds: readonly string[],
  wantParent: string | null,
): boolean {
  if (wantParent == null) return false
  if (orderedIds.includes(wantParent)) return true
  // Build the index once rather than letting each getDragDescendants call redo an
  // O(n) findIndex — otherwise this is O(m*n) for an m-id selection on an n-block page.
  const indexById = buildIndexById(blocks)
  return orderedIds.some((id) => getDragDescendants(blocks, id, indexById).has(wantParent))
}

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

  // #3799 — reject a cyclic request up front (see `wouldCreateMoveCycle`'s
  // doc comment for why this and the post-rebuild presence check below are
  // outcome-equivalent for this input shape, and why the guard exists
  // anyway). NOTE: an id absent from `blocks` entirely (not merely a
  // now-nonexistent parent) is likewise not a concern here — it can only ever
  // produce `orderedIds.includes(wantParent) === false` and an empty
  // descendant set, so this guard correctly does not fire for it, and the
  // presence check below remains the (sole, necessary) catch-all for that and
  // any other divergence.
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

  // #3320 — dense-renumber every OTHER sibling group too (untouched by this
  // move — including every VACATED source group, a parent a moved id left
  // other than the destination), from its RENDERED array order. Without
  // this, a group nobody touched in THIS move can still hold stale/duplicate/
  // out-of-order `position` integers left behind by earlier optimistic
  // same-parent movers (#404 `reorder`/`moveUp`/`moveDown`, which heal only
  // the ONE moved block's position — see the doc comment above). Left alone,
  // those stale integers would make `buildFlatTree`'s position sort scramble
  // a group the user never touched. Group by FINAL parent (`parentOf`) and
  // walk `blocks` in array order so each group gets a fresh dense rank
  // matching what's already rendered; ids already ranked above (the
  // destination group, just above) are skipped via `posOf.has`. #3799 — a
  // vacated source group's remaining children were previously renumbered by
  // a dedicated block here too; deleted as redundant (this loop assigns the
  // BYTE-IDENTICAL ranks — same group key `oldParentOf === parentOf` for a
  // non-moved id, same `blocks` array order).
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

  // Materialise the updated bag and rebuild. Every block now has a `posOf`
  // entry (destination group above, every other group — including every
  // vacated source — just above), so every sibling group gets a dense rank
  // reproducing its rendered order, not only the group(s) this move directly
  // touched. `posOf.get(b.id) ?? null` (never the pre-existing `b.position`:
  // the #3320 loop above guarantees every block id got a `posOf` entry, so
  // that fallback arm was dead code — Finding 3, #3799). A block re-allocates
  // only when its (parent, rank) actually changed — the `pos === b.position`
  // guard below keeps the same reference for a block whose dense rank already
  // matched its stored position.
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
 *
 * #3799 Finding 5 — kept, not deleted (unlike Findings 2-4 above, which were
 * PROVABLY subsumed by other code reachable from the exact same inputs): the
 * `#3759` triage's "never observed to matter across 96 reconciles" is an
 * EMPIRICAL corpus result, not a proof of unreachability like Finding 3's
 * `posOf.has` invariant. Both branches below stay reachable in production:
 *   - `!cur` genuinely guards a block deleted (or dropped by a racing
 *     `load()`) between the pre-await provisional splice and this resolve
 *     callback — a real concurrent-write race, not defensive noise;
 *   - the `state.blocks === handle.provBlocks` reference-equality disjunct is
 *     a redundant-for-CORRECTNESS (the second disjunct would also evaluate
 *     true whenever this one does) but genuine fast path: it skips two extra
 *     lookups in the common no-concurrent-write case, mirroring the same
 *     check in `rollbackProvisionalMove` below.
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
