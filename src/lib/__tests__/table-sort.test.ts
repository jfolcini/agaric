/**
 * #6607: the order "Sort ascending / descending" gives a Markdown table's body rows,
 * from one column's cell texts. Numbers compare as numbers and ISO dates as dates when
 * every non-empty cell is one; anything else is locale-aware text. Empty cells go last in
 * both directions, and ties keep their order.
 */

import { describe, expect, it } from 'vitest'

import { sortedRowOrder } from '@/lib/table-sort'

const sorted = (cells: string[], direction: 'asc' | 'desc' = 'asc') =>
  sortedRowOrder(cells, direction).map((i) => cells[i])

describe('sortedRowOrder', () => {
  it('sorts text locale-aware, case and accents beside their letter', () => {
    expect(sorted(['pear', 'Apple', 'éclair', 'banana'])).toEqual([
      'Apple',
      'banana',
      'éclair',
      'pear',
    ])
    expect(sorted(['pear', 'Apple', 'éclair', 'banana'], 'desc')).toEqual([
      'pear',
      'éclair',
      'banana',
      'Apple',
    ])
  })

  it('sorts a column of numbers by value, not by text', () => {
    expect(sorted(['10', '9', '-2.5', '100', '0.5'])).toEqual(['-2.5', '0.5', '9', '10', '100'])
    expect(sorted(['10', '9', '100'], 'desc')).toEqual(['100', '10', '9'])
  })

  it('sorts a column of ISO dates by date', () => {
    expect(sorted(['2026-11-02', '2025-01-30', '2026-01-15T08:00', '2026-01-15'])).toEqual([
      '2025-01-30',
      '2026-01-15',
      '2026-01-15T08:00',
      '2026-11-02',
    ])
    expect(sorted(['2026-11-02', '2025-01-30'], 'desc')).toEqual(['2026-11-02', '2025-01-30'])
  })

  it('sorts a mixed column as text, digits by their value inside the text', () => {
    expect(sorted(['item 10', '2026-01-01', 'item 9', '7'])).toEqual([
      '7',
      '2026-01-01',
      'item 9',
      'item 10',
    ])
  })

  it('puts empty cells last in both directions', () => {
    expect(sorted(['3', '', '1', '  ', '2'])).toEqual(['1', '2', '3', '', '  '])
    expect(sorted(['3', '', '1', '  ', '2'], 'desc')).toEqual(['3', '2', '1', '', '  '])
    expect(sorted(['b', '', 'a'], 'desc')).toEqual(['b', 'a', ''])
  })

  it('keeps tied rows in their order, in both directions', () => {
    const cells = ['2', '1', '2', '1']
    expect(sortedRowOrder(cells, 'asc')).toEqual([1, 3, 0, 2])
    expect(sortedRowOrder(cells, 'desc')).toEqual([0, 2, 1, 3])
  })

  it('returns no rows for no rows', () => {
    expect(sortedRowOrder([], 'asc')).toEqual([])
  })
})
