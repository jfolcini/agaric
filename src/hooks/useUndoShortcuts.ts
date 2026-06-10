/**
 * useUndoShortcuts — global keyboard shortcuts for undo/redo.
 *
 * Registers Ctrl+Z (undo) and Ctrl+Y / Ctrl+Shift+Z (redo) on the document.
 * Only fires when the page-editor view is active and the focus is
 * NOT inside a contentEditable, input, or textarea element.
 */

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { notify } from '@/lib/notify'
import { useNavigationStore } from '@/stores/navigation'
import { pageBlockRegistry } from '@/stores/page-blocks'
import { selectPageStack, useTabsStore } from '@/stores/tabs'
import { useUndoStore } from '@/stores/undo'

import { announce } from '../lib/announcer'
import { matchesShortcutBinding } from '../lib/keyboard-config'
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

      // `undoLastPageOp` (Ctrl/Cmd+Z by default) — routed through
      // `matchesShortcutBinding` (#724) so Settings rebinds are honoured.
      // The default binding carries no Shift requirement, so Ctrl+Shift+Z
      // (page-level redo, handled below) does not match it.
      if (matchesShortcutBinding(e, 'undoLastPageOp')) {
        e.preventDefault()
        useUndoStore
          .getState()
          .undo(pageId)
          .then(async (result) => {
            if (result) {
              // Use per-op-type translation; fall back to generic t('undo.undoneMessage') if unknown.
              const opKey = `undo.op.${snakeToCamel(result.reversed_op_type)}`
              const message = t(opKey, { defaultValue: t('undo.undoneMessage') })
              notify(message, { duration: 1500 })
              announce(t('announce.undone'))
              await refreshAfterUndoRedo(pageId)
            }
          })
          .catch(() => {
            notify.error(t('undo.undoFailedMessage'))
            announce(t('announce.undoFailed'))
          })
        return
      }

      // `redoLastUndoneOp` (Ctrl+Y / Ctrl+Shift+Z by default — the catalog
      // lists both alternatives) — routed through `matchesShortcutBinding`
      // (#724) so Settings rebinds are honoured.
      if (matchesShortcutBinding(e, 'redoLastUndoneOp')) {
        e.preventDefault()
        useUndoStore
          .getState()
          .redo(pageId)
          .then(async (result) => {
            if (result) {
              // Use per-op-type translation; fall back to generic t('undo.redoneMessage') if unknown.
              const opKey = `redo.op.${snakeToCamel(result.reversed_op_type)}`
              const message = t(opKey, { defaultValue: t('undo.redoneMessage') })
              notify(message, { duration: 1500 })
              announce(t('announce.redone'))
              await refreshAfterUndoRedo(pageId)
            }
          })
          .catch(() => {
            notify.error(t('undo.redoFailedMessage'))
            announce(t('announce.redoFailed'))
          })
        return
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [t])
}
