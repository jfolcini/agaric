import * as React from 'react'
import { useIsMobile } from '@/hooks/useIsMobile'

/**
 * State hook for the Sidebar primitive.
 *
 * Extracted from `sidebar.tsx` to keep the host file focused on the 22
 * sub-component renderers. Owns:
 *   - Controlled / uncontrolled `open` state (with cookie persistence).
 *   - `openMobile` Sheet visibility.
 *   - `isMobile` viewport sense (delegated to `useIsMobile`).
 *   - `sidebarWidth` + `isResizing`, persisted to localStorage with
 *     min-width clamp and 50-vw soft cap.
 *   - `toggleSidebar` helper that respects the mobile/desktop split.
 *
 * Public API: returns the object used to seed `SidebarContext`. Consumers
 * read it via `useSidebar()` — this hook is only called inside
 * `SidebarProvider`.
 */

export const SIDEBAR_COOKIE_NAME = 'sidebar_state'
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
export const SIDEBAR_WIDTH_DEFAULT = 150
export const SIDEBAR_WIDTH_MIN = 120
export const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar_width'

export type SidebarState = {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: React.Dispatch<React.SetStateAction<boolean>>
  isMobile: boolean
  toggleSidebar: () => void
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  isResizing: boolean
  setIsResizing: React.Dispatch<React.SetStateAction<boolean>>
}

export type UseSidebarStateOptions = {
  defaultOpen?: boolean | undefined
  open?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
}

export function useSidebarState({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
}: UseSidebarStateOptions): SidebarState {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)

  // Sidebar width state — persisted in localStorage
  const [sidebarWidth, _setSidebarWidth] = React.useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
      if (stored) {
        const parsed = Number(stored)
        if (parsed >= SIDEBAR_WIDTH_MIN) return Math.min(parsed, window.innerWidth * 0.5)
      }
    } catch {
      // localStorage unavailable
    }
    return SIDEBAR_WIDTH_DEFAULT
  })
  const setSidebarWidth = React.useCallback((width: number) => {
    const maxWidth = Math.floor(window.innerWidth * 0.5)
    const clamped = Math.max(SIDEBAR_WIDTH_MIN, Math.min(maxWidth, width))
    _setSidebarWidth(clamped)
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped))
    } catch {
      // localStorage unavailable
    }
  }, [])

  const [isResizing, setIsResizing] = React.useState(false)

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }

      // This sets the cookie to keep the sidebar state.
      // biome-ignore lint/suspicious/noDocumentCookie: shadcn/ui sidebar state persistence
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
    },
    [setOpenProp, open],
  )

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen])

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? 'expanded' : 'collapsed'

  return {
    state,
    open,
    setOpen,
    isMobile,
    openMobile,
    setOpenMobile,
    toggleSidebar,
    sidebarWidth,
    setSidebarWidth,
    isResizing,
    setIsResizing,
  }
}
