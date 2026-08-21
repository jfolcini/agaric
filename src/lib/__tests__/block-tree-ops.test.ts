/**
 * Unit tests for the pure helpers extracted out of the page-blocks store
 * actions (`splitBlock` and `indent`). Each helper takes its inputs as
 * parameters and returns a result — no store access, no IO, no async — so
 * they are tested in isolation here without a Zustand instance or mocks.
 */

import { describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { parse } from '@/editor/markdown-serializer'
import type { BlockLevelNode } from '@/editor/types'
import {
  computeIndentedBlocks,
  findPrevSiblingAt,
  isNonEmptyBlock,
  planSplit,
} from '@/lib/block-tree-ops'
import { logger } from '@/lib/logger'
import type { FlatBlock } from '@/lib/tree-utils'

// Wraps the real `parse` in a spy (delegating by default) so ONE test below
// can force a content-less `{ type: 'doc' }` return — #3274 fixed the only
// real-input paths that used to produce that shape (a lone table-separator
// line, and the already-dead ordered/bullet-list empty-items guards), so it
// is no longer reachable through any markdown string `planSplit` could be
// given. The `?? []` fallback in `planSplit` is still type-required (`parse`
// still types `content` as optional) and worth keeping defensive, so the spy
// stands in for the input that can no longer produce it for real.
vi.mock('@/editor/markdown-serializer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/editor/markdown-serializer')>()
  return { ...actual, parse: vi.fn(actual.parse) }
})

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

  it('returns edit-only for a lone table-separator line (#3274: no longer parses to zero blocks)', () => {
    // "|---|" matches the table producer's `line.startsWith('|')` guard.
    // Before #3274, a lone separator-shaped row was dropped by
    // buildTableRows regardless of position, so the parse yielded zero
    // blocks. The delimiter row is now recognized POSITIONALLY (only the row
    // immediately after a header can be one) — with no row above it, "|---|"
    // is the header itself, so `blocks.length === 1` and `planSplit` edits
    // the block in place with the reparsed table's canonical markdown.
    const plan = planSplit('|---|')
    expect(plan).toEqual({ kind: 'edit-only', content: '| \\--- |\n| --- |' })
  })

  // EQUIVALENCE (#3750) — `serializeSingleBlock`'s `{ type: 'doc', content: [b]
  // }` wrapper's `type` field (Stryker StringLiteral mutant: `'doc'` -> `''`).
  // `serialize` (src/editor/markdown-serialize.ts) is two lines: `if
  // (!doc.content || doc.content.length === 0) return ''` then
  // `serializeBlockSequence(doc.content, onUnknownNode).join('\n')` — it never
  // reads `doc.type` anywhere in its own body or in anything it calls
  // (`serializeBlockSequence`/`serializeBlockNode` switch on each CHILD node's
  // own `.type` inside `doc.content`, never on the wrapper's). `type: 'doc'` is
  // a TypeScript-only literal (`DocNode.type: 'doc'`) with zero runtime
  // consumers, so no input can make this mutant produce different output — not
  // "the suite stayed green," but that the field is structurally unread by the
  // only function it is ever passed to. Killing it would require pinning
  // behavior against a field the callee provably never inspects. The test
  // below is the closest this file comes to exercising `serializeSingleBlock`
  // directly: it pins the case where `serializeSingleBlock` must NOT be
  // called at all.
  it('does not synthesize a phantom block when parse() yields no content array', () => {
    // #3274 fixed the only real-input path that used to make `parse()`
    // return `{ type: 'doc' }` with `content` genuinely `undefined` (a lone
    // table-separator line) — the ordered/bullet-list `items.length === 0`
    // guards were already unreachable (the outer regex that gates entry into
    // each production always matches on the FIRST collected item too). No
    // markdown string can drive `planSplit`'s `doc.content ?? []` fallback on
    // line 52 through its `undefined` branch anymore, so this test stubs
    // `parse()` directly to keep that defensive fallback demonstrably covered
    // (the `content` field is still typed optional) rather than asserting
    // an inert precondition.
    //
    // If the `?? []` fallback fell back to a non-empty placeholder array
    // instead, `blocks.length === 1` would go true and route the
    // placeholder's first entry into `serializeSingleBlock` as though it
    // were a real block, which — not being a well-formed BlockLevelNode —
    // would hit the serializer's "unknown node type" path and log a warning
    // (and raise a toast via `notifyUnknownNodeTypeToast`). The correct code
    // never calls `serializeSingleBlock` at all for zero blocks, so `warn`
    // stays uncalled; that is the observable difference this test pins.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.mocked(parse).mockReturnValueOnce({ type: 'doc' })
    try {
      const plan = planSplit('irrelevant — parse() is stubbed for this test')
      expect(plan).toEqual({ kind: 'edit-only', content: '' })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      // Restore in `finally`: a failing assertion above would otherwise leave
      // `logger.warn` stubbed for every later test in this file.
      warn.mockRestore()
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

  it('skips a hole/undefined entry in the blocks slice instead of dereferencing it', () => {
    // Index 1 is genuinely absent (not a real FlatBlock) — the `if
    // (!candidate) continue` guard must skip it rather than read `.depth`
    // off `undefined`, which would throw.
    const a = makeBlock({ id: 'A', parent_id: null, depth: 0 })
    const c = makeBlock({ id: 'C', parent_id: null, depth: 0 })
    const blocks = [a, undefined, c] as unknown as FlatBlock[]
    expect(findPrevSiblingAt(blocks, 2)?.id).toBe('A')
  })

  it('stops at a shallower block even when an earlier same-depth block would coincidentally match parent_id', () => {
    // X (depth 1, parent 'P') precedes Y (depth 0 — a real ancestor
    // boundary), which precedes C (depth 1, parent 'P') — same depth/parent
    // as X purely by coincidence. The walk must return null as soon as the
    // shallower Y is seen; X must never be considered.
    const x = makeBlock({ id: 'X', parent_id: 'P', depth: 1 })
    const y = makeBlock({ id: 'Y', parent_id: null, depth: 0 })
    const c = makeBlock({ id: 'C', parent_id: 'P', depth: 1 })
    expect(findPrevSiblingAt([x, y, c], 2)).toBeNull()
  })

  it('does not match a candidate at a different depth even when parent_id happens to coincide', () => {
    // D is one level deeper than C but shares C's parent_id by coincidence —
    // the depth-equality half of the match condition must still reject it.
    const d = makeBlock({ id: 'D', parent_id: null, depth: 1 })
    const c = makeBlock({ id: 'C', parent_id: null, depth: 0 })
    expect(findPrevSiblingAt([d, c], 1)).toBeNull()
  })

  it('does not match when only the candidate has a non-null parent_id', () => {
    const candidate = makeBlock({ id: 'X', parent_id: 'OTHER', depth: 0 })
    const block = makeBlock({ id: 'C', parent_id: null, depth: 0 })
    expect(findPrevSiblingAt([candidate, block], 1)).toBeNull()
  })

  it('does not match when only the block has a non-null parent_id', () => {
    const candidate = makeBlock({ id: 'X', parent_id: null, depth: 0 })
    const block = makeBlock({ id: 'C', parent_id: 'OTHER', depth: 0 })
    expect(findPrevSiblingAt([candidate, block], 1)).toBeNull()
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

  // #2200 — the prevSibling-descendants skip-loop and the insertion anchor now
  // share one id→index map over `remaining` instead of scanning it twice for
  // the same id (#2041/#2200, mirrors the dedent/moveDown conversion).
  // Untouched entries must keep their exact object reference either way.
  it('#2200 — preserves untouched entries by reference, not just by value', () => {
    const a = makeBlock({ id: 'A', position: 0, parent_id: null, depth: 0 })
    const a1 = makeBlock({ id: 'A1', position: 0, parent_id: 'A', depth: 1 })
    const a2 = makeBlock({ id: 'A2', position: 1, parent_id: 'A', depth: 1 })
    const b = makeBlock({ id: 'B', position: 1, parent_id: null, depth: 0 })
    const c = makeBlock({ id: 'C', position: 2, parent_id: null, depth: 0 })

    const result = computeIndentedBlocks([a, a1, a2, b, c], 'B', a)

    expect(result.map((x) => x.id)).toEqual(['A', 'A1', 'A2', 'B', 'C'])
    expect(result[0]).toBe(a)
    expect(result[1]).toBe(a1)
    expect(result[2]).toBe(a2)
    expect(result[4]).toBe(c)
    // The moved block gets a new object (re-parented/re-depthed).
    expect(result[3]).not.toBe(b)
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

  it('inserts after prevSibling even when prevSibling is not at index 0 of the remaining array', () => {
    // Z precedes prevSibling A in `remaining` (index 1, not 0) — insertAt
    // must be derived from A's real index (1) plus one, not fall back to the
    // `?? -1` default, which a falsy-coercing bug would trigger even for a
    // legitimate nonzero index.
    const z = makeBlock({ id: 'Z', position: 0, parent_id: null, depth: 0 })
    const a = makeBlock({ id: 'A', position: 1, parent_id: null, depth: 0 })
    const b = makeBlock({ id: 'B', position: 2, parent_id: null, depth: 0 })

    const result = computeIndentedBlocks([z, a, b], 'B', a)

    expect(result.map((x) => x.id)).toEqual(['Z', 'A', 'B'])
    expect(result[2]?.parent_id).toBe('A')
    expect(result[2]?.depth).toBe(1)
  })

  // #3750 (NoCoverage) — `insertAt`'s `?? -1` fallback only fires when
  // `remainingIndex.get(prevSibling.id)` is `undefined`, i.e. `prevSibling`
  // is NOT among `blocks` at all. The docstring says "callers are
  // responsible for validating that `prevSibling` is a legal indent target",
  // so no in-contract caller reaches this — but the code degrades to a
  // defensive `-1` (insert at the front) instead of throwing, and no
  // existing test drove that default, leaving the mutant `?? -1` -> `?? +1`
  // (insert two slots in, effectively past the end for a short array)
  // unobserved. A stale/ghost `prevSibling` reference (e.g. a captured
  // sibling that a concurrent write already removed) exercises exactly that
  // default without asserting anything about the removed block itself.
  it('inserts at the front, not past the end, when prevSibling is a ghost reference absent from blocks', () => {
    const x = makeBlock({ id: 'X', position: 0, parent_id: null, depth: 0 })
    const y = makeBlock({ id: 'Y', position: 1, parent_id: null, depth: 0 })
    const ghost = makeBlock({ id: 'GHOST', position: 0, parent_id: null, depth: 0 })

    const result = computeIndentedBlocks([x, y], 'X', ghost)

    // `-1 + 1 = 0`: X (re-parented under the ghost id) lands FIRST. The `+1`
    // mutant computes `1 + 1 = 2`, which `Array.splice` clamps to the end of
    // the one-element `remaining` array ([Y]), landing X LAST instead —
    // ['Y', 'X'].
    expect(result.map((b) => b.id)).toEqual(['X', 'Y'])
    expect(result[0]?.parent_id).toBe('GHOST')
  })
})
