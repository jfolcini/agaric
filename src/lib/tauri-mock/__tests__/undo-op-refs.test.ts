/**
 * #2468 — ref-addressed undo in the mock: `op_refs` capture on the migrated
 * mutation handlers, plus the `undo_op` / `undo_ops` handlers.
 *
 * Pins:
 *  - every migrated mutation (`create_block` / `edit_block` / `delete_block` /
 *    `move_block` / `set_property` / `delete_property` / `add_tag` /
 *    `remove_tag`) returns the ref(s) of the op-log row(s) it appended
 *    (`WithOps` wire shape). A `delete_property` of a key the block does not
 *    hold surfaces `op_refs: []` (#5898), exactly like the backend;
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
/** Content creates ignore the space, but the command still requires one. */
const SCOPE = { kind: 'active', space_id: '00000000000000000000SPACEZ' }
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

/**
 * Give `blockId` an `effort` property no op wrote: the block holds it, but the
 * log has no `set_property` to restore. Conformance seeds cannot build this
 * (both runners seed properties through `set_property`).
 */
function seedPropertyWithoutOp(blockId: string): void {
  properties.set(
    blockId,
    new Map([
      [
        'effort',
        {
          key: 'effort',
          value_text: '2h',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      ],
    ]),
  )
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
      scope: SCOPE,
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

  it('#5057 — a second set_property reverses to a set, on a reserved key too', () => {
    // `reverse_set_property` answers `DeleteProperty` only when the key had NO
    // prior value; with one it answers `SetProperty` back to that prior. The
    // reverse-type table used to say `set_property` unconditionally, which got
    // the first-set case wrong.
    //
    // The RESERVED half is why this reads the op log rather than the op's own
    // `from_value`: `setReservedColumnProperty` writes `from_value: null`
    // deliberately, so a second `todo_state` write would look priorless and
    // reverse to a delete, where the backend finds the earlier op and reverses
    // to a set.
    for (const [key, value] of [
      ['effort', { value_text: '2h' }],
      ['todo_state', { value_text: 'TODO' }],
    ] as const) {
      const base = {
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      }
      dispatch('set_property', { blockId: A, key, value: { ...base, ...value } })
      const second = dispatch('set_property', {
        blockId: A,
        key,
        value: { ...base, value_text: key === 'todo_state' ? 'DONE' : '4h' },
      }) as WithOpsResp

      dispatch('undo_op', { opRef: second.op_refs[0] })
      expect(opLog.at(-1)?.op_type, `reverse of a second ${key} write`).toBe('set_property')
    }
  })

  it('#6156 — a task clear returns the refs of the stamps it clears, and undoing them gives the task and its stamps back', () => {
    // TODO then DONE leaves both stamps, `created_at` and `completed_at`.
    for (const state of ['TODO', 'DONE']) dispatch('set_todo_state', { blockId: A, state })
    const stamps = () =>
      ['created_at', 'completed_at'].map((key) => dispatch('get_property', { blockId: A, key }))
    const held = stamps()
    expect(
      held.map((row) => row !== null),
      'sanity: the block holds both stamps',
    ).toEqual([true, true])

    const del = dispatch('delete_property', { blockId: A, key: 'todo_state' }) as WithOpsResp
    expect(stamps(), 'sanity: the stamps went with the state').toEqual([null, null])
    expect(del.op_refs, 'the state’s delete, then the clear of each stamp').toHaveLength(3)

    // Newest first, as the undo store submits an entry.
    dispatch('undo_ops', { ops: del.op_refs.toReversed() })

    expect(rowOf(A)['todo_state']).toBe('DONE')
    expect(stamps()).toEqual(held)
  })

  it('#6156 — set_todo_state_batch returns the refs of every op it appends, the stamps’ among them, and undoing them takes the set or the clear back', () => {
    const stamp = () => dispatch('get_property', { blockId: A, key: 'created_at' })
    const set = dispatch('set_todo_state_batch', {
      blockIds: [A],
      state: 'TODO',
    }) as WithOpsResp
    expect(set['updated']).toBe(1)
    expect(set.op_refs, 'the state’s set, then the `created_at` stamp').toEqual(
      opLog.slice(-2).map(({ device_id, seq }) => ({ device_id, seq })),
    )
    const held = stamp()
    expect(held, 'sanity: the set stamped the block').not.toBeNull()

    const clear = dispatch('set_todo_state_batch', { blockIds: [A], state: null }) as WithOpsResp
    expect(clear.op_refs, 'the state’s clear, then the stamp’s').toHaveLength(2)
    dispatch('undo_ops', { ops: clear.op_refs.toReversed() })
    expect(rowOf(A)['todo_state']).toBe('TODO')
    expect(stamp()).toEqual(held)

    dispatch('undo_ops', { ops: set.op_refs.toReversed() })
    expect(rowOf(A)['todo_state']).toBeNull()
    expect(stamp()).toBeNull()
  })

  it('#6156 — set_todo_state returns the refs of every op it appends, the stamps’ among them, and undoing them takes the state and its stamp back', () => {
    const stamp = () => dispatch('get_property', { blockId: A, key: 'created_at' })
    const set = dispatch('set_todo_state', { blockId: A, state: 'TODO' }) as WithOpsResp
    expect(set['todo_state']).toBe('TODO')
    expect(set.op_refs, 'the state’s set, then the `created_at` stamp').toEqual(
      opLog.slice(-2).map(({ device_id, seq }) => ({ device_id, seq })),
    )
    expect(stamp(), 'sanity: the set stamped the block').not.toBeNull()

    dispatch('undo_ops', { ops: set.op_refs.toReversed() })

    expect(rowOf(A)['todo_state']).toBeNull()
    expect(stamp()).toBeNull()
  })

  it('#6156 — completing a repeating task returns the refs of its next occurrence too, and undoing them removes it', () => {
    dispatch('set_property', {
      blockId: A,
      key: 'repeat',
      value: {
        value_text: '+1w',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    dispatch('set_due_date', { blockId: A, date: '2026-06-15' })
    // The occurrence is created in the block's space.
    rowOf(A)['space_id'] = SCOPE.space_id
    const before = new Set(blocks.keys())
    const logged = opLog.length

    const done = dispatch('set_todo_state', { blockId: A, state: 'DONE' }) as WithOpsResp

    const next = [...blocks.keys()].filter((id) => !before.has(id))
    expect(next, 'sanity: completing it made the next occurrence').toHaveLength(1)
    expect(done.op_refs, 'every op the completion appended').toEqual(
      opLog.slice(logged).map(({ device_id, seq }) => ({ device_id, seq })),
    )

    dispatch('undo_ops', { ops: done.op_refs.toReversed() })

    expect(rowOf(A)['todo_state']).toBeNull()
    expect(rowOf(next[0] as string)['deleted_at'], 'the next occurrence is gone').not.toBeNull()
  })

  it('#5057 — undoing a reserved-key delete_property is accepted, as on the backend', () => {
    // The delete records the `prior` it removes (#6156), which an undo judges it reversible by.
    dispatch('set_property', {
      blockId: A,
      key: 'todo_state',
      value: {
        value_text: 'TODO',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    })
    const del = dispatch('delete_property', { blockId: A, key: 'todo_state' }) as WithOpsResp
    expect(() => dispatch('undo_op', { opRef: del.op_refs[0] })).not.toThrow()
  })

  it('delete_property echoes (block_id, key) + op_refs; a delete of an absent key appends nothing', () => {
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
    // (`delete_property_core`, #5898): nothing is appended and no ref surfaces.
    const again = dispatch('delete_property', { blockId: A, key: 'effort' }) as WithOpsResp
    expect(again.op_refs).toEqual([])
    expect(opLog.length).toBe(opCount + 1)
  })

  it('undoing the delete of a property no op wrote restores it (#5918)', () => {
    // A value a peer set has no op in this device's log. The delete records
    // the value it removes, so its undo needs none.
    seedPropertyWithoutOp(A)

    const del = dispatch('delete_property', { blockId: A, key: 'effort' }) as WithOpsResp
    expect(del.op_refs).toHaveLength(1)
    dispatch('undo_op', { opRef: del.op_refs[0] })

    const restored = dispatch('get_property', { blockId: A, key: 'effort' }) as {
      value_text: string | null
    } | null
    expect(restored?.value_text).toBe('2h')
  })

  it('undoing a set over a property no op wrote sets it back (#6014)', () => {
    // A value a peer set has no op in this device's log. The set records the
    // value it overwrites, so its undo is a set back to it, not a delete.
    seedPropertyWithoutOp(A)

    const set = dispatch('set_property', {
      blockId: A,
      key: 'effort',
      value: {
        value_text: '4h',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
    }) as WithOpsResp
    dispatch('undo_op', { opRef: set.op_refs[0] })

    expect(opLog.at(-1)?.op_type).toBe('set_property')
    const restored = dispatch('get_property', { blockId: A, key: 'effort' }) as {
      value_text: string | null
    } | null
    expect(restored?.value_text).toBe('2h')
  })

  it('restore_page_to_op restores a property no op wrote (#5918)', () => {
    const target = dispatch('edit_block', { blockId: B, toText: 'target' }) as WithOpsResp
    seedPropertyWithoutOp(A)
    dispatch('delete_property', { blockId: A, key: 'effort' })
    dispatch('edit_block', { blockId: B, toText: 'after' })

    dispatch('restore_page_to_op', {
      pageId: PAGE,
      targetDeviceId: target.op_refs[0]?.device_id,
      targetSeq: target.op_refs[0]?.seq,
    })

    expect(rowOf(B)['content']).toBe('target')
    const restored = dispatch('get_property', { blockId: A, key: 'effort' }) as {
      value_text: string | null
    } | null
    expect(restored?.value_text).toBe('2h')
  })

  it('add_tag / remove_tag each surface their op_ref', () => {
    const add = dispatch('add_tag', { blockId: A, tagId: TAG }) as WithOpsResp
    expect(add.op_refs).toHaveLength(1)

    const remove = dispatch('remove_tag', { blockId: A, tagId: TAG }) as WithOpsResp
    expect(remove.op_refs).toHaveLength(1)
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
    // Bookkeeping: the reverse op was appended and is the returned ref. #4868 —
    // it carries the PLAIN reverse type with `is_undo`, the way the backend
    // appends it, not an `undo_` prefix.
    expect(opLog.at(-1)?.op_type).toBe('edit_block')
    expect(opLog.at(-1)?.is_undo).toBe(true)
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
      is_undo: false,
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
