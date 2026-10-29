/**
 * #5841 S1 — the mock's `set_property_def` op: the three definition writers
 * append one each and answer `WithOps`, undo restores the prior definition,
 * `create_space` records its defaults, and global history scoped to a space
 * lists the space's definition ops.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { opLog, seedBlocks } from '@/lib/tauri-mock/seed'

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
