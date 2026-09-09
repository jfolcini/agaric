/**
 * #4870 — a reverse row carries a genuine FORWARD payload of its reverse type,
 * not a bookkeeping stash.
 *
 * The backend's reverse row is a real op: `compute_reverse` builds a payload of
 * the reverse type and `append_local_undo_op_in_tx` writes it
 * (`src-tauri/agaric-engine/src/reverse/`, `src-tauri/src/commands/history.rs`).
 * The mock wrote `{ reversed }` / `{ re_applied }` / `{ reverted }` instead, so
 * reverting a reverse row read every key it needed as absent and `revert_ops`
 * had to skip such rows outright to keep an `edit_block` undo from wiping the
 * block's content.
 *
 * The invariant every test here states, in the shape that particular op type
 * makes it observable: reverting a reverse row RE-APPLIES the op it reversed.
 * The shapes are not symmetric with their forward twins — `set_property`
 * spreads no value at all and is reverted through a typed `from_value`, and
 * `delete_property`'s reverse is a `set_property` whose OWN `from_value` is
 * null so that reverting it deletes the key again — so each of those gets its
 * own case.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { HistoryEntry } from '@/lib/bindings'
import { getPayloadRawContent } from '@/lib/history-utils'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  type MockOpLogEntry,
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
} from '@/lib/tauri-mock/seed'

const PAGE = '00000000000000000000PAGEZZ'
const A = '0000000000000000000000BL_A'
const B = '0000000000000000000000BL_B'
const TAG = '000000000000000000000TAGZZ'

interface Ref {
  device_id: string
  seq: number
}

function seedPage(): void {
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0
  blocks.set(PAGE, makeBlock(PAGE, 'page', 'Test Page', null, 0))
  blocks.set(A, makeBlock(A, 'content', 'original', PAGE, 1))
  blocks.set(B, makeBlock(B, 'content', 'sibling', PAGE, 2))
}

/** The row `undo_page_op` just appended. */
function lastOp(): MockOpLogEntry {
  const op = opLog.at(-1)
  if (!op) throw new Error('op log is empty')
  return op
}

function payloadOf(op: MockOpLogEntry): Record<string, unknown> {
  return JSON.parse(op.payload) as Record<string, unknown>
}

/** Undo the newest op, then revert the reverse row it appended. */
function undoThenRevertTheReverse(): void {
  dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
  const reverseRow = lastOp()
  dispatch('revert_ops', { ops: [{ device_id: reverseRow.device_id, seq: reverseRow.seq }] })
}

describe('#4870 — reverse rows carry a real reverse payload', () => {
  beforeEach(seedPage)

  it('edit_block: the reverse swaps from_text and to_text', () => {
    dispatch('edit_block', { blockId: A, toText: 'edited once' })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    const reverse = lastOp()
    expect(reverse.op_type).toBe('edit_block')
    // A forward edit from what the undo landed on, back to what it replaced.
    expect(payloadOf(reverse)).toMatchObject({
      block_id: A,
      from_text: 'edited once',
      to_text: 'original',
    })
  })

  it('edit_block: reverting the reverse row re-applies the edit', () => {
    dispatch('edit_block', { blockId: A, toText: 'edited once' })
    undoThenRevertTheReverse()

    // The stash carried no `from_text`, so the edit arm used to write
    // `?? null` — a content WIPE, which is why `revert_ops` skipped the row.
    expect(blocks.get(A)?.['content']).toBe('edited once')
  })

  it('edit_block: the undo row is restorable in block history', () => {
    dispatch('edit_block', { blockId: A, toText: 'edited once' })
    const undo = dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 }) as {
      new_op_ref: Ref
    }

    const rows = dispatch('get_block_history', { blockId: A, limit: 50 }) as {
      items: HistoryEntry[]
    }
    const undoRow = rows.items.find((r) => r.seq === undo.new_op_ref.seq)
    // `BlockHistoryItem`'s restorability predicate, verbatim
    // (`src/components/HistoryListItem/BlockHistoryItem.tsx`): an `edit_block`
    // row whose payload yields a raw content string. The stash yielded none,
    // so the restore affordance was absent where the backend offers it.
    expect(undoRow?.op_type).toBe('edit_block')
    expect(getPayloadRawContent(undoRow as HistoryEntry)).toBe('original')
  })

  it('move_block: the reverse swaps the old and new placement', () => {
    dispatch('move_block', { blockId: A, newParentId: PAGE, newIndex: 1 })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    const forward = payloadOf(opLog[0] as MockOpLogEntry)
    const reverse = lastOp()
    expect(reverse.op_type).toBe('move_block')
    expect(payloadOf(reverse)).toMatchObject({
      block_id: A,
      old_parent_id: forward['new_parent_id'],
      old_position: forward['new_position'],
      new_parent_id: forward['old_parent_id'],
      new_position: forward['old_position'],
    })
  })

  it('move_block: reverting the reverse row re-applies the move', () => {
    // A starts at position 1, B at 2. Move A after B, undo, then revert the
    // undo: A is back after B.
    dispatch('move_block', { blockId: A, newParentId: PAGE, newIndex: 1 })
    expect(blocks.get(A)?.['position']).toBe(2)

    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
    expect(blocks.get(A)?.['position']).toBe(1)

    const reverseRow = lastOp()
    dispatch('revert_ops', { ops: [{ device_id: reverseRow.device_id, seq: reverseRow.seq }] })
    expect(blocks.get(A)?.['position']).toBe(2)
  })

  it('create_block: the reverse is a delete_block naming the block alone', () => {
    dispatch('create_block', { content: 'fresh', parentId: PAGE, position: 3 })
    const created = payloadOf(opLog.at(-1) as MockOpLogEntry)['block_id'] as string

    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
    const reverse = lastOp()
    expect(reverse.op_type).toBe('delete_block')
    expect(payloadOf(reverse)).toMatchObject({ block_id: created })
    expect(blocks.get(created)?.['deleted_at']).not.toBeNull()

    // Reverting the reverse restores the block — the original create, re-applied.
    dispatch('revert_ops', { ops: [{ device_id: reverse.device_id, seq: reverse.seq }] })
    expect(blocks.get(created)?.['deleted_at']).toBeNull()
  })

  it('delete_block: reverting the reverse row re-deletes the block', () => {
    dispatch('delete_block', { blockId: A })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
    expect(lastOp().op_type).toBe('restore_block')
    expect(blocks.get(A)?.['deleted_at']).toBeNull()

    const reverseRow = lastOp()
    dispatch('revert_ops', { ops: [{ device_id: reverseRow.device_id, seq: reverseRow.seq }] })
    expect(blocks.get(A)?.['deleted_at']).not.toBeNull()
  })

  it('set_todo_state: the reverse swaps state and from_state', () => {
    dispatch('set_todo_state', { blockId: A, state: 'TODO' })
    dispatch('set_todo_state', { blockId: A, state: 'DONE' })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
    expect(blocks.get(A)?.['todo_state']).toBe('TODO')

    const reverse = lastOp()
    expect(reverse.op_type).toBe('set_todo_state')
    expect(payloadOf(reverse)).toMatchObject({ block_id: A, state: 'TODO', from_state: 'DONE' })

    dispatch('revert_ops', { ops: [{ device_id: reverse.device_id, seq: reverse.seq }] })
    expect(blocks.get(A)?.['todo_state']).toBe('DONE')
  })

  it('set_priority: the reverse swaps level and from_level', () => {
    dispatch('set_priority', { blockId: A, level: 'C' })
    dispatch('set_priority', { blockId: A, level: 'A' })
    undoThenRevertTheReverse()
    expect(blocks.get(A)?.['priority']).toBe('A')
  })

  it('set_due_date: the reverse swaps date and from_date', () => {
    dispatch('set_due_date', { blockId: A, date: '2026-01-01' })
    dispatch('set_due_date', { blockId: A, date: '2026-02-02' })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
    expect(blocks.get(A)?.['due_date']).toBe('2026-01-01')

    const reverse = lastOp()
    expect(payloadOf(reverse)).toMatchObject({
      block_id: A,
      date: '2026-01-01',
      from_date: '2026-02-02',
    })

    dispatch('revert_ops', { ops: [{ device_id: reverse.device_id, seq: reverse.seq }] })
    expect(blocks.get(A)?.['due_date']).toBe('2026-02-02')
  })

  it('set_scheduled_date: the reverse swaps date and from_date', () => {
    dispatch('set_scheduled_date', { blockId: A, date: '2026-01-01' })
    dispatch('set_scheduled_date', { blockId: A, date: '2026-02-02' })
    undoThenRevertTheReverse()
    expect(blocks.get(A)?.['scheduled_date']).toBe('2026-02-02')
  })

  it('set_property: the reverse carries the value being undone as from_value', () => {
    dispatch('set_property', { blockId: A, key: 'author', value: { value_text: 'ada' } })
    dispatch('set_property', { blockId: A, key: 'author', value: { value_text: 'grace' } })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
    expect(properties.get(A)?.get('author')?.['value_text']).toBe('ada')

    // The mock's forward `set_property` payload records only the value it
    // REPLACED, so the inverse's `from_value` has to come from the live
    // properties map — read before the revert runs, or it reads back 'ada'.
    const reverse = lastOp()
    expect(reverse.op_type).toBe('set_property')
    expect(payloadOf(reverse)).toMatchObject({
      block_id: A,
      key: 'author',
      from_value: { value_text: 'grace' },
    })

    dispatch('revert_ops', { ops: [{ device_id: reverse.device_id, seq: reverse.seq }] })
    expect(properties.get(A)?.get('author')?.['value_text']).toBe('grace')
  })

  it('delete_property: the reverse is a set_property whose from_value is null', () => {
    dispatch('set_property', { blockId: A, key: 'author', value: { value_text: 'ada' } })
    dispatch('delete_property', { blockId: A, key: 'author' })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })
    expect(properties.get(A)?.get('author')?.['value_text']).toBe('ada')

    const reverse = lastOp()
    expect(reverse.op_type).toBe('set_property')
    // Null, not 'ada': the property was ABSENT immediately before this reverse
    // op, so reverting it must delete the key again rather than resurrect it.
    expect(payloadOf(reverse)).toMatchObject({ block_id: A, key: 'author', from_value: null })

    dispatch('revert_ops', { ops: [{ device_id: reverse.device_id, seq: reverse.seq }] })
    expect(properties.get(A)?.has('author')).toBe(false)
  })

  it('add_tag: the reverse is a remove_tag that actually drops the tag', () => {
    blocks.set(TAG, makeBlock(TAG, 'tag', 'sometag', null, 99))
    dispatch('add_tag', { blockId: A, tagId: TAG })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    const reverse = lastOp()
    expect(reverse.op_type).toBe('remove_tag')
    expect(payloadOf(reverse)).toMatchObject({ block_id: A, tag_id: TAG })
    // The positional undo chain covered the block-row types only, so it
    // stamped the right label over an untouched tag set.
    expect(blockTags.get(A)?.has(TAG)).toBe(false)

    dispatch('revert_ops', { ops: [{ device_id: reverse.device_id, seq: reverse.seq }] })
    expect(blockTags.get(A)?.has(TAG)).toBe(true)
  })

  it('remove_tag: the reverse is an add_tag that actually re-adds the tag', () => {
    blocks.set(TAG, makeBlock(TAG, 'tag', 'sometag', null, 99))
    dispatch('add_tag', { blockId: A, tagId: TAG })
    dispatch('remove_tag', { blockId: A, tagId: TAG })
    dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 })

    const reverse = lastOp()
    expect(reverse.op_type).toBe('add_tag')
    expect(blockTags.get(A)?.has(TAG)).toBe(true)

    dispatch('revert_ops', { ops: [{ device_id: reverse.device_id, seq: reverse.seq }] })
    expect(blockTags.get(A)?.has(TAG)).toBe(false)
  })

  it('redo re-applies a property op the old per-type chain never touched', () => {
    // `redo_page_op` owned a second per-type chain covering the block-row
    // types only, so redoing a property undo was a silent no-op. It now
    // reverses the UNDO row — which is what `redo_page_op_inner` does.
    dispatch('set_property', { blockId: A, key: 'author', value: { value_text: 'ada' } })
    const undo = dispatch('undo_page_op', { pageId: PAGE, undoDepth: 0 }) as { new_op_ref: Ref }
    expect(properties.get(A)?.has('author')).toBe(false)

    dispatch('redo_page_op', {
      undoDeviceId: undo.new_op_ref.device_id,
      undoSeq: undo.new_op_ref.seq,
    })
    expect(properties.get(A)?.get('author')?.['value_text']).toBe('ada')
  })
})
