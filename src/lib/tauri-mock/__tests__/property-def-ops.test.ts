/**
 * #5841 S1 — the mock's `set_property_def` op: the three definition writers
 * append one each and answer `WithOps`, undo restores the prior definition,
 * `create_space` records its defaults, and global history scoped to a space
 * lists the space's definition ops.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { opLog, properties, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'

const SPACE = 'SPACE_PERSONAL'

interface Ref {
  device_id: string
  seq: number
}

type WithOpsDef = Record<string, unknown> & { op_refs: Ref[] }

function call<T>(cmd: string, args: Record<string, unknown>): T {
  return dispatch(cmd, args) as T
}

function lastOp(): { op_type: string; payload: Record<string, unknown>; ref: Ref } {
  const op = opLog.at(-1)
  if (!op) throw new Error('op log is empty')
  return {
    op_type: op.op_type,
    payload: JSON.parse(op.payload) as Record<string, unknown>,
    ref: { device_id: op.device_id, seq: op.seq },
  }
}

function listedDef(key: string): Record<string, unknown> | undefined {
  const page = call<{ items: Array<Record<string, unknown>> }>('list_property_defs', {
    spaceId: SPACE,
  })
  return page.items.find((d) => d['key'] === key)
}

const SELECT = { value_type: 'select', options: '["low","high"]' }

function createSelect(): WithOpsDef {
  return call<WithOpsDef>('create_property_def', {
    spaceId: SPACE,
    key: 'level',
    valueType: 'select',
    options: SELECT.options,
  })
}

beforeEach(() => {
  seedBlocks()
})

describe('definition writers append set_property_def', () => {
  it('create appends one op with no prior and answers its ref', () => {
    const before = opLog.length
    const resp = createSelect()
    expect(opLog.length).toBe(before + 1)
    const op = lastOp()
    expect(op.op_type).toBe('set_property_def')
    expect(op.payload).toEqual({ space_id: SPACE, key: 'level', def: SELECT, prior: null })
    expect(resp.op_refs).toEqual([op.ref])
    expect(resp['key']).toBe('level')
    expect(resp['builtin']).toBe(false)
  })

  it('create of a key the space already declares appends nothing', () => {
    createSelect()
    const before = opLog.length
    const resp = call<WithOpsDef>('create_property_def', {
      spaceId: SPACE,
      key: 'level',
      valueType: 'select',
      options: '["other"]',
    })
    expect(opLog.length).toBe(before)
    expect(resp.op_refs).toEqual([])
    expect(resp['options']).toBe(SELECT.options)
  })

  it('an options edit records the definition it replaced', () => {
    createSelect()
    const options = '["low","mid","high"]'
    const resp = call<WithOpsDef>('update_property_def_options', {
      spaceId: SPACE,
      key: 'level',
      options,
    })
    const op = lastOp()
    expect(op.op_type).toBe('set_property_def')
    expect(op.payload).toEqual({
      space_id: SPACE,
      key: 'level',
      def: { value_type: 'select', options },
      prior: SELECT,
    })
    expect(resp.op_refs).toEqual([op.ref])
    expect(resp['options']).toBe(options)
  })

  it('delete answers the removed definition and records it as the prior', () => {
    createSelect()
    const resp = call<WithOpsDef>('delete_property_def', { spaceId: SPACE, key: 'level' })
    const op = lastOp()
    expect(op.payload).toEqual({ space_id: SPACE, key: 'level', def: null, prior: SELECT })
    expect(resp.op_refs).toEqual([op.ref])
    expect(resp['key']).toBe('level')
    expect(resp['options']).toBe(SELECT.options)
    expect(listedDef('level')).toBeUndefined()
  })
})

describe('undoing a set_property_def', () => {
  it('brings a deleted definition back', () => {
    createSelect()
    const { op_refs } = call<WithOpsDef>('delete_property_def', { spaceId: SPACE, key: 'level' })
    const [result] = call<Array<{ new_op_type: string }>>('undo_ops', { ops: op_refs })
    expect(result?.new_op_type).toBe('set_property_def')
    expect(lastOp().payload).toMatchObject({ def: SELECT, prior: null })
    expect(listedDef('level')).toMatchObject({ ...SELECT, builtin: false })
  })

  it('puts the old options back after an edit', () => {
    createSelect()
    const { op_refs } = call<WithOpsDef>('update_property_def_options', {
      spaceId: SPACE,
      key: 'level',
      options: '["only"]',
    })
    call('undo_ops', { ops: op_refs })
    expect(listedDef('level')?.['options']).toBe(SELECT.options)
  })

  it('withdraws a created definition', () => {
    const { op_refs } = createSelect()
    call('undo_ops', { ops: op_refs })
    expect(listedDef('level')).toBeUndefined()
  })
})

describe('where set_property_def ops show', () => {
  it('create_space records one op per default definition', () => {
    const before = opLog.length
    const spaceId = call<string>('create_space', { name: 'Garden', accentColor: null })
    const defOps = opLog
      .slice(before)
      .filter((o) => o.op_type === 'set_property_def')
      .map((o) => JSON.parse(o.payload) as Record<string, unknown>)
    expect(defOps.map((p) => p['key'])).toEqual(['status', 'url', 'effort', 'assignee', 'location'])
    expect(defOps.every((p) => p['space_id'] === spaceId && p['prior'] === null)).toBe(true)
  })

  it("global history scoped to a space lists that space's definition ops only", () => {
    createSelect()
    const history = (space: string): string[] =>
      call<{ items: Array<{ op_type: string }> }>('list_page_history', {
        pageId: '__all__',
        opTypeFilter: 'set_property_def',
        scope: { kind: 'active', space_id: space },
        limit: 50,
      }).items.map((row) => row.op_type)
    expect(history(SPACE)).toEqual(['set_property_def'])
    expect(history('SPACE_WORK')).toEqual([])
  })
})

// #5841 S2 — rename and merge of a property key.

const X = SEED_IDS.BLOCK_GS_1
const Y = SEED_IDS.BLOCK_GS_2
const Z = SEED_IDS.BLOCK_GS_3
const TRASHED = SEED_IDS.BLOCK_GS_4

interface Rejection {
  kind: string
  code?: string
}

function rejectionOf(fn: () => unknown): Rejection {
  try {
    fn()
  } catch (err) {
    return err as Rejection
  }
  throw new Error('expected a rejection')
}

function setText(blockId: string, key: string, text: string): Ref[] {
  const row = call<{ op_refs: Ref[] }>('set_property', {
    blockId,
    key,
    value: {
      value_text: text,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    },
  })
  return row.op_refs
}

/** `key`'s text on `blockId`, or undefined when the block holds no `key`. */
function textOf(blockId: string, key: string): string | null | undefined {
  const rows = call<Array<Record<string, unknown>>>('get_properties', { blockId })
  const row = rows.find((r) => r['key'] === key)
  return row === undefined ? undefined : (row['value_text'] as string | null)
}

/** An engine Null under `key`: a clear, which SQL holds no row for. */
function setNull(blockId: string, key: string): void {
  if (!properties.has(blockId)) properties.set(blockId, new Map())
  properties.get(blockId)?.set(key, {
    block_id: blockId,
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  })
}

function declare(key: string, valueType = 'text', options: string | null = null): void {
  call('create_property_def', { spaceId: SPACE, key, valueType, options })
}

function rename(oldKey: string, newKey: string): WithOpsDef {
  return call<WithOpsDef>('rename_property_key', { spaceId: SPACE, oldKey, newKey })
}

describe('rename_property_key', () => {
  it('moves every value of the space, Trash included, and the definition', () => {
    declare('client')
    setText(X, 'client', 'alpha')
    setText(TRASHED, 'client', 'beta')
    call('delete_block', { blockId: TRASHED })
    const before = opLog.length
    const resp = rename('client', 'customer')
    expect(opLog.length).toBe(before + 1)
    const op = lastOp()
    expect(op.op_type).toBe('rename_property_key')
    expect(op.payload).toEqual({ space_id: SPACE, old_key: 'client', new_key: 'customer' })
    expect(resp.op_refs).toEqual([op.ref])
    expect(resp).toMatchObject({ key: 'customer', value_type: 'text', builtin: false })
    expect(textOf(X, 'customer')).toBe('alpha')
    expect(textOf(X, 'client')).toBeUndefined()
    expect(textOf(TRASHED, 'customer')).toBe('beta')
    expect(listedDef('client')).toBeUndefined()
    expect(listedDef('customer')).toMatchObject({ value_type: 'text' })
  })

  it('refuses a built-in, internal, declared or used target, and an undeclared or internal source', () => {
    declare('client')
    declare('status_two')
    setText(Y, 'used', 'x')
    expect(rejectionOf(() => rename('client', 'due_date'))).toMatchObject({
      kind: 'validation',
      code: 'BuiltinPropertyLocked',
    })
    expect(rejectionOf(() => rename('client', 'template')).kind).toBe('validation')
    expect(rejectionOf(() => rename('client', 'status_two')).kind).toBe('validation')
    expect(rejectionOf(() => rename('client', 'used')).kind).toBe('validation')
    expect(rejectionOf(() => rename('client', 'client')).kind).toBe('validation')
    expect(rejectionOf(() => rename('nothing', 'customer')).kind).toBe('not_found')
    expect(rejectionOf(() => rename('template', 'customer')).kind).toBe('validation')
    expect(rejectionOf(() => rename('todo_state', 'customer'))).toMatchObject({
      code: 'BuiltinPropertyLocked',
    })
    expect(listedDef('client')).toBeDefined()
  })

  it('undo puts the key back, and redo renames it again', () => {
    declare('client')
    setText(X, 'client', 'alpha')
    const { op_refs } = rename('client', 'customer')
    const [undone] = call<Array<{ new_op_ref: Ref }>>('undo_ops', { ops: op_refs })
    expect(lastOp().payload).toMatchObject({ old_key: 'customer', new_key: 'client' })
    expect(textOf(X, 'client')).toBe('alpha')
    expect(textOf(X, 'customer')).toBeUndefined()
    expect(listedDef('client')).toBeDefined()
    expect(listedDef('customer')).toBeUndefined()
    call('redo_page_op', {
      undoDeviceId: undone?.new_op_ref.device_id,
      undoSeq: undone?.new_op_ref.seq,
    })
    expect(textOf(X, 'customer')).toBe('alpha')
    expect(listedDef('customer')).toBeDefined()
  })

  it('refuses to undo onto an old key declared again since', () => {
    declare('client')
    setText(X, 'client', 'alpha')
    const { op_refs } = rename('client', 'customer')
    declare('client')
    expect(rejectionOf(() => call('undo_ops', { ops: op_refs })).kind).toBe('validation')
    expect(textOf(X, 'customer')).toBe('alpha')
  })

  it('refuses to undo onto an old key a block used again since', () => {
    declare('client')
    setText(X, 'client', 'alpha')
    const { op_refs } = rename('client', 'customer')
    setText(Y, 'client', 'again')
    expect(rejectionOf(() => call('undo_ops', { ops: op_refs })).kind).toBe('validation')
    expect(textOf(X, 'customer')).toBe('alpha')
  })

  it("counts, refuses, moves and follows the space's own block", () => {
    declare('client')
    declare('area')
    setText(SPACE, 'client', 'a')
    const setSpace = setText(SPACE, 'client', 'b')
    setText(SPACE, 'spot', 'x')
    expect(rejectionOf(() => rename('client', 'spot')).kind).toBe('validation')
    rename('client', 'customer')
    expect(textOf(SPACE, 'customer')).toBe('b')
    expect(
      call('preview_property_merge', { spaceId: SPACE, fromKey: 'customer', intoKey: 'area' }),
    ).toEqual({ moved: 1, dropped: 0 })
    call('undo_ops', { ops: setSpace })
    expect(textOf(SPACE, 'customer')).toBe('a')
    expect(textOf(SPACE, 'client')).toBeUndefined()
  })

  it('moves a value onto an engine Null under the new key', () => {
    declare('client')
    setText(X, 'client', 'alpha')
    setNull(X, 'customer')
    rename('client', 'customer')
    expect(textOf(X, 'customer')).toBe('alpha')
    expect(textOf(X, 'client')).toBeUndefined()
  })

  it('undo of a value written before the rename follows the key', () => {
    declare('client')
    setText(X, 'client', 'a')
    const setX = setText(X, 'client', 'b')
    const setY = setText(Y, 'client', 'c')
    rename('client', 'customer')
    call('undo_ops', { ops: setX })
    // The undo's own op names the key it wrote, so a redo writes there too.
    expect(lastOp().payload).toMatchObject({ block_id: X, key: 'customer' })
    expect(textOf(X, 'customer')).toBe('a')
    expect(textOf(X, 'client')).toBeUndefined()
    call('undo_ops', { ops: setY })
    expect(textOf(Y, 'customer')).toBeUndefined()
    expect(textOf(Y, 'client')).toBeUndefined()
  })

  it('undoing the value and the rename together lands on the old key', () => {
    declare('client')
    setText(X, 'client', 'a')
    const setX = setText(X, 'client', 'b')
    const { op_refs } = rename('client', 'customer')
    call('undo_ops', { ops: [...setX, ...op_refs] })
    expect(textOf(X, 'client')).toBe('a')
    expect(textOf(X, 'customer')).toBeUndefined()
  })
})

describe('merge_property_key', () => {
  const STAGE = '["a","shared"]'
  const PHASE = '["shared","b"]'

  function seedMerge(): void {
    declare('stage', 'select', STAGE)
    declare('phase', 'select', PHASE)
    setText(X, 'stage', 'a')
    setText(Y, 'phase', 'b')
    setText(Z, 'stage', 'shared')
    setText(Z, 'phase', 'b')
    setText(TRASHED, 'stage', 'a')
    call('delete_block', { blockId: TRASHED })
  }

  function preview(fromKey = 'stage', intoKey = 'phase'): { moved: number; dropped: number } {
    return call('preview_property_merge', { spaceId: SPACE, fromKey, intoKey })
  }

  function merge(acknowledged: { moved: number; dropped: number }): WithOpsDef {
    return call<WithOpsDef>('merge_property_key', {
      spaceId: SPACE,
      fromKey: 'stage',
      intoKey: 'phase',
      acknowledged,
    })
  }

  it('previews what moves and what is dropped, Trash included', () => {
    seedMerge()
    expect(preview()).toEqual({ moved: 2, dropped: 1 })
  })

  it('refuses a stale acknowledgement with its code, and writes nothing', () => {
    seedMerge()
    const before = opLog.length
    expect(rejectionOf(() => merge({ moved: 1, dropped: 1 }))).toMatchObject({
      kind: 'validation',
      code: 'UnacknowledgedPropertyLoss',
    })
    expect(opLog.length).toBe(before)
    expect(textOf(X, 'stage')).toBe('a')
  })

  it('refuses keys of different types, undeclared, built-in or internal keys', () => {
    seedMerge()
    declare('note')
    expect(rejectionOf(() => preview('note', 'phase')).kind).toBe('validation')
    expect(rejectionOf(() => preview('nothing', 'phase')).kind).toBe('not_found')
    expect(rejectionOf(() => preview('stage', 'nothing')).kind).toBe('not_found')
    expect(rejectionOf(() => preview('stage', 'stage')).kind).toBe('validation')
    expect(rejectionOf(() => preview('stage', 'priority'))).toMatchObject({
      code: 'BuiltinPropertyLocked',
    })
    expect(rejectionOf(() => preview('template', 'phase')).kind).toBe('validation')
  })

  it('moves values, drops the doubled one, unions the options and records one op', () => {
    seedMerge()
    const before = opLog.length
    const resp = merge({ moved: 2, dropped: 1 })
    expect(opLog.length).toBe(before + 1)
    const op = lastOp()
    expect(op.op_type).toBe('rewrite_properties')
    const union = '["shared","b","a"]'
    const fields = (text: string | null) =>
      text === null
        ? null
        : { value_text: text, value_num: null, value_date: null, value_ref: null, value_bool: null }
    expect(op.payload).toEqual({
      space_id: SPACE,
      reason: 'merge',
      defs: [
        { key: 'stage', def: null, prior: { value_type: 'select', options: STAGE } },
        {
          key: 'phase',
          def: { value_type: 'select', options: union },
          prior: { value_type: 'select', options: PHASE },
        },
      ],
      values: [
        { block_id: X, key: 'stage', value: null, prior: fields('a') },
        { block_id: X, key: 'phase', value: fields('a'), prior: null },
        { block_id: Z, key: 'stage', value: null, prior: fields('shared') },
        { block_id: TRASHED, key: 'stage', value: null, prior: fields('a') },
        { block_id: TRASHED, key: 'phase', value: fields('a'), prior: null },
      ],
    })
    expect(resp).toMatchObject({ key: 'phase', options: union, op_refs: [op.ref] })
    expect(textOf(X, 'phase')).toBe('a')
    expect(textOf(X, 'stage')).toBeUndefined()
    expect(textOf(Z, 'phase')).toBe('b')
    expect(textOf(Z, 'stage')).toBeUndefined()
    expect(textOf(TRASHED, 'phase')).toBe('a')
    expect(listedDef('stage')).toBeUndefined()
    expect(listedDef('phase')?.['options']).toBe(union)
  })

  it('undo brings back the merged key, its values and the target options', () => {
    seedMerge()
    const { op_refs } = merge({ moved: 2, dropped: 1 })
    call('undo_ops', { ops: op_refs })
    expect(textOf(X, 'stage')).toBe('a')
    expect(textOf(X, 'phase')).toBeUndefined()
    expect(textOf(Z, 'stage')).toBe('shared')
    expect(textOf(Z, 'phase')).toBe('b')
    expect(listedDef('stage')?.['options']).toBe(STAGE)
    expect(listedDef('phase')?.['options']).toBe(PHASE)
  })

  it('undo of a value written before the merge follows the moved key', () => {
    seedMerge()
    const setX = setText(X, 'stage', 'shared')
    merge({ moved: 2, dropped: 1 })
    call('undo_ops', { ops: setX })
    expect(textOf(X, 'phase')).toBe('a')
    expect(textOf(X, 'stage')).toBeUndefined()
  })

  it("removes the merged key's engine Null without moving it, and moves onto the target's", () => {
    declare('stage')
    declare('phase')
    setNull(X, 'stage')
    setText(Y, 'stage', 'a')
    setNull(Y, 'phase')
    expect(preview()).toEqual({ moved: 1, dropped: 0 })
    merge({ moved: 1, dropped: 0 })
    const fields = {
      value_text: 'a',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    }
    expect(lastOp().payload['values']).toEqual([
      { block_id: X, key: 'stage', value: null, prior: null },
      { block_id: Y, key: 'stage', value: null, prior: fields },
      { block_id: Y, key: 'phase', value: fields, prior: null },
    ])
    expect(properties.get(X)?.has('stage')).toBe(false)
    expect(properties.get(X)?.has('phase')).toBe(false)
    expect(textOf(Y, 'phase')).toBe('a')
  })

  it('undo skips a block purged since the merge', () => {
    seedMerge()
    const { op_refs } = merge({ moved: 2, dropped: 1 })
    call('purge_block', { blockId: TRASHED })
    call('undo_ops', { ops: op_refs })
    expect(properties.has(TRASHED)).toBe(false)
    expect(textOf(X, 'stage')).toBe('a')
  })

  // `undoing_a_delete_and_a_merge_into_its_key_restores_both_values_5841`.
  it('undoing a delete and a merge into its key restores both values', () => {
    declare('stage')
    declare('phase')
    setText(X, 'stage', 's')
    setText(X, 'phase', 'p')
    const deleted = call<{ op_refs: Ref[] }>('delete_property', { blockId: X, key: 'phase' })
    const merged = merge({ moved: 1, dropped: 0 })
    call('undo_ops', { ops: [...deleted.op_refs, ...merged.op_refs] })
    expect(textOf(X, 'phase')).toBe('p')
    expect(textOf(X, 'stage')).toBe('s')
  })
})

describe('where rename and merge ops show', () => {
  it("global history scoped to a space lists that space's rename and merge ops", () => {
    declare('client')
    declare('customer_two')
    rename('client', 'customer')
    call('merge_property_key', {
      spaceId: SPACE,
      fromKey: 'customer',
      intoKey: 'customer_two',
      acknowledged: { moved: 0, dropped: 0 },
    })
    const history = (space: string, opTypeFilter: string): string[] =>
      call<{ items: Array<{ op_type: string }> }>('list_page_history', {
        pageId: '__all__',
        opTypeFilter,
        scope: { kind: 'active', space_id: space },
        limit: 50,
      }).items.map((row) => row.op_type)
    expect(history(SPACE, 'rename_property_key')).toEqual(['rename_property_key'])
    expect(history(SPACE, 'rewrite_properties')).toEqual(['rewrite_properties'])
    expect(history('SPACE_WORK', 'rename_property_key')).toEqual([])
  })
})
