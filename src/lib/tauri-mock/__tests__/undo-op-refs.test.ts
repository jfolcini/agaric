/**
 * #2468 — ref-addressed undo in the mock: `op_refs` capture on the migrated
 * mutation handlers, plus the `undo_op` / `undo_ops` handlers.
 *
 * Pins:
 *  - every migrated mutation (`create_block` / `edit_block` / `delete_block` /
 *    `move_block` / `set_property` / `delete_property` / `add_tag` /
 *    `remove_tag`) returns the ref(s) of the op-log row(s) it appended
 *    (`WithOps` wire shape). Idempotent tag no-ops (mock-only leniency, kept
 *    for the `tag_add_remove` conformance fixture — the REAL command rejects
 *    them) surface `op_refs: []`; a no-prior `delete_property` appends its op
 *    and surfaces the ref, exactly like the backend;
 *  - `undo_op` reverses EXACTLY the referenced op — newer ops landing after
 *    capture cannot shift the target (the #2446 race the migration kills);
 *  - the reject rules mirror `undo_op_inner`: unknown ref → `not_found`;
 *    foreign/replicated, undo-op refs, and already-reversed ops →
 *    `validation`;
 *  - `undo_ops` is atomic (validate-all-before-apply-any) and returns
 *    newest-first results;
 *  - a redo op's `new_op_ref` is a valid `undo_op` target (undo→redo→undo
 *    cycling).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '../handlers'
import { blocks, blockTags, makeBlock, opLog, properties, propertyDefs } from '../seed'

const PAGE = '00000000000000000000PAGEZZ'
const TAG = '000000000000000000000TAGZZ'

interface Ref {
  device_id: string
  seq: number
}

interface WithOpsResp {
  op_refs: Ref[]
  [key: string]: unknown
}

interface UndoResultResp {
  reversed_op: Ref
  reversed_op_type: string
  new_op_ref: Ref
  new_op_type: string
  is_redo: boolean
}

function seedPage(childIds: string[]): void {
  blocks.clear()
  properties.clear()
  blockTags.clear()
  propertyDefs.clear()
  opLog.length = 0

  blocks.set(PAGE, makeBlock(PAGE, 'page', 'Test Page', null, 0))
  blocks.set(TAG, makeBlock(TAG, 'tag', 'ref-tag', null, 99))
  childIds.forEach((id, i) => {
    blocks.set(id, makeBlock(id, 'content', `block ${id}`, PAGE, i + 1))
  })
}

function rowOf(id: string): Record<string, unknown> {
  const b = blocks.get(id)
  if (!b) throw new Error(`block ${id} missing`)
  return b
}

/** Run `fn` and return the AppError-shaped rejection it throws. */
function captureRejection(fn: () => unknown): { kind: string; message: string } {
  try {
    fn()
  } catch (err) {
    return err as { kind: string; message: string }
  }
  throw new Error('expected the dispatch to throw')
}

const A = '0000000000000000000000BL_A'
const B = '0000000000000000000000BL_B'

describe('#2468 — op_refs capture on migrated mutation handlers', () => {
  beforeEach(() => {
    seedPage([A, B])
  })

  it('create_block returns the appended op ref and keeps the STORED row ref-free', () => {
    const resp = dispatch('create_block', {
      blockType: 'content',
      content: 'new',
      parentId: PAGE,
      index: 0,
    }) as WithOpsResp & { id: string }

    expect(resp.op_refs).toHaveLength(1)
    const last = opLog.at(-1)
    expect(resp.op_refs[0]).toEqual({ device_id: last?.device_id, seq: last?.seq })
    expect(last?.op_type).toBe('create_block')
    // The blocks store must not grow an `op_refs` field (list_blocks & co.
    // return the stored rows verbatim).
    expect(rowOf(resp.id)).not.toHaveProperty('op_refs')
  })

  it('edit_block / delete_block / move_block / set_property each return their op ref', () => {
    const edit = dispatch('edit_block', { blockId: A, toText: 'edited' }) as WithOpsResp
    expect(edit.op_refs).toEqual([{ device_id: 'mock-device', seq: opLog.at(-1)?.seq }])

    const del = dispatch('delete_block', { blockId: B }) as WithOpsResp
    expect(del.op_refs).toEqual([{ device_id: 'mock-device', seq: opLog.at(-1)?.seq }])

    const move = dispatch('move_block', {
      blockId: A,
      newParentId: PAGE,
      newIndex: 0,
    }) as WithOpsResp
    expect(move.op_refs).toEqual([{ device_id: 'mock-device', seq: opLog.at(-1)?.seq }])

    const setProp = dispatch('set_property', {
      blockId: A,
      key: 'effort',
      value: {
        value_text: '2h',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    }) as WithOpsResp
    expect(setProp.op_refs).toEqual([{ device_id: 'mock-device', seq: opLog.at(-1)?.seq }])
  })

  it('delete_property echoes (block_id, key) + op_refs; a no-prior delete still surfaces its ref but is not undoable', () => {
    dispatch('set_property', {
      blockId: A,
      key: 'effort',
      value: {
        value_text: '2h',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    const opCount = opLog.length

    const resp = dispatch('delete_property', { blockId: A, key: 'effort' }) as WithOpsResp
    expect(resp['block_id']).toBe(A)
    expect(resp['key']).toBe('effort')
    expect(resp.op_refs).toHaveLength(1)
    expect(opLog.length).toBe(opCount + 1)

    // Second delete: the property no longer exists. Backend parity
    // (`delete_property_core`): the op is STILL appended and its ref is
    // STILL surfaced — but undoing it fails, because there is no prior
    // `set_property` to restore (`build_reverse_delete_property` → NotFound).
    const again = dispatch('delete_property', { blockId: A, key: 'effort' }) as WithOpsResp
    expect(again.op_refs).toHaveLength(1)
    expect(opLog.length).toBe(opCount + 2)
    const err = captureRejection(() => dispatch('undo_op', { opRef: again.op_refs[0] }))
    expect(err.kind).toBe('not_found')
    expect(err.message).toMatch(/no prior set_property/)
  })

  it('add_tag / remove_tag repeats surface empty op_refs (idempotent no-op)', () => {
    const add = dispatch('add_tag', { blockId: A, tagId: TAG }) as WithOpsResp
    expect(add.op_refs).toHaveLength(1)

    // The duplicate add still logs its op (LWW convergence, pinned by the
    // `tag_add_remove` conformance fixture) but exposes NO undoable ref —
    // reversing it would remove the edge the FIRST add owns.
    const addAgain = dispatch('add_tag', { blockId: A, tagId: TAG }) as WithOpsResp
    expect(addAgain.op_refs).toEqual([])

    const remove = dispatch('remove_tag', { blockId: A, tagId: TAG }) as WithOpsResp
    expect(remove.op_refs).toHaveLength(1)

    const removeAgain = dispatch('remove_tag', { blockId: A, tagId: TAG }) as WithOpsResp
    expect(removeAgain.op_refs).toEqual([])
  })
})

describe('#2468 — undo_op reverses exactly the referenced op', () => {
  beforeEach(() => {
    seedPage([A, B])
  })

  it('reverts the CAPTURED op even when newer ops landed after it (#2446)', () => {
    const editA = dispatch('edit_block', { blockId: A, toText: 'A edited' }) as WithOpsResp
    // Newer ops land after capture — a positional depth-0 undo would target
    // the edit of B, not A.
    dispatch('edit_block', { blockId: B, toText: 'B edited' })

    const result = dispatch('undo_op', { opRef: editA.op_refs[0] }) as UndoResultResp

    expect(result.reversed_op).toEqual(editA.op_refs[0])
    expect(result.reversed_op_type).toBe('edit_block')
    expect(result.is_redo).toBe(false)
    // A reverted; B untouched.
    expect(rowOf(A)['content']).toBe(`block ${A}`)
    expect(rowOf(B)['content']).toBe('B edited')
    // Bookkeeping: an `undo_*` op was appended and is the returned ref.
    expect(opLog.at(-1)?.op_type).toBe('undo_edit_block')
    expect(result.new_op_ref.seq).toBe(opLog.at(-1)?.seq)
  })

  it('reverses tag and property ops (the newly-undoable op types)', () => {
    const add = dispatch('add_tag', { blockId: A, tagId: TAG }) as WithOpsResp
    expect(blockTags.get(A)?.has(TAG)).toBe(true)
    dispatch('undo_op', { opRef: add.op_refs[0] })
    expect(blockTags.get(A)?.has(TAG)).toBe(false)

    const setProp = dispatch('set_property', {
      blockId: A,
      key: 'effort',
      value: {
        value_text: '2h',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    }) as WithOpsResp
    expect(properties.get(A)?.get('effort')?.['value_text']).toBe('2h')
    dispatch('undo_op', { opRef: setProp.op_refs[0] })
    // Property did not exist before → the revert removes it.
    expect(properties.get(A)?.get('effort')).toBeUndefined()
  })

  it('rejects an unknown ref with not_found', () => {
    const err = captureRejection(() =>
      dispatch('undo_op', { opRef: { device_id: 'mock-device', seq: 9999 } }),
    )
    expect(err.kind).toBe('not_found')
  })

  it('rejects a foreign/replicated op ref with validation', () => {
    // A replicated op sits in the log under its ORIGIN device id.
    opLog.push({
      device_id: 'other-device',
      seq: 424_242,
      op_type: 'edit_block',
      payload: JSON.stringify({ block_id: A, to_text: 'x', from_text: 'y' }),
      created_at: new Date().toISOString(),
    })
    const err = captureRejection(() =>
      dispatch('undo_op', { opRef: { device_id: 'other-device', seq: 424_242 } }),
    )
    expect(err.kind).toBe('validation')
    expect(err.message).toMatch(/foreign/)
  })

  it('rejects a ref to an undo op with validation (redo owns those)', () => {
    const edit = dispatch('edit_block', { blockId: A, toText: 'A edited' }) as WithOpsResp
    const undone = dispatch('undo_op', { opRef: edit.op_refs[0] }) as UndoResultResp

    const err = captureRejection(() => dispatch('undo_op', { opRef: undone.new_op_ref }))
    expect(err.kind).toBe('validation')
    expect(err.message).toMatch(/undo/)
  })

  it('rejects an already-reversed op with validation', () => {
    const edit = dispatch('edit_block', { blockId: A, toText: 'A edited' }) as WithOpsResp
    dispatch('undo_op', { opRef: edit.op_refs[0] })

    const err = captureRejection(() => dispatch('undo_op', { opRef: edit.op_refs[0] }))
    expect(err.kind).toBe('validation')
    expect(err.message).toMatch(/already reversed/)
  })

  it('a redo op ref is a VALID undo target (undo→redo→undo cycling)', () => {
    const edit = dispatch('edit_block', { blockId: A, toText: 'A edited' }) as WithOpsResp
    const undone = dispatch('undo_op', { opRef: edit.op_refs[0] }) as UndoResultResp
    expect(rowOf(A)['content']).toBe(`block ${A}`)

    // Redo re-applies the edit; its new_op_ref (the appended redo op) becomes
    // the next undo target per the #2468 contract.
    const redone = dispatch('redo_page_op', {
      undoDeviceId: undone.new_op_ref.device_id,
      undoSeq: undone.new_op_ref.seq,
    }) as UndoResultResp
    expect(rowOf(A)['content']).toBe('A edited')

    const undoneAgain = dispatch('undo_op', { opRef: redone.new_op_ref }) as UndoResultResp
    expect(rowOf(A)['content']).toBe(`block ${A}`)
    // The effective reverted op is the ORIGINAL edit.
    expect(undoneAgain.reversed_op).toEqual(edit.op_refs[0])
  })
})

describe('#2468 — undo_ops (atomic ref-set undo)', () => {
  beforeEach(() => {
    seedPage([A, B])
  })

  it('reverts the whole set newest-first and returns newest-first results', () => {
    const editA = dispatch('edit_block', { blockId: A, toText: 'A edited' }) as WithOpsResp
    const editB = dispatch('edit_block', { blockId: B, toText: 'B edited' }) as WithOpsResp

    // Submit OLDEST-first to prove the handler orders newest-first itself.
    const results = dispatch('undo_ops', {
      ops: [editA.op_refs[0], editB.op_refs[0]],
    }) as UndoResultResp[]

    expect(results).toHaveLength(2)
    expect(results[0]?.reversed_op).toEqual(editB.op_refs[0])
    expect(results[1]?.reversed_op).toEqual(editA.op_refs[0])
    expect(rowOf(A)['content']).toBe(`block ${A}`)
    expect(rowOf(B)['content']).toBe(`block ${B}`)
  })

  it('is ATOMIC: one bad ref anywhere aborts the whole set before anything is applied', () => {
    const editA = dispatch('edit_block', { blockId: A, toText: 'A edited' }) as WithOpsResp
    const opCount = opLog.length

    const err = captureRejection(() =>
      dispatch('undo_ops', {
        ops: [editA.op_refs[0], { device_id: 'mock-device', seq: 9999 }],
      }),
    )

    expect(err.kind).toBe('not_found')
    // Nothing applied, nothing appended: A keeps its edit, log unchanged.
    expect(rowOf(A)['content']).toBe('A edited')
    expect(opLog.length).toBe(opCount)
  })

  it('returns [] for an empty ref set and rejects duplicate refs with validation', () => {
    // Backend parity: `undo_ops_inner` short-circuits `Ok(vec![])` on empty.
    expect(dispatch('undo_ops', { ops: [] })).toEqual([])

    const editA = dispatch('edit_block', { blockId: A, toText: 'A edited' }) as WithOpsResp
    const err = captureRejection(() =>
      dispatch('undo_ops', { ops: [editA.op_refs[0], editA.op_refs[0]] }),
    )
    expect(err.kind).toBe('validation')
    expect(err.message).toMatch(/duplicate/)
    expect(rowOf(A)['content']).toBe('A edited')
  })
})
