import * as React from 'react'

import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { TOGGLE_SIDEBAR_EVENT } from '@/lib/overlay-events'

/**
 * Keyboard shortcut handler for the Sidebar primitive.
 *
 * Extracted from `sidebar.tsx`. Binds the rebindable `toggleSidebar`
 * shortcut (`Cmd+B` / `Ctrl+B` by default — routed through
 * `matchesShortcutBinding`, #724) to `toggleSidebar()` at the `window`
 * level, but bails out when the user is editing in an input/textarea or
 * any contenteditable surface (TipTap maps Ctrl+B to Bold).
 *
 * #2942 — also listens for `TOGGLE_SIDEBAR_EVENT`, the editor-agnostic
 * signal the command palette's "Toggle sidebar" entry dispatches
 * (`palette-commands.ts` is a plain module outside the React tree and
 * can't reach `toggleSidebar()` — sidebar open/closed state lives in this
 * provider's local context, not a store).
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
    const handleToggleEvent = () => toggleSidebar()

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener(TOGGLE_SIDEBAR_EVENT, handleToggleEvent)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener(TOGGLE_SIDEBAR_EVENT, handleToggleEvent)
    }
  }, [toggleSidebar])
}
