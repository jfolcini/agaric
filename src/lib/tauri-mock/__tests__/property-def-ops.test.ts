/**
 * #5841 S1 — the mock's `set_property_def` op: the three definition writers
 * append one each and answer `WithOps`, undo restores the prior definition,
 * `create_space` records its defaults, and global history scoped to a space
 * lists the space's definition ops.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { coerce } from '@/lib/tauri-mock/coerce'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, opLog, properties, SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'

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
  message: string
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

  it('undoing a delete of a name a rename reused keeps both values', () => {
    declare('client')
    setText(X, 'client', 'mine')
    setText(X, 'area', 'old')
    call('delete_property', { blockId: X, key: 'area' })
    const deleted = [lastOp().ref]
    const { op_refs } = rename('client', 'area')
    call('undo_ops', { ops: op_refs })
    call('undo_ops', { ops: deleted })
    expect(textOf(X, 'area')).toBe('old')
    expect(textOf(X, 'client')).toBe('mine')
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

// #5841 S3 — changing a property key's type.

describe('change_property_type', () => {
  interface Counts {
    converted: number
    removed: number
  }
  interface ValueRow {
    block_id: string
    deleted: boolean
    value: string
    converted: string | null
  }

  /** `effortx` is text, held as "3", "042", "abc" and, in the Trash, "7". */
  function seedEffort(): void {
    declare('effortx')
    setText(X, 'effortx', '3')
    setText(Y, 'effortx', '042')
    setText(Z, 'effortx', 'abc')
    setText(TRASHED, 'effortx', '7')
    call('delete_block', { blockId: TRASHED })
  }

  function preview(valueType: string, options: string | null = null, key = 'effortx'): Counts {
    return call('preview_property_type_change', { spaceId: SPACE, key, valueType, options })
  }

  function values(
    kind: 'converted' | 'removed',
    valueType: string,
    cursor: string | null = null,
    limit = 50,
  ): { items: ValueRow[]; next_cursor: string | null; has_more: boolean } {
    return call('list_property_type_change_values', {
      spaceId: SPACE,
      key: 'effortx',
      valueType,
      options: null,
      kind,
      cursor,
      limit,
    })
  }

  function change(
    valueType: string,
    acknowledged: Counts,
    options: string | null = null,
    key = 'effortx',
  ): WithOpsDef {
    return call<WithOpsDef>('change_property_type', {
      spaceId: SPACE,
      key,
      valueType,
      options,
      acknowledged,
    })
  }

  function rowOf(blockId: string, key = 'effortx'): Record<string, unknown> | undefined {
    return call<Array<Record<string, unknown>>>('get_properties', { blockId }).find(
      (r) => r['key'] === key,
    )
  }

  const text = (t: string) => ({
    value_text: t,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  })
  const num = (n: number) => ({
    value_text: null,
    value_num: n,
    value_date: null,
    value_ref: null,
    value_bool: null,
  })

  it('previews what converts and what is removed, Trash included', () => {
    seedEffort()
    expect(preview('number')).toEqual({ converted: 3, removed: 1 })
    expect(preview('date')).toEqual({ converted: 0, removed: 4 })
    expect(preview('url')).toEqual({ converted: 4, removed: 0 })
  })

  it('lists the values of each kind by block, a page at a time', () => {
    seedEffort()
    expect(values('removed', 'number').items).toEqual([
      expect.objectContaining({ block_id: Z, value: 'abc', converted: null, deleted: false }),
    ])
    const first = values('converted', 'number', null, 2)
    expect(first.items.map((r) => [r.block_id, r.value, r.converted])).toEqual([
      [X, '3', '3'],
      [Y, '042', '42'],
    ])
    expect(first.has_more).toBe(true)
    const second = values('converted', 'number', first.next_cursor, 2)
    expect(second.items).toEqual([
      expect.objectContaining({ block_id: TRASHED, value: '7', converted: '7', deleted: true }),
    ])
    expect(second.has_more).toBe(false)
  })

  it('refuses a built-in, internal, malformed, undeclared or unchanged type, writing nothing', () => {
    seedEffort()
    const before = opLog.length
    expect(rejectionOf(() => preview('text', null, 'due_date'))).toMatchObject({
      kind: 'validation',
      code: 'BuiltinPropertyLocked',
    })
    expect(rejectionOf(() => preview('number', null, 'template')).kind).toBe('validation')
    expect(rejectionOf(() => preview('colour')).kind).toBe('validation')
    expect(rejectionOf(() => preview('select')).kind).toBe('validation')
    expect(rejectionOf(() => preview('number', null, 'nothing')).kind).toBe('not_found')
    expect(rejectionOf(() => preview('text')).kind).toBe('validation')
    expect(rejectionOf(() => change('number', { converted: 4, removed: 0 }))).toMatchObject({
      kind: 'validation',
      code: 'UnacknowledgedPropertyLoss',
    })
    expect(opLog.length).toBe(before)
    expect(textOf(Z, 'effortx')).toBe('abc')
  })

  it('converts and removes in one op, and the values move to the typed slot', () => {
    seedEffort()
    const before = opLog.length
    const resp = change('number', { converted: 3, removed: 1 })
    expect(opLog.length).toBe(before + 1)
    const op = lastOp()
    expect(op.op_type).toBe('rewrite_properties')
    expect(op.payload).toEqual({
      space_id: SPACE,
      reason: 'change_type',
      defs: [
        {
          key: 'effortx',
          def: { value_type: 'number', options: null },
          prior: { value_type: 'text', options: null },
        },
      ],
      values: [
        { block_id: X, key: 'effortx', value: num(3), prior: text('3') },
        { block_id: Y, key: 'effortx', value: num(42), prior: text('042') },
        { block_id: Z, key: 'effortx', value: null, prior: text('abc') },
        { block_id: TRASHED, key: 'effortx', value: num(7), prior: text('7') },
      ],
    })
    expect(resp).toMatchObject({ key: 'effortx', value_type: 'number', op_refs: [op.ref] })
    expect(rowOf(Y)).toMatchObject(num(42))
    expect(rowOf(Z)).toBeUndefined()
    expect(rowOf(TRASHED)).toMatchObject(num(7))
    expect(listedDef('effortx')).toMatchObject({ value_type: 'number' })
  })

  it('undo restores the values and the definition, and redo changes it again', () => {
    seedEffort()
    const { op_refs } = change('number', { converted: 3, removed: 1 })
    const [undone] = call<Array<{ new_op_ref: Ref }>>('undo_ops', { ops: op_refs })
    expect(rowOf(Y)).toMatchObject(text('042'))
    expect(rowOf(Z)).toMatchObject(text('abc'))
    expect(listedDef('effortx')).toMatchObject({ value_type: 'text' })
    call('redo_page_op', {
      undoDeviceId: undone?.new_op_ref.device_id,
      undoSeq: undone?.new_op_ref.seq,
    })
    expect(rowOf(Y)).toMatchObject(num(42))
    expect(rowOf(Z)).toBeUndefined()
  })

  it('moves a value whose form does not change to the new slot, and back on undo', () => {
    declare('effortx')
    setText(X, 'effortx', '2026-01-05')
    setText(Y, 'effortx', '2026-02-30')
    const { op_refs } = change('date', { converted: 1, removed: 1 })
    expect(lastOp().payload['values']).toEqual([
      { block_id: Y, key: 'effortx', value: null, prior: text('2026-02-30') },
    ])
    expect(rowOf(X)).toMatchObject({ value_text: null, value_date: '2026-01-05' })
    call('undo_ops', { ops: op_refs })
    expect(rowOf(X)).toMatchObject(text('2026-01-05'))
    expect(rowOf(Y)).toMatchObject(text('2026-02-30'))
  })

  it('to boolean takes true and false only; to select keeps the listed options', () => {
    declare('effortx')
    setText(X, 'effortx', 'true')
    setText(Y, 'effortx', 'yes')
    expect(preview('boolean')).toEqual({ converted: 1, removed: 1 })
    expect(preview('select', '["true"]')).toEqual({ converted: 1, removed: 1 })
    change('boolean', { converted: 1, removed: 1 })
    expect(rowOf(X)).toMatchObject({ value_text: null, value_bool: 1 })
    expect(rowOf(Y)).toBeUndefined()
  })

  it('undo of an earlier value converts it under the new type, or refuses one that does not fit', () => {
    declare('effortx')
    setText(X, 'effortx', '6')
    const second = setText(X, 'effortx', '5')
    setText(Y, 'effortx', 'abc')
    const third = setText(Y, 'effortx', '1')
    change('number', { converted: 2, removed: 0 })
    call('undo_ops', { ops: second })
    expect(rowOf(X)).toMatchObject(num(6))
    const before = opLog.length
    expect(rejectionOf(() => call('undo_ops', { ops: third })).kind).toBe('validation')
    expect(opLog.length).toBe(before)
    expect(rowOf(Y)).toMatchObject(num(1))
  })

  it("undo of an earlier value fits the slot only, never the select's options", () => {
    declare('stagey', 'select', '["a","c"]')
    setText(X, 'stagey', 'c')
    const second = setText(X, 'stagey', 'a')
    call('update_property_def_options', { spaceId: SPACE, key: 'stagey', options: '["a"]' })
    call('undo_ops', { ops: second })
    expect(rowOf(X, 'stagey')).toMatchObject(text('c'))
  })

  it("undo of an earlier value on the space's own block converts it too", () => {
    declare('effortx')
    setText(SPACE, 'effortx', '6')
    const second = setText(SPACE, 'effortx', '5')
    change('number', { converted: 1, removed: 0 })
    call('undo_ops', { ops: second })
    expect(rowOf(SPACE)).toMatchObject(num(6))
  })

  it("undoing a change re-projects the strings written since under the old type's slot", () => {
    declare('effortx', 'number')
    call('set_property', { blockId: X, key: 'effortx', value: num(3) })
    const { op_refs } = change('text', { converted: 1, removed: 0 })
    setText(Y, 'effortx', '5')
    setText(Z, 'effortx', 'abc')
    call('undo_ops', { ops: op_refs })
    expect(rowOf(X)).toMatchObject(num(3))
    expect(rowOf(Y)).toMatchObject(num(5))
    expect(rowOf(Z)).toBeUndefined()
  })

  it('checks the limit before refusing the key', () => {
    const err = rejectionOf(() =>
      call('list_property_type_change_values', {
        spaceId: SPACE,
        key: 'due_date',
        valueType: 'text',
        options: null,
        kind: 'removed',
        cursor: null,
        limit: 0,
      }),
    )
    expect(err).toMatchObject({ kind: 'validation' })
    expect(err.code).toBeUndefined()
  })

  it("lists a number as Rust's Display writes it", () => {
    declare('scorex', 'number')
    call('set_property', { blockId: X, key: 'scorex', value: num(-0) })
    call('set_property', { blockId: Y, key: 'scorex', value: num(1e21) })
    const page = call<{ items: ValueRow[] }>('list_property_type_change_values', {
      spaceId: SPACE,
      key: 'scorex',
      valueType: 'text',
      options: null,
      kind: 'converted',
      cursor: null,
      limit: 50,
    })
    expect(page.items.map((r) => [r.value, r.converted])).toEqual([
      ['-0', '-0'],
      ['1000000000000000000000', '1000000000000000000000'],
    ])
  })

  // The cells of `coerce.rs`'s table the fixtures do not reach.
  it.each([
    [' 4 ', 'number', 4],
    ['1e3', 'number', 1000],
    ['-.5', 'number', -0.5],
    ['inf', 'number', null],
    ['NaN', 'number', null],
    ['1e400', 'number', null],
    ['0x10', 'number', null],
    ['+3', 'number', 3],
    ['1.', 'number', 1],
    ['.5', 'number', 0.5],
    ['1e-400', 'number', 0],
    ['', 'number', null],
    ['.', 'number', null],
    ['e5', 'number', null],
    ['1_000', 'number', null],
    ['INF', 'number', null],
    ['-Infinity', 'number', null],
    ['nan', 'number', null],
    // Rust's `str::trim` strips Unicode White_Space: U+0085 is, U+FEFF is not.
    ['\u00854\u0085', 'number', 4],
    ['﻿4', 'number', null],
    ['0024-02-29', 'date', '0024-02-29'],
    ['0025-02-29', 'date', null],
    ['true ', 'boolean', null],
    ['TRUE', 'boolean', null],
    ['01arz3ndektsv4rrffq69g5fav', 'ref', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['81ARZ3NDEKTSV4RRFFQ69G5FAV', 'ref', null],
    ['2026-1-05', 'date', null],
    [42, 'text', '42'],
    [-0, 'text', '-0'],
    [1e21, 'text', '1000000000000000000000'],
    [1e-7, 'text', '0.0000001'],
    [0.1 + 0.2, 'text', '0.30000000000000004'],
    [-2.5e-3, 'select', '-0.0025'],
    [true, 'url', 'true'],
    [true, 'number', null],
    [1, 'boolean', null],
    [7, 'date', null],
  ] as const)('coerces %j to %s as %j', (value, to, expected) => {
    expect(coerce(value, to)).toBe(expected)
  })
})

// #5841 S4 — renaming a select option.

describe('rename_property_option', () => {
  function optionsOf(key: string): unknown {
    const options = listedDef(key)?.['options']
    return typeof options === 'string' ? JSON.parse(options) : options
  }

  function renameOption(oldOption: string, newOption: string, key = 'stage'): WithOpsDef {
    return call<WithOpsDef>('rename_property_option', { spaceId: SPACE, key, oldOption, newOption })
  }

  /** `stage` lists draft, review and done; X and the trashed block hold review, Y draft. */
  function seedStage(): void {
    declare('stage', 'select', '["draft","review","done"]')
    setText(X, 'stage', 'review')
    setText(Y, 'stage', 'draft')
    setText(TRASHED, 'stage', 'review')
    call('delete_block', { blockId: TRASHED })
  }

  it("renames the option in place and every value of the space's blocks, Trash included", () => {
    seedStage()
    const before = opLog.length
    const resp = renameOption('review', 'in_review')
    expect(opLog.length).toBe(before + 1)
    const op = lastOp()
    expect(op.op_type).toBe('rename_property_option')
    expect(op.payload).toEqual({
      space_id: SPACE,
      key: 'stage',
      old_option: 'review',
      new_option: 'in_review',
    })
    expect(resp.op_refs).toEqual([op.ref])
    expect(resp).toMatchObject({ key: 'stage', value_type: 'select', builtin: false })
    expect(optionsOf('stage')).toEqual(['draft', 'in_review', 'done'])
    expect(textOf(X, 'stage')).toBe('in_review')
    expect(textOf(TRASHED, 'stage')).toBe('in_review')
    expect(textOf(Y, 'stage')).toBe('draft')
  })

  it("leaves another space's blocks holding the same key and value", () => {
    seedStage()
    const other = 'OTHER_SPACE_BLOCK'
    blocks.set(other, { ...makeBlock(other, 'content', 'x', null, 1), space_id: 'SPACE_OTHER' })
    properties.set(other, new Map([['stage', { key: 'stage', value_text: 'review' }]]))
    renameOption('review', 'in_review')
    expect(textOf(other, 'stage')).toBe('review')
  })

  it('refuses in the order the backend does', () => {
    seedStage()
    declare('note')
    setText(Z, 'stage', 'done')
    call('update_property_def_options', {
      spaceId: SPACE,
      key: 'stage',
      options: '["draft","review"]',
    })
    const before = opLog.length
    const refused = (key: string, from: string, to: string) =>
      rejectionOf(() => renameOption(from, to, key))
    expect(refused('priority', '1', '9')).toMatchObject({
      code: 'BuiltinPropertyLocked',
      message: "property 'priority' is built in and cannot be changed",
    })
    expect(refused('todo_state', 'DONE', 'FINISHED').code).toBe('BuiltinPropertyLocked')
    expect(refused('template', 'a', 'b')).toMatchObject({
      kind: 'validation',
      message: "property 'template' is the app's own and cannot be changed",
    })
    expect(refused('stage', 'review', '  ').message).toBe('an option cannot be empty')
    expect(refused('stage', 'review', 'review').message).toBe(
      "'review' cannot be renamed to itself",
    )
    expect(refused('nothing', 'a', 'b')).toMatchObject({
      kind: 'not_found',
      message: "property definition 'nothing'",
    })
    expect(refused('note', 'a', 'b').message).toBe(
      "'note' is a text property; only a select has options",
    )
    expect(refused('stage', 'gone', 'b').message).toBe("'gone' is not an option of 'stage'")
    expect(refused('stage', 'review', 'draft').message).toBe(
      "'draft' is already an option of 'stage'",
    )
    expect(refused('stage', 'review', 'done').message).toBe(
      "'done' is already held by 1 block(s) of this space, the Trash included",
    )
    expect(opLog.length).toBe(before)
    expect(optionsOf('stage')).toEqual(['draft', 'review'])
    expect(textOf(X, 'stage')).toBe('review')
  })

  it('undo renames back, keeping the order, and redo renames again', () => {
    seedStage()
    const { op_refs } = renameOption('review', 'in_review')
    const [undone] = call<Array<{ new_op_ref: Ref }>>('undo_ops', { ops: op_refs })
    expect(lastOp()).toMatchObject({
      op_type: 'rename_property_option',
      payload: { key: 'stage', old_option: 'in_review', new_option: 'review' },
    })
    expect(optionsOf('stage')).toEqual(['draft', 'review', 'done'])
    expect(textOf(X, 'stage')).toBe('review')
    expect(textOf(TRASHED, 'stage')).toBe('review')
    call('redo_page_op', {
      undoDeviceId: undone?.new_op_ref.device_id,
      undoSeq: undone?.new_op_ref.seq,
    })
    expect(optionsOf('stage')).toEqual(['draft', 'in_review', 'done'])
    expect(textOf(X, 'stage')).toBe('in_review')
  })

  it('undo renames back a value written as the new name since, and leaves a later edit', () => {
    seedStage()
    const { op_refs } = renameOption('review', 'in_review')
    setText(Z, 'stage', 'in_review')
    setText(X, 'stage', 'done')
    call('undo_ops', { ops: op_refs })
    expect(textOf(Z, 'stage')).toBe('review')
    expect(textOf(X, 'stage')).toBe('done')
  })

  it('undo after a later key rename renames back under the new key', () => {
    seedStage()
    const { op_refs } = renameOption('review', 'in_review')
    rename('stage', 'phase')
    call('undo_ops', { ops: op_refs })
    expect(optionsOf('phase')).toEqual(['draft', 'review', 'done'])
    expect(textOf(X, 'phase')).toBe('review')
    expect(textOf(TRASHED, 'phase')).toBe('review')
  })

  it('refuses the undo once the definition is gone or the old name is an option again', () => {
    seedStage()
    const renamed = renameOption('review', 'in_review')
    call('update_property_def_options', {
      spaceId: SPACE,
      key: 'stage',
      options: '["draft","in_review","done","review"]',
    })
    expect(rejectionOf(() => call('undo_ops', { ops: renamed.op_refs })).message).toBe(
      "'review' is already an option of 'stage'",
    )
    expect(textOf(X, 'stage')).toBe('in_review')

    declare('lane', 'select', '["a","b"]')
    const laneRenamed = renameOption('a', 'c', 'lane')
    call('delete_property_def', { spaceId: SPACE, key: 'lane' })
    expect(rejectionOf(() => call('undo_ops', { ops: laneRenamed.op_refs })).kind).toBe('not_found')
  })

  it("an earlier value's undo lands on the new name, one way only", () => {
    declare('stage', 'select', '["draft","review","done","in_review"]')
    setText(X, 'stage', 'review')
    const xToDone = setText(X, 'stage', 'done')
    // Y held `in_review` before the rename made it the name of `review`.
    setText(Y, 'stage', 'in_review')
    const yToDraft = setText(Y, 'stage', 'draft')
    call('update_property_def_options', {
      spaceId: SPACE,
      key: 'stage',
      options: '["draft","review","done"]',
    })
    renameOption('review', 'in_review')
    rename('stage', 'phase')
    call('undo_ops', { ops: xToDone })
    expect(textOf(X, 'phase')).toBe('in_review')
    call('undo_ops', { ops: yToDraft })
    expect(textOf(Y, 'phase')).toBe('in_review')
  })

  it('global history scoped to a space lists the rename', () => {
    seedStage()
    renameOption('review', 'in_review')
    const history = (space: string): string[] =>
      call<{ items: Array<{ op_type: string }> }>('list_page_history', {
        pageId: '__all__',
        opTypeFilter: 'rename_property_option',
        scope: { kind: 'active', space_id: space },
        limit: 50,
      }).items.map((row) => row.op_type)
    expect(history(SPACE)).toEqual(['rename_property_option'])
    expect(history('SPACE_WORK')).toEqual([])
  })
})
