import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import {
  buildCustomPropsMap,
  columnValue,
  deriveCustomColumns,
  propertyRowDisplay,
} from '@/lib/query-result-columns'
import type { PropertyRow } from '@/lib/tauri'

function row(overrides: Partial<PropertyRow> & { key: string }): PropertyRow {
  return {
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    ...overrides,
  }
}

describe('propertyRowDisplay', () => {
  it('prefers text, then num, date, ref, bool', () => {
    expect(propertyRowDisplay(row({ key: 'k', value_text: 'hi' }))).toBe('hi')
    expect(propertyRowDisplay(row({ key: 'k', value_num: 42 }))).toBe('42')
    expect(propertyRowDisplay(row({ key: 'k', value_date: '2025-06-01' }))).toBe('2025-06-01')
    expect(propertyRowDisplay(row({ key: 'k', value_ref: 'B9' }))).toBe('B9')
    expect(propertyRowDisplay(row({ key: 'k', value_bool: 1 }))).toBe('true')
    expect(propertyRowDisplay(row({ key: 'k', value_bool: 0 }))).toBe('false')
  })

  it('returns null when no value is set or text is empty', () => {
    expect(propertyRowDisplay(row({ key: 'k' }))).toBeNull()
    expect(propertyRowDisplay(row({ key: 'k', value_text: '' }))).toBeNull()
  })
})

describe('buildCustomPropsMap', () => {
  it('keeps custom properties and drops reserved/internal keys', () => {
    const map = buildCustomPropsMap({
      B1: [
        row({ key: 'area', value_text: 'frontend' }),
        row({ key: 'todo_state', value_text: 'TODO' }), // reserved → dropped
        row({ key: 'priority', value_text: '1' }), // reserved → dropped
        row({ key: 'space', value_ref: 'S1' }), // excluded → dropped
        row({ key: 'created_at', value_num: 1 }), // internal → dropped
      ],
    })
    expect(map.get('B1')).toEqual(new Map([['area', 'frontend']]))
  })

  it('omits blocks with no displayable custom properties', () => {
    const map = buildCustomPropsMap({
      B1: [row({ key: 'todo_state', value_text: 'TODO' })],
      B2: [row({ key: 'empty', value_text: '' })],
      B3: [],
    })
    expect(map.has('B1')).toBe(false)
    expect(map.has('B2')).toBe(false)
    expect(map.has('B3')).toBe(false)
  })
})

describe('deriveCustomColumns', () => {
  it('unions keys across blocks, sorted, prefixed', () => {
    const cols = deriveCustomColumns(
      [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2' })],
      new Map([
        ['B1', new Map([['status', 'open']])],
        ['B2', new Map([['area', 'fe']])],
      ]),
    )
    expect(cols).toEqual([
      { key: 'prop:area', label: 'area', propKey: 'area' },
      { key: 'prop:status', label: 'status', propKey: 'status' },
    ])
  })

  it('returns nothing when no custom properties present', () => {
    expect(deriveCustomColumns([makeBlock({ id: 'B1' })], new Map())).toEqual([])
  })
})

describe('columnValue', () => {
  const block = makeBlock({ id: 'B1', content: 'Hi', todo_state: 'TODO' })
  const customProps = new Map([['B1', new Map([['area', 'fe']])]])

  it('reads content, block fields, and custom props', () => {
    expect(columnValue(block, 'content', customProps)).toBe('Hi')
    expect(columnValue(block, 'todo_state', customProps)).toBe('TODO')
    expect(columnValue(block, 'prop:area', customProps)).toBe('fe')
  })

  it('returns null for a missing custom prop', () => {
    expect(columnValue(block, 'prop:missing', customProps)).toBeNull()
    expect(columnValue(makeBlock({ id: 'B2' }), 'prop:area', customProps)).toBeNull()
  })
})
