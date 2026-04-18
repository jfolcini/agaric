/**
 * Unit tests for the pure helpers extracted out of the page-blocks store
 * actions (`splitBlock` and `indent`). Each helper takes its inputs as
 * parameters and returns a result — no store access, no IO, no async — so
 * they are tested in isolation here without a Zustand instance or mocks.
 */

import { describe, expect, it } from 'vitest'
import { makeBlock } from '../../__tests__/fixtures'
import type { BlockLevelNode } from '../../editor/types'
import {
  computeIndentedBlocks,
  findPrevSiblingAt,
  isNonEmptyBlock,
  planSplit,
} from '../page-blocks'

describe('isNonEmptyBlock', () => {
  it('returns true for a non-paragraph block even without content', () => {
    const heading: BlockLevelNode = { type: 'heading', attrs: { level: 1 } }
    expect(isNonEmptyBlock(heading)).toBe(true)
  })

  it('returns true for a horizontal rule', () => {
    const hr: BlockLevelNode = { type: 'horizontalRule' }
    expect(isNonEmptyBlock(hr)).toBe(true)
  })

  it('returns false for a paragraph with undefined content', () => {
    const p: BlockLevelNode = { type: 'paragraph' }
    expect(isNonEmptyBlock(p)).toBe(false)
  })

  it('returns false for a paragraph with empty content array', () => {
    const p: BlockLevelNode = { type: 'paragraph', content: [] }
    expect(isNonEmptyBlock(p)).toBe(false)
  })

  it('returns true for a paragraph with at least one inline node', () => {
    const p: BlockLevelNode = {
      type: 'paragraph',
      content: [{ type: 'text', text: 'hello' }],
    }
    expect(isNonEmptyBlock(p)).toBe(true)
  })
})

describe('planSplit', () => {
  it('returns noop for the empty string', () => {
    expect(planSplit('')).toEqual({ kind: 'noop' })
  })

  it('returns noop for single-line content that round-trips to itself', () => {
    expect(planSplit('hello world')).toEqual({ kind: 'noop' })
  })

  it('returns edit-only when a single block round-trips to a different markdown', () => {
    // An unclosed `[` parses as a single paragraph, but the serializer
    // escapes the bracket → serialized form differs from the input.
    const plan = planSplit('[broken')
    expect(plan.kind).toBe('edit-only')
    if (plan.kind === 'edit-only') {
      expect(plan.content).toBe('\\[broken')
    }
  })

  it('treats a multi-line fenced code block as a single block (noop)', () => {
    const code = '```\nline 1\nline 2\n```'
    expect(planSplit(code)).toEqual({ kind: 'noop' })
  })

  it('returns split for two paragraphs separated by a newline', () => {
    const plan = planSplit('first\nsecond')
    expect(plan.kind).toBe('split')
    if (plan.kind === 'split') {
      expect(plan.first).toBe('first')
      expect(plan.rest).toHaveLength(1)
      expect(plan.rest[0]).toBe('second')
    }
  })

  it('splits three lines into first + two rest entries', () => {
    const plan = planSplit('one\ntwo\nthree')
    expect(plan.kind).toBe('split')
    if (plan.kind === 'split') {
      expect(plan.first).toBe('one')
      expect(plan.rest).toHaveLength(2)
      expect(plan.rest[0]).toBe('two')
      expect(plan.rest[1]).toBe('three')
    }
  })

  it('drops empty paragraphs when splitting around blank lines', () => {
    // "hello\n\nworld" parses as paragraph("hello"), empty paragraph, paragraph("world")
    // → the empty paragraph is filtered out by isNonEmptyBlock.
    const plan = planSplit('hello\n\nworld')
    expect(plan.kind).toBe('split')
    if (plan.kind === 'split') {
      expect(plan.first).toBe('hello')
      expect(plan.rest).toHaveLength(1)
      expect(plan.rest[0]).toBe('world')
    }
  })

  it('returns split with empty rest when a leading empty line is followed by content', () => {
    // "\ntext" parses as paragraph("") + paragraph("text"); after filtering
    // the empty paragraph, only one non-empty block remains — but the
    // blocks.length <= 1 branch examined the raw parse output (length 2), so
    // we fall through to the split branch with first='text' and rest=[].
    const plan = planSplit('\ntext')
    expect(plan.kind).toBe('split')
    if (plan.kind === 'split') {
      expect(plan.first).toBe('text')
      expect(plan.rest).toHaveLength(0)
    }
  })

  it('returns noop when parsing yields only empty paragraphs', () => {
    // "\n\n\n" parses to multiple empty paragraphs; after the filter, nonEmpty
    // is empty → noop.
    const plan = planSplit('\n\n\n')
    expect(plan.kind).toBe('noop')
  })

  it('splits a heading followed by a paragraph into two blocks', () => {
    const plan = planSplit('# Title\nParagraph')
    expect(plan.kind).toBe('split')
    if (plan.kind === 'split') {
      expect(plan.first).toBe('# Title')
      expect(plan.rest).toHaveLength(1)
      expect(plan.rest[0]).toBe('Paragraph')
    }
  })
})

describe('findPrevSiblingAt', () => {
  it('returns null for index 0', () => {
    const blocks = [makeBlock({ id: 'A', parent_id: null, depth: 0 })]
    expect(findPrevSiblingAt(blocks, 0)).toBeNull()
  })

  it('returns null for an out-of-range index', () => {
    const blocks = [makeBlock({ id: 'A', parent_id: null, depth: 0 })]
    expect(findPrevSiblingAt(blocks, 5)).toBeNull()
  })

  it('returns the immediate previous sibling at the same depth/parent', () => {
    const a = makeBlock({ id: 'A', parent_id: null, depth: 0 })
    const b = makeBlock({ id: 'B', parent_id: null, depth: 0 })
    const result = findPrevSiblingAt([a, b], 1)
    expect(result?.id).toBe('A')
  })

  it('skips over deeper-depth children of the previous sibling', () => {
    // A (depth 0), A1 (depth 1, child of A), A2 (depth 1, child of A), B (depth 0)
    const a = makeBlock({ id: 'A', parent_id: null, depth: 0 })
    const a1 = makeBlock({ id: 'A1', parent_id: 'A', depth: 1 })
    const a2 = makeBlock({ id: 'A2', parent_id: 'A', depth: 1 })
    const b = makeBlock({ id: 'B', parent_id: null, depth: 0 })
    const result = findPrevSiblingAt([a, a1, a2, b], 3)
    expect(result?.id).toBe('A')
  })

  it('returns null when the previous block is at a shallower depth', () => {
    // Parent (depth 0), Child (depth 1) — Child has no previous sibling.
    const parent = makeBlock({ id: 'P', parent_id: null, depth: 0 })
    const child = makeBlock({ id: 'C', parent_id: 'P', depth: 1 })
    expect(findPrevSiblingAt([parent, child], 1)).toBeNull()
  })

  it('returns null when the previous same-depth block has a different parent_id', () => {
    const p1Child = makeBlock({ id: 'X', parent_id: 'P1', depth: 1 })
    const p2Child = makeBlock({ id: 'Y', parent_id: 'P2', depth: 1 })
    // Walking back from Y (depth 1, parent P2): the only earlier block has the
    // same depth but parent P1 → no match → but the walk continues (same
    // depth, different parent) until depth < 1 is seen or the list ends.
    expect(findPrevSiblingAt([p1Child, p2Child], 1)).toBeNull()
  })

  it('treats null and undefined parent_id as equivalent', () => {
    const a = makeBlock({ id: 'A', parent_id: null, depth: 0 })
    // Construct a block that has parent_id set to null as well; both should
    // match under the `?? null` normalization.
    const b = makeBlock({ id: 'B', parent_id: null, depth: 0 })
    expect(findPrevSiblingAt([a, b], 1)?.id).toBe('A')
  })
})

describe('computeIndentedBlocks', () => {
  it('indents a top-level block under its previous sibling', () => {
    const a = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
    const b = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })

    const result = computeIndentedBlocks([a, b], 'B', a)

    expect(result).toHaveLength(2)
    const moved = result.find((x) => x.id === 'B')
    expect(moved?.parent_id).toBe('A')
    expect(moved?.position).toBe(1)
    expect(moved?.depth).toBe(1)
  })

  it('keeps the previous sibling unchanged', () => {
    const a = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
    const b = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })

    const result = computeIndentedBlocks([a, b], 'B', a)

    const prev = result.find((x) => x.id === 'A')
    expect(prev?.depth).toBe(0)
    expect(prev?.parent_id).toBeNull()
    expect(prev?.position).toBe(0)
  })

  it('places the indented subtree after the prevSibling existing children', () => {
    const a = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
    const a1 = makeBlock({ id: 'A1', position: 0, parent_id: 'A', depth: 1 })
    const a2 = makeBlock({ id: 'A2', position: 1, parent_id: 'A', depth: 1 })
    const b = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })

    const result = computeIndentedBlocks([a, a1, a2, b], 'B', a)

    expect(result).toHaveLength(4)
    const order = result.map((x) => x.id)
    expect(order).toEqual(['A', 'A1', 'A2', 'B'])
    const moved = result.find((x) => x.id === 'B')
    expect(moved?.parent_id).toBe('A')
    expect(moved?.depth).toBe(1)
  })

  it('increments depth for every descendant of the moved block', () => {
    const a = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
    const b = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
    const b1 = makeBlock({ id: 'B1', position: 0, parent_id: 'B', depth: 1 })
    const b2 = makeBlock({ id: 'B2', position: 1, parent_id: 'B', depth: 1 })

    const result = computeIndentedBlocks([a, b, b1, b2], 'B', a)

    expect(result).toHaveLength(4)
    expect(result.find((x) => x.id === 'B')?.depth).toBe(1)
    expect(result.find((x) => x.id === 'B1')?.depth).toBe(2)
    expect(result.find((x) => x.id === 'B2')?.depth).toBe(2)
  })

  it('preserves the descendants parent_id (they only change depth)', () => {
    const a = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
    const b = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
    const b1 = makeBlock({ id: 'B1', position: 0, parent_id: 'B', depth: 1 })

    const result = computeIndentedBlocks([a, b, b1], 'B', a)

    // B1's parent is still 'B' — only the root of the moved subtree is
    // re-parented; descendants keep their original parent_id.
    expect(result.find((x) => x.id === 'B1')?.parent_id).toBe('B')
  })

  it('does not mutate the input array', () => {
    const a = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
    const b = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
    const input = [a, b]

    const result = computeIndentedBlocks(input, 'B', a)

    // Original array is untouched
    expect(input).toHaveLength(2)
    expect(input[0]?.id).toBe('A')
    expect(input[1]?.id).toBe('B')
    expect(input[1]?.parent_id).toBeNull()
    expect(input[1]?.depth).toBe(0)
    // Result is a new array reference
    expect(result).not.toBe(input)
  })

  it('handles indenting a block that appears after the prevSibling subtree', () => {
    // A with existing children [A1, A2, A3], then B at root.
    const a = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
    const a1 = makeBlock({ id: 'A1', position: 0, parent_id: 'A', depth: 1 })
    const a2 = makeBlock({ id: 'A2', position: 1, parent_id: 'A', depth: 1 })
    const a3 = makeBlock({ id: 'A3', position: 2, parent_id: 'A', depth: 1 })
    const b = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })

    const result = computeIndentedBlocks([a, a1, a2, a3, b], 'B', a)

    expect(result.map((x) => x.id)).toEqual(['A', 'A1', 'A2', 'A3', 'B'])
    expect(result[4]?.parent_id).toBe('A')
    expect(result[4]?.depth).toBe(1)
  })
})
