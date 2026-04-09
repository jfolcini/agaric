/**
 * useEditorBlur — extracted blur-handling hook for the roving TipTap editor.
 *
 * Implements the 5-step guard chain:
 *   1. No active block → bail
 *   2. Stale blur (editor moved to a different block) → bail
 *   3. Early-persist for newly created (empty) blocks
 *   4. Portal / transient-UI guard (relatedTarget + visible-element scan)
 *   5. Unmount → save-or-split → discard draft → clear focus
 *
 * Extracted from EditableBlock (M-42) for testability and reuse.
 */

import type React from 'react'
import { useCallback, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { shouldSplitOnBlur } from '../editor/use-roving-editor'

/**
 * CSS selectors for transient UI elements (popups, toolbars, pickers) that
 * should NOT cause the editor to unmount when they receive focus.
 * Add new entries here when introducing new popup-style UI.
 */
export const EDITOR_PORTAL_SELECTORS = [
  '.suggestion-popup',
  '.suggestion-list',
  '.formatting-toolbar',
  '[data-radix-popper-content-wrapper]',
  '.rdp',
  '.date-picker-popup',
  '.property-key-editor',
  '.block-context-menu',
]

export function useEditorBlur(params: {
  rovingEditor: Pick<
    RovingEditorHandle,
    'activeBlockId' | 'originalMarkdown' | 'getMarkdown' | 'unmount'
  >
  blockId: string
  edit: (blockId: string, content: string) => void
  splitBlock: (blockId: string, content: string) => void
  setFocused: (id: string | null) => void
  discardDraft: () => void
}): { handleBlur: (e: React.FocusEvent) => void } {
  const { blockId, edit, splitBlock, setFocused, discardDraft } = params

  // Store rovingEditor in a ref to avoid stale closures — the handle's
  // object identity changes on every render.
  const rovingEditorRef = useRef(params.rovingEditor)
  rovingEditorRef.current = params.rovingEditor

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      // Step 1: No active block → bail
      if (!rovingEditorRef.current.activeBlockId) return

      // Step 2: Stale blur (editor already moved to different block) → bail
      // If the editor has already moved to a different block (e.g.
      // handleFocus called mount on another block), this blur is stale —
      // ignore it to prevent saving the wrong block's content to this one.
      if (rovingEditorRef.current.activeBlockId !== blockId) return

      // Step 3: Early-persist for new (empty) blocks
      // For new blocks (created empty), persist any typed content before
      // checking transient UI. This prevents data loss when a popup is in
      // the DOM but the user clicked outside.
      if (rovingEditorRef.current.originalMarkdown === '' && rovingEditorRef.current.getMarkdown) {
        const content = rovingEditorRef.current.getMarkdown()
        if (content && content !== '') {
          edit(blockId, content)
          // Don't return — continue to normal blur logic (unmount, setFocused, etc.)
        }
      }

      // Step 4a: Don't unmount if focus moved to a suggestion popup, formatting
      // toolbar, or date picker — these are transient UI elements that need the
      // editor to stay mounted.
      const related = e.relatedTarget as HTMLElement | null
      if (related) {
        if (EDITOR_PORTAL_SELECTORS.some((sel) => related.closest(sel))) {
          return
        }
      }

      // Step 4b: Also check if a suggestion popup, date picker, or popover is
      // currently visible in the DOM. Radix leaves wrapper elements mounted when
      // closed (with visibility:hidden or opacity:0), so we use checkVisibility()
      // which detects display:none, visibility:hidden, and opacity:0. Falls back
      // to offsetParent for older browsers.
      if (
        EDITOR_PORTAL_SELECTORS.some((sel) => {
          const el = document.querySelector(sel) as HTMLElement | null
          if (!el) return false
          if (typeof el.checkVisibility === 'function') {
            return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          }
          // Fallback: offsetParent is null for display:none and hidden ancestors
          return el.offsetParent !== null
        })
      )
        return

      // Step 5: Unmount → save or split → discard draft → clear focus
      const changed = rovingEditorRef.current.unmount()
      if (changed !== null) {
        if (shouldSplitOnBlur(changed)) {
          flushSync(() => {
            splitBlock(blockId, changed)
          })
        } else {
          flushSync(() => {
            edit(blockId, changed)
          })
        }
        discardDraft()
      }
      setFocused(null)
    },
    [blockId, edit, splitBlock, setFocused, discardDraft],
  )

  return { handleBlur }
}
