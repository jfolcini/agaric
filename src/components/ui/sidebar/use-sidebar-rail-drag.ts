import * as React from 'react'

import { SIDEBAR_WIDTH_DEFAULT } from '@/components/ui/sidebar/use-sidebar-state'

/**
 * Pointer-drag resize handler for `SidebarRail`.
 *
 * Extracted from `sidebar.tsx`. Owns the entire pointer-drag dance:
 *   - Mousedown / touchdown latches start position + start width.
 *   - Pointermove past the 2-px hysteresis threshold sets `isResizing`
 *     (and, if the sidebar was collapsed, expands it so the drag can
 *     widen smoothly from 0).
 *   - Dragging below `SIDEBAR_WIDTH_ICON_PX` collapses the sidebar.
 *   - Pointerup that never moved is treated as a click → `toggleSidebar`.
 *   - FE-H-15: unmount during a drag must detach the `document`-level
 *     listeners (pointerup never fires in that case), so we track the
 *     active handles in a ref and clean them up in the unmount effect.
 *
 * The hook also exposes an `onDoubleClick` helper that resets the width
 * to the default and forces the sidebar open.
 */

const SIDEBAR_WIDTH_ICON_PX = 48 // 3rem at 16px base

export interface UseSidebarRailDragOptions {
  open: boolean
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  setOpen: (open: boolean) => void
  setIsResizing: React.Dispatch<React.SetStateAction<boolean>>
  toggleSidebar: () => void
}

export interface UseSidebarRailDragReturn {
  onPointerDown: (event: React.PointerEvent) => void
  onDoubleClick: () => void
}

export function useSidebarRailDrag({
  open,
  sidebarWidth,
  setSidebarWidth,
  setOpen,
  setIsResizing,
  toggleSidebar,
}: UseSidebarRailDragOptions): UseSidebarRailDragReturn {
  const dragState = React.useRef({
    dragging: false,
    startX: 0,
    startWidth: 0,
    moved: false,
    wasCollapsed: false,
  })
  // FE-H-15: track the active drag's listener handles so an unmount mid-drag
  // can detach them from `document` (the pointerup handler never fires in that
  // case, leaving stale listeners attached otherwise).
  const dragListenersRef = React.useRef<{
    move: (e: PointerEvent) => void
    up: (e: PointerEvent) => void
  } | null>(null)

  const onDoubleClick = React.useCallback(() => {
    setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)
    setOpen(true)
  }, [setSidebarWidth, setOpen])

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const state = dragState.current
      state.dragging = true
      state.startX = e.clientX
      state.wasCollapsed = !open
      // When collapsed, start from 0 so dragging right opens smoothly
      state.startWidth = open ? sidebarWidth : 0
      state.moved = false

      const onPointerMove = (ev: PointerEvent) => {
        if (!state.dragging) return
        const delta = ev.clientX - state.startX
        if (Math.abs(delta) > 2 && !state.moved) {
          state.moved = true
          setIsResizing(true)
          // When dragging from collapsed state, open the sidebar
          if (state.wasCollapsed) {
            setOpen(true)
          }
        }
        if (state.moved) {
          const newWidth = state.startWidth + delta
          if (newWidth < SIDEBAR_WIDTH_ICON_PX) {
            // Dragged below icon width — collapse
            state.dragging = false
            document.removeEventListener('pointermove', onPointerMove)
            document.removeEventListener('pointerup', onPointerUp)
            dragListenersRef.current = null
            document.documentElement.style.cursor = ''
            document.body.style.userSelect = ''
            setIsResizing(false)
            setOpen(false)
            return
          }
          setSidebarWidth(newWidth)
        }
      }

      const onPointerUp = () => {
        state.dragging = false
        document.removeEventListener('pointermove', onPointerMove)
        document.removeEventListener('pointerup', onPointerUp)
        dragListenersRef.current = null
        document.documentElement.style.cursor = ''
        document.body.style.userSelect = ''
        if (state.moved) {
          setIsResizing(false)
        } else {
          // If we didn't drag, treat as a click → toggle
          toggleSidebar()
        }
      }

      document.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerup', onPointerUp)
      dragListenersRef.current = { move: onPointerMove, up: onPointerUp }
      document.documentElement.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [open, sidebarWidth, setSidebarWidth, toggleSidebar, setIsResizing, setOpen],
  )

  // FE-H-15: if the rail unmounts mid-drag, detach the still-attached
  // `document` listeners so they do not leak and reference stale state.
  React.useEffect(
    () => () => {
      const handles = dragListenersRef.current
      if (handles) {
        document.removeEventListener('pointermove', handles.move)
        document.removeEventListener('pointerup', handles.up)
        dragListenersRef.current = null
      }
    },
    [],
  )

  return { onPointerDown, onDoubleClick }
}
