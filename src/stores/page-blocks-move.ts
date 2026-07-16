/**
 * Optimistic structural-move core for the per-page block store (#1077, #2274).
 *
 * Extracted from `page-blocks.ts` (#2254) — behavior-preserving move. Holds the
 * recompute-at-commit + reconcile-or-reload core (`applyStructuralMove`) shared
 * by every optimistic mover (createBelow/reorder/indent/dedent/moveUp/moveDown)
 * and the batched-move surgical reconcile (`reconcileBatchMove`, used by
 * moveBlocks). Callers live in `page-blocks-reducers.ts`.
 */

import type { MoveResponse } from '@/lib/tauri'
import { buildFlatTree, type FlatBlock } from '@/lib/tree-utils'
import { cloneBlocksByIdWith } from '@/stores/page-blocks-map'
import type { PageBlockState } from '@/stores/page-blocks-types'

// ── Optimistic structural-move core (#1077) ──────────────────────────────

/**
 * #1077 — the recompute-at-commit + reconcile-or-reload core shared by every
 * optimistic structural mover (`createBelow`, `reorder`, `indent`, `dedent`,
 * `moveUp`, `moveDown`).
 *
 * Each of those actions captures a pre-await snapshot and dispatches its
 * `move_block` / `create_block` IPC FIRST (that part stays in the caller, and
 * so does any backend-echo parent-mismatch reload — see the call sites), then
 * runs this core SYNCHRONOUSLY with the resolved IPC response. The core:
 *
 *  1. runs `validateAtCommit(state)` inside a functional `set()` updater, so
 *     the anchor/sibling context is re-validated against `state.blocks`
 *     CURRENT AT COMMIT TIME — a concurrent write (edit flush, sync load,
 *     queued move) that landed while the IPC was in flight must survive;
 *  2. on a `'reload'` decision, commits nothing and falls back to a full
 *     `get().load()` to reconcile FE with the backend;
 *  3. on a `'skip'` decision, commits nothing and does NOT reload (the state
 *     is already reconciled — e.g. an interleaved sync load already delivered
 *     the new block);
 *  4. on a `'commit'` decision, applies `computeSpliced(state)` and derives the
 *     next `blocksById` via the subtree-touch `cloneBlocksByIdWith(touchedIds)`
 *     perf invariant (only the touched keys re-allocate).
 *
 * The `needsReload` flag + `set()` wrapper + `if (needsReload) await load()`
 * fallback all live here; callers pass only their action-specific predicate and
 * splice. The pre-await-capture contract is preserved because this runs
 * synchronously after the caller's capture + dispatch — the only await is the
 * conditional reconciling `load()`.
 */
type StructuralCommitDecision =
  /** Anchor/sibling context still valid — apply `computeSpliced`. */
  | { kind: 'commit' }
  /** Context invalid mid-flight — commit nothing and reload to reconcile. */
  | { kind: 'reload' }
  /** State already reconciled — commit nothing, do NOT reload. */
  | { kind: 'skip' }

interface StructuralMoveSpec {
  /**
   * Re-validate the action's anchor/sibling context against the commit-time
   * `state`. Return `{ kind: 'commit' }` to apply the splice, `{ kind: 'reload' }`
   * to fall back to `load()`, or `{ kind: 'skip' }` to commit nothing without
   * reloading. A bare `true`/`false` is accepted as sugar for
   * `'commit'`/`'reload'` (the common two-outcome movers).
   */
  validateAtCommit: (state: PageBlockState) => StructuralCommitDecision | boolean
  /**
   * Compute the spliced flat tree and the set of ids whose `FlatBlock`
   * reference changed (the subtree-touch perf invariant). Only called after
   * `validateAtCommit` resolves to `'commit'`.
   */
  computeSpliced: (state: PageBlockState) => {
    blocks: FlatBlock[]
    touchedIds: Iterable<string>
  }
}

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

/**
 * Run the optimistic recompute-at-commit + reconcile-or-reload core. See
 * `StructuralMoveSpec`. Must be invoked synchronously after the caller has
 * captured its pre-await snapshot and dispatched its IPC.
 */
export async function applyStructuralMove(
  set: (updater: (state: PageBlockState) => Partial<PageBlockState>) => void,
  get: () => PageBlockState,
  { validateAtCommit, computeSpliced }: StructuralMoveSpec,
): Promise<void> {
  let needsReload = false
  set((state) => {
    const decision = validateAtCommit(state)
    const kind = decision === true ? 'commit' : decision === false ? 'reload' : decision.kind
    if (kind === 'reload') {
      needsReload = true
      return {}
    }
    if (kind === 'skip') return {}
    const { blocks, touchedIds } = computeSpliced(state)
    // Perf (#2041): resolve touched ids via a single id→object Map built once
    // (O(n)) instead of a per-id `blocks.find` (O(touched×n)) inside the loop.
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
    return {
      blocks,
      blocksById: cloneBlocksByIdWith(state.blocksById, touched),
    }
  })
  if (needsReload) await get().load()
}
