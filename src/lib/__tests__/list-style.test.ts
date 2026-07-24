/**
 * Tests for `list-style` (#3000) — list-ness as a block-property helper.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tauri/properties', () => ({
  setProperty: vi.fn().mockResolvedValue(undefined),
  deleteProperty: vi.fn().mockResolvedValue(undefined),
}))

import {
  asListStyle,
  clearListStyle,
  LIST_STYLE_KEY,
  LIST_STYLE_OPTIONS_JSON,
  listStyleFromRows,
  setListStyle,
} from '@/lib/list-style'
import { deleteProperty, setProperty } from '@/lib/tauri/properties'
import type { PropertyRow } from '@/lib/tauri/properties'

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
    expect(setProperty).toHaveBeenCalledWith({
      blockId: 'B1',
      key: LIST_STYLE_KEY,
      valueText: 'ordered',
    })
    expect(deleteProperty).not.toHaveBeenCalled()
  })

  it('clears the property when set to none (never stores a sentinel)', async () => {
    await setListStyle('B1', 'none')
    expect(deleteProperty).toHaveBeenCalledWith('B1', LIST_STYLE_KEY)
    expect(setProperty).not.toHaveBeenCalled()
  })
})

describe('clearListStyle', () => {
  it('deletes the listStyle property row', async () => {
    await clearListStyle('B2')
    expect(deleteProperty).toHaveBeenCalledWith('B2', LIST_STYLE_KEY)
  })
})

describe('LIST_STYLE_OPTIONS_JSON', () => {
  it('matches the seed-migration options JSON exactly', () => {
    expect(LIST_STYLE_OPTIONS_JSON).toBe('["bullet","ordered"]')
  })
})
