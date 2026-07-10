/**
 * #2003 — mock `set_property_batch` handler behavior.
 *
 * Mirrors the backend `set_property_batch`: an ALLOWLISTED reserved property
 * (`todo_state` / `priority` / `due_date` / `scheduled_date`) set/cleared on
 * N blocks in one tx. This suite pins the mock's parity-critical semantics
 * that component tests rely on:
 *  - the op payload's typed value column is routed by key
 *    (`todo_state`/`priority` → `value_text`; date keys → `value_date`);
 *  - a `null` value clears (emits an op with no `value_*` field);
 *  - missing / soft-deleted ids are skipped, and `updated` counts live ids;
 *  - an empty id list and a non-allowlisted key are hard rejections.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { isValidation } from '../../app-error'
import { dispatch } from '../handlers'
import { blocks, makeBlock, opLog, properties, seedBlocks } from '../seed'

const A = '0000000000000000000000000A'
const B = '0000000000000000000000000B'
const DELETED = '00000000000000000000DELETE'
const MISSING = '0000000000000000000MISSING'

function resetMockState(): void {
  seedBlocks()
  blocks.clear()
  properties.clear()
  opLog.length = 0

  blocks.set(A, makeBlock(A, 'block', 'a', null, 0))
  blocks.set(B, makeBlock(B, 'block', 'b', null, 1))
  const del = makeBlock(DELETED, 'block', 'x', null, 2)
  del['deleted_at'] = '2025-01-01T00:00:00Z'
  blocks.set(DELETED, del)
}

/** The most recent op_log entry's parsed payload. */
function lastPayload(): Record<string, unknown> {
  const last = opLog.at(-1)
  if (!last) throw new Error('test setup: expected an op_log entry')
  return JSON.parse(last.payload) as Record<string, unknown>
}

describe('tauri-mock set_property_batch', () => {
  beforeEach(() => {
    resetMockState()
  })

  it('routes todo_state/priority to value_text and counts live ids', () => {
    const updated = dispatch('set_property_batch', {
      blockIds: [A, B],
      key: 'todo_state',
      value: 'DONE',
    })

    expect(updated).toBe(2)
    const payload = lastPayload()
    expect(payload).toMatchObject({ key: 'todo_state', value_text: 'DONE' })
    expect(payload).not.toHaveProperty('value_date')
    expect(blocks.get(A)?.['todo_state']).toBe('DONE')
  })

  it('routes priority to value_text', () => {
    dispatch('set_property_batch', { blockIds: [A], key: 'priority', value: '1' })
    const payload = lastPayload()
    expect(payload).toMatchObject({ key: 'priority', value_text: '1' })
    expect(payload).not.toHaveProperty('value_date')
  })

  it('routes due_date/scheduled_date to value_date', () => {
    dispatch('set_property_batch', {
      blockIds: [A],
      key: 'due_date',
      value: '2026-07-10',
    })
    const payload = lastPayload()
    expect(payload).toMatchObject({ key: 'due_date', value_date: '2026-07-10' })
    expect(payload).not.toHaveProperty('value_text')

    dispatch('set_property_batch', {
      blockIds: [A],
      key: 'scheduled_date',
      value: '2026-08-01',
    })
    expect(lastPayload()).toMatchObject({ key: 'scheduled_date', value_date: '2026-08-01' })
  })

  it('null value clears — emits an op with no value_* field', () => {
    const updated = dispatch('set_property_batch', {
      blockIds: [A],
      key: 'todo_state',
      value: null,
    })
    expect(updated).toBe(1)
    const payload = lastPayload()
    expect(payload).toMatchObject({ key: 'todo_state' })
    expect(payload).not.toHaveProperty('value_text')
    expect(payload).not.toHaveProperty('value_date')
    expect(blocks.get(A)?.['todo_state']).toBeNull()
  })

  it('skips missing / soft-deleted ids and counts only live ids', () => {
    const updated = dispatch('set_property_batch', {
      blockIds: [A, DELETED, MISSING],
      key: 'priority',
      value: '2',
    })
    expect(updated).toBe(1)
  })

  it('rejects an empty id list', () => {
    let err: unknown
    try {
      dispatch('set_property_batch', { blockIds: [], key: 'todo_state', value: 'TODO' })
    } catch (e) {
      err = e
    }
    expect(isValidation(err)).toBe(true)
  })

  it('rejects a non-allowlisted key', () => {
    let err: unknown
    try {
      dispatch('set_property_batch', { blockIds: [A], key: 'color', value: 'red' })
    } catch (e) {
      err = e
    }
    expect(isValidation(err)).toBe(true)
  })
})
