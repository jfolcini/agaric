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
import { consumePreDragFocus } from '@/lib/pre-drag-focus'

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
import { useIsTouch } from './useIsTouch'

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

/**
 * #929 — resolve the *rendered* indent width (the CSS `--indent-width` custom
 * property) so the drag's pointer-distance-per-level matches the indent guides.
 * The JS `INDENT_WIDTH` constant is 24, but the CSS var drops to 16px on coarse
 * pointers and 12px on ≤640px viewports (see index.css). Reading the constant
 * made the drag disagree with the guides on those viewports. Falls back to
 * `INDENT_WIDTH` when unset / unparseable / SSR (no `window`/`document`).
 */
function resolveIndentWidth(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return INDENT_WIDTH
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--indent-width').trim()
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : INDENT_WIDTH
}

export interface UseBlockDnDReturn {
  activeId: string | null
  overId: string | null
  projected: Projection | null
  /**
   * #923 — whether the projected drop lands AFTER the over-row (i.e. the user
   * is dragging downward, with the active block currently above the over-row in
   * document order). The drop indicator renders BELOW the over-row when true,
   * ABOVE it when false. Null when there is no active drag / over-target.
   */
  dropAfter: boolean
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
  // #929 — the rendered `--indent-width` resolved at drag start, so the
  // projection's pointer-distance-per-level matches the visible indent guides
  // on coarse/narrow viewports (where the CSS var differs from INDENT_WIDTH).
  const [indentWidth, setIndentWidth] = useState<number>(() => resolveIndentWidth())

  // Auto-scroll when dragging near viewport edges
  const fallbackRef = useRef<HTMLElement | null>(null)
  useAutoScrollOnDrag(scrollContainerRef ?? fallbackRef, !!activeId)

  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor

  // #923 — the block that was being edited when the drag began. `handleDragStart`
  // clears focus (flush + setFocused(null)); if the drag is then CANCELLED (Esc)
  // or ends as a no-op (released over nothing), we restore this focus so the user
  // lands back where they were instead of with no focused block.
  const preDragFocusedIdRef = useRef<string | null>(null)

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
      indentWidth,
      rootParentId,
      subtreeHeight,
    )
  }, [activeId, overId, offsetLeft, visibleItems, rootParentId, subtreeHeight, indentWidth])

  // #923 — direction of the projected drop relative to the over-row. The drop
  // lands AFTER the over-row when the active block currently sits ABOVE it in
  // document order (dragging downward). Derived from indices in `visibleItems`
  // (descendants of the active block are already excluded, so the comparison is
  // purely between the head and the over-row). False when over the active row
  // itself, the sentinel, or either id is absent — the indicator then renders
  // above, matching the prior always-top behaviour.
  const dropAfter = useMemo(() => {
    if (!activeId || !overId || activeId === overId) return false
    const activeIndex = visibleItems.findIndex((b) => b.id === activeId)
    const overIndex = visibleItems.findIndex((b) => b.id === overId)
    if (activeIndex < 0 || overIndex < 0) return false
    return activeIndex < overIndex
  }, [activeId, overId, visibleItems])

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
  // #926 — discriminate the drag-activation by POINTER COARSENESS, not viewport
  // width. The gutter/drag-handle already renders on `useIsTouch()` (pointer:
  // coarse); using `useIsMobile()` (width < 768) here disagreed with it — a
  // narrow desktop window got the 250ms press-and-hold sensor with a mouse
  // (laggy), and a large touch tablet (width ≥ 768) got the 8px mouse sensor
  // (drag fights scroll). Aligning to pointer:coarse fixes both edges.
  // Coarse pointer → press-and-hold (250ms) so a drag doesn't fight scroll;
  // fine pointer → 8px distance so a click still works.
  const isTouch = useIsTouch()
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: isTouch ? { delay: 250, tolerance: 5 } : { distance: 8 },
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
      // #929 — re-resolve the rendered indent width at the start of each drag
      // so a viewport/media-query change since mount is reflected.
      setIndentWidth(resolveIndentWidth())

      // #923 — capture the pre-drag focused block so a cancel/no-op can restore it.
      //
      // #966 — for a HANDLE-initiated drag, the handle's `pointerdown` already
      // blurred the contenteditable and `useEditorBlur` tore the editor down
      // (`activeBlockId` → null, `setFocused(null)`) BEFORE this `handleDragStart`
      // runs past the 8px threshold. So `rovingEditor.activeBlockId` is already
      // null here and #923 had nothing to restore. The drag handle snapshots the
      // focus in its `pointerdown` (before that blur) via `capturePreDragFocus`;
      // consume it as the fallback. The live `activeBlockId` is still preferred
      // (keyboard-initiated drags keep focus and never press the handle), and we
      // ALWAYS consume so a handle press that never became a drag can't leak a
      // stale id into a later keyboard drag.
      const liveFocus = rovingEditorRef.current.activeBlockId
      const capturedFocus = consumePreDragFocus()
      preDragFocusedIdRef.current = liveFocus ?? capturedFocus

      // Flush editor if active
      if (liveFocus) {
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

      // #923 — released over nothing: no move, so restore the pre-drag focus
      // (a successful move below restores focus on the dragged block instead).
      if (!over) {
        if (preDragFocusedIdRef.current) setFocused(preDragFocusedIdRef.current)
        preDragFocusedIdRef.current = null
        return
      }
      preDragFocusedIdRef.current = null

      const blockId = active.id as string
      const activeBlock = blocks.find((b) => b.id === blockId)

      // On success restore focus on the dragged block so EditableBlock's
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
      // action.
      if (isMultiDrag && projected && activeBlock) {
        // #1593 — `moveBlocks` is the only path that can relocate the whole
        // selection. If it's not wired, do NOT fall through to the single-block
        // path: that would silently move just the active block's subtree while
        // the rest of the visible selection stays put — which looks like a bug.
        // No-op the drop with a warning instead. (Latent: the live BlockTree
        // always passes `moveBlocks`.)
        if (!moveBlocks) {
          logger.warn(
            'useBlockDnD',
            'multi-select drag dropped: `moveBlocks` is not wired, so the whole selection cannot be moved (refusing to relocate just the active block)',
            { dragRoots },
          )
          return
        }
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
    // #923 — Esc-cancel returns the user to the block they were editing.
    if (preDragFocusedIdRef.current) setFocused(preDragFocusedIdRef.current)
    preDragFocusedIdRef.current = null
  }, [setFocused])

  return {
    activeId,
    overId,
    projected,
    dropAfter,
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
