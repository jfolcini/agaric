/**
 * useEditorBlur — extracted blur-handling hook for the roving TipTap editor.
 *
 * Implements the 5-step guard chain:
 *   1. No active block -> bail
 *   2. Stale blur (editor moved to a different block) -> bail
 *   3. Early-persist for newly created (empty) blocks
 *   4. Portal / transient-UI guard (relatedTarget + visible-element scan)
 *   5. Unmount -> save-or-split -> discard draft -> clear focus
 *
 * B-56: Step 4b now scopes the portal scan to elements OUTSIDE the editor
 * wrapper (`e.currentTarget`). Elements inside the wrapper (e.g. the
 * formatting toolbar) are part of the editor lifecycle and must not prevent
 * save on external blur.
 *
 * Extracted from EditableBlock (M-42) for testability and reuse.
 */

import type React from 'react'
import { useCallback, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { shouldSplitOnBlur } from '../editor/use-roving-editor'
import { logger } from '../lib/logger'

/**
 * Single-attribute opt-in for transient UI elements (popups, toolbars,
 * pickers) that should NOT cause the editor to unmount when they receive
 * focus. New overlays opt in via markup — `<div data-editor-portal>…` —
 * instead of editing a hardcoded selector list (PEND-30 L-3).
 *
 * The legacy `EDITOR_PORTAL_SELECTORS` array (8 class selectors) is gone:
 * `.suggestion-popup`, `.suggestion-list`, `.formatting-toolbar`, `.rdp`
 * (the react-day-picker root — we tag our `Calendar` wrapper instead),
 * `.date-picker-popup`, `.property-key-editor`, `.block-context-menu`
 * all carry `data-editor-portal=""` on their outermost portal element.
 *
 * Tests / external code that historically imported the array can use
 * this selector string instead.
 */
export const EDITOR_PORTAL_SELECTOR = '[data-editor-portal]'

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
      // Step 1: No active block -> bail
      if (!rovingEditorRef.current.activeBlockId) return

      // Step 2: Stale blur (editor already moved to different block) -> bail
      // If the editor has already moved to a different block (e.g.
      // handleFocus called mount on another block), this blur is stale —
      // ignore it to prevent saving the wrong block's content to this one.
      if (rovingEditorRef.current.activeBlockId !== blockId) return

      // Step 3: Early-persist for new (empty) blocks
      // For new blocks (created empty), persist any typed content before
      // checking transient UI. This prevents data loss when a popup is in
      // the DOM but the user clicked outside.
      //
      // B-65: Only early-persist when the content does NOT need splitting.
      // Multi-paragraph content must go through Step 5's splitBlock path;
      // calling edit() here with the unsplit content and then splitBlock()
      // in Step 5 would create duplicate operations.
      if (rovingEditorRef.current.originalMarkdown === '' && rovingEditorRef.current.getMarkdown) {
        const content = rovingEditorRef.current.getMarkdown()
        if (content && content !== '' && !shouldSplitOnBlur(content)) {
          edit(blockId, content)
          // Don't return — continue to normal blur logic (unmount, setFocused, etc.)
        }
      }

      // Step 4a: Don't unmount if focus moved to a portal-tagged overlay
      // (suggestion popup, formatting toolbar, date picker, …). All such
      // transient UI elements opt in via `data-editor-portal` (PEND-30 L-3).
      const related = e.relatedTarget as HTMLElement | null
      if (related?.closest(EDITOR_PORTAL_SELECTOR)) {
        logger.debug('EditorBlur', 'blur prevented — focus moved to portal', { blockId })
        return
      }

      // Step 4b: Also check if a portal-tagged overlay is currently visible
      // in the DOM OUTSIDE the editor wrapper. Elements inside the wrapper
      // (e.g. formatting toolbar) are managed by the editor lifecycle and
      // must not prevent save on external blur (B-56). Radix leaves wrapper
      // elements mounted when closed (with visibility:hidden or opacity:0),
      // so we use checkVisibility() which detects display:none,
      // visibility:hidden, and opacity:0. Falls back to offsetParent for
      // older browsers.
      const wrapper = e.currentTarget as HTMLElement
      {
        const hasVisiblePopup = Array.from(
          document.querySelectorAll<HTMLElement>(EDITOR_PORTAL_SELECTOR),
        ).some((el) => {
          if (wrapper.contains(el)) return false
          if (typeof el.checkVisibility === 'function') {
            return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          }
          return el.offsetParent !== null
        })
        if (hasVisiblePopup) {
          logger.debug('EditorBlur', 'blur prevented — visible portal outside wrapper', {
            blockId,
          })
          return
        }
      }

      // Step 5: Unmount -> save or split -> discard draft -> clear focus
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
      }
      // Always discard draft on blur — even when content is unchanged, a
      // stale draft from a previous autosave cycle may exist in the database.
      discardDraft()
      logger.debug('editor', 'blur', { blockId })
      setFocused(null)
    },
    [blockId, edit, splitBlock, setFocused, discardDraft],
  )

  return { handleBlur }
}
