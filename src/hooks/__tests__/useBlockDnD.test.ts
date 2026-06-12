/**
 * Tests for useBlockDnD hook — drag-and-drop state and handlers in the block tree.
 *
 * Validates:
 * - Initial state (activeId, overId, projected, visibleItems)
 * - handleDragStart sets DnD state and flushes editor when active
 * - handleDragMove updates offsetLeft
 * - handleDragOver updates overId
 * - handleDragEnd with parent/depth change calls moveToParent
 * - handleDragEnd with same-level reorder calls reorder
 * - handleDragEnd with no over or same block does nothing
 * - handleDragCancel resets all DnD state
 * - activeDescendants memo excludes descendants from visibleItems
 * - projected memo calls getProjection when activeId and overId are set
 * - sensors are configured with PointerSensor and KeyboardSensor
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Module mocks (must be before imports) ────────────────────────────────

vi.mock('@dnd-kit/core', () => ({
  PointerSensor: 'PointerSensor',
  KeyboardSensor: 'KeyboardSensor',
  useSensor: vi.fn((sensor: unknown, opts?: unknown) => ({ sensor, opts })),
  useSensors: vi.fn((...args: unknown[]) => args),
}))

vi.mock('@dnd-kit/sortable', () => ({
  sortableKeyboardCoordinates: vi.fn(),
}))

vi.mock('../../lib/tree-utils', () => ({
  getDragDescendants: vi.fn(() => new Set<string>()),
  getProjection: vi.fn(() => null),
  computeDropIndex: vi.fn(() => 0),
  computeSelectionRoots: vi.fn(() => []),
  SENTINEL_ID: '__drop-after-last__',
}))

vi.mock('@/components/editor/SortableBlock', () => ({
  INDENT_WIDTH: 24,
}))

vi.mock('../useIsTouch', () => ({
  useIsTouch: vi.fn(() => false),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

// ── Imports ──────────────────────────────────────────────────────────────

import { makeBlock } from '../../__tests__/fixtures'
import type { Projection } from '../../lib/tree-utils'
import {
  computeDropIndex,
  computeSelectionRoots,
  getDragDescendants,
  getProjection,
} from '../../lib/tree-utils'
import { useBlockDnD } from '../useBlockDnD'
import { useIsTouch } from '../useIsTouch'

const mockedGetDragDescendants = vi.mocked(getDragDescendants)
const mockedGetProjection = vi.mocked(getProjection)
const mockedComputeDropIndex = vi.mocked(computeDropIndex)
const mockedComputeSelectionRoots = vi.mocked(computeSelectionRoots)
const mockedUseIsTouch = vi.mocked(useIsTouch)

// ── Helpers ──────────────────────────────────────────────────────────────

function makeDefaultParams(overrides?: Partial<Parameters<typeof useBlockDnD>[0]>) {
  return {
    blocks: [
      makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
      makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
    ],
    collapsedVisible: [
      makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
      makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
    ],
    rootParentId: null,
    rovingEditor: { activeBlockId: null },
    handleFlush: vi.fn(() => null),
    setFocused: vi.fn(),
    reorder: vi.fn(async () => {}),
    moveToParent: vi.fn(async () => {}),
    moveBlocks: vi.fn(async () => {}),
    ...overrides,
  }
}

/** Create a minimal DragStartEvent-like object. */
function makeDragStartEvent(id: string) {
  return { active: { id } } as { active: { id: string } }
}

/** Create a minimal DragMoveEvent-like object. */
function makeDragMoveEvent(deltaX: number) {
  return { delta: { x: deltaX } } as { delta: { x: number } }
}

/** Create a minimal DragOverEvent-like object. */
function makeDragOverEvent(overId: string | null) {
  return { over: overId ? { id: overId } : null } as { over: { id: string } | null }
}

/** Create a minimal DragEndEvent-like object. */
function makeDragEndEvent(activeId: string, overId: string | null) {
  return {
    active: { id: activeId },
    over: overId ? { id: overId } : null,
  } as { active: { id: string }; over: { id: string } | null }
}

// ── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockedGetDragDescendants.mockReturnValue(new Set<string>())
  mockedGetProjection.mockReturnValue(null as unknown as Projection)
  mockedComputeDropIndex.mockReturnValue(0)
  mockedComputeSelectionRoots.mockReturnValue([])
})

describe('useBlockDnD', () => {
  // ── 1. Initial state ─────────────────────────────────────────────────

  describe('initial state', () => {
    it('returns null activeId, overId, projected', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      expect(result.current.activeId).toBeNull()
      expect(result.current.overId).toBeNull()
      expect(result.current.projected).toBeNull()
    })

    it('returns collapsedVisible as visibleItems', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      expect(result.current.visibleItems).toEqual(params.collapsedVisible)
    })

    it('does not call getDragDescendants when no drag is active', () => {
      const params = makeDefaultParams()
      renderHook(() => useBlockDnD(params))

      expect(mockedGetDragDescendants).not.toHaveBeenCalled()
    })
  })

  // ── 2. handleDragStart ───────────────────────────────────────────────

  describe('handleDragStart', () => {
    it('sets activeId and overId to the dragged block id', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      expect(result.current.activeId).toBe('B')
      expect(result.current.overId).toBe('B')
    })

    it('does not call handleFlush or setFocused when rovingEditor.activeBlockId is null', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      expect(params.handleFlush).not.toHaveBeenCalled()
      expect(params.setFocused).not.toHaveBeenCalled()
    })

    it('calls handleFlush and setFocused(null) when rovingEditor.activeBlockId is set', () => {
      const params = makeDefaultParams({
        rovingEditor: { activeBlockId: 'A' },
      })
      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      expect(params.handleFlush).toHaveBeenCalledOnce()
      expect(params.setFocused).toHaveBeenCalledWith(null)
    })
  })

  // ── 3. handleDragMove ────────────────────────────────────────────────

  describe('handleDragMove', () => {
    it('updates offsetLeft (verified via getProjection call)', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag to set activeId/overId
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      // Move with delta.x = 48
      act(() => {
        result.current.handleDragMove(makeDragMoveEvent(48) as never)
      })

      // getProjection should be called with the offset; we verify the offset argument
      // The last call to getProjection should include 48 as the dragOffset
      const calls = mockedGetProjection.mock.calls
      const lastCall = calls[calls.length - 1]
      expect(lastCall?.[3]).toBe(48) // dragOffset param
    })
  })

  // ── 4. handleDragOver ────────────────────────────────────────────────

  describe('handleDragOver', () => {
    it('updates overId to event.over.id', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag first
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      act(() => {
        result.current.handleDragOver(makeDragOverEvent('C') as never)
      })

      expect(result.current.overId).toBe('C')
    })

    it('sets overId to null when event.over is null', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      // Over with null
      act(() => {
        result.current.handleDragOver(makeDragOverEvent(null) as never)
      })

      expect(result.current.overId).toBeNull()
    })
  })

  // ── 5. handleDragEnd — parent change via moveToParent ────────────────

  describe('handleDragEnd (parent/depth change)', () => {
    it('calls moveToParent when projected indicates depth change', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // Set up projection to indicate a depth change (B dragged under A)
      const projection: Projection = { depth: 1, parentId: 'A', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(0)

      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag on B
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      // End drag over C (projected says depth=1 parent=A)
      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('B', 'C') as never)
      })

      expect(mockedComputeDropIndex).toHaveBeenCalled()
      expect(params.moveToParent).toHaveBeenCalledWith('B', 'A', 0)
    })

    it('calls moveToParent when projected indicates parent change', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 1, parent_id: 'A', position: 0, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 1, content: 'Block C' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // B is child of A (depth 1, parent A). Projection says move to root (depth 0, parent null)
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(2)

      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag on B
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      // End drag over C
      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('B', 'C') as never)
      })

      expect(params.moveToParent).toHaveBeenCalledWith('B', null, 2)
    })

    it('calls reorder (not moveToParent) for a same-parent move at same depth (R5 #404)', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // Projection at same depth/parent but different slot (A over C). The
      // parent did not change, so R5 routes through the optimistic reorder
      // path instead of moveToParent's structural reload.
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(2)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'C') as never)
      })

      expect(params.reorder).toHaveBeenCalledWith('A', 2)
      expect(params.moveToParent).not.toHaveBeenCalled()
    })

    it('resets DnD state after dragEnd', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      const projection: Projection = { depth: 1, parentId: 'A', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(0)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('B', 'A') as never)
      })

      expect(result.current.activeId).toBeNull()
      expect(result.current.overId).toBeNull()
    })
  })

  // ── 6. handleDragEnd — same-level reorder ────────────────────────────

  describe('handleDragEnd (same-level reorder)', () => {
    it('calls reorder when no projection and active.id !== over.id', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // No projection (null)
      mockedGetProjection.mockReturnValue(null as unknown as Projection)

      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      // Now clear the projection mock so projected is null when dragEnd reads it
      // Actually, projected is already computed during render. Since we mock
      // getProjection to return null, projected will be null.
      // But wait — after handleDragStart, activeId='A' and overId='A', so
      // getProjection gets called. We need it to return null during the next render.
      mockedGetProjection.mockReturnValue(null as unknown as Projection)

      // End drag with A over C
      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'C') as never)
      })

      // The fallback path calls reorder with the computed 0-based slot
      // (computeDropIndex mocked to 0 here).
      expect(params.reorder).toHaveBeenCalledWith('A', 0)
      expect(params.moveToParent).not.toHaveBeenCalled()
    })

    it('still routes to reorder (slot append) when over target is unknown', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      mockedGetProjection.mockReturnValue(null as unknown as Projection)
      // computeDropIndex resolves an unknown over to an append slot.
      mockedComputeDropIndex.mockReturnValue(1)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      // End drag over 'Z' which doesn't exist in blocks
      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'Z') as never)
      })

      expect(params.reorder).toHaveBeenCalledWith('A', 1)
      expect(params.moveToParent).not.toHaveBeenCalled()
    })
  })

  // ── 7. handleDragEnd — no over (early return) ────────────────────────

  describe('handleDragEnd (no over)', () => {
    it('does nothing when over is null', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', null) as never)
      })

      expect(params.reorder).not.toHaveBeenCalled()
      expect(params.moveToParent).not.toHaveBeenCalled()
      // State should still be reset
      expect(result.current.activeId).toBeNull()
      expect(result.current.overId).toBeNull()
    })
  })

  // ── 8. handleDragEnd — same block, no change ─────────────────────────

  describe('handleDragEnd (same block, no change)', () => {
    it('does nothing when active.id === over.id and no depth/parent change', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // Projection shows same depth and same parent
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      // End drag: active=A, over=A — same block, depth=0 matches A's depth, parentId=null matches A's parent
      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'A') as never)
      })

      expect(params.moveToParent).not.toHaveBeenCalled()
      expect(params.reorder).not.toHaveBeenCalled()
    })
  })

  // ── 9. handleDragCancel ──────────────────────────────────────────────

  describe('handleDragCancel', () => {
    it('resets activeId, overId', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag to set state
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      expect(result.current.activeId).toBe('B')
      expect(result.current.overId).toBe('B')

      act(() => {
        result.current.handleDragCancel()
      })

      expect(result.current.activeId).toBeNull()
      expect(result.current.overId).toBeNull()
    })

    it('resets offsetLeft (verified via getProjection not receiving stale offset)', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag and move
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })
      act(() => {
        result.current.handleDragMove(makeDragMoveEvent(100) as never)
      })

      // Cancel
      act(() => {
        result.current.handleDragCancel()
      })

      // After cancel, activeId is null, so projected should be null
      // and getProjection should NOT be called with the stale offset
      expect(result.current.projected).toBeNull()
      expect(result.current.activeId).toBeNull()
    })

    // #923 — Esc-cancel restores the block that was being edited before the drag.
    it('restores the pre-drag focused block on cancel', () => {
      const params = makeDefaultParams({ rovingEditor: { activeBlockId: 'A' } })
      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })
      // Drag start cleared focus.
      expect(params.setFocused).toHaveBeenCalledWith(null)

      act(() => {
        result.current.handleDragCancel()
      })
      // Cancel restored the originally-focused block.
      expect(params.setFocused).toHaveBeenLastCalledWith('A')
    })

    it('does not restore focus on cancel when no block was focused pre-drag', () => {
      const params = makeDefaultParams({ rovingEditor: { activeBlockId: null } })
      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })
      act(() => {
        result.current.handleDragCancel()
      })
      expect(params.setFocused).not.toHaveBeenCalled()
    })
  })

  // ── 10. activeDescendants memo ───────────────────────────────────────

  describe('activeDescendants / visibleItems memo', () => {
    it('calls getDragDescendants when activeId is set', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'A1', depth: 1, parent_id: 'A', position: 0, content: 'Block A1' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      mockedGetDragDescendants.mockReturnValue(new Set(['A1']))

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      expect(mockedGetDragDescendants).toHaveBeenCalledWith(blocks, 'A')
    })

    it('excludes descendants from visibleItems during drag', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'A1', depth: 1, parent_id: 'A', position: 0, content: 'Block A1' }),
        makeBlock({ id: 'A2', depth: 1, parent_id: 'A', position: 1, content: 'Block A2' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // When A is dragged, A1 and A2 are descendants
      mockedGetDragDescendants.mockReturnValue(new Set(['A1', 'A2']))

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      const visibleIds = result.current.visibleItems.map((b) => b.id)
      expect(visibleIds).toEqual(['A', 'B'])
      expect(visibleIds).not.toContain('A1')
      expect(visibleIds).not.toContain('A2')
    })

    it('returns full collapsedVisible when no drag is active', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'A1', depth: 1, parent_id: 'A', position: 0, content: 'Block A1' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })
      const { result } = renderHook(() => useBlockDnD(params))

      expect(result.current.visibleItems).toEqual(blocks)
    })
  })

  // ── 11. projected memo ───────────────────────────────────────────────

  describe('projected memo', () => {
    it('returns null when activeId is null', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      expect(result.current.projected).toBeNull()
      expect(mockedGetProjection).not.toHaveBeenCalled()
    })

    it('returns null when overId is null', () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag then set overId to null via handleDragOver
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      mockedGetProjection.mockClear()

      act(() => {
        result.current.handleDragOver(makeDragOverEvent(null) as never)
      })

      expect(result.current.projected).toBeNull()
    })

    it('calls getProjection with correct args when both activeId and overId are set', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      ]
      const params = makeDefaultParams({
        blocks,
        collapsedVisible: blocks,
        rootParentId: 'ROOT',
      })

      const projection: Projection = { depth: 1, parentId: 'A', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      // getProjection should have been called with visibleItems, activeId, overId, offsetLeft=0, INDENT_WIDTH=24, rootParentId='ROOT', subtreeHeight
      expect(mockedGetProjection).toHaveBeenCalledWith(
        expect.any(Array), // visibleItems
        'B', // activeId
        'B', // overId (set to active id on drag start)
        0, // offsetLeft (reset on drag start)
        24, // INDENT_WIDTH
        'ROOT', // rootParentId
        expect.any(Number), // #928 subtreeHeight
      )

      expect(result.current.projected).toEqual(projection)
    })

    it('updates projected when offsetLeft changes via handleDragMove', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      const projection1: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      const projection2: Projection = { depth: 1, parentId: 'A', maxDepth: 1, minDepth: 0 }

      mockedGetProjection.mockReturnValue(projection1)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      expect(result.current.projected).toEqual(projection1)

      // Now move to indent
      mockedGetProjection.mockReturnValue(projection2)

      act(() => {
        result.current.handleDragMove(makeDragMoveEvent(48) as never)
      })

      expect(result.current.projected).toEqual(projection2)
    })
  })

  // ── 12. sensors ──────────────────────────────────────────────────────

  describe('sensors', () => {
    it('configures PointerSensor with distance constraint on desktop', () => {
      mockedUseIsTouch.mockReturnValue(false)
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      // useSensors mock returns the arguments passed, so sensors is an array of sensor configs
      const sensors = result.current.sensors as unknown as Array<{ sensor: string; opts?: unknown }>

      expect(sensors).toHaveLength(2)

      // First sensor: PointerSensor
      expect(sensors[0]?.sensor).toBe('PointerSensor')
      expect(sensors[0]?.opts).toEqual({
        activationConstraint: { distance: 8 },
      })

      // Second sensor: KeyboardSensor
      expect(sensors[1]?.sensor).toBe('KeyboardSensor')
      expect(sensors[1]?.opts).toHaveProperty('coordinateGetter')
    })

    it('configures PointerSensor with delay constraint on touch (coarse pointer)', () => {
      mockedUseIsTouch.mockReturnValue(true)
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      const sensors = result.current.sensors as unknown as Array<{ sensor: string; opts?: unknown }>

      expect(sensors).toHaveLength(2)

      // First sensor: PointerSensor with delay-only (long press to drag)
      expect(sensors[0]?.sensor).toBe('PointerSensor')
      expect(sensors[0]?.opts).toEqual({
        activationConstraint: { delay: 250, tolerance: 5 },
      })

      // Second sensor: KeyboardSensor (unchanged)
      expect(sensors[1]?.sensor).toBe('KeyboardSensor')
      expect(sensors[1]?.opts).toHaveProperty('coordinateGetter')
    })
  })

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles dragEnd when activeBlock not found in blocks', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // Projection will still be present
      const projection: Projection = { depth: 1, parentId: 'A', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('MISSING') as never)
      })

      // End drag — activeBlock won't be found, so projected && activeBlock is false
      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('MISSING', 'A') as never)
      })

      // Should not call moveToParent because activeBlock is undefined
      expect(params.moveToParent).not.toHaveBeenCalled()
      // Falls through to reorder, but MISSING is not in blocks, so overIndex check matters
      // The reorder path checks active.id !== over.id (MISSING !== A) => true
      // Then overIndex of 'A' in blocks = 0 >= 0 => reorder called
      expect(params.reorder).toHaveBeenCalledWith('MISSING', 0)
    })

    it('handles rootParentId being non-null for parent change comparison', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: 'ROOT', position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: 'ROOT', position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({
        blocks,
        collapsedVisible: blocks,
        rootParentId: 'ROOT',
      })

      // Projection says same depth but different parent (moving out of ROOT)
      const projection: Projection = { depth: 0, parentId: 'OTHER', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(0)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'B') as never)
      })

      // currentParentId = block.parent_id ('ROOT') ?? rootParentId ('ROOT') = 'ROOT'
      // projected.parentId = 'OTHER' !== 'ROOT' => parentChanged = true
      expect(params.moveToParent).toHaveBeenCalledWith('A', 'OTHER', 0)
    })

    it('uses rootParentId fallback when block.parent_id is null', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({
        blocks,
        collapsedVisible: blocks,
        rootParentId: 'ROOT',
      })

      // projected.parentId = 'ROOT' (same as currentParentId which is null ?? 'ROOT' = 'ROOT')
      // depth same, parent same => R5 routes to reorder (not moveToParent).
      const projection: Projection = { depth: 0, parentId: 'ROOT', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(1)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'B') as never)
      })

      // currentParentId = null ?? 'ROOT' = 'ROOT'; projected.parentId = 'ROOT'
      // → parentChanged = false → optimistic reorder by slot.
      expect(params.reorder).toHaveBeenCalledWith('A', 1)
      expect(params.moveToParent).not.toHaveBeenCalled()
    })

    it('handles multiple sequential drag operations', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })
      mockedGetProjection.mockReturnValue(null as unknown as Projection)

      const { result } = renderHook(() => useBlockDnD(params))

      // First drag-and-cancel
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })
      act(() => {
        result.current.handleDragCancel()
      })

      expect(result.current.activeId).toBeNull()

      // Second drag
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('C') as never)
      })

      expect(result.current.activeId).toBe('C')
      expect(result.current.overId).toBe('C')
    })
  })

  // ── 13. Sentinel drop handling (UX-176) ──────────────────────────────

  describe('handleDragEnd (sentinel)', () => {
    it('calls reorder when dropping on sentinel at the same parent (R5 #404)', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // Sentinel drop at root level — A is already a root block, so the parent
      // does not change → the SENTINEL branch of the same-parent reorder path
      // fires (reorder, not moveToParent).
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(3)

      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag on A
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      // Set over to sentinel
      act(() => {
        result.current.handleDragOver(makeDragOverEvent('__drop-after-last__') as never)
      })

      // End drag over sentinel
      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', '__drop-after-last__') as never)
      })

      expect(params.reorder).toHaveBeenCalledWith('A', 3)
      expect(params.moveToParent).not.toHaveBeenCalled()
    })

    it('passes the SENTINEL overId to computeDropIndex for sentinel', () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(5)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', '__drop-after-last__') as never)
      })

      // computeDropIndex is called with (visibleItems, parentId, overId, activeId).
      expect(mockedComputeDropIndex).toHaveBeenCalledWith(
        expect.any(Array),
        null,
        '__drop-after-last__', // overId (sentinel)
        'A',
      )
      // Same-parent sentinel drop → optimistic reorder by slot (R5 #404).
      expect(params.reorder).toHaveBeenCalledWith('A', 5)
    })
  })

  // ── 14. UX-241: focus restore after drag ─────────────────────────────

  describe('handleDragEnd (UX-241 focus restore)', () => {
    it('restores focus on the dragged block after a successful moveToParent', async () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      const projection: Projection = { depth: 1, parentId: 'A', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(0)

      const { result } = renderHook(() => useBlockDnD(params))

      await act(async () => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      await act(async () => {
        result.current.handleDragEnd(makeDragEndEvent('B', 'C') as never)
        // Flush the microtask queue so the .then(() => setFocused(blockId))
        // chained on moveToParent has a chance to fire.
        await Promise.resolve()
      })

      expect(params.moveToParent).toHaveBeenCalledWith('B', 'A', 0)
      expect(params.setFocused).toHaveBeenCalledWith('B')
    })

    it('restores focus on the dragged block after a successful same-level reorder', async () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // No projection → falls through to same-level reorder branch.
      mockedGetProjection.mockReturnValue(null as unknown as Projection)
      mockedComputeDropIndex.mockReturnValue(2)

      const { result } = renderHook(() => useBlockDnD(params))

      await act(async () => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      await act(async () => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'C') as never)
        await Promise.resolve()
      })

      expect(params.reorder).toHaveBeenCalledWith('A', 2)
      expect(params.setFocused).toHaveBeenCalledWith('A')
    })

    it('does NOT restore focus when moveToParent rejects', async () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      ]
      const moveToParent = vi.fn(async () => {
        throw new Error('move failed')
      })
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks, moveToParent })

      const projection: Projection = { depth: 1, parentId: 'A', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(0)

      const { result } = renderHook(() => useBlockDnD(params))

      await act(async () => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      await act(async () => {
        result.current.handleDragEnd(makeDragEndEvent('B', 'C') as never)
        // Let the rejected promise propagate through .catch so setFocused
        // is NOT scheduled.
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(params.moveToParent).toHaveBeenCalled()
      // drag-start had rovingEditor.activeBlockId === null, so setFocused
      // was never called with null during drag-start.  Post-drop, .catch
      // fires instead of .then, so setFocused should not have been called
      // with the block id.
      expect(params.setFocused).not.toHaveBeenCalledWith('B')
    })

    it('does NOT restore focus when reorder rejects', async () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
        makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      ]
      const reorder = vi.fn(async () => {
        throw new Error('reorder failed')
      })
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks, reorder })

      mockedGetProjection.mockReturnValue(null as unknown as Projection)
      mockedComputeDropIndex.mockReturnValue(2)

      const { result } = renderHook(() => useBlockDnD(params))

      await act(async () => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      await act(async () => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'C') as never)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(params.reorder).toHaveBeenCalledWith('A', 2)
      expect(params.setFocused).not.toHaveBeenCalledWith('A')
    })

    it('does NOT restore focus when the drop is cancelled (no over target)', async () => {
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      await act(async () => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      await act(async () => {
        result.current.handleDragEnd(makeDragEndEvent('B', null) as never)
        await Promise.resolve()
      })

      expect(params.moveToParent).not.toHaveBeenCalled()
      expect(params.reorder).not.toHaveBeenCalled()
      expect(params.setFocused).not.toHaveBeenCalledWith('B')
    })

    it('does NOT restore focus when dropping on the same block with no depth/parent change', async () => {
      const blocks = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
        makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // Projection matches current depth/parent exactly, and the drag ends on
      // itself — no move should happen and no focus restore either.
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)

      const { result } = renderHook(() => useBlockDnD(params))

      await act(async () => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      await act(async () => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'A') as never)
        await Promise.resolve()
      })

      expect(params.moveToParent).not.toHaveBeenCalled()
      expect(params.reorder).not.toHaveBeenCalled()
      expect(params.setFocused).not.toHaveBeenCalledWith('A')
    })
  })

  // ── 15. Multi-select drag (#914) ─────────────────────────────────────
  describe('handleDragEnd (multi-select drag)', () => {
    const threeBlocks = [
      makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0, content: 'Block A' }),
      makeBlock({ id: 'B', depth: 0, parent_id: null, position: 1, content: 'Block B' }),
      makeBlock({ id: 'C', depth: 0, parent_id: null, position: 2, content: 'Block C' }),
      makeBlock({ id: 'D', depth: 0, parent_id: null, position: 3, content: 'Block D' }),
    ]

    it('moves the whole selection via moveBlocks when the dragged block is one of >1 roots', () => {
      const params = makeDefaultParams({
        blocks: threeBlocks,
        collapsedVisible: threeBlocks,
        selectedBlockIds: ['A', 'B'],
      })

      // Roots = [A, B]; dragging A.
      mockedComputeSelectionRoots.mockReturnValue(['A', 'B'])
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(2)

      const { result } = renderHook(() => useBlockDnD(params))

      expect(result.current.isMultiDrag).toBe(false) // no active drag yet

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      expect(result.current.isMultiDrag).toBe(true)
      expect(result.current.dragRoots).toEqual(['A', 'B'])

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'D') as never)
      })

      // The whole selection (roots) relocates; single-block paths untouched.
      expect(params.moveBlocks).toHaveBeenCalledWith(['A', 'B'], null, 2)
      expect(params.reorder).not.toHaveBeenCalled()
      expect(params.moveToParent).not.toHaveBeenCalled()
    })

    it('falls back to single-block drag when the dragged block is NOT in the selection', () => {
      const params = makeDefaultParams({
        blocks: threeBlocks,
        collapsedVisible: threeBlocks,
        selectedBlockIds: ['A', 'B'],
      })

      // Selection is A,B but the user drags C → single-block behaviour.
      mockedComputeSelectionRoots.mockReturnValue(['A', 'B'])
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(1)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('C') as never)
      })

      expect(result.current.isMultiDrag).toBe(false)

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('C', 'A') as never)
      })

      expect(params.moveBlocks).not.toHaveBeenCalled()
      // Same-parent reorder path for the single block.
      expect(params.reorder).toHaveBeenCalledWith('C', 1)
    })

    it('falls back to single-block drag when only one block is selected', () => {
      const params = makeDefaultParams({
        blocks: threeBlocks,
        collapsedVisible: threeBlocks,
        selectedBlockIds: ['A'],
      })

      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(2)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      expect(result.current.isMultiDrag).toBe(false)

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'C') as never)
      })

      expect(params.moveBlocks).not.toHaveBeenCalled()
      expect(params.reorder).toHaveBeenCalledWith('A', 2)
    })

    it('falls back to single-block drag when the selection collapses to a single root', () => {
      // A selected with its selected child A1 → only one root (A).
      const nested = [
        makeBlock({ id: 'A', depth: 0, parent_id: null, position: 0 }),
        makeBlock({ id: 'A1', depth: 1, parent_id: 'A', position: 0 }),
      ]
      const params = makeDefaultParams({
        blocks: nested,
        collapsedVisible: nested,
        selectedBlockIds: ['A', 'A1'],
      })

      mockedComputeSelectionRoots.mockReturnValue(['A'])
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(0)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      expect(result.current.isMultiDrag).toBe(false)

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'A1') as never)
      })

      expect(params.moveBlocks).not.toHaveBeenCalled()
    })

    it('passes the projected parent to moveBlocks for a reparenting multi-drag', () => {
      const params = makeDefaultParams({
        blocks: threeBlocks,
        collapsedVisible: threeBlocks,
        selectedBlockIds: ['B', 'C'],
      })

      mockedComputeSelectionRoots.mockReturnValue(['B', 'C'])
      // Projection nests under A.
      const projection: Projection = { depth: 1, parentId: 'A', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(0)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('B', 'A') as never)
      })

      expect(params.moveBlocks).toHaveBeenCalledWith(['B', 'C'], 'A', 0)
    })

    it('restores focus on the dragged block after a successful multi-drag', async () => {
      const params = makeDefaultParams({
        blocks: threeBlocks,
        collapsedVisible: threeBlocks,
        selectedBlockIds: ['A', 'B'],
      })

      mockedComputeSelectionRoots.mockReturnValue(['A', 'B'])
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputeDropIndex.mockReturnValue(2)

      const { result } = renderHook(() => useBlockDnD(params))

      await act(async () => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      await act(async () => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'D') as never)
        await Promise.resolve()
      })

      expect(params.moveBlocks).toHaveBeenCalledWith(['A', 'B'], null, 2)
      expect(params.setFocused).toHaveBeenCalledWith('A')
    })
  })
})
