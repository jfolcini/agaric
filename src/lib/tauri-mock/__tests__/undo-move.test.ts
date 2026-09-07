/**
 * #958 — structural reorder/reparent undo must revert IN PLACE.
 *
 * This drives the EXACT e2e undo path — the `move_block` + `undo_page_op`
 * handlers in `handlers.ts`, then a fresh `load_page_subtree` (what the
 * production `refreshAfterUndoRedo` → store `load()` re-fetches) — and asserts
 * the reloaded order/parent reverts to the pre-move state without any reopen.
 *
 * Before the fix, `undo_page_op` wrote the raw `old_position` back onto the
 * moved block WITHOUT renumbering its sibling group, so the moved block
 * collided (same `position`) with the sibling now occupying its old slot.
 * `load_page_subtree` orders by `position ASC, id ASC`, so the tie broke on id
 * — NOT the intended pre-move order — and the order/depth failed to revert
 * (the "Undone" toast fired, but the tree only "healed" on a full reopen).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blocks,
  blockTags,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
} from '@/lib/tauri-mock/seed'

const PAGE = '00000000000000000000PAGEZZ'
const SPACE = 'SPACE_PERSONAL'

/** Reset every relevant mock store and seed a page with `n` root children. */
function seedPage(childIds: string[]): void {
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0

  blocks.set(PAGE, makeBlock(PAGE, 'page', 'Test Page', null, 0))
  properties.set(
    PAGE,
    new Map([
      [
        'space',
        {
          block_id: PAGE,
          key: 'space',
          value_text: null,
          value_num: null,
          value_date: null,
          value_ref: SPACE,
          value_bool: null,
        },
      ],
    ]),
  )
  childIds.forEach((id, i) => {
    blocks.set(id, makeBlock(id, 'content', `block ${id}`, PAGE, i + 1))
  })
}

/** The reloaded top-level child order (what the store rebuilds after undo). */
function loadedRootOrder(): string[] {
  // #1258 — `load_page_subtree` now returns `{ blocks, truncated, total }`.
  const { blocks: rows } = dispatch('load_page_subtree', {
    rootBlockId: PAGE,
    scope: { kind: 'active', space_id: SPACE },
  }) as { blocks: Array<Record<string, unknown>> }
  return rows
    .filter((r) => (r['parent_id'] as string | null) === PAGE)
    .map((r) => r['id'] as string)
}

function rowOf(id: string): Record<string, unknown> {
  const b = blocks.get(id)
  if (!b) throw new Error(`block ${id} missing`)
  return b
}

describe('#958 — reorder/reparent undo reverts in place', () => {
  beforeEach(() => {
    seedPage([])
  })

  it('reverts a move-down (reorder) so the reloaded order returns to A,B', () => {
    // Use ids where the FIRST block sorts AFTER the second lexically, so a
    // position collision would (wrongly) keep the moved block last — the exact
    // failure the e2e hit on a 2-block page.
    const A = '0000000000000000000000ZZ_A'
    const B = '0000000000000000000000AA_B'
    seedPage([A, B])
    expect(loadedRootOrder()).toEqual([A, B])

    // Move A down to slot 1 (after B).
    dispatch('move_block', { blockId: A, newParentId: PAGE, newIndex: 1 })
    expect(loadedRootOrder()).toEqual([B, A])

    // Undo — the e2e path. Must restore A,B in the reloaded snapshot.
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    expect(loadedRootOrder()).toEqual([A, B])
    // Dense, distinct ranks — no collision.
    expect(rowOf(A)['position']).not.toBe(rowOf(B)['position'])
  })

  it("#4669 — undo restores into the LIVE group, leaving the tombstone's rank alone", () => {
    // `revert.ts` carries near-copies of `renumberSiblings` /
    // `insertAtSlotAndRenumber` (a circular import forced the duplication), and
    // they rank DIFFERENTLY from the originals on purpose, because the backend
    // does:
    //
    //   * forward apply → `reproject_dense_positions`, which ranks the whole
    //     ordered group, tombstone included (#419).
    //   * reverse apply → `apply_reverse_in_tx`'s MoveBlock arm, whose target
    //     group is `WHERE parent_id IS ? AND deleted_at IS NULL`, densified by
    //     `reproject_live_sibling_group` — "tombstoned siblings are excluded:
    //     they are not part of the live order a user sees"
    //     (`src-tauri/src/commands/history.rs`).
    //
    // So the tombstone KEEPS its stale rank across the undo and the restored
    // live block legitimately lands on the same number. That shared position is
    // the contract, not a collision bug — asserting the two must differ pins a
    // divergence instead. The fuzz lane cannot reach this (its renderer emits
    // no undo command), which is why it is pinned by hand.
    const A = '00000000000000000000TOMB_A'
    const B = '00000000000000000000TOMB_B'
    const OTHER = '000000000000000000OTHERPAGE'
    seedPage([A, B])
    blocks.set(OTHER, makeBlock(OTHER, 'page', 'Other', null, 2))

    // Forward path: A is tombstoned and KEEPS position 1.
    dispatch('delete_block', { blockId: A })
    expect(rowOf(A)['deleted_at']).not.toBeNull()
    expect(rowOf(A)['position']).toBe(1)

    dispatch('move_block', { blockId: B, newParentId: OTHER, newIndex: 0 })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    expect(rowOf(B)['parent_id']).toBe(PAGE)
    // The live target group was EMPTY (A is a tombstone), so the slot clamps to
    // 0 and B densifies to 1 — on top of A's untouched stale 1.
    expect(rowOf(A)['position']).toBe(1)
    expect(rowOf(B)['position']).toBe(1)
    // What actually matters to a reader: B is the only thing they can see.
    expect(loadedRootOrder()).toEqual([B])
  })

  it('#4669 — revert_ops takes the same live-only reverse path as undo_page_op', () => {
    // `revert_ops` goes through `revert.ts`'s `applyRevertForOp`, which carries
    // its OWN copies of the two position helpers. `undo_page_op` above never
    // reaches them, so without this the copies could drift and nothing would
    // say so. Same expected shape, for the same reason.
    const A = '000000000000000000REVTOMBA'
    const B = '000000000000000000REVTOMBB'
    const OTHER = '0000000000000000REVOTHERPG'
    seedPage([A, B])
    blocks.set(OTHER, makeBlock(OTHER, 'page', 'Other', null, 2))
    // A child under B, so the revert's descendant `page_id` re-stamp is
    // exercised and not merely present (#957 — a moved subtree's descendants
    // must carry the new page root; the backend's reverse arm re-derives the
    // whole subtree via `rederive_page_and_space_ids`).
    const KID = (dispatch('create_block', { parentId: B, content: 'kid' }) as { id: string }).id

    dispatch('delete_block', { blockId: A })
    dispatch('move_block', { blockId: B, newParentId: OTHER, newIndex: 0 })
    expect(rowOf(KID)['page_id']).toBe(OTHER)

    const moveOp = opLog.findLast((o) => o.op_type === 'move_block')
    if (!moveOp) throw new Error('no move_block op to revert')
    dispatch('revert_ops', { ops: [{ device_id: moveOp.device_id, seq: moveOp.seq }] })

    expect(rowOf(B)['parent_id']).toBe(PAGE)
    expect(rowOf(A)['position']).toBe(1)
    expect(rowOf(B)['position']).toBe(1)
    expect(loadedRootOrder()).toEqual([B])
    // The subtree came back with it.
    expect(rowOf(KID)['page_id']).toBe(PAGE)
  })

  it('reverts a reparent (indent then dedent then undo) so the block re-nests', () => {
    // GS-style ids; GS_3 indents under GS_2, dedents back to root, then undo
    // must re-nest it under GS_2 at the indented depth.
    const GS1 = '00000000000000000000000GS1'
    const GS2 = '00000000000000000000000GS2'
    const GS3 = '00000000000000000000000GS3'
    seedPage([GS1, GS2, GS3])

    // Indent GS_3 under GS_2 (append as last child → slot 0, GS_2 has no kids).
    dispatch('move_block', { blockId: GS3, newParentId: GS2, newIndex: 0 })
    expect(rowOf(GS3)['parent_id']).toBe(GS2)

    // Dedent GS_3 back to root, right after GS_2 (GS_2 is root slot 1 → slot 2).
    dispatch('move_block', { blockId: GS3, newParentId: PAGE, newIndex: 2 })
    expect(rowOf(GS3)['parent_id']).toBe(PAGE)
    expect(loadedRootOrder()).toEqual([GS1, GS2, GS3])

    // Undo the dedent — GS_3 must re-nest under GS_2 (the indented depth),
    // and the reloaded snapshot must reflect it with no reopen.
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    expect(rowOf(GS3)['parent_id']).toBe(GS2)
    // page_id recomputed from the restored parent (still the page).
    expect(rowOf(GS3)['page_id']).toBe(PAGE)
    // Root now holds only GS1, GS2; GS3 is GS2's child.
    expect(loadedRootOrder()).toEqual([GS1, GS2])
    const gs2Children = (
      dispatch('load_page_subtree', {
        rootBlockId: PAGE,
        scope: { kind: 'active', space_id: SPACE },
      }) as {
        blocks: Array<Record<string, unknown>>
      }
    ).blocks.filter((r) => (r['parent_id'] as string | null) === GS2)
    expect(gs2Children.map((r) => r['id'])).toEqual([GS3])
  })

  it('redo of a reorder re-applies the move with dense, distinct ranks', () => {
    const A = '0000000000000000000000ZZ_A'
    const B = '0000000000000000000000AA_B'
    seedPage([A, B])

    dispatch('move_block', { blockId: A, newParentId: PAGE, newIndex: 1 })
    const undoResult = dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 }) as {
      new_op_ref: { seq: number }
    }
    expect(loadedRootOrder()).toEqual([A, B])

    // The undo op's ref (`new_op_ref`) is the redo target — the frontend
    // stores it on the redo stack, matching the backend's #659 contract.
    dispatch('redo_page_op', { pageId: PAGE, undoSeq: undoResult.new_op_ref.seq })

    expect(loadedRootOrder()).toEqual([B, A])
    expect(rowOf(A)['position']).not.toBe(rowOf(B)['position'])
  })
})
