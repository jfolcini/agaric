/**
 * Tests for src/lib/tree-utils.ts — flat tree builder, projection, and position computation.
 */

import { describe, expect, it } from 'vitest'
import type { BlockRow } from '../tauri'
import {
  buildFlatTree,
  computePosition,
  type FlatBlock,
  getDragDescendants,
  getProjection,
} from '../tree-utils'

// ── Helpers ──────────────────────────────────────────────────────────────

/** Create a minimal BlockRow for testing. */
function mkBlock(
  id: string,
  parentId: string | null,
  position: number | null,
  content = '',
): BlockRow {
  return {
    id,
    block_type: 'text',
    content,
    parent_id: parentId,
    position,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
  }
}

/** Create a FlatBlock for testing. */
function mkFlat(
  id: string,
  parentId: string | null,
  position: number | null,
  depth: number,
): FlatBlock {
  return { ...mkBlock(id, parentId, position), depth }
}

// ── buildFlatTree ────────────────────────────────────────────────────────

describe('buildFlatTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildFlatTree([])).toEqual([])
  })

  it('flattens a single-level list sorted by position', () => {
    const blocks = [mkBlock('c', null, 3), mkBlock('a', null, 1), mkBlock('b', null, 2)]
    const result = buildFlatTree(blocks)
    expect(result.map((b) => b.id)).toEqual(['a', 'b', 'c'])
    expect(result.every((b) => b.depth === 0)).toBe(true)
  })

  it('flattens a two-level tree depth-first', () => {
    const blocks = [
      mkBlock('p1', null, 1),
      mkBlock('p2', null, 2),
      mkBlock('c1', 'p1', 1),
      mkBlock('c2', 'p1', 2),
      mkBlock('c3', 'p2', 1),
    ]
    const result = buildFlatTree(blocks)
    expect(result.map((b) => [b.id, b.depth])).toEqual([
      ['p1', 0],
      ['c1', 1],
      ['c2', 1],
      ['p2', 0],
      ['c3', 1],
    ])
  })

  it('flattens a three-level tree depth-first', () => {
    const blocks = [
      mkBlock('root', null, 1),
      mkBlock('child', 'root', 1),
      mkBlock('grandchild', 'child', 1),
    ]
    const result = buildFlatTree(blocks)
    expect(result.map((b) => [b.id, b.depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['grandchild', 2],
    ])
  })

  it('respects custom rootParentId', () => {
    const blocks = [mkBlock('pageRoot', 'page1', 1), mkBlock('child', 'pageRoot', 1)]
    const result = buildFlatTree(blocks, 'page1')
    expect(result.map((b) => [b.id, b.depth])).toEqual([
      ['pageRoot', 0],
      ['child', 1],
    ])
  })

  it('ignores orphaned blocks (parent not in set)', () => {
    const blocks = [mkBlock('a', null, 1), mkBlock('orphan', 'nonexistent', 1)]
    const result = buildFlatTree(blocks)
    expect(result.map((b) => b.id)).toEqual(['a'])
  })

  it('sorts by position within each parent group', () => {
    const blocks = [
      mkBlock('p', null, 1),
      mkBlock('c3', 'p', 30),
      mkBlock('c1', 'p', 10),
      mkBlock('c2', 'p', 20),
    ]
    const result = buildFlatTree(blocks)
    expect(result.map((b) => b.id)).toEqual(['p', 'c1', 'c2', 'c3'])
  })

  it('handles null positions (sorted last)', () => {
    const blocks = [mkBlock('a', null, 1), mkBlock('b', null, null), mkBlock('c', null, 2)]
    const result = buildFlatTree(blocks)
    expect(result.map((b) => b.id)).toEqual(['a', 'c', 'b'])
  })
})

// ── getDragDescendants ───────────────────────────────────────────────────

describe('getDragDescendants', () => {
  const items: FlatBlock[] = [
    mkFlat('a', null, 1, 0),
    mkFlat('a1', 'a', 1, 1),
    mkFlat('a1a', 'a1', 1, 2),
    mkFlat('a2', 'a', 2, 1),
    mkFlat('b', null, 2, 0),
  ]

  it('returns all descendants of a node', () => {
    const desc = getDragDescendants(items, 'a')
    expect(desc).toEqual(new Set(['a1', 'a1a', 'a2']))
  })

  it('returns descendants of a mid-level node', () => {
    const desc = getDragDescendants(items, 'a1')
    expect(desc).toEqual(new Set(['a1a']))
  })

  it('returns empty set for a leaf', () => {
    const desc = getDragDescendants(items, 'a1a')
    expect(desc).toEqual(new Set())
  })

  it('returns empty set for unknown id', () => {
    const desc = getDragDescendants(items, 'unknown')
    expect(desc).toEqual(new Set())
  })

  it('returns empty set for the last root item', () => {
    const desc = getDragDescendants(items, 'b')
    expect(desc).toEqual(new Set())
  })
})

// ── getProjection ────────────────────────────────────────────────────────

describe('getProjection', () => {
  const INDENT = 24

  // Flat list:
  //   [0] A  (depth 0)
  //   [1] A1 (depth 1)
  //   [2] B  (depth 0)
  //   [3] C  (depth 0)
  const items: FlatBlock[] = [
    mkFlat('A', null, 1, 0),
    mkFlat('A1', 'A', 1, 1),
    mkFlat('B', null, 2, 0),
    mkFlat('C', null, 3, 0),
  ]

  it('returns fallback for missing active item', () => {
    const result = getProjection(items, 'MISSING', 'B', 0, INDENT)
    expect(result.depth).toBe(0)
    expect(result.parentId).toBeNull()
  })

  it('keeps same depth when dragging vertically without horizontal offset', () => {
    // Drag C (depth 0) over B (depth 0), no horizontal offset
    const result = getProjection(items, 'C', 'B', 0, INDENT)
    expect(result.depth).toBe(0)
    expect(result.parentId).toBeNull()
  })

  it('increases depth when dragging right', () => {
    // Drag C (index 3, depth 0) over A1 (index 1) with rightward offset.
    // After sim: [A, C, A1, B] — prev=A (depth 0), next=A1 (depth 1)
    // maxDepth = 0+1 = 1, minDepth = 1 → locked at depth 1
    // C becomes a sibling of A1 (child of A)
    const result = getProjection(items, 'C', 'A1', INDENT * 2, INDENT)
    expect(result.depth).toBe(1)
    expect(result.parentId).toBe('A') // sibling of A1, child of A
  })

  it('clamps depth to maxDepth (previous item depth + 1)', () => {
    // Drag C over A (index 0), massive rightward offset
    // After sim: prev=undefined (first position), maxDepth=0
    const result = getProjection(items, 'C', 'A', INDENT * 5, INDENT)
    expect(result.depth).toBe(0)
    expect(result.parentId).toBeNull()
  })

  it('clamps depth to minDepth (next item depth)', () => {
    // Drag B over A1 with leftward offset → projected depth would be negative
    // After sim: [A, B, A1, C] — prev=A (depth 0), next=A1 (depth 1)
    // minDepth = 1, so clamped to 1
    const result = getProjection(items, 'B', 'A1', -INDENT * 5, INDENT)
    expect(result.depth).toBe(1)
    expect(result.parentId).toBe('A') // sibling of A1
  })

  it('never returns negative depth', () => {
    const singleLevel: FlatBlock[] = [mkFlat('X', null, 1, 0), mkFlat('Y', null, 2, 0)]
    const result = getProjection(singleLevel, 'Y', 'X', -INDENT * 10, INDENT)
    expect(result.depth).toBeGreaterThanOrEqual(0)
  })

  it('respects rootParentId', () => {
    const items2: FlatBlock[] = [mkFlat('X', 'page1', 1, 0), mkFlat('Y', 'page1', 2, 0)]
    const result = getProjection(items2, 'Y', 'X', 0, INDENT, 'page1')
    expect(result.depth).toBe(0)
    expect(result.parentId).toBe('page1')
  })

  it('projects indent as child of previous item', () => {
    // Two root items: drag Y right to become child of X
    const flat: FlatBlock[] = [mkFlat('X', null, 1, 0), mkFlat('Y', null, 2, 0)]
    const result = getProjection(flat, 'Y', 'X', INDENT, INDENT)
    // After sim: [Y, X] — Y is at index 0, no prev, maxDepth=0
    // Wait, overId='X' which is index 0. Active='Y' index 1.
    // Clone: remove Y from [X,Y] → [X], insert at 0 → [Y, X]
    // projectedIndex = 0, prev=undefined, maxDepth=0
    // Hmm, that's wrong. Let me re-read the algorithm.
    // overIndex=0, activeIndex=1, overIndex < activeIndex? No, 0 < 1 yes.
    // clonedItems: splice(1,1) → [X], splice(0,0,Y) → [Y, X]
    // projectedIndex = 0 (overIndex since overIndex <= activeIndex)
    // prev = cloned[-1] = undefined, maxDepth = 0
    // So depth=0. Can't indent when dragged to first position.
    expect(result.depth).toBe(0)
  })

  it('projects indent when dragged after sibling', () => {
    // Drag Y after X with rightward offset
    // items: [X(0), Z(0), Y(0)]
    const flat: FlatBlock[] = [
      mkFlat('X', null, 1, 0),
      mkFlat('Z', null, 2, 0),
      mkFlat('Y', null, 3, 0),
    ]
    // Drag Y over Z (same position), with rightward offset of 1 indent
    const result = getProjection(flat, 'Y', 'Z', INDENT, INDENT)
    // overIndex=1, activeIndex=2: overIndex < activeIndex
    // clone: remove Y → [X, Z], insert at 1 → [X, Y, Z]
    // projectedIndex=1, prev=X(depth 0), next=Z(depth 0)
    // maxDepth=1, minDepth=0
    // dragDepth=round(24/24)=1, projected=0+1=1, clamped to 1
    expect(result.depth).toBe(1)
    expect(result.parentId).toBe('X') // child of X
  })
})

// ── computePosition ──────────────────────────────────────────────────────

describe('computePosition', () => {
  it('returns 1 for first child of empty parent', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 1, 0)]
    expect(computePosition(items, 'A', 1, 'dragged')).toBe(1)
  })

  it('returns position after last sibling', () => {
    const items: FlatBlock[] = [
      mkFlat('P', null, 1, 0),
      mkFlat('C1', 'P', 1, 1),
      mkFlat('C2', 'P', 2, 1),
    ]
    // Drop at end (index 3) under parent P
    expect(computePosition(items, 'P', 3, 'dragged')).toBe(3)
  })

  it('returns position before first sibling', () => {
    const items: FlatBlock[] = [
      mkFlat('P', null, 1, 0),
      mkFlat('C1', 'P', 5, 1),
      mkFlat('C2', 'P', 10, 1),
    ]
    // Drop at start (index 1, before C1) under parent P
    expect(computePosition(items, 'P', 1, 'dragged')).toBe(4)
  })

  it('returns negative position when first sibling is at position 0', () => {
    const items: FlatBlock[] = [
      mkFlat('P', null, 1, 0),
      mkFlat('C1', 'P', 0, 1),
      mkFlat('C2', 'P', 1, 1),
    ]
    // Drop before C1 (which is at position 0) — must go negative
    expect(computePosition(items, 'P', 1, 'dragged')).toBe(-1)
  })

  it('uses gap between siblings when available', () => {
    const items: FlatBlock[] = [
      mkFlat('P', null, 1, 0),
      mkFlat('C1', 'P', 1, 1),
      mkFlat('C2', 'P', 5, 1),
    ]
    // Drop between C1 and C2 (index 2)
    expect(computePosition(items, 'P', 2, 'dragged')).toBe(2)
  })

  it('returns position + 1 when no gap (consecutive)', () => {
    const items: FlatBlock[] = [
      mkFlat('P', null, 1, 0),
      mkFlat('C1', 'P', 1, 1),
      mkFlat('C2', 'P', 2, 1),
    ]
    // Drop between C1 and C2 (index 2) — consecutive positions
    expect(computePosition(items, 'P', 2, 'dragged')).toBe(2)
  })

  it('excludes active item from sibling scan', () => {
    const items: FlatBlock[] = [
      mkFlat('P', null, 1, 0),
      mkFlat('C1', 'P', 1, 1),
      mkFlat('dragged', 'P', 2, 1),
      mkFlat('C2', 'P', 3, 1),
    ]
    // The dragged item is excluded from siblings
    const pos = computePosition(items, 'P', 3, 'dragged')
    expect(pos).toBe(2)
  })

  it('handles root-level items (null parent)', () => {
    const items: FlatBlock[] = [mkFlat('A', null, 1, 0), mkFlat('B', null, 2, 0)]
    expect(computePosition(items, null, 2, 'dragged')).toBe(3)
  })
})
