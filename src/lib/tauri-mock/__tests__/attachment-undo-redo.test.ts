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
 *
 * Its other answer is pinned below. With no original `add_attachment` op there
 * is nothing to rebuild from and the backend returns `NonReversible`
 * (`reverse_delete_attachment_returns_non_reversible_error`, agaric-engine
 * `tests/reverse_tests.rs`); a seeded attachment is exactly that case, since
 * `addMockAttachment` sets the row without an op.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isAppError } from '@/lib/app-error'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { addMockAttachment, opLog, seedBlocks } from '@/lib/tauri-mock/seed'

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

  // `delete_attachment_inner` takes its app-data dir as `_app_data_dir` and
  // reclaims nothing: the bytes outlive the row and the GC pass (#1993) is what
  // frees them. So an undone delete has a file to point back at. The mock used
  // to drop the bytes with the row, which restored a row that read as empty.
  it('restores readable bytes when the delete is undone', () => {
    const blockId = newPageId()
    const added = dispatch('add_attachment_with_bytes', {
      blockId,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: [104, 105],
    }) as Record<string, unknown>
    const attachmentId = added['id'] as string

    dispatch('delete_attachment', { attachmentId })
    const deleteOp = opLog.at(-1)
    expect(deleteOp?.op_type).toBe('delete_attachment')

    dispatch('undo_op', { opRef: { device_id: deleteOp?.device_id, seq: deleteOp?.seq } })

    const restored = dispatch('read_attachment', { attachmentId }) as ArrayBuffer
    expect([...new Uint8Array(restored)]).toEqual([104, 105])
  })

  it('refuses to undo the delete of an attachment no op ever added', () => {
    const blockId = newPageId()
    const seeded = addMockAttachment(blockId, 'seeded.txt', 'text/plain', 12)
    dispatch('delete_attachment', { attachmentId: seeded['id'] })
    const deleteOp = opLog.at(-1)
    expect(deleteOp?.op_type).toBe('delete_attachment')
    const opsBefore = opLog.length

    let thrown: unknown
    try {
      dispatch('undo_op', { opRef: { device_id: deleteOp?.device_id, seq: deleteOp?.seq } })
    } catch (err) {
      thrown = err
    }

    expect(isAppError(thrown)).toBe(true)
    expect(isAppError(thrown) && thrown.kind).toBe('non_reversible')
    // The reverse is computed before it is applied, so the refusal leaves both
    // the row and the op log exactly as the delete left them.
    expect(dispatch('list_attachments', { blockId })).toEqual([])
    expect(opLog.length).toBe(opsBefore)
  })

  // The other arm of that refusal: `restore_page_to_op` skips every
  // `STATIC_NON_REVERSIBLE_OP_TYPES` op ON SIGHT (agaric-engine
  // `reverse/batch.rs`) and counts it, even here — where the add op is right
  // there and the inverse could be computed. The rewind must keep counting
  // where the undo above rejects.
  it('counts rather than rejects the same op under a page rewind', () => {
    const blockId = newPageId()
    const createOp = opLog.at(-1)
    const added = dispatch('add_attachment_with_bytes', {
      blockId,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: [104, 105],
    }) as Record<string, unknown>
    dispatch('delete_attachment', { attachmentId: added['id'] })

    const restored = dispatch('restore_page_to_op', {
      pageId: '__all__',
      targetDeviceId: createOp?.device_id,
      targetSeq: createOp?.seq,
    }) as Record<string, unknown>

    expect(restored['non_reversible_skipped']).toBe(1)
    expect(restored['ops_reverted']).toBe(1)
  })
})
