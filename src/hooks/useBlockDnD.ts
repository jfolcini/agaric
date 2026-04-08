/**
 * useBlockDnD — hook for drag-and-drop state and handlers in the block tree.
 *
 * Manages:
 * - DnD state (activeId, overId, offsetLeft)
 * - Computed memos (activeDescendants, visibleItems, projected)
 * - DnD event handlers (drag start/move/over/end/cancel)
 * - DnD sensors setup
 */

import {
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { type RefObject, useCallback, useMemo, useRef, useState } from 'react'
import { INDENT_WIDTH } from '../components/SortableBlock'
import {
  computePosition,
  type FlatBlock,
  getDragDescendants,
  getProjection,
  type Projection,
} from '../lib/tree-utils'
import { useIsMobile } from './use-mobile'
import { useAutoScrollOnDrag } from './useAutoScrollOnDrag'

interface UseBlockDnDParams {
  blocks: FlatBlock[]
  collapsedVisible: FlatBlock[]
  rootParentId: string | null
  rovingEditor: { activeBlockId: string | null }
  handleFlush: () => string | null
  setFocused: (id: string | null) => void
  reorder: (blockId: string, newIndex: number) => Promise<void>
  moveToParent: (blockId: string, newParentId: string | null, newPosition: number) => Promise<void>
  scrollContainerRef?: RefObject<HTMLElement | null>
}

export interface UseBlockDnDReturn {
  activeId: string | null
  overId: string | null
  projected: Projection | null
  visibleItems: FlatBlock[]
  sensors: ReturnType<typeof useSensors>
  handleDragStart: (event: DragStartEvent) => void
  handleDragMove: (event: DragMoveEvent) => void
  handleDragOver: (event: DragOverEvent) => void
  handleDragEnd: (event: DragEndEvent) => void
  handleDragCancel: () => void
}

export function useBlockDnD({
  blocks,
  collapsedVisible,
  rootParentId,
  rovingEditor,
  handleFlush,
  setFocused,
  reorder,
  moveToParent,
  scrollContainerRef,
}: UseBlockDnDParams): UseBlockDnDReturn {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [offsetLeft, setOffsetLeft] = useState(0)

  // Auto-scroll when dragging near viewport edges
  const fallbackRef = useRef<HTMLElement | null>(null)
  useAutoScrollOnDrag(scrollContainerRef ?? fallbackRef, !!activeId)

  // Items visible during drag: exclude descendants of the active item
  const activeDescendants = useMemo(
    () => (activeId ? getDragDescendants(collapsedVisible, activeId) : new Set<string>()),
    [activeId, collapsedVisible],
  )

  const visibleItems = useMemo(
    () =>
      activeId ? collapsedVisible.filter((b) => !activeDescendants.has(b.id)) : collapsedVisible,
    [collapsedVisible, activeId, activeDescendants],
  )

  // Projection of where the dragged item would land
  const projected = useMemo(() => {
    if (!activeId || !overId) return null
    return getProjection(visibleItems, activeId, overId, offsetLeft, INDENT_WIDTH, rootParentId)
  }, [activeId, overId, offsetLeft, visibleItems, rootParentId])

  // ── DnD sensors ────────────────────────────────────────────────────
  // PointerSensor with 8px activation distance so clicks still work.
  const isMobile = useIsMobile()
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: isMobile ? { delay: 250, tolerance: 5 } : { distance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // ── DnD handlers ───────────────────────────────────────────────────
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = event.active.id as string
      setActiveId(id)
      setOverId(id)
      setOffsetLeft(0)

      // Flush editor if active
      if (rovingEditor.activeBlockId) {
        handleFlush()
        setFocused(null)
      }
    },
    [rovingEditor, handleFlush, setFocused],
  )

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    setOffsetLeft(event.delta.x)
  }, [])

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setOverId((event.over?.id as string) ?? null)
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event

      // Reset DnD state
      setActiveId(null)
      setOverId(null)
      setOffsetLeft(0)

      if (!over) return

      const blockId = active.id as string
      const activeBlock = blocks.find((b) => b.id === blockId)

      if (projected && activeBlock) {
        // Check if the projection indicates a depth/parent change
        const currentParentId = activeBlock.parent_id ?? rootParentId
        const depthChanged = projected.depth !== activeBlock.depth
        const parentChanged = projected.parentId !== currentParentId

        if (depthChanged || parentChanged || active.id !== over.id) {
          // Tree-aware move: use projection to determine new parent + position
          const newPosition = computePosition(
            visibleItems,
            projected.parentId,
            visibleItems.findIndex((b) => b.id === over.id),
            blockId,
          )
          moveToParent(blockId, projected.parentId, newPosition)
          return
        }
      }

      // Same-level reorder (no depth/parent change)
      if (active.id !== over.id) {
        const overIndex = blocks.findIndex((b) => b.id === over.id)
        if (overIndex >= 0) {
          reorder(blockId, overIndex)
        }
      }
    },
    [blocks, rootParentId, projected, visibleItems, moveToParent, reorder],
  )

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setOverId(null)
    setOffsetLeft(0)
  }, [])

  return {
    activeId,
    overId,
    projected,
    visibleItems,
    sensors,
    handleDragStart,
    handleDragMove,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  }
}
