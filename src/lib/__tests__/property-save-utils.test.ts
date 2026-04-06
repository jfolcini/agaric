/**
 * Tests for src/lib/property-save-utils.ts
 *
 * Validates:
 *  - buildPropertyParams: correct params for text, number, date types
 *  - buildPropertyParams: invalid number detection
 *  - buildPropertyParams: empty number field handling
 *  - handleSaveProperty: success and validation-failure paths
 *  - handleDeleteProperty: calls deleteProperty and onRefresh
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockedInvoke = vi.mocked(invoke)

import {
  buildInitParams,
  buildPropertyParams,
  handleDeleteProperty,
  handleSaveProperty,
  NON_DELETABLE_PROPERTIES,
} from '../property-save-utils'
import type { PropertyDefinition } from '../tauri'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildPropertyParams', () => {
  it('returns valueText for text type', () => {
    const result = buildPropertyParams('B1', 'author', 'Alice', 'text')
    expect(result).toEqual({
      ok: true,
      params: { blockId: 'B1', key: 'author', valueText: 'Alice' },
    })
  })

  it('returns empty string valueText for empty text', () => {
    const result = buildPropertyParams('B1', 'author', '', 'text')
    expect(result).toEqual({
      ok: true,
      params: { blockId: 'B1', key: 'author', valueText: '' },
    })
  })

  it('returns valueNum for valid number', () => {
    const result = buildPropertyParams('B1', 'priority', '42', 'number')
    expect(result).toEqual({
      ok: true,
      params: { blockId: 'B1', key: 'priority', valueNum: 42 },
    })
  })

  it('returns valueNum for decimal number', () => {
    const result = buildPropertyParams('B1', 'score', '3.14', 'number')
    expect(result).toEqual({
      ok: true,
      params: { blockId: 'B1', key: 'score', valueNum: 3.14 },
    })
  })

  it('returns invalidNumber error for non-numeric input', () => {
    const result = buildPropertyParams('B1', 'priority', 'abc', 'number')
    expect(result).toEqual({ ok: false, error: 'invalidNumber' })
  })

  it('clears number field when value is empty', () => {
    const result = buildPropertyParams('B1', 'priority', '', 'number')
    expect(result).toEqual({
      ok: true,
      params: { blockId: 'B1', key: 'priority', valueText: '' },
    })
  })

  it('clears number field when value is whitespace only', () => {
    const result = buildPropertyParams('B1', 'priority', '   ', 'number')
    expect(result).toEqual({
      ok: true,
      params: { blockId: 'B1', key: 'priority', valueText: '' },
    })
  })

  it('returns valueDate for date type', () => {
    const result = buildPropertyParams('B1', 'due', '2026-06-15', 'date')
    expect(result).toEqual({
      ok: true,
      params: { blockId: 'B1', key: 'due', valueDate: '2026-06-15' },
    })
  })

  it('returns null valueDate for empty date', () => {
    const result = buildPropertyParams('B1', 'due', '', 'date')
    expect(result).toEqual({
      ok: true,
      params: { blockId: 'B1', key: 'due', valueDate: null },
    })
  })

  it('treats unknown types as text', () => {
    const result = buildPropertyParams('B1', 'custom', 'val', 'ref')
    expect(result).toEqual({
      ok: true,
      params: { blockId: 'B1', key: 'custom', valueText: 'val' },
    })
  })
})

describe('NON_DELETABLE_PROPERTIES', () => {
  it('contains all expected builtin keys', () => {
    for (const key of [
      'todo_state',
      'priority',
      'due_date',
      'scheduled_date',
      'created_at',
      'completed_at',
      'repeat',
      'repeat-until',
      'repeat-count',
      'repeat-seq',
      'repeat-origin',
    ]) {
      expect(NON_DELETABLE_PROPERTIES.has(key)).toBe(true)
    }
  })

  it('does not include user-deletable properties', () => {
    for (const key of ['effort', 'assignee', 'location']) {
      expect(NON_DELETABLE_PROPERTIES.has(key)).toBe(false)
    }
  })
})

describe('buildInitParams', () => {
  const makeDef = (key: string, valueType: string): PropertyDefinition => ({
    key,
    value_type: valueType,
    options: null,
    created_at: '2026-01-01T00:00:00Z',
  })

  it('returns valueText empty string for text type', () => {
    const result = buildInitParams('B1', makeDef('author', 'text'))
    expect(result).toEqual({ blockId: 'B1', key: 'author', valueText: '' })
  })

  it('returns valueText empty string for select type', () => {
    const result = buildInitParams('B1', makeDef('status', 'select'))
    expect(result).toEqual({ blockId: 'B1', key: 'status', valueText: '' })
  })

  it('returns valueNum 0 for number type', () => {
    const result = buildInitParams('B1', makeDef('weight', 'number'))
    expect(result).toEqual({ blockId: 'B1', key: 'weight', valueNum: 0 })
  })

  it('returns today as valueDate for date type', () => {
    const today = new Date().toISOString().slice(0, 10)
    const result = buildInitParams('B1', makeDef('due', 'date'))
    expect(result).toEqual({ blockId: 'B1', key: 'due', valueDate: today })
  })

  it('returns valueRef null for ref type', () => {
    const result = buildInitParams('B1', makeDef('parent', 'ref'))
    expect(result).toEqual({ blockId: 'B1', key: 'parent', valueRef: null })
  })

  it('returns null for unknown types', () => {
    const result = buildInitParams('B1', makeDef('mystery', 'blob'))
    expect(result).toBeNull()
  })
})

describe('handleSaveProperty', () => {
  it('saves text property and refreshes', async () => {
    const refreshedProps = [
      { key: 'author', value_text: 'Bob', value_num: null, value_date: null, value_ref: null },
    ]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_property') return undefined
      if (cmd === 'get_properties') return refreshedProps
      return null
    })

    const onRefresh = vi.fn()
    const ok = await handleSaveProperty('B1', 'author', 'Bob', 'text', onRefresh)

    expect(ok).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'B1',
      key: 'author',
      valueText: 'Bob',
      valueNum: null,
      valueDate: null,
      valueRef: null,
    })
    expect(mockedInvoke).toHaveBeenCalledWith('get_properties', { blockId: 'B1' })
    expect(onRefresh).toHaveBeenCalledWith(refreshedProps)
  })

  it('returns false for invalid number without calling setProperty', async () => {
    const onRefresh = vi.fn()
    const ok = await handleSaveProperty('B1', 'count', 'abc', 'number', onRefresh)

    expect(ok).toBe(false)
    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('saves number property correctly', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_property') return undefined
      if (cmd === 'get_properties') return []
      return null
    })

    const onRefresh = vi.fn()
    const ok = await handleSaveProperty('B1', 'count', '99', 'number', onRefresh)

    expect(ok).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'B1',
      key: 'count',
      valueNum: 99,
      valueText: null,
      valueDate: null,
      valueRef: null,
    })
  })

  it('saves date property correctly', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_property') return undefined
      if (cmd === 'get_properties') return []
      return null
    })

    const onRefresh = vi.fn()
    const ok = await handleSaveProperty('B1', 'due', '2026-06-15', 'date', onRefresh)

    expect(ok).toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'B1',
      key: 'due',
      valueDate: '2026-06-15',
      valueText: null,
      valueNum: null,
      valueRef: null,
    })
  })

  it('propagates errors from setProperty', async () => {
    mockedInvoke.mockRejectedValue(new Error('backend error'))

    const onRefresh = vi.fn()
    await expect(handleSaveProperty('B1', 'key', 'val', 'text', onRefresh)).rejects.toThrow(
      'backend error',
    )
    expect(onRefresh).not.toHaveBeenCalled()
  })
})

describe('handleDeleteProperty', () => {
  it('calls deleteProperty and invokes onRefresh', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const onRefresh = vi.fn()

    await handleDeleteProperty('B1', 'author', onRefresh)

    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'B1',
      key: 'author',
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('propagates errors from deleteProperty', async () => {
    mockedInvoke.mockRejectedValue(new Error('delete failed'))
    const onRefresh = vi.fn()

    await expect(handleDeleteProperty('B1', 'key', onRefresh)).rejects.toThrow('delete failed')
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
