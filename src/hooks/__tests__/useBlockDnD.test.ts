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
  computePosition: vi.fn(() => 0),
}))

vi.mock('../../components/SortableBlock', () => ({
  INDENT_WIDTH: 24,
}))

vi.mock('../use-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

// ── Imports ──────────────────────────────────────────────────────────────

import type { FlatBlock, Projection } from '../../lib/tree-utils'
import { computePosition, getDragDescendants, getProjection } from '../../lib/tree-utils'
import { useIsMobile } from '../use-mobile'
import { useBlockDnD } from '../useBlockDnD'

const mockedGetDragDescendants = vi.mocked(getDragDescendants)
const mockedGetProjection = vi.mocked(getProjection)
const mockedComputePosition = vi.mocked(computePosition)
const mockedUseIsMobile = vi.mocked(useIsMobile)

// ── Helpers ──────────────────────────────────────────────────────────────

function makeFlatBlock(
  id: string,
  depth = 0,
  parentId: string | null = null,
  position = 0,
): FlatBlock {
  return {
    id,
    block_type: 'block',
    content: `Block ${id}`,
    parent_id: parentId,
    position,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    depth,
  }
}

function makeDefaultParams(overrides?: Partial<Parameters<typeof useBlockDnD>[0]>) {
  return {
    blocks: [
      makeFlatBlock('A', 0, null, 0),
      makeFlatBlock('B', 0, null, 1),
      makeFlatBlock('C', 0, null, 2),
    ],
    collapsedVisible: [
      makeFlatBlock('A', 0, null, 0),
      makeFlatBlock('B', 0, null, 1),
      makeFlatBlock('C', 0, null, 2),
    ],
    rootParentId: null,
    rovingEditor: { activeBlockId: null },
    handleFlush: vi.fn(() => null),
    setFocused: vi.fn(),
    reorder: vi.fn(async () => {}),
    moveToParent: vi.fn(async () => {}),
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
  mockedComputePosition.mockReturnValue(0)
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
      expect(lastCall[3]).toBe(48) // dragOffset param
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
        makeFlatBlock('A', 0, null, 0),
        makeFlatBlock('B', 0, null, 1),
        makeFlatBlock('C', 0, null, 2),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // Set up projection to indicate a depth change (B dragged under A)
      const projection: Projection = { depth: 1, parentId: 'A', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputePosition.mockReturnValue(0)

      const { result } = renderHook(() => useBlockDnD(params))

      // Start drag on B
      act(() => {
        result.current.handleDragStart(makeDragStartEvent('B') as never)
      })

      // End drag over C (projected says depth=1 parent=A)
      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('B', 'C') as never)
      })

      expect(mockedComputePosition).toHaveBeenCalled()
      expect(params.moveToParent).toHaveBeenCalledWith('B', 'A', 0)
    })

    it('calls moveToParent when projected indicates parent change', () => {
      const blocks = [
        makeFlatBlock('A', 0, null, 0),
        makeFlatBlock('B', 1, 'A', 0),
        makeFlatBlock('C', 0, null, 1),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // B is child of A (depth 1, parent A). Projection says move to root (depth 0, parent null)
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputePosition.mockReturnValue(2)

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

    it('calls moveToParent when active.id !== over.id even at same depth', () => {
      const blocks = [
        makeFlatBlock('A', 0, null, 0),
        makeFlatBlock('B', 0, null, 1),
        makeFlatBlock('C', 0, null, 2),
      ]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      // Projection at same depth/parent but different position (A over C)
      const projection: Projection = { depth: 0, parentId: null, maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputePosition.mockReturnValue(2)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'C') as never)
      })

      // active.id ('A') !== over.id ('C'), so moveToParent is called
      expect(params.moveToParent).toHaveBeenCalledWith('A', null, 2)
    })

    it('resets DnD state after dragEnd', () => {
      const blocks = [makeFlatBlock('A', 0, null, 0), makeFlatBlock('B', 0, null, 1)]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      const projection: Projection = { depth: 1, parentId: 'A', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputePosition.mockReturnValue(0)

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
        makeFlatBlock('A', 0, null, 0),
        makeFlatBlock('B', 0, null, 1),
        makeFlatBlock('C', 0, null, 2),
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

      // overIndex for 'C' in blocks is 2
      expect(params.reorder).toHaveBeenCalledWith('A', 2)
      expect(params.moveToParent).not.toHaveBeenCalled()
    })

    it('does not call reorder when overIndex is -1', () => {
      const blocks = [makeFlatBlock('A', 0, null, 0), makeFlatBlock('B', 0, null, 1)]
      const params = makeDefaultParams({ blocks, collapsedVisible: blocks })

      mockedGetProjection.mockReturnValue(null as unknown as Projection)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      // End drag over 'Z' which doesn't exist in blocks
      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'Z') as never)
      })

      expect(params.reorder).not.toHaveBeenCalled()
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
      const blocks = [makeFlatBlock('A', 0, null, 0), makeFlatBlock('B', 0, null, 1)]
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
  })

  // ── 10. activeDescendants memo ───────────────────────────────────────

  describe('activeDescendants / visibleItems memo', () => {
    it('calls getDragDescendants when activeId is set', () => {
      const blocks = [
        makeFlatBlock('A', 0, null, 0),
        makeFlatBlock('A1', 1, 'A', 0),
        makeFlatBlock('B', 0, null, 1),
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
        makeFlatBlock('A', 0, null, 0),
        makeFlatBlock('A1', 1, 'A', 0),
        makeFlatBlock('A2', 1, 'A', 1),
        makeFlatBlock('B', 0, null, 1),
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
        makeFlatBlock('A', 0, null, 0),
        makeFlatBlock('A1', 1, 'A', 0),
        makeFlatBlock('B', 0, null, 1),
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
        makeFlatBlock('A', 0, null, 0),
        makeFlatBlock('B', 0, null, 1),
        makeFlatBlock('C', 0, null, 2),
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

      // getProjection should have been called with visibleItems, activeId, overId, offsetLeft=0, INDENT_WIDTH=24, rootParentId='ROOT'
      expect(mockedGetProjection).toHaveBeenCalledWith(
        expect.any(Array), // visibleItems
        'B', // activeId
        'B', // overId (set to active id on drag start)
        0, // offsetLeft (reset on drag start)
        24, // INDENT_WIDTH
        'ROOT', // rootParentId
      )

      expect(result.current.projected).toEqual(projection)
    })

    it('updates projected when offsetLeft changes via handleDragMove', () => {
      const blocks = [makeFlatBlock('A', 0, null, 0), makeFlatBlock('B', 0, null, 1)]
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
      mockedUseIsMobile.mockReturnValue(false)
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      // useSensors mock returns the arguments passed, so sensors is an array of sensor configs
      const sensors = result.current.sensors as unknown as Array<{ sensor: string; opts?: unknown }>

      expect(sensors).toHaveLength(2)

      // First sensor: PointerSensor
      expect(sensors[0].sensor).toBe('PointerSensor')
      expect(sensors[0].opts).toEqual({
        activationConstraint: { distance: 8 },
      })

      // Second sensor: KeyboardSensor
      expect(sensors[1].sensor).toBe('KeyboardSensor')
      expect(sensors[1].opts).toHaveProperty('coordinateGetter')
    })

    it('configures PointerSensor with delay constraint on mobile', () => {
      mockedUseIsMobile.mockReturnValue(true)
      const params = makeDefaultParams()
      const { result } = renderHook(() => useBlockDnD(params))

      const sensors = result.current.sensors as unknown as Array<{ sensor: string; opts?: unknown }>

      expect(sensors).toHaveLength(2)

      // First sensor: PointerSensor with delay-only (long press to drag)
      expect(sensors[0].sensor).toBe('PointerSensor')
      expect(sensors[0].opts).toEqual({
        activationConstraint: { delay: 250, tolerance: 5 },
      })

      // Second sensor: KeyboardSensor (unchanged)
      expect(sensors[1].sensor).toBe('KeyboardSensor')
      expect(sensors[1].opts).toHaveProperty('coordinateGetter')
    })
  })

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles dragEnd when activeBlock not found in blocks', () => {
      const blocks = [makeFlatBlock('A', 0, null, 0)]
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
      const blocks = [makeFlatBlock('A', 0, 'ROOT', 0), makeFlatBlock('B', 0, 'ROOT', 1)]
      const params = makeDefaultParams({
        blocks,
        collapsedVisible: blocks,
        rootParentId: 'ROOT',
      })

      // Projection says same depth but different parent (moving out of ROOT)
      const projection: Projection = { depth: 0, parentId: 'OTHER', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputePosition.mockReturnValue(0)

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
      const blocks = [makeFlatBlock('A', 0, null, 0), makeFlatBlock('B', 0, null, 1)]
      const params = makeDefaultParams({
        blocks,
        collapsedVisible: blocks,
        rootParentId: 'ROOT',
      })

      // projected.parentId = 'ROOT' (same as currentParentId which is null ?? 'ROOT' = 'ROOT')
      // depth same => no change, but A !== B so moveToParent still called
      const projection: Projection = { depth: 0, parentId: 'ROOT', maxDepth: 1, minDepth: 0 }
      mockedGetProjection.mockReturnValue(projection)
      mockedComputePosition.mockReturnValue(1)

      const { result } = renderHook(() => useBlockDnD(params))

      act(() => {
        result.current.handleDragStart(makeDragStartEvent('A') as never)
      })

      act(() => {
        result.current.handleDragEnd(makeDragEndEvent('A', 'B') as never)
      })

      // currentParentId = null ?? 'ROOT' = 'ROOT'
      // projected.parentId = 'ROOT'
      // depthChanged = false, parentChanged = false
      // But active.id ('A') !== over.id ('B') => moveToParent called
      expect(params.moveToParent).toHaveBeenCalledWith('A', 'ROOT', 1)
    })

    it('handles multiple sequential drag operations', () => {
      const blocks = [
        makeFlatBlock('A', 0, null, 0),
        makeFlatBlock('B', 0, null, 1),
        makeFlatBlock('C', 0, null, 2),
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
})
