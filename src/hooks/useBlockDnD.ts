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

import { INDENT_WIDTH } from '@/components/editor/SortableBlock'
import { logger } from '@/lib/logger'

import {
  computeDropIndex,
  computeSelectionRoots,
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
  /**
   * Parent that depth-0 drops in `collapsedVisible` resolve to. This is the
   * page root normally, but the ZOOMED block id when a zoom is active (#712):
   * `zoomedVisible` rebases depth to 0 at the zoomed block's children, so a
   * depth-0 projection must reparent to the zoomed block, not the page root.
   */
  rootParentId: string | null
  rovingEditor: { activeBlockId: string | null }
  /**
   * #914 — global multi-selection. When the dragged block is one of these and
   * the selection has >1 root, the drag moves the WHOLE selection (see
   * `handleDragEnd`). Optional/omittable: when absent or single, drag falls back
   * to the single-block behaviour.
   */
  selectedBlockIds?: string[]
  handleFlush: () => string | null
  setFocused: (id: string | null) => void
  reorder: (blockId: string, newIndex: number) => Promise<void>
  moveToParent: (blockId: string, newParentId: string | null, newPosition: number) => Promise<void>
  /**
   * #914 — move a contiguous set of selection-root blocks under a new parent at
   * a 0-based sibling slot. Required for multi-select drag; optional so call
   * sites that never multi-select can omit it.
   */
  moveBlocks?: (ids: string[], newParentId: string | null, newIndex: number) => Promise<void>
  scrollContainerRef?: RefObject<HTMLElement | null>
}

export interface UseBlockDnDReturn {
  activeId: string | null
  overId: string | null
  projected: Projection | null
  visibleItems: FlatBlock[]
  /**
   * #914 — whether the active drag is moving the whole multi-selection (the
   * dragged block is one of >1 selection roots) rather than a single block.
   */
  isMultiDrag: boolean
  /**
   * #914 — selection roots being moved by the active multi-select drag, in
   * document order. Empty unless `isMultiDrag` is true.
   */
  dragRoots: string[]
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
  selectedBlockIds,
  handleFlush,
  setFocused,
  reorder,
  moveToParent,
  moveBlocks,
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

  // Height of the dragged subtree (max descendant depth − active depth), so the
  // projection can't offer a depth whose descendants would exceed
  // MAX_BLOCK_DEPTH and get rejected by the backend (#928).
  const subtreeHeight = useMemo(() => {
    if (!activeId || activeDescendants.size === 0) return 0
    const activeDepth = collapsedVisible.find((b) => b.id === activeId)?.depth ?? 0
    let h = 0
    for (const b of collapsedVisible) {
      if (activeDescendants.has(b.id)) h = Math.max(h, b.depth - activeDepth)
    }
    return h
  }, [activeId, activeDescendants, collapsedVisible])

  // Projection of where the dragged item would land
  const projected = useMemo(() => {
    if (!activeId || !overId) return null
    return getProjection(
      visibleItems,
      activeId,
      overId,
      offsetLeft,
      INDENT_WIDTH,
      rootParentId,
      subtreeHeight,
    )
  }, [activeId, overId, offsetLeft, visibleItems, rootParentId, subtreeHeight])

  // #914 — selection roots for the active drag. When the dragged block is part
  // of a multi-selection, the whole selection moves as one gesture. We collapse
  // the selection to its top-level "roots" (selected blocks not already nested
  // inside another selected block) so a nested selected child travels inside its
  // ancestor's subtree instead of being moved independently. Computed against
  // the full `blocks` (true tree) so collapsed/zoomed views don't drop roots.
  // A drag is a multi-drag only when the dragged block is itself a root AND
  // there is more than one root — otherwise it stays single-block behaviour.
  const dragRoots = useMemo(() => {
    if (!activeId || !selectedBlockIds || selectedBlockIds.length <= 1) return []
    if (!selectedBlockIds.includes(activeId)) return []
    const roots = computeSelectionRoots(blocks, selectedBlockIds)
    if (roots.length <= 1 || !roots.includes(activeId)) return []
    return roots
  }, [activeId, selectedBlockIds, blocks])

  const isMultiDrag = dragRoots.length > 1

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

      // #914 — multi-select drag. When the dragged block is one of >1 selection
      // roots, relocate the WHOLE selection (contiguous, order-preserving) to
      // the projected slot instead of moving just the active block + its own
      // subtree. Requires a projection (drop position) and the `moveBlocks`
      // action; otherwise fall through to single-block behaviour.
      if (isMultiDrag && projected && activeBlock && moveBlocks) {
        // The drop slot is computed for the active block as if it alone moved;
        // the other roots land contiguously after it (moveBlocks fans out the
        // consecutive slots). #400: 0-based sibling slot under projected parent.
        const newIndex = computeDropIndex(
          visibleItems,
          projected.parentId,
          over.id as string,
          blockId,
        )
        restoreFocusOnSuccess('moveBlocks', moveBlocks(dragRoots, projected.parentId, newIndex))
        return
      }

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
    [
      blocks,
      rootParentId,
      projected,
      visibleItems,
      moveToParent,
      reorder,
      setFocused,
      isMultiDrag,
      dragRoots,
      moveBlocks,
    ],
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
    isMultiDrag,
    dragRoots,
    sensors,
    handleDragStart,
    handleDragMove,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  }
}
