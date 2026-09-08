/**
 * #4868 — undo provenance is `op_log.is_undo`, not an `undo_` / `redo_` /
 * `revert_` op_type prefix.
 *
 * `undo_page_op_inner`'s own doc comment states the rule the mock used to
 * break (`src-tauri/src/commands/history.rs`): a reverse op "uses a plain
 * `op_type` (e.g. `edit_block`), NOT an `undo_`/`redo_` prefix, so the filter
 * must key on the `is_undo` flag, not the op_type."
 *
 * Three consequences, one test each:
 *
 *  1. A REDO op keeps `is_undo = 0` — "its effect is forward-equivalent"
 *     (`src-tauri/src/commands/history.rs:2401`) — so `AND ol.is_undo = 0` admits it and it is the
 *     next Ctrl+Z target. The prefix filter excluded `redo_*` and targeted the
 *     op BEFORE it, so undo-after-redo undid the wrong thing in browser mode.
 *  2. A reverse op carries a `block_id` like any other op, so the two readers
 *     that require one — `list_page_history`'s per-page scope and
 *     `get_block_history` — list it. They used to drop every undo.
 *  3. The op TYPE is the genuine reverse type, which is what the #763 op-log
 *     digest compares across the two stacks.
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
const A = '0000000000000000000000BL_A'

interface Ref {
  device_id: string
  seq: number
}
interface UndoResultResp {
  reversed_op: Ref
  new_op_ref: Ref
  new_op_type: string
}
interface Paged {
  items: Array<Record<string, unknown>>
}

function seedPage(): void {
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0
  blocks.set(PAGE, makeBlock(PAGE, 'page', 'Test Page', null, 0))
  blocks.set(A, makeBlock(A, 'content', 'original', PAGE, 1))
}

describe('#4868 — undo provenance is is_undo, not an op_type prefix', () => {
  beforeEach(seedPage)

  it('a redo op OCCUPIES a slot in the undoable list, because it is is_undo = 0', () => {
    // Two edits, so the depth axis can tell the two worlds apart. Depth 0
    // cannot: whether the redo is in the list or not, the op it resolves to is
    // the same one, and the content lands on 'v1' either way — an assertion
    // true for two reasons.
    dispatch('edit_block', { blockId: A, toText: 'v1' })
    dispatch('edit_block', { blockId: A, toText: 'v2' })

    const undo = dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 }) as UndoResultResp
    expect(blocks.get(A)?.['content']).toBe('v1')
    dispatch('redo_page_op', {
      undoDeviceId: undo.new_op_ref.device_id,
      undoSeq: undo.new_op_ref.seq,
    })
    expect(blocks.get(A)?.['content']).toBe('v2')

    // Undoable, newest-first, is now [redo, edit→v2, edit→v1], so depth 1 is
    // the SECOND edit and reversing it lands on 'v1'. With the redo excluded
    // the list is [edit→v2, edit→v1], depth 1 is the FIRST edit, and reversing
    // that lands on 'original' — which is what the op_type prefix filter did.
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 1 })
    expect(blocks.get(A)?.['content']).toBe('v1')
  })

  it('an undo op is listed by per-page history and by block history', () => {
    dispatch('edit_block', { blockId: A, toText: 'edited once' })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    const pageRows = dispatch('list_page_history', { pageId: PAGE, limit: 50 }) as Paged
    const blockRows = dispatch('get_block_history', { blockId: A, limit: 50 }) as Paged

    // Two ops now, and BOTH are scoped to the page and to the block: the
    // forward `edit_block` and its reverse. The reverse used to carry no
    // `block_id`, so both readers dropped it and served one row.
    expect(pageRows.items).toHaveLength(2)
    expect(blockRows.items).toHaveLength(2)
  })

  it('a reverse op carries the genuine reverse type, and the flag', () => {
    dispatch('edit_block', { blockId: A, toText: 'edited once' })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    const reverse = opLog.at(-1)
    expect(reverse?.op_type).toBe('edit_block')
    expect(reverse?.is_undo).toBe(true)

    // A forward op is not flagged, which is what makes the flag mean anything.
    expect(opLog[0]?.op_type).toBe('edit_block')
    expect(opLog[0]?.is_undo).toBe(false)
  })

  it('a redo takes the reverse of the UNDO op, not of the original', () => {
    // Backend: `compute_reverse(undo_op)`. Undoing a `create_block` appends a
    // `delete_block`, so redoing it reverses THAT and lands on
    // `restore_block`. Deriving the type from the original op instead gives
    // `create_block` — the one arm where the type still differed cross-stack.
    const created = dispatch('create_block', {
      content: 'fresh',
      parentId: PAGE,
      position: 2,
    }) as { op_refs: Ref[] }
    expect(created.op_refs).toHaveLength(1)

    const undo = dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 }) as UndoResultResp
    expect(opLog.at(-1)?.op_type).toBe('delete_block')

    const redo = dispatch('redo_page_op', {
      undoDeviceId: undo.new_op_ref.device_id,
      undoSeq: undo.new_op_ref.seq,
    }) as { new_op_type: string }

    expect(opLog.at(-1)?.op_type).toBe('restore_block')
    expect(opLog.at(-1)?.is_undo).toBe(false)
    expect(redo.new_op_type).toBe('restore_block')
  })

  it('a create_block reverse is a delete_block, not an undo_delete_block', () => {
    const created = dispatch('create_block', {
      content: 'fresh',
      parentId: PAGE,
      position: 2,
    }) as { op_refs: Ref[] }
    expect(created.op_refs).toHaveLength(1)

    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
    const reverse = opLog.at(-1)
    expect(reverse?.op_type).toBe('delete_block')
    expect(reverse?.is_undo).toBe(true)
  })

  it('reverting a reverse row leaves the content alone, it does not wipe it', () => {
    // The reverse row now advertises `edit_block` with a resolvable
    // `block_id`, so `revert_ops` reaches `applyRevertForOp`'s edit arm —
    // which writes `payload.from_text ?? null`. The row's payload is a
    // bookkeeping stash and has no `from_text`, so an unguarded revert sets
    // the content to NULL. The backend re-applies the original edit instead;
    // a no-op is the safe half of that divergence, a wipe is not (#4870).
    dispatch('edit_block', { blockId: A, toText: 'edited once' })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
    expect(blocks.get(A)?.['content']).toBe('original')

    const reverseRow = opLog.at(-1)
    dispatch('revert_ops', {
      ops: [{ device_id: reverseRow?.device_id, seq: reverseRow?.seq }],
    })

    expect(blocks.get(A)?.['content']).toBe('original')
  })

  it('a positional undo of a tag op stamps remove_tag, not edit_block', () => {
    // The effect chain covers the five block-row types and defaulted to
    // `edit_block` for everything else, so undoing a tag or property op
    // labelled the reverse row `edit_block`. Since the row is now one History
    // displays and the #763 digest compares, that label is observable.
    const TAG = '000000000000000000000TAGZZ'
    blocks.set(TAG, makeBlock(TAG, 'tag', 'sometag', null, 99))
    dispatch('add_tag', { blockId: A, tagId: TAG })

    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    expect(opLog.at(-1)?.op_type).toBe('remove_tag')
    expect(opLog.at(-1)?.is_undo).toBe(true)
  })
})
