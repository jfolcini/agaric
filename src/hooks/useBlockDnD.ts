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

import { logger } from '@/lib/logger'

import { INDENT_WIDTH } from '../components/SortableBlock'
import {
  computeDropIndex,
  type FlatBlock,
  getDragDescendants,
  getProjection,
  type Projection,
  SENTINEL_ID,
} from '../lib/tree-utils'
import { useAutoScrollOnDrag } from './useAutoScrollOnDrag'
import { useIsMobile } from './useIsMobile'

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

  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor

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
      if (rovingEditorRef.current.activeBlockId) {
        handleFlush()
        setFocused(null)
      }
    },
    [handleFlush, setFocused],
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

      // UX-241: on success restore focus on the dragged block so EditableBlock's
      // `isFocused` effect re-fires `scrollIntoView` and the viewport tracks it.
      // Only restore on success — if the move rejects, leave focus cleared.
      const restoreFocusOnSuccess = (label: string, p: Promise<unknown>) =>
        p
          .then(() => setFocused(blockId))
          .catch((err: unknown) => {
            logger.warn(
              'useBlockDnD',
              `${label} failed after drag — focus cleared`,
              { blockId },
              err,
            )
          })

      if (projected && activeBlock) {
        const currentParentId = activeBlock.parent_id ?? rootParentId
        const parentChanged = projected.parentId !== currentParentId
        // #400: send the 0-based sibling slot; the backend derives the
        // convergent fractional key (no colliding / `<= 0` positions).
        const newIndex = computeDropIndex(
          visibleItems,
          projected.parentId,
          over.id as string,
          blockId,
        )

        if (parentChanged) {
          // Reparent / nest / change depth → structural change needs a refetch.
          restoreFocusOnSuccess('moveToParent', moveToParent(blockId, projected.parentId, newIndex))
          return
        }

        // R5 (#404): a same-parent reorder takes the optimistic local-splice
        // path instead of `moveToParent`'s full `load()` refetch.
        if (active.id !== over.id || (over.id as string) === SENTINEL_ID) {
          restoreFocusOnSuccess('reorder', reorder(blockId, newIndex))
        }
        return
      }

      // Fallback (no projection): same-parent reorder by sibling slot.
      if (active.id !== over.id) {
        const newIndex = computeDropIndex(
          blocks,
          activeBlock?.parent_id ?? rootParentId,
          over.id as string,
          blockId,
        )
        restoreFocusOnSuccess('reorder', reorder(blockId, newIndex))
      }
    },
    [blocks, rootParentId, projected, visibleItems, moveToParent, reorder, setFocused],
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
