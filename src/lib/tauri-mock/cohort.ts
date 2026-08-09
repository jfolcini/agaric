/**
 * Tauri mock — the soft-delete COHORT primitive.
 *
 * #3331. The mock models the backend's soft delete the way the backend does:
 * a `delete_block` stamps ONE `deleted_at` marker across the target and its
 * whole ACTIVE descendant subtree (the cohort), and a `restore_block` clears
 * exactly the contiguous same-marker set reachable from the seed. Both walks
 * are the mock's stand-in for `agaric_store::block_descendants::
 * collect_subtree_ids_unbounded` under `DescendantWalkFilter::Active` /
 * `DescendantWalkFilter::Cohort(deleted_at_ref)`.
 *
 * #3693. A restore also walks UPWARD: `restoreDeletedAncestorChain` is the
 * stand-in for `agaric_store::block_descendants::restore_deleted_ancestor_chain`
 * (#1884), which every backend restore writer calls right after the downward
 * cohort UPDATE. `restoreCohort` runs both, so no mock call site can take one
 * walk without the other.
 *
 * They live HERE, in a leaf module that owns no mock state, because three
 * call sites need them and two of them cannot reach `handlers/shared.ts`:
 *
 *   * `handlers/blocks.ts`   — the forward `delete_block` / `restore_block`.
 *   * `revert.ts`            — the reversal core behind `revert_ops`, `undo_op`
 *                              and `undo_ops`. `handlers/shared.ts` imports
 *                              `revert.ts`, so `revert.ts` importing back would
 *                              close an import cycle.
 *   * `handlers/history.ts`  — the positional `undo_page_op`.
 *
 * Reversal fidelity (the #3331 defect): the backend's `reverse_delete_block`
 * (src-tauri/src/reverse/block_ops.rs) returns
 * `RestoreBlock { deleted_at_ref: record.created_at }`, and the apply arm for
 * `OpPayload::RestoreBlock` (src-tauri/src/commands/history.rs) walks the
 * cohort. Symmetrically, `reverse_create_block` and `reverse_restore_block`
 * both return `DeleteBlock`, whose apply arm cascades the ACTIVE subtree. So
 * every reversal of a lifecycle op is a COHORT operation on the backend; the
 * mock used to mutate the single target row, leaving a subtree delete's
 * children stranded in Trash after an undo.
 */

/** A mock block row. Mirrors `handlers/shared.ts`'s untyped row shape. */
type BlockRow = Record<string, unknown>
/** The mock's `blocks` store (id → row). */
export type CohortBlocks = Map<string, BlockRow>

let cohortSeq = 0

/**
 * Mint a fresh, unique soft-delete cohort marker.
 *
 * The backend stamps `deleted_at` with the delete op's `created_at` (epoch ms)
 * and relies on it being distinct per delete — `RestoreBlock`'s
 * `deleted_at_ref` guard matches on equality, so two deletes that shared a
 * marker would restore each other's rows. `Date.now()` alone is not distinct
 * at mock speed (two deletes in the same millisecond collide), hence the
 * monotonic suffix. Still ISO-shaped, so it sorts and stays a truthy string
 * the rest of the mock reads as "deleted".
 */
export function nextCohortMarker(): string {
  cohortSeq += 1
  return `${new Date().toISOString()}#${cohortSeq.toString().padStart(6, '0')}`
}

/**
 * Soft-delete `blockId` and its whole ACTIVE descendant subtree, stamping the
 * SAME `marker` on every row tombstoned. Returns the number of rows tombstoned
 * (target INCLUDED — the backend's `descendants_affected` is the CTE's
 * `rows_affected()`, and the CTE yields the seed at depth 0).
 *
 * Mirrors `descendants_cte_active!()`: the recursive arm only descends into
 * children whose `deleted_at` is NULL, so an already-deleted descendant — and
 * everything below it — keeps its own, older cohort marker and is left
 * untouched. A missing or already-deleted target is a no-op (matching the
 * CTE seed's `WHERE deleted_at IS NULL` filter) and returns 0.
 */
export function deleteCohort(blocks: CohortBlocks, blockId: string, marker: string): number {
  const target = blocks.get(blockId)
  if (!target || target['deleted_at']) return 0
  let affected = 0
  const stack: string[] = [blockId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()
    if (id == null) break
    if (seen.has(id)) continue
    seen.add(id)
    const node = blocks.get(id)
    if (!node || node['deleted_at']) continue
    node['deleted_at'] = marker
    affected++
    for (const child of blocks.values()) {
      if (child['parent_id'] === id && !child['deleted_at'] && !seen.has(child['id'] as string)) {
        stack.push(child['id'] as string)
      }
    }
  }
  return affected
}

/**
 * Restore `blockId` and only the descendants that share its `deleted_at`
 * cohort marker, reached via a CONTIGUOUS same-cohort walk from the seed.
 * Returns the number of rows restored — the DOWNWARD cohort only, matching
 * `RestoreResponse::restored_count`, which the backend takes from the
 * `write_cohort_deleted_at_json` UPDATE's `rows_affected()` and NOT from the
 * ancestor chain the same command also revives (see `restoreCohort`).
 *
 * Mirrors `descendants_cte_cohort!()` / `DescendantWalkFilter::Cohort`: the
 * recursive arm only descends into a child whose `deleted_at` equals the
 * seed's marker, so the walk stops at the first block of a DIFFERENT cohort
 * (an independently-deleted nested subtree stays deleted). A live or missing
 * target has no cohort to restore and returns 0.
 */
function restoreCohortDownward(blocks: CohortBlocks, blockId: string): number {
  const target = blocks.get(blockId)
  const cohort = target?.['deleted_at'] as string | null | undefined
  if (!target || !cohort) return 0
  let restored = 0
  const stack: string[] = [blockId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()
    if (id == null) break
    if (seen.has(id)) continue
    seen.add(id)
    const node = blocks.get(id)
    if (!node || node['deleted_at'] !== cohort) continue
    node['deleted_at'] = null
    restored++
    for (const child of blocks.values()) {
      if (child['deleted_at'] === cohort && !seen.has(child['id'] as string)) {
        if (child['parent_id'] === id) stack.push(child['id'] as string)
      }
    }
  }
  return restored
}

/**
 * Depth bound for the upward walk, mirroring the `deleted_chain` CTE's
 * `c.depth < 100` guard (AGENTS.md invariant #9 — a corrupted `parent_id`
 * chain must not run away).
 */
const ANCESTOR_CHAIN_DEPTH_CAP = 100

/**
 * #3693 — restore the contiguous soft-deleted ANCESTOR chain above `blockId`,
 * up to (but not including) the nearest LIVE ancestor or the root. Returns the
 * restored ancestor ids in depth-ascending order (nearest parent first), so
 * the last element is the backend's `topmost`.
 *
 * Mirrors `agaric_store::block_descendants::restore_deleted_ancestor_chain`
 * (`src-tauri/agaric-store/src/block_descendants.rs`, #1884) and its
 * `deleted_chain` CTE exactly:
 *
 *   * the seed is the block's PARENT, included only when that parent is
 *     itself soft-deleted — so a block whose parent is live restores nothing;
 *   * the recursive arm walks `parent_id` upward while each ancestor is
 *     soft-deleted, so the walk stops at the first LIVE ancestor and at the
 *     root (`parent_id IS NULL`); a live ancestor is never touched;
 *   * the walk is NOT cohort-filtered. That is the whole point: the hole it
 *     closes is "delete a child, LATER delete its parent" — the parent's
 *     cascade skips the already-deleted child, so the two carry DIFFERENT
 *     `deleted_at` markers and the downward cohort walk can never reach the
 *     parent. Restoring the child alone would leave it live under a
 *     tombstoned parent: absent from the tree (`list_children` filters
 *     `deleted_at IS NULL`) AND from trash, a state the backend cannot
 *     produce.
 *
 * Deliberately unconditional on the seed's own state, like the SQL: a missing
 * block has no `parent_id` to seed from and a live block's ancestors are still
 * reconnected, matching the `OpPayload::RestoreBlock` apply arm
 * (`src-tauri/src/commands/history.rs`), which runs this walk with no
 * live-block guard. Idempotent — a re-run finds the chain already live.
 */
export function restoreDeletedAncestorChain(blocks: CohortBlocks, blockId: string): string[] {
  const seed = blocks.get(blockId)
  if (!seed) return []
  const chain: string[] = []
  const seen = new Set<string>([blockId])
  let cursor = (seed['parent_id'] as string | null | undefined) ?? null
  let depth = 0
  while (cursor != null && depth < ANCESTOR_CHAIN_DEPTH_CAP) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const node = blocks.get(cursor)
    if (!node || !node['deleted_at']) break
    node['deleted_at'] = null
    chain.push(cursor)
    cursor = (node['parent_id'] as string | null | undefined) ?? null
    depth++
  }
  return chain
}

/**
 * Restore `blockId`: the downward same-cohort subtree AND the upward
 * contiguous soft-deleted ancestor chain. Returns the DOWNWARD cohort count
 * (`restored_count` on the wire).
 *
 * Both walks live behind this one entry point because every backend writer of
 * a restore performs both — `restore_block_inner`
 * (`src-tauri/src/commands/blocks/crud.rs`), the `OpPayload::RestoreBlock`
 * apply arm (`src-tauri/src/commands/history.rs`) and
 * `project_restore_block_to_sql` (`agaric-engine/src/loro/projection.rs`) —
 * and the mock has three call sites of its own (`handlers/blocks.ts`,
 * `revert.ts`, `handlers/history.ts`). Pairing them here makes it structurally
 * impossible for one call site to take the downward walk alone, which is the
 * divergence #3693 reported.
 */
export function restoreCohort(blocks: CohortBlocks, blockId: string): number {
  // Order mirrors the backend: cohort UPDATE first, ancestor chain second.
  // (They cannot interact — the cohort is strictly below the seed and the
  // chain strictly above it — but keeping the order makes the mirror literal.)
  const restored = restoreCohortDownward(blocks, blockId)
  restoreDeletedAncestorChain(blocks, blockId)
  return restored
}
