/**
 * Tests for `list-ordinals` (#3000) — computed ordered-list numbering.
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { computeListOrdinals } from '@/lib/list-ordinals'
import type { ListStyle } from '@/lib/list-style'
import type { FlatBlock } from '@/lib/tree-utils'

/** Build a visible list from `[id, depth, style]` triples (DFS order). */
function tree(rows: [id: string, depth: number, style: ListStyle][]): {
  items: FlatBlock[]
  styleOf: (id: string) => ListStyle
} {
  const styles = new Map(rows.map(([id, , style]) => [id, style]))
  const items = rows.map(([id, depth]) => makeBlock({ id, depth }))
  return { items, styleOf: (id) => styles.get(id) ?? 'none' }
}

describe('computeListOrdinals', () => {
  it('numbers a consecutive run of ordered siblings 1..n', () => {
    const { items, styleOf } = tree([
      ['A', 0, 'ordered'],
      ['B', 0, 'ordered'],
      ['C', 0, 'ordered'],
    ])
    expect(computeListOrdinals(items, styleOf)).toEqual(
      new Map([
        ['A', 1],
        ['B', 2],
        ['C', 3],
      ]),
    )
  })

  it('omits bullet and none blocks from the map', () => {
    const { items, styleOf } = tree([
      ['A', 0, 'ordered'],
      ['B', 0, 'bullet'],
      ['C', 0, 'none'],
    ])
    const map = computeListOrdinals(items, styleOf)
    expect(map.get('A')).toBe(1)
    expect(map.has('B')).toBe(false)
    expect(map.has('C')).toBe(false)
  })

  it('resets numbering when a non-ordered sibling breaks the run', () => {
    const { items, styleOf } = tree([
      ['A', 0, 'ordered'],
      ['B', 0, 'ordered'],
      ['X', 0, 'bullet'],
      ['C', 0, 'ordered'],
      ['D', 0, 'ordered'],
    ])
    const map = computeListOrdinals(items, styleOf)
    expect([map.get('A'), map.get('B'), map.get('C'), map.get('D')]).toEqual([1, 2, 1, 2])
  })

  it('numbers each depth as its own sibling group, and a child does not break the parent run', () => {
    // A and B are ordered siblings at depth 0; A has an ordered child A1.
    // A1 sits between A and B in DFS order but must NOT reset B's numbering —
    // B is A's sibling, so the run is A=1, B=2, while A1=1 in its own group.
    const { items, styleOf } = tree([
      ['A', 0, 'ordered'],
      ['A1', 1, 'ordered'],
      ['B', 0, 'ordered'],
    ])
    const map = computeListOrdinals(items, styleOf)
    expect(map.get('A')).toBe(1)
    expect(map.get('A1')).toBe(1)
    expect(map.get('B')).toBe(2)
  })

  it('separate ordered groups under different parents each start at 1', () => {
    const { items, styleOf } = tree([
      ['P1', 0, 'none'],
      ['P1a', 1, 'ordered'],
      ['P1b', 1, 'ordered'],
      ['P2', 0, 'none'],
      ['P2a', 1, 'ordered'],
    ])
    const map = computeListOrdinals(items, styleOf)
    expect([map.get('P1a'), map.get('P1b'), map.get('P2a')]).toEqual([1, 2, 1])
  })

  it('recomputes after a reorder (numbers follow position, nothing stored)', () => {
    // Same three ordered blocks, now in the order C, A, B — the ordinal
    // follows position, so nothing is carried over from a prior arrangement.
    const { items, styleOf } = tree([
      ['C', 0, 'ordered'],
      ['A', 0, 'ordered'],
      ['B', 0, 'ordered'],
    ])
    const map = computeListOrdinals(items, styleOf)
    expect([map.get('C'), map.get('A'), map.get('B')]).toEqual([1, 2, 3])
  })

  it('handles an empty list', () => {
    expect(computeListOrdinals([], () => 'none')).toEqual(new Map())
  })
})
