import * as React from 'react'

import { matchesShortcutBinding } from '@/lib/keyboard-config'

/**
 * Keyboard shortcut handler for the Sidebar primitive.
 *
 * Extracted from `sidebar.tsx`. Binds the rebindable `toggleSidebar`
 * shortcut (`Cmd+B` / `Ctrl+B` by default — routed through
 * `matchesShortcutBinding`, #724) to `toggleSidebar()` at the `window`
 * level, but bails out when the user is editing in an input/textarea or
 * any contenteditable surface (TipTap maps Ctrl+B to Bold).
 */

export function useSidebarKeyboard(toggleSidebar: () => void): void {
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcutBinding(event, 'toggleSidebar')) return
      // Skip when user is editing — Ctrl+B is Bold in TipTap
      const target = event.target as HTMLElement | null
      if (target) {
        const tag = target.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea') return
        if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true') return
      }
      event.preventDefault()
      toggleSidebar()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleSidebar])
}
