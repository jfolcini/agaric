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

import type { PropertyRow } from '@/lib/bindings'
import { getTodayString } from '@/lib/date-utils'
import {
  buildInitParams,
  buildPropertyParams,
  carriedRenameDefinition,
  handleDeleteProperty,
  handleSaveProperty,
  NON_DELETABLE_PROPERTIES,
  renameMayDeclareKey,
} from '@/lib/property-save-utils'
import type { PropertyDefinition } from '@/lib/tauri'

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
      params: { blockId: 'B1', key: 'priority', valueNum: null },
    })
  })

  it('clears number field when value is whitespace only', () => {
    const result = buildPropertyParams('B1', 'priority', '   ', 'number')
    expect(result).toEqual({
      ok: true,
      params: { blockId: 'B1', key: 'priority', valueNum: null },
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

  it('returns today (local calendar day) as valueDate for date type', () => {
    // Must be the local day, not the UTC day — otherwise users in
    // negative-offset timezones get tomorrow's date by default.
    const result = buildInitParams('B1', makeDef('due', 'date'))
    expect(result).toEqual({ blockId: 'B1', key: 'due', valueDate: getTodayString() })
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
      value: {
        value_text: 'Bob',
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
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
      value: {
        value_text: null,
        value_num: 99,
        value_date: null,
        value_ref: null,
        value_bool: null,
      },
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
      value: {
        value_text: null,
        value_num: null,
        value_date: '2026-06-15',
        value_ref: null,
        value_bool: null,
      },
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

// #4010 — a renamed key had no `property_definitions` row of its own, so the
// next inline chip edit resolved it to the `'text'` fallback and re-flattened
// the typed column the rename had just carried over. `carriedRenameDefinition`
// decides what the rename may copy: a declaration the user already made, never
// an invented one, and never one that contradicts the row being carried (that
// would make the engine reject the rename's own write).
describe('carriedRenameDefinition', () => {
  const row = (over: Partial<PropertyRow> = {}): PropertyRow => ({
    key: 'k',
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...over,
  })

  it('carries a declaration that agrees with the carried column', () => {
    expect(
      carriedRenameDefinition({ value_type: 'number', options: null }, row({ value_num: 5 })),
    ).toEqual({ valueType: 'number', options: null })
    expect(
      carriedRenameDefinition(
        { value_type: 'date', options: null },
        row({ value_date: '2026-09-15' }),
      ),
    ).toEqual({ valueType: 'date', options: null })
    expect(
      carriedRenameDefinition({ value_type: 'boolean', options: null }, row({ value_bool: 0 })),
    ).toEqual({ valueType: 'boolean', options: null })
    expect(
      carriedRenameDefinition({ value_type: 'ref', options: null }, row({ value_ref: 'B2' })),
    ).toEqual({ valueType: 'ref', options: null })
    expect(
      carriedRenameDefinition({ value_type: 'text', options: null }, row({ value_text: 'hi' })),
    ).toEqual({ valueType: 'text', options: null })
  })

  it('carries select options, which the definition is not creatable without', () => {
    expect(
      carriedRenameDefinition(
        { value_type: 'select', options: '["a","b"]' },
        row({ value_text: 'a' }),
      ),
    ).toEqual({ valueType: 'select', options: '["a","b"]' })
    // `create_property_def_inner` rejects a select with no options array.
    expect(
      carriedRenameDefinition({ value_type: 'select', options: null }, row({ value_text: 'a' })),
    ).toBeNull()
  })

  it('mirrors the engine in letting a text/select declaration hold a ref', () => {
    expect(
      carriedRenameDefinition({ value_type: 'text', options: null }, row({ value_ref: 'B2' })),
    ).toEqual({ valueType: 'text', options: null })
  })

  it('invents nothing for a key that was never declared', () => {
    expect(carriedRenameDefinition(null, row({ value_num: 5 }))).toBeNull()
    expect(carriedRenameDefinition(undefined, row({ value_text: 'hi' }))).toBeNull()
  })

  it('skips a declaration that contradicts the carried column', () => {
    // `number` over a `value_text` row: copying it makes the engine reject
    // the rename's own write ("Property 'x' expects type 'number', got 'text'").
    expect(
      carriedRenameDefinition({ value_type: 'number', options: null }, row({ value_text: 'five' })),
    ).toBeNull()
    expect(
      carriedRenameDefinition({ value_type: 'date', options: null }, row({ value_num: 5 })),
    ).toBeNull()
    expect(
      carriedRenameDefinition({ value_type: 'ref', options: null }, row({ value_text: 'hi' })),
    ).toBeNull()
  })

  it('skips a value_type create_property_def would reject outright', () => {
    expect(
      carriedRenameDefinition({ value_type: 'timestamp', options: null }, row({ value_text: 'x' })),
    ).toBeNull()
  })

  // Adversarial review — step 4 is not the only declaration check the engine
  // runs. `validate_property_value` step 5 also requires a `select`'s
  // `value_text` to be IN its options array, and errors outright on options
  // JSON it cannot parse. A declaration failing either of those rejects the
  // rename's own write exactly like a type mismatch does, so it must not be
  // copied. The drift is reachable: the Properties tab edits an options list
  // in place, long after values were stored against it.
  it('skips a select declaration whose options no longer contain the carried value', () => {
    expect(
      carriedRenameDefinition(
        { value_type: 'select', options: '["a","b"]' },
        row({ value_text: 'c' }),
      ),
    ).toBeNull()
  })

  it('skips a select declaration with unusable options JSON', () => {
    // Malformed: engine step 5 fails with "has malformed options JSON".
    expect(
      carriedRenameDefinition({ value_type: 'select', options: '{oops' }, row({ value_text: 'a' })),
    ).toBeNull()
    // Not a JSON array of strings: `serde_json::from_str::<Vec<String>>` fails.
    expect(
      carriedRenameDefinition({ value_type: 'select', options: '[1,2]' }, row({ value_text: 'a' })),
    ).toBeNull()
    // Empty array: `create_property_def_inner` rejects it up front.
    expect(
      carriedRenameDefinition({ value_type: 'select', options: '[]' }, row({ value_text: 'a' })),
    ).toBeNull()
  })

  it('still carries a select whose ref-valued row escapes the options check', () => {
    // Engine step 5 only constrains `value_text`; a select-declared key
    // holding a ref passes it, so the copy stays safe.
    expect(
      carriedRenameDefinition({ value_type: 'select', options: '["a"]' }, row({ value_ref: 'B2' })),
    ).toEqual({ valueType: 'select', options: '["a"]' })
  })
})

// #4041 review notes 3 + 4 — the rename must only DECLARE a key whose
// declaration it could withdraw again, because the value write that follows can
// still fail and `delete_property_def_inner` refuses to remove a definition for
// a builtin key or for one any `block_properties` row references.
describe('renameMayDeclareKey', () => {
  /** Backend stand-in: `get_property_def` + `list_property_keys`. */
  function installBackend(defs: Record<string, unknown>, keysInUse: string[]) {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'get_property_def') return defs[(args as { key: string }).key] ?? null
      if (cmd === 'list_property_keys') return keysInUse
      return null
    })
  }

  it('allows a fresh, unused, non-builtin key', async () => {
    installBackend({}, ['estimate'])
    expect(await renameMayDeclareKey('effortPoints')).toBe(true)
  })

  it('refuses a key any block already holds a value for', async () => {
    // The un-exitable state: the definition could never be deleted again while
    // those rows exist, so it must not be written in the first place.
    installBackend({}, ['estimate', 'status'])
    expect(await renameMayDeclareKey('status')).toBe(false)
  })

  it('refuses an already-declared key — that row is not this rename to withdraw', async () => {
    installBackend(
      { effortPoints: { key: 'effortPoints', value_type: 'text', options: null, created_at: 'T' } },
      [],
    )
    expect(await renameMayDeclareKey('effortPoints')).toBe(false)
  })

  it('refuses builtin and column-backed keys without any lookup', async () => {
    installBackend({}, [])
    // `delete_property_def_inner` refuses every `is_builtin_property_key`, so
    // such a declaration is permanent the moment it lands.
    for (const key of ['repeat', 'created_at', 'completed_at', 'due_date', 'space']) {
      expect(await renameMayDeclareKey(key)).toBe(false)
    }
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})
