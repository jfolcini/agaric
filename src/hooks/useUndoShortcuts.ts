/**
 * useUndoShortcuts — global keyboard shortcuts for undo/redo.
 *
 * Registers Ctrl+Z (undo) and Ctrl+Y (redo) on the document.
 * Only fires when the page-editor view is active and the focus is
 * NOT inside a contentEditable, input, or textarea element.
 */

import { useEffect } from 'react'
import { toast } from 'sonner'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import { useUndoStore } from '@/stores/undo'
import { getBlock } from '../lib/tauri'

/** Reload block store and refresh page title in nav store after undo/redo. */
async function refreshAfterUndoRedo(pageId: string): Promise<void> {
  await useBlockStore.getState().load(pageId)
  try {
    const pageBlock = await getBlock(pageId)
    if (pageBlock?.content) {
      useNavigationStore.getState().replacePage(pageId, pageBlock.content)
    }
  } catch {
    // Page title refresh is best-effort
  }
}

export function useUndoShortcuts(): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip if inside contentEditable, input, or textarea
      const target = e.target as HTMLElement
      if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return
      }

      const { currentView, pageStack } = useNavigationStore.getState()
      if (currentView !== 'page-editor' || pageStack.length === 0) return

      const pageId = pageStack[pageStack.length - 1].pageId

      // Ctrl+Z (or Cmd+Z on Mac) — Undo
      // Skip Ctrl+Shift+Z (that's TipTap's redo, handled by the editor)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        useUndoStore
          .getState()
          .undo(pageId)
          .then(async (result) => {
            if (result) {
              toast('Undone', { duration: 1500 })
              await refreshAfterUndoRedo(pageId)
            }
          })
          .catch(() => toast.error('Undo failed'))
        return
      }

      // Ctrl+Y (or Cmd+Y on Mac) — Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault()
        useUndoStore
          .getState()
          .redo(pageId)
          .then(async (result) => {
            if (result) {
              toast('Redone', { duration: 1500 })
              await refreshAfterUndoRedo(pageId)
            }
          })
          .catch(() => toast.error('Redo failed'))
        return
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])
}
