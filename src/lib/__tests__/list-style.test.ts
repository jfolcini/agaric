/**
 * Tests for `list-style` (#3000) — list-ness as a block-property helper.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSetProperty, mockDeleteProperty } = vi.hoisted(() => ({
  mockSetProperty: vi.fn().mockResolvedValue({ status: 'ok', data: {} }),
  mockDeleteProperty: vi.fn().mockResolvedValue({ status: 'ok', data: {} }),
}))
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      setProperty: (...args: unknown[]) => mockSetProperty(...args),
      deleteProperty: (...args: unknown[]) => mockDeleteProperty(...args),
    },
  }
})

import type { PropertyRow } from '@/lib/bindings'
import {
  asListStyle,
  clearListStyle,
  LIST_STYLE_KEY,
  LIST_STYLE_OPTIONS_JSON,
  listStyleForBlockType,
  listStyleFromRows,
  setListStyle,
} from '@/lib/list-style'

const row = (over: Partial<PropertyRow>): PropertyRow => ({
  key: LIST_STYLE_KEY,
  value_text: null,
  value_num: null,
  value_date: null,
  value_ref: null,
  value_bool: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('asListStyle', () => {
  it('narrows the two stored styles and defaults everything else to none', () => {
    expect(asListStyle('bullet')).toBe('bullet')
    expect(asListStyle('ordered')).toBe('ordered')
    expect(asListStyle('none')).toBe('none')
    expect(asListStyle(null)).toBe('none')
    expect(asListStyle(undefined)).toBe('none')
    expect(asListStyle('garbage')).toBe('none')
  })
})

describe('listStyleFromRows', () => {
  it('reads the listStyle row, absence = none', () => {
    expect(listStyleFromRows([row({ value_text: 'bullet' })])).toBe('bullet')
    expect(listStyleFromRows([row({ value_text: 'ordered' })])).toBe('ordered')
    expect(listStyleFromRows([row({ key: 'other', value_text: 'x' })])).toBe('none')
    expect(listStyleFromRows([])).toBe('none')
    expect(listStyleFromRows(undefined)).toBe('none')
  })
})

describe('setListStyle', () => {
  it('writes bullet/ordered as a value_text property', async () => {
    await setListStyle('B1', 'ordered')
    expect(mockSetProperty).toHaveBeenCalledWith('B1', LIST_STYLE_KEY, {
      value_text: 'ordered',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })
    expect(mockDeleteProperty).not.toHaveBeenCalled()
  })

  it('clears the property when set to none (never stores a sentinel)', async () => {
    await setListStyle('B1', 'none')
    expect(mockDeleteProperty).toHaveBeenCalledWith('B1', LIST_STYLE_KEY)
    expect(mockSetProperty).not.toHaveBeenCalled()
  })
})

describe('clearListStyle', () => {
  it('deletes the listStyle property row', async () => {
    await clearListStyle('B2')
    expect(mockDeleteProperty).toHaveBeenCalledWith('B2', LIST_STYLE_KEY)
  })
})

describe('listStyleForBlockType (#4552 slice 2)', () => {
  it('maps the two list targets to their stored style', () => {
    expect(listStyleForBlockType('numbered-list')).toBe('ordered')
    expect(listStyleForBlockType('bullet-list')).toBe('bullet')
  })

  it('maps every other target to none (clears the property)', () => {
    expect(listStyleForBlockType('paragraph')).toBe('none')
    expect(listStyleForBlockType('h1')).toBe('none')
    expect(listStyleForBlockType('h6')).toBe('none')
    expect(listStyleForBlockType('quote')).toBe('none')
    expect(listStyleForBlockType('code')).toBe('none')
    expect(listStyleForBlockType('callout')).toBe('none')
  })
})

describe('LIST_STYLE_OPTIONS_JSON', () => {
  it('matches the seed-migration options JSON exactly', () => {
    expect(LIST_STYLE_OPTIONS_JSON).toBe('["bullet","ordered"]')
  })
})
