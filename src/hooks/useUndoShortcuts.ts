/**
 * useUndoShortcuts — global keyboard shortcuts for undo/redo.
 *
 * Registers Ctrl+Z (undo) and Ctrl+Y / Ctrl+Shift+Z (redo) on the document.
 * Only fires when the page-editor view is active and the focus is
 * NOT inside a contentEditable, input, or textarea element.
 */

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import { useUndoStore } from '@/stores/undo'
import { getBlock } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'

/** Reload block store and refresh page title in nav store after undo/redo. */
async function refreshAfterUndoRedo(pageId: string): Promise<void> {
  await useBlockStore.getState().load(pageId)
  try {
    const pageBlock = await getBlock(pageId)
    if (pageBlock?.content) {
      useNavigationStore.getState().replacePage(pageId, pageBlock.content)
      useResolveStore.getState().set(pageId, pageBlock.content, false)
    }
  } catch {
    // Page title refresh is best-effort
  }
}

export function useUndoShortcuts(): void {
  const { t } = useTranslation()
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip if inside contentEditable, input, or textarea
      const target = e.target as HTMLElement
      if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return
      }

      const { currentView, pageStack } = useNavigationStore.getState()
      if (currentView !== 'page-editor' || pageStack.length === 0) return

      const pageId = pageStack[pageStack.length - 1]!.pageId

      // Ctrl+Z (or Cmd+Z on Mac) — Undo
      // Skip Ctrl+Shift+Z (that's page-level redo, handled below)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        useUndoStore
          .getState()
          .undo(pageId)
          .then(async (result) => {
            if (result) {
              toast(t('undo.undoneMessage'), { duration: 1500 })
              await refreshAfterUndoRedo(pageId)
            }
          })
          .catch(() => toast.error(t('undo.undoFailedMessage')))
        return
      }

      // Ctrl+Y (or Cmd+Y on Mac) or Ctrl+Shift+Z (Linux/Windows convention) — Redo
      if (
        ((e.ctrlKey || e.metaKey) && e.key === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z'))
      ) {
        e.preventDefault()
        useUndoStore
          .getState()
          .redo(pageId)
          .then(async (result) => {
            if (result) {
              toast(t('undo.redoneMessage'), { duration: 1500 })
              await refreshAfterUndoRedo(pageId)
            }
          })
          .catch(() => toast.error(t('undo.redoFailedMessage')))
        return
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [t])
}
