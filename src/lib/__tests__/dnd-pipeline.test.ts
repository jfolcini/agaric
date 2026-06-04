/**
 * Drag-and-drop DROP PIPELINE integration tests.
 *
 * `tree-utils.test.ts` covers `getProjection` / `computePosition` in isolation.
 * This file wires them together exactly the way `useBlockDnD.handleDragEnd`
 * does, then applies the SAME semantics the real backend (`move_block`) uses,
 * so the tests assert the property a user actually cares about: *after I drop a
 * block, is it where I dropped it?*
 *
 * Backend ground truth (verified in src-tauri):
 *   - `move_block` does `UPDATE blocks SET parent_id=?, position=?` with NO
 *     sibling renumbering (commands/blocks/move_ops.rs:160).
 *   - `position` must be > 0 (1-based); `position <= 0` is rejected with
 *     `AppError::Validation("position must be positive")` (move_ops.rs:43).
 *   - `list` orders siblings by `position ASC, id ASC` (blocks/queries.rs:540),
 *     so equal positions tie-break by ULID (creation order), NOT drop intent.
 *   - new blocks are created at `MAX(position)+1`, i.e. consecutive 1,2,3…
 *     with no gaps (blocks/crud.rs:202).
 *
 * Bugs this surfaces are encoded with `it.fails(...)`: the body asserts the
 * CORRECT (desired) outcome, which currently throws, so `it.fails` passes and
 * the suite stays green. When the underlying bug is fixed the body starts
 * passing and `it.fails` flips to red — the signal to delete the `.fails`.
 * Each `it.fails` is paired with a plain `it(...)` CHARACTERIZATION test that
 * locks in today's (wrong) behaviour so a fix can't change it silently.
 */

import { describe, expect, it } from 'vitest'

import { makeBlock } from '../../__tests__/fixtures'
import { computePosition, type FlatBlock, getProjection, SENTINEL_ID } from '../tree-utils'

const INDENT = 24

// ── Faithful backend model ────────────────────────────────────────────────

class PositionRejectedError extends Error {}

/** Apply `move_block` as the Rust backend does: set parent+position, renumber
 *  nothing, reject a non-positive position. */
function backendMove(
  rows: FlatBlock[],
  blockId: string,
  parentId: string | null,
  position: number,
): FlatBlock[] {
  if (position <= 0) {
    throw new PositionRejectedError(`position must be positive (1-based), got ${position}`)
  }
  return rows.map((b) => (b.id === blockId ? { ...b, parent_id: parentId, position } : b))
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
  position: number
  depthOf: (id: string) => number
}

/**
 * Reproduce `useBlockDnD.handleDragEnd`'s parent+position computation for a
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
  const overIndex =
    overId === SENTINEL_ID ? visibleItems.length : visibleItems.findIndex((b) => b.id === overId)
  const position = computePosition(visibleItems, projected.parentId, overIndex, activeId)

  const moved = backendMove(rows, activeId, projected.parentId, position)
  const flat = reflatten(moved)
  return {
    order: flat.map((b) => b.id),
    parentId: projected.parentId,
    position,
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
  it('drags a block to the very bottom (works — id tie-break agrees with intent)', () => {
    const rows = flatRoots('A', 'B', 'C')
    const { order } = simulateMouseDrop(rows, 'A', 'C')
    expect(order).toEqual(['B', 'A', 'C'])
  })

  // ── BUG 1: off-by-one on a downward drag onto the adjacent sibling ──────
  // Dragging A down onto B should swap them → [B, A, C]. computePosition is
  // handed the RAW over-index (active still occupies the slot above), so it
  // inserts BEFORE B instead of after → position 1 → A never moves.
  it.fails('BUG: drags a block DOWN onto the next sibling (should swap, currently no-ops)', () => {
    const rows = flatRoots('A', 'B', 'C')
    const { order } = simulateMouseDrop(rows, 'A', 'B')
    expect(order).toEqual(['B', 'A', 'C']) // DESIRED
  })

  it('CHARACTERIZATION: downward drag onto next sibling computes a no-op position', () => {
    const rows = flatRoots('A', 'B', 'C')
    const { order, position } = simulateMouseDrop(rows, 'A', 'B')
    expect(position).toBe(1) // == A's own position → no move
    expect(order).toEqual(['A', 'B', 'C'])
  })

  // ── BUG 2: position collision on an upward drag between siblings ────────
  // Dragging C up onto B should land it between A and B → [A, C, B].
  // computePosition returns B.position (2); the backend does not renumber and
  // `list` tie-breaks by ULID (B < C) → C ends up AFTER B (unchanged).
  it.fails('BUG: drags a block UP between two siblings (should reorder, currently no-ops)', () => {
    const rows = flatRoots('A', 'B', 'C')
    const { order } = simulateMouseDrop(rows, 'C', 'B')
    expect(order).toEqual(['A', 'C', 'B']) // DESIRED
  })

  it('CHARACTERIZATION: upward drag collides on position and leaves order unchanged', () => {
    const rows = flatRoots('A', 'B', 'C')
    const { order, position } = simulateMouseDrop(rows, 'C', 'B')
    expect(position).toBe(2) // collides with B
    expect(order).toEqual(['A', 'B', 'C'])
  })

  // ── BUG 3: drop-to-top computes a position the backend rejects ──────────
  // Dropping a block above the first sibling computes `firstPos - 1`. With the
  // first sibling at position 1 that is 0, which the backend REJECTS → the
  // whole move throws and the user sees an error toast instead of a reorder.
  it.fails('BUG: drags a block to the very TOP (should become first, currently rejected)', () => {
    const rows = flatRoots('A', 'B')
    const { order } = simulateMouseDrop(rows, 'B', 'A')
    expect(order).toEqual(['B', 'A']) // DESIRED
  })

  it('CHARACTERIZATION: drop-to-top emits a non-positive position the backend rejects', () => {
    const rows = flatRoots('A', 'B')
    expect(() => simulateMouseDrop(rows, 'B', 'A')).toThrow(/position must be positive/)
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
    const { parentId, position, depthOf } = simulateMouseDrop(rows, 'B', 'B', INDENT * 2)
    expect(parentId).toBe('A')
    expect(position).toBe(1) // first child of A — no collision
    expect(depthOf('B')).toBe(1)
  })

  // ── BUG 4: nesting as the FIRST child computes position 0 ──────────────
  // Dropping B so it becomes A's first child (before existing child A1) hits
  // the same non-positive-position rejection as drop-to-top.
  it.fails('BUG: nests a block as the first child of a populated parent (currently rejected)', () => {
    const rows: FlatBlock[] = [
      makeBlock({ id: 'A', parent_id: null, position: 1, depth: 0 }),
      makeBlock({ id: 'A1', parent_id: 'A', position: 1, depth: 1 }),
      makeBlock({ id: 'B', parent_id: null, position: 2, depth: 0 }),
    ]
    // Drag B up onto A1 with a small right offset → first child of A, before A1.
    const { order } = simulateMouseDrop(rows, 'B', 'A1', 4)
    expect(order).toEqual(['A', 'B', 'A1']) // DESIRED
  })

  it('CHARACTERIZATION: nesting before the first child emits position 0', () => {
    const rows: FlatBlock[] = [
      makeBlock({ id: 'A', parent_id: null, position: 1, depth: 0 }),
      makeBlock({ id: 'A1', parent_id: 'A', position: 1, depth: 1 }),
      makeBlock({ id: 'B', parent_id: null, position: 2, depth: 0 }),
    ]
    expect(() => simulateMouseDrop(rows, 'B', 'A1', 4)).toThrow(/position must be positive/)
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

  // The downward-drag off-by-one (BUG 1) also defeats subtree reordering.
  it.fails('BUG: dragging a parent DOWN onto the next sibling (should move subtree past it)', () => {
    const rows: FlatBlock[] = [
      makeBlock({ id: 'P', parent_id: null, position: 1, depth: 0 }),
      makeBlock({ id: 'P1', parent_id: 'P', position: 1, depth: 1 }),
      makeBlock({ id: 'Q', parent_id: null, position: 2, depth: 0 }),
    ]
    const { order } = simulateMouseDrop(rows, 'P', 'Q')
    expect(order).toEqual(['Q', 'P', 'P1']) // DESIRED
  })
})
