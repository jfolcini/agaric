/**
 * Drag-and-drop DROP PIPELINE integration tests.
 *
 * `tree-utils.test.ts` covers `getProjection` / `computeDropIndex` in isolation.
 * This file wires them together exactly the way `useBlockDnD.handleDragEnd`
 * does, then applies the SAME semantics the new backend (`move_block`) uses,
 * so the tests assert the property a user actually cares about: *after I drop a
 * block, is it where I dropped it?*
 *
 * Backend ground truth (#400 — index-based move on Loro's fractional index):
 *   - `move_block(blockId, parentId, newIndex)` inserts the block at the
 *     0-based `newIndex` slot among the target parent's OTHER children, then
 *     materializes dense 1-based `position` for every sibling group it touched
 *     (old + new parent). No collisions, no gaps, never rejected.
 *   - `list` orders siblings by `position ASC, id ASC`; because positions are
 *     now dense + collision-free, order matches drop intent (not ULID).
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '../../__tests__/fixtures'
import { computeDropIndex, type FlatBlock, getProjection, SENTINEL_ID } from '../tree-utils'

const INDENT = 24

// ── Faithful backend model (#400) ─────────────────────────────────────────

/**
 * Apply `move_block` as the new Rust backend does: set the block's parent,
 * insert it at the 0-based `newIndex` slot among the target parent's OTHER
 * children, then assign dense 1-based positions to BOTH the old and new
 * sibling groups. Never rejects.
 */
function backendMove(
  rows: FlatBlock[],
  blockId: string,
  parentId: string | null,
  newIndex: number,
): FlatBlock[] {
  const moved = rows.find((b) => b.id === blockId)
  if (!moved) return rows
  const oldParentId = moved.parent_id ?? null

  // Order the target parent's other children by current (position, id).
  const others = rows
    .filter((b) => b.id !== blockId && (b.parent_id ?? null) === parentId)
    .sort((a, b) => {
      const pa = a.position ?? Number.MAX_SAFE_INTEGER
      const pb = b.position ?? Number.MAX_SAFE_INTEGER
      if (pa !== pb) return pa - pb
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  const slot = Math.max(0, Math.min(newIndex, others.length))
  const ordered = [...others]
  ordered.splice(slot, 0, { ...moved, parent_id: parentId })

  // Dense 1-based ranks for the new sibling group.
  const newPos = new Map<string, number>()
  ordered.forEach((b, i) => newPos.set(b.id, i + 1))

  // Dense 1-based ranks for the old sibling group (block removed) when the
  // parent changed.
  const oldPos = new Map<string, number>()
  if (oldParentId !== parentId) {
    rows
      .filter((b) => b.id !== blockId && (b.parent_id ?? null) === oldParentId)
      .sort((a, b) => {
        const pa = a.position ?? Number.MAX_SAFE_INTEGER
        const pb = b.position ?? Number.MAX_SAFE_INTEGER
        if (pa !== pb) return pa - pb
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      .forEach((b, i) => oldPos.set(b.id, i + 1))
  }

  return rows.map((b) => {
    if (b.id === blockId) return { ...b, parent_id: parentId, position: newPos.get(b.id) as number }
    if (newPos.has(b.id)) return { ...b, position: newPos.get(b.id) as number }
    if (oldPos.has(b.id)) return { ...b, position: oldPos.get(b.id) as number }
    return b
  })
}

/** Order a flat bag of rows exactly like the DB `list` query (position, id). */
function listOrder(rows: FlatBlock[]): string[] {
  const out: string[] = []
  const childrenOf = (parentId: string | null) =>
    rows
      .filter((b) => (b.parent_id ?? null) === parentId)
      .sort((a, b) => {
        const pa = a.position ?? Number.MAX_SAFE_INTEGER
        const pb = b.position ?? Number.MAX_SAFE_INTEGER
        if (pa !== pb) return pa - pb
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 // tie-break: ULID ASC
      })
  const walk = (parentId: string | null) => {
    for (const child of childrenOf(parentId)) {
      out.push(child.id)
      walk(child.id)
    }
  }
  walk(null)
  return out
}

/** Rebuild depth-annotated flat rows in list order. */
function reflatten(rows: FlatBlock[]): FlatBlock[] {
  const order = listOrder(rows)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const depthOf = new Map<string, number>()
  return order.map((id) => {
    const row = byId.get(id) as FlatBlock
    const parentDepth = row.parent_id != null ? (depthOf.get(row.parent_id) ?? -1) : -1
    const depth = parentDepth + 1
    depthOf.set(id, depth)
    return { ...row, depth }
  })
}

function collectDescendants(items: FlatBlock[], activeId: string): Set<string> {
  const out = new Set<string>()
  const idx = items.findIndex((b) => b.id === activeId)
  if (idx < 0) return out
  const activeDepth = items[idx]?.depth ?? 0
  for (let i = idx + 1; i < items.length; i++) {
    if ((items[i] as FlatBlock).depth <= activeDepth) break
    out.add((items[i] as FlatBlock).id)
  }
  return out
}

interface DropResult {
  order: string[]
  parentId: string | null
  index: number
  depthOf: (id: string) => number
}

/**
 * Reproduce `useBlockDnD.handleDragEnd`'s parent + slot computation for a
 * pointer drag, then apply the backend move. `overId === activeId` models the
 * "drag in place + horizontal offset to indent/dedent" gesture.
 */
function simulateMouseDrop(
  rows: FlatBlock[],
  activeId: string,
  overId: string,
  offsetX = 0,
): DropResult {
  const items = reflatten(rows)
  const descendantIds = collectDescendants(items, activeId)
  const visibleItems = items.filter((b) => !descendantIds.has(b.id))

  const projected = getProjection(visibleItems, activeId, overId, offsetX, INDENT, null)
  // Matches handleDragEnd: compute the 0-based sibling slot from the projected
  // parent + the drop target.
  const index = computeDropIndex(visibleItems, projected.parentId, overId, activeId)

  const moved = backendMove(rows, activeId, projected.parentId, index)
  const flat = reflatten(moved)
  return {
    order: flat.map((b) => b.id),
    parentId: projected.parentId,
    index,
    depthOf: (id: string) => flat.find((b) => b.id === id)?.depth ?? -1,
  }
}

// ── Fixtures (ULID-ascending ids, 1-based consecutive positions) ──────────

function flatRoots(...ids: string[]): FlatBlock[] {
  return ids.map((id, i) => makeBlock({ id, parent_id: null, position: i + 1, depth: 0 }))
}

// ───────────────────────────────────────────────────────────────────────────
// Same-level reorder
// ───────────────────────────────────────────────────────────────────────────

describe('drop pipeline — same-level reorder', () => {
  it('drags a block DOWN onto the last sibling (lands after it)', () => {
    const rows = flatRoots('A', 'B', 'C')
    const { order } = simulateMouseDrop(rows, 'A', 'C')
    // Downward drag drops AFTER the target (A vacates, B/C slide up) → A last.
    expect(order).toEqual(['B', 'C', 'A'])
  })

  // Dragging A down onto B swaps them → [B, A, C]. The 0-based slot
  // (computeDropIndex) accounts for A vacating its slot, so it lands AFTER B.
  it('drags a block DOWN onto the next sibling (swaps)', () => {
    const rows = flatRoots('A', 'B', 'C')
    const { order } = simulateMouseDrop(rows, 'A', 'B')
    expect(order).toEqual(['B', 'A', 'C'])
  })

  // Dragging C up onto B lands it between A and B → [A, C, B]. Dense renumber
  // means no collision and order matches intent.
  it('drags a block UP between two siblings (reorders)', () => {
    const rows = flatRoots('A', 'B', 'C')
    const { order } = simulateMouseDrop(rows, 'C', 'B')
    expect(order).toEqual(['A', 'C', 'B'])
  })

  // Dropping a block above the first sibling computes slot 0 — "move to top" —
  // which the backend accepts (no `position <= 0` rejection anymore).
  it('drags a block to the very TOP (becomes first)', () => {
    const rows = flatRoots('A', 'B')
    const { order, index } = simulateMouseDrop(rows, 'B', 'A')
    expect(index).toBe(0)
    expect(order).toEqual(['B', 'A'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Drag to indent / nest
// ───────────────────────────────────────────────────────────────────────────

describe('drop pipeline — drag to indent', () => {
  it('indents a block under the previous sibling (drag-in-place + right offset)', () => {
    const rows = flatRoots('A', 'B', 'C')
    // Gesture: keep the pointer over B (the dragged row) and push right one
    // indent level → B becomes the first child of A.
    const { parentId, index, depthOf } = simulateMouseDrop(rows, 'B', 'B', INDENT * 2)
    expect(parentId).toBe('A')
    expect(index).toBe(0) // first (and only) child of A — slot 0
    expect(depthOf('B')).toBe(1)
  })

  // Dropping B so it becomes A's first child (before existing child A1) is
  // slot 0 — "nest as first child" — which the backend now accepts.
  it('nests a block as the first child of a populated parent', () => {
    const rows: FlatBlock[] = [
      makeBlock({ id: 'A', parent_id: null, position: 1, depth: 0 }),
      makeBlock({ id: 'A1', parent_id: 'A', position: 1, depth: 1 }),
      makeBlock({ id: 'B', parent_id: null, position: 2, depth: 0 }),
    ]
    // Drag B up onto A1 with a small right offset → first child of A, before A1.
    const { order } = simulateMouseDrop(rows, 'B', 'A1', 4)
    expect(order).toEqual(['A', 'B', 'A1'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Drop after last (sentinel)
// ───────────────────────────────────────────────────────────────────────────

describe('drop pipeline — sentinel (drop after last)', () => {
  it('moves a block to the end at root level', () => {
    const rows = flatRoots('A', 'B', 'C')
    const { order, parentId } = simulateMouseDrop(rows, 'A', SENTINEL_ID)
    expect(parentId).toBeNull()
    expect(order).toEqual(['B', 'C', 'A'])
  })

  it('nests a block under the last item when dropped on the sentinel with right offset', () => {
    const rows = flatRoots('A', 'B', 'C')
    const { parentId, depthOf } = simulateMouseDrop(rows, 'A', SENTINEL_ID, INDENT + INDENT)
    expect(parentId).toBe('C') // child of the last visible block
    expect(depthOf('A')).toBe(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Subtree integrity
// ───────────────────────────────────────────────────────────────────────────

describe('drop pipeline — subtree moves as a unit', () => {
  it('a moved parent keeps its child adjacent and nested (subtree intact)', () => {
    const rows: FlatBlock[] = [
      makeBlock({ id: 'P', parent_id: null, position: 1, depth: 0 }),
      makeBlock({ id: 'P1', parent_id: 'P', position: 1, depth: 1 }),
      makeBlock({ id: 'Q', parent_id: null, position: 2, depth: 0 }),
    ]
    const { order, depthOf } = simulateMouseDrop(rows, 'P', SENTINEL_ID)
    // P moved to end; P1 still its child, directly after it.
    expect(order).toEqual(['Q', 'P', 'P1'])
    expect(depthOf('P1')).toBe(1)
  })

  it('dragging a parent DOWN onto the next sibling moves the subtree past it', () => {
    const rows: FlatBlock[] = [
      makeBlock({ id: 'P', parent_id: null, position: 1, depth: 0 }),
      makeBlock({ id: 'P1', parent_id: 'P', position: 1, depth: 1 }),
      makeBlock({ id: 'Q', parent_id: null, position: 2, depth: 0 }),
    ]
    const { order } = simulateMouseDrop(rows, 'P', 'Q')
    expect(order).toEqual(['Q', 'P', 'P1'])
  })
})
