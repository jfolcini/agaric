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
 * Returns the number of rows restored.
 *
 * Mirrors `descendants_cte_cohort!()` / `DescendantWalkFilter::Cohort`: the
 * recursive arm only descends into a child whose `deleted_at` equals the
 * seed's marker, so the walk stops at the first block of a DIFFERENT cohort
 * (an independently-deleted nested subtree stays deleted). A live or missing
 * target has no cohort to restore and returns 0.
 */
export function restoreCohort(blocks: CohortBlocks, blockId: string): number {
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
