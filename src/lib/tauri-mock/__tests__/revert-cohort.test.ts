/**
 * #3331 — reversing a soft-delete lifecycle op is a COHORT operation.
 *
 * The forward `delete_block` handler stamps ONE `deleted_at` marker across the
 * target and its whole active subtree and appends a SINGLE `delete_block` op —
 * exactly like the backend's single-op cascade. Reversal must therefore walk
 * the cohort too: `src-tauri/agaric-engine/src/reverse/block_ops.rs` reverses `DeleteBlock`
 * into `RestoreBlock { deleted_at_ref: record.created_at }`, and the apply arm
 * in `src-tauri/src/commands/history.rs` clears the whole
 * `DescendantWalkFilter::Cohort(ref)` set. Symmetrically, `reverse_create_block`
 * and `reverse_restore_block` both return `DeleteBlock`, whose apply arm
 * cascades over `DescendantWalkFilter::Active`.
 *
 * Every reversal entry point is exercised through the real command surface
 * (`dispatch`), because there are THREE of them and they used to diverge from
 * the forward handler independently:
 *
 *   * `undo_op` / `undo_ops`  → `applyUndoForTarget` → `applyRevertForOp`
 *   * `revert_ops`            → `applyRevertForOp`
 *   * `undo_page_op`          → its own positional arm in `handlers/history.ts`
 *
 * The boundary case matters as much as the happy path: a descendant deleted
 * SEPARATELY (its own, older cohort marker) must stay in Trash, because the
 * backend's cohort CTE stops descending at the first row whose `deleted_at`
 * differs from `deleted_at_ref`.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
} from '@/lib/tauri-mock/seed'

const PAGE = '00000000000000000000PAGEZZ'
const P = '0000000000000000000000000P'
const A = '0000000000000000000000000A'
const B = '0000000000000000000000000B'
const C = '0000000000000000000000000C'
const D = '0000000000000000000000000D'

interface Ref {
  device_id: string
  seq: number
}
interface WithOpsResp {
  op_refs: Ref[]
  [key: string]: unknown
}

/**
 * PAGE
 *  └─ P
 *      ├─ A
 *      │   └─ D
 *      └─ B
 *          └─ C
 */
function seedSubtree(): void {
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0

  blocks.set(PAGE, makeBlock(PAGE, 'page', 'Test Page', null, 0))
  blocks.set(P, makeBlock(P, 'content', 'P', PAGE, 1))
  blocks.set(A, makeBlock(A, 'content', 'A', P, 1))
  blocks.set(D, makeBlock(D, 'content', 'D', A, 1))
  blocks.set(B, makeBlock(B, 'content', 'B', P, 2))
  blocks.set(C, makeBlock(C, 'content', 'C', B, 1))
}

function deletedAt(id: string): unknown {
  return blocks.get(id)?.['deleted_at']
}

function liveIds(): string[] {
  return [...blocks.values()].filter((b) => !b['deleted_at']).map((b) => b['id'] as string)
}

describe('#3331 — soft-delete lifecycle reversal walks the cohort', () => {
  beforeEach(seedSubtree)

  it('undo_op of a subtree delete_block restores the whole cohort, not just the target', () => {
    const del = dispatch('delete_block', { blockId: P }) as WithOpsResp
    expect(del['descendants_affected']).toBe(5)
    expect(liveIds()).toEqual([PAGE])

    dispatch('undo_op', { opRef: del.op_refs[0] })

    // The whole cohort comes back — not P alone with its children stranded.
    expect(liveIds().toSorted()).toEqual([A, B, C, D, P, PAGE].toSorted())
  })

  it('revert_ops of a subtree delete_block restores the whole cohort', () => {
    const del = dispatch('delete_block', { blockId: P }) as WithOpsResp

    dispatch('revert_ops', { ops: del.op_refs })

    expect(liveIds().toSorted()).toEqual([A, B, C, D, P, PAGE].toSorted())
  })

  it('undo_page_op (positional) of a subtree delete_block restores the whole cohort', () => {
    dispatch('delete_block', { blockId: P })

    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    expect(liveIds().toSorted()).toEqual([A, B, C, D, P, PAGE].toSorted())
  })

  it('leaves an independently-deleted descendant cohort in trash on undo', () => {
    // D is tombstoned on its OWN cohort marker first…
    dispatch('delete_block', { blockId: D })
    const dMarker = deletedAt(D)
    expect(dMarker).toBeTruthy()

    // …so P's cascade skips it (the active-subtree walk never descends into an
    // already-deleted row) and stamps a DIFFERENT marker on P, A, B, C.
    const del = dispatch('delete_block', { blockId: P }) as WithOpsResp
    expect(del['descendants_affected']).toBe(4)
    expect(deletedAt(D)).toBe(dMarker)
    expect(deletedAt(P)).not.toBe(dMarker)

    dispatch('undo_op', { opRef: del.op_refs[0] })

    // P's cohort is live again; D keeps its own, older tombstone.
    expect(liveIds().toSorted()).toEqual([A, B, C, P, PAGE].toSorted())
    expect(deletedAt(D)).toBe(dMarker)
  })

  it('undo_op of a create_block cascades the delete over the active subtree', () => {
    // Undo-of-create reverses to `DeleteBlock` on the backend, which cascades.
    // Model it the way it actually arises: a block created, then given
    // children, then un-created.
    const created = dispatch('create_block', {
      parentId: PAGE,
      content: 'X',
      blockType: 'content',
    }) as WithOpsResp
    const x = created['id'] as string
    dispatch('move_block', { blockId: P, newParentId: x, newIndex: 0 })
    expect(liveIds()).toHaveLength(7)

    dispatch('undo_op', { opRef: created.op_refs[0] })

    // X and everything now under it is tombstoned on one cohort.
    expect(liveIds()).toEqual([PAGE])
    const marker = deletedAt(x)
    expect(marker).toBeTruthy()
    for (const id of [P, A, B, C, D]) expect(deletedAt(id)).toBe(marker)
  })

  it('undo_op of a restore_block re-deletes the whole restored subtree', () => {
    dispatch('delete_block', { blockId: P })
    const restore = dispatch('restore_block', { blockId: P }) as Record<string, unknown>
    expect(restore['restored_count']).toBe(5)
    expect(liveIds()).toHaveLength(6)

    // `restore_block` is a `WithOps`-less handler; take its op off the log.
    const restoreOp = opLog.findLast((o) => o.op_type === 'restore_block')
    expect(restoreOp).toBeDefined()
    dispatch('undo_op', {
      opRef: { device_id: restoreOp?.device_id, seq: restoreOp?.seq },
    })

    expect(liveIds()).toEqual([PAGE])
  })
})
