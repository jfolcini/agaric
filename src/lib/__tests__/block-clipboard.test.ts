/**
 * Tests for the block-subtree ⇄ indented-markdown serializer/parser (#913).
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '../../__tests__/fixtures'
import { INDENT_UNIT, parseIndentedMarkdown, serializeBlockSubtree } from '../block-clipboard'
import type { FlatBlock } from '../tree-utils'

/** Build a flat tree from `[id, depth, parentId, content]` rows. */
function tree(rows: Array<[string, number, string | null, string]>): FlatBlock[] {
  return rows.map(([id, depth, parent_id, content]) => makeBlock({ id, depth, parent_id, content }))
}

describe('serializeBlockSubtree', () => {
  it('returns empty string when nothing is selected', () => {
    const items = tree([['A', 0, null, 'a']])
    expect(serializeBlockSubtree(items, [])).toBe('')
  })

  it('serializes a single selected leaf as one line', () => {
    const items = tree([['A', 0, null, 'hello']])
    expect(serializeBlockSubtree(items, ['A'])).toBe('hello')
  })

  it('serializes a flat list of selected roots at indent 0', () => {
    const items = tree([
      ['A', 0, null, 'a'],
      ['B', 0, null, 'b'],
      ['C', 0, null, 'c'],
    ])
    expect(serializeBlockSubtree(items, ['A', 'B', 'C'])).toBe('a\nb\nc')
  })

  it('indents children under their parent (2 spaces per level)', () => {
    const items = tree([
      ['A', 0, null, 'parent'],
      ['B', 1, 'A', 'child'],
      ['C', 2, 'B', 'grandchild'],
    ])
    // Selecting only the root pulls the whole subtree along.
    expect(serializeBlockSubtree(items, ['A'])).toBe('parent\n  child\n    grandchild')
  })

  it('collapses a selected descendant into its selected ancestor (no double-emit)', () => {
    const items = tree([
      ['A', 0, null, 'parent'],
      ['B', 1, 'A', 'child'],
    ])
    // Both selected, but B is inside A — emit the subtree once.
    expect(serializeBlockSubtree(items, ['A', 'B'])).toBe('parent\n  child')
  })

  it('serializes mixed-depth sibling subtrees in document order', () => {
    const items = tree([
      ['A', 0, null, 'a'],
      ['A1', 1, 'A', 'a1'],
      ['B', 0, null, 'b'],
      ['B1', 1, 'B', 'b1'],
      ['B2', 2, 'B1', 'b2'],
    ])
    expect(serializeBlockSubtree(items, ['A', 'B'])).toBe('a\n  a1\nb\n  b1\n    b2')
  })

  it('normalizes a deeply-nested selection so the shallowest root sits at indent 0', () => {
    const items = tree([
      ['ROOT', 0, null, 'root'],
      ['MID', 1, 'ROOT', 'mid'],
      ['LEAF', 2, 'MID', 'leaf'],
    ])
    // Selecting MID copies MID (rebased to 0) + LEAF (one level under it).
    expect(serializeBlockSubtree(items, ['MID'])).toBe('mid\n  leaf')
  })

  it('emits an empty line for an empty-content block', () => {
    const items = tree([
      ['A', 0, null, ''],
      ['B', 1, 'A', 'child'],
    ])
    expect(serializeBlockSubtree(items, ['A'])).toBe('\n  child')
  })
})

describe('parseIndentedMarkdown', () => {
  it('returns [] for empty / whitespace-only input', () => {
    expect(parseIndentedMarkdown('')).toEqual([])
    expect(parseIndentedMarkdown('   \n\n  ')).toEqual([])
  })

  it('parses a single line as one top-level block', () => {
    expect(parseIndentedMarkdown('hello')).toEqual([{ content: 'hello', parentIndex: null }])
  })

  it('parses a flat list as top-level siblings', () => {
    expect(parseIndentedMarkdown('a\nb\nc')).toEqual([
      { content: 'a', parentIndex: null },
      { content: 'b', parentIndex: null },
      { content: 'c', parentIndex: null },
    ])
  })

  it('parses nested indentation into parent pointers', () => {
    const parsed = parseIndentedMarkdown('parent\n  child\n    grandchild')
    expect(parsed).toEqual([
      { content: 'parent', parentIndex: null },
      { content: 'child', parentIndex: 0 },
      { content: 'grandchild', parentIndex: 1 },
    ])
  })

  it('parses mixed depths with multiple subtrees', () => {
    const parsed = parseIndentedMarkdown('a\n  a1\nb\n  b1\n    b2')
    expect(parsed).toEqual([
      { content: 'a', parentIndex: null },
      { content: 'a1', parentIndex: 0 },
      { content: 'b', parentIndex: null },
      { content: 'b1', parentIndex: 2 },
      { content: 'b2', parentIndex: 3 },
    ])
  })

  it('skips blank interior lines', () => {
    const parsed = parseIndentedMarkdown('a\n\n  b\n\nc')
    expect(parsed).toEqual([
      { content: 'a', parentIndex: null },
      { content: 'b', parentIndex: 0 },
      { content: 'c', parentIndex: null },
    ])
  })

  it('clamps an over-indented jump to one level deeper (no orphan)', () => {
    // 'deep' is indented 4 levels under a top-level block — clamp to 1.
    const parsed = parseIndentedMarkdown(`top\n${' '.repeat(INDENT_UNIT * 4)}deep`)
    expect(parsed).toEqual([
      { content: 'top', parentIndex: null },
      { content: 'deep', parentIndex: 0 },
    ])
  })

  it('treats a tab as one indent unit', () => {
    const parsed = parseIndentedMarkdown('parent\n\tchild')
    expect(parsed).toEqual([
      { content: 'parent', parentIndex: null },
      { content: 'child', parentIndex: 0 },
    ])
  })
})

describe('round-trip serialize ⇄ parse', () => {
  it('flat list round-trips', () => {
    const items = tree([
      ['A', 0, null, 'a'],
      ['B', 0, null, 'b'],
    ])
    const md = serializeBlockSubtree(items, ['A', 'B'])
    expect(parseIndentedMarkdown(md)).toEqual([
      { content: 'a', parentIndex: null },
      { content: 'b', parentIndex: null },
    ])
  })

  it('nested subtree round-trips structure', () => {
    const items = tree([
      ['A', 0, null, 'parent'],
      ['B', 1, 'A', 'child'],
      ['C', 2, 'B', 'grandchild'],
    ])
    const md = serializeBlockSubtree(items, ['A'])
    expect(parseIndentedMarkdown(md)).toEqual([
      { content: 'parent', parentIndex: null },
      { content: 'child', parentIndex: 0 },
      { content: 'grandchild', parentIndex: 1 },
    ])
  })

  it('mixed-depth multi-subtree round-trips', () => {
    const items = tree([
      ['A', 0, null, 'a'],
      ['A1', 1, 'A', 'a1'],
      ['B', 0, null, 'b'],
      ['B1', 1, 'B', 'b1'],
    ])
    const md = serializeBlockSubtree(items, ['A', 'B'])
    expect(parseIndentedMarkdown(md)).toEqual([
      { content: 'a', parentIndex: null },
      { content: 'a1', parentIndex: 0 },
      { content: 'b', parentIndex: null },
      { content: 'b1', parentIndex: 2 },
    ])
  })
})
