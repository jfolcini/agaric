/**
 * #5057 — the half of the attachment undo/redo round trip that
 * `attachment_add_bytes.json` cannot observe.
 *
 * That fixture pins the op TYPES each leg appends and the state the round trip
 * SETTLES at, which is the seeded row alone — a new attachment's own row is not
 * comparable across the stacks (its id, `fs_path` and `content_hash` are minted
 * per stack and `created_at` is a clock read), so the fixture ends with the add
 * undone. The redo in the middle therefore has nothing to prove there: a redo
 * that quietly restored nothing settles at the same place.
 *
 * What it restores is what the user sees, so it is pinned here instead — a
 * mock-internal test with hand-written expectations, NOT parity evidence.
 * `reverse_delete_attachment` is what the backend runs, and the shape this
 * asserts is read off it: the immutable half from the original `add_attachment`
 * op, `fs_path` / `filename` adopted from the delete.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { opLog, seedBlocks } from '@/lib/tauri-mock/seed'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

/** A fresh live page to hang the attachment off. */
function newPageId(): string {
  const created = dispatch('create_block', {
    parentId: null,
    blockType: 'page',
    content: 'Uploads',
    position: null,
  }) as Record<string, unknown>
  return created['id'] as string
}

describe('attachment add → undo → redo (mock-internal)', () => {
  beforeEach(() => {
    seedBlocks()
  })

  it('redo puts the row back as the delete left it', () => {
    const blockId = newPageId()
    const added = dispatch('add_attachment_with_bytes', {
      blockId,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: [104, 105],
    }) as Record<string, unknown>

    const addOp = opLog.at(-1)
    expect(addOp?.op_type).toBe('add_attachment')

    const undo = dispatch('undo_op', {
      opRef: { device_id: addOp?.device_id, seq: addOp?.seq },
    }) as Record<string, unknown>
    expect(undo['new_op_type']).toBe('delete_attachment')
    expect(dispatch('list_attachments', { blockId })).toEqual([])

    const undoRef = undo['new_op_ref'] as Record<string, unknown>
    const redo = dispatch('redo_page_op', {
      undoDeviceId: undoRef['device_id'],
      undoSeq: undoRef['seq'],
    }) as Record<string, unknown>
    expect(redo['new_op_type']).toBe('add_attachment')

    const rows = dispatch('list_attachments', { blockId }) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: added['id'],
      block_id: blockId,
      filename: 'notes.txt',
      mime_type: 'text/plain',
      size_bytes: 2,
      fs_path: added['fs_path'],
    })
  })
})
