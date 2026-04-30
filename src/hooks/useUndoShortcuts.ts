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
import { useNavigationStore } from '@/stores/navigation'
import { pageBlockRegistry } from '@/stores/page-blocks'
import { selectPageStack, useTabsStore } from '@/stores/tabs'
import { useUndoStore } from '@/stores/undo'
import { announce } from '../lib/announcer'
import { getBlock } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'

/** Reload block store and refresh page title in nav store after undo/redo. */
async function refreshAfterUndoRedo(pageId: string): Promise<void> {
  await pageBlockRegistry.get(pageId)?.getState().load()
  try {
    const pageBlock = await getBlock(pageId)
    if (pageBlock?.content) {
      useTabsStore.getState().replacePage(pageId, pageBlock.content)
      useResolveStore.getState().set(pageId, pageBlock.content, false)
    }
  } catch {
    // Page title refresh is best-effort
  }
}

/**
 * Convert a backend op_type string (snake_case, e.g. `create_block`) into the
 * camelCase form used in i18n keys (e.g. `createBlock`). Required because the
 * i18n key schema allows only `namespace.name` alphanumerics. Returns empty
 * string for nullish input so the caller falls back to the generic message.
 */
function snakeToCamel(s: string | null | undefined): string {
  if (typeof s !== 'string') return ''
  return s.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase())
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

      const navState = useNavigationStore.getState()
      const pageStack = selectPageStack(useTabsStore.getState())
      if (navState.currentView !== 'page-editor' || pageStack.length === 0) return

      const pageId = pageStack[pageStack.length - 1]?.pageId as string

      // Ctrl+Z (or Cmd+Z on Mac) — Undo
      // Skip Ctrl+Shift+Z (that's page-level redo, handled below)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        useUndoStore
          .getState()
          .undo(pageId)
          .then(async (result) => {
            if (result) {
              // Use per-op-type translation; fall back to generic "Undone" if unknown.
              const opKey = `undo.op.${snakeToCamel(result.reversed_op_type)}`
              const message = t(opKey, { defaultValue: t('undo.undoneMessage') })
              toast(message, { duration: 1500 })
              announce(t('announce.undone'))
              await refreshAfterUndoRedo(pageId)
            }
          })
          .catch(() => {
            toast.error(t('undo.undoFailedMessage'))
            announce(t('announce.undoFailed'))
          })
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
              // Use per-op-type translation; fall back to generic "Redone" if unknown.
              const opKey = `redo.op.${snakeToCamel(result.reversed_op_type)}`
              const message = t(opKey, { defaultValue: t('undo.redoneMessage') })
              toast(message, { duration: 1500 })
              announce(t('announce.redone'))
              await refreshAfterUndoRedo(pageId)
            }
          })
          .catch(() => {
            toast.error(t('undo.redoFailedMessage'))
            announce(t('announce.redoFailed'))
          })
        return
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [t])
}
