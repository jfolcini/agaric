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

import { dispatch } from '../handlers'
import { blocks, blockTags, makeBlock, opLog, properties, propertyDefs } from '../seed'

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
  const rows = dispatch('load_page_subtree', {
    rootBlockId: PAGE,
    spaceId: SPACE,
  }) as Array<Record<string, unknown>>
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
      dispatch('load_page_subtree', { rootBlockId: PAGE, spaceId: SPACE }) as Array<
        Record<string, unknown>
      >
    ).filter((r) => (r['parent_id'] as string | null) === GS2)
    expect(gs2Children.map((r) => r['id'])).toEqual([GS3])
  })

  it('redo of a reorder re-applies the move with dense, distinct ranks', () => {
    const A = '0000000000000000000000ZZ_A'
    const B = '0000000000000000000000AA_B'
    seedPage([A, B])

    dispatch('move_block', { blockId: A, newParentId: PAGE, newIndex: 1 })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
    expect(loadedRootOrder()).toEqual([A, B])

    // The original move op's seq is the redo target (frontend stores it).
    const moveOp = opLog.find((o) => o.op_type === 'move_block')
    expect(moveOp).toBeDefined()
    dispatch('redo_page_op', { pageId: PAGE, undoSeq: moveOp?.seq })

    expect(loadedRootOrder()).toEqual([B, A])
    expect(rowOf(A)['position']).not.toBe(rowOf(B)['position'])
  })
})
