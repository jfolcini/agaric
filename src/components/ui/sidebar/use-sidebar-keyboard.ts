import * as React from 'react'

/**
 * Keyboard shortcut handler for the Sidebar primitive.
 *
 * Extracted from `sidebar.tsx`. Binds `Cmd+B` / `Ctrl+B` to
 * `toggleSidebar()` at the `window` level, but bails out when the user is
 * editing in an input/textarea or any contenteditable surface (TipTap maps
 * Ctrl+B to Bold).
 */

export const SIDEBAR_KEYBOARD_SHORTCUT = 'b'

export function useSidebarKeyboard(toggleSidebar: () => void): void {
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        // Skip when user is editing — Ctrl+B is Bold in TipTap
        const target = event.target as HTMLElement | null
        if (target) {
          const tag = target.tagName?.toLowerCase()
          if (tag === 'input' || tag === 'textarea') return
          if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true')
            return
        }
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleSidebar])
}
