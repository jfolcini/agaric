/**
 * useUndoShortcuts — global keyboard shortcuts for undo/redo.
 *
 * Registers Ctrl+Z (undo) and Ctrl+Y / Ctrl+Shift+Z (redo) on the document.
 * Performs a real page-level undo/redo only when the page-editor view is
 * active and the focus is NOT inside a contentEditable, input, or textarea
 * element.
 *
 * #2941 — Journal view (the default landing view) is a DIFFERENT case, not
 * covered by "not page-editor". Journal days ARE pages — per-page undo
 * already works there via the swipe-to-delete "Undo" toast (`performPageUndo`
 * pinned to the day's own pageId, read from the block's page-store React
 * context). But THIS document-level listener has no page context to read: it
 * has no reliable, already-tracked signal for which day-page the user last
 * touched (weekly/monthly render many day-pages at once and nothing records
 * a global "last focused page"). Rather than silently no-op (the pre-#2941
 * bug users hit on the default view), the journal branch surfaces a toast
 * pointing at the working per-block History alternative. See
 * `notifyJournalUndoUnavailable` below.
 */

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { announce } from '@/lib/announcer'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { t as translate } from '@/lib/i18n'
import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { invalidateNameCaches } from '@/lib/name-change-bus'
import { notify } from '@/lib/notify'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import { getPageStore } from '@/stores/page-blocks'
import { renamePage } from '@/stores/page-rename'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'
import { useUndoStore } from '@/stores/undo'

/**
 * Reload block store and refresh page title in nav store after undo/redo.
 *
 * #4391 — `spaceId` is threaded in, not read here: by the time this runs the
 * undo/redo IPC has already awaited, and `load()` and `getBlock` await again
 * below, so a read taken here would be a fresh emit-time read of a value the
 * user may have changed in between. Callers capture it in the tick the
 * user's undo/redo gesture is handled. See `@/stores/page-rename`.
 *
 * #4534 — this is also where an undo/redo pays back the picker's name caches.
 * Every EVICTING publisher on the bus owes a RESTORE signal to whatever can
 * reverse it, and the reverse of a delete is not a rename: it puts rows BACK.
 * The pairing is already explicit on the two other delete surfaces —
 * `PageBrowserBatchToolbar.handleUndoTrash` and
 * `usePageDeleteAction.handleUndo` both call `invalidateNameCaches()` next to
 * their `restore_blocks_by_ids` — and #4524 added a third evicting publisher
 * (`useBlockMultiSelect.handleBatchDelete`) whose only advertised escape
 * hatch is the Ctrl+Z that lands HERE. Without this call the block tree's
 * batch delete leaves the page restored in the DB and back in the tree, yet
 * permanently missing from `[[` for the rest of the session — a page the user
 * cannot link to but can see, which is the worse polarity of the same
 * stale-cache class #4007 exists to close.
 *
 * Why a blanket invalidation and not a targeted re-add: the undo store is
 * ref-addressed and reports only `reversed_op_type` — it cannot say WHICH
 * pages (if any) came back, and a delete cascades to nested pages nobody
 * named. That is exactly `usePageDeleteAction.handleUndo`'s reasoning: an
 * EMPTY cache means "not fetched for this space yet", so re-adding the one id
 * we could name would latch a partial list as the whole space. Drop both
 * caches and let the next picker read re-fetch. Unconditional on purpose —
 * `invalidated` needs no space to compare against (see the name-change-bus
 * docblock), and every caller has already checked that an op was really
 * reversed (`if (!result) return`), so a no-op Ctrl+Z costs nothing here.
 *
 * It runs BEFORE the title-refresh `try` below, not inside it: the cache drop
 * is a correctness obligation of the undo, while the `getBlock` title refresh
 * is documented best-effort and swallows its own failures. Ordering it after
 * would silently make the obligation conditional on that best-effort IPC.
 */
async function refreshAfterUndoRedo(pageId: string, spaceId: string | null): Promise<void> {
  await getPageStore(pageId)?.getState().load()
  invalidateNameCaches()
  try {
    const pageBlock = unwrap(await commands.getBlock(pageId))
    if (pageBlock?.content) {
      // #3322 — one fan-out to every store that holds a title copy (tabs +
      // recents + resolve); see `@/stores/page-rename`.
      renamePage(pageId, pageBlock.content, spaceId)
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

/**
 * Undo the last page op for `pageId` and surface the standard feedback
 * (per-op-type toast, screen-reader announcement, store reload). Shared by
 * the Ctrl+Z keyboard shortcut and the swipe-to-delete "Undo" toast action
 * (#927 finding 7) so both routes are byte-for-byte identical — the gesture's
 * safety net replays the exact same reverse op the keyboard would.
 *
 * Uses the standalone `t` (not the React `useTranslation` hook) so it is
 * safe to call from a toast action callback outside the component tree.
 * Returns a promise that resolves once the undo + reload settle (rejections
 * are surfaced as an error toast and swallowed).
 */
export async function performPageUndo(pageId: string): Promise<void> {
  // #4391 — every route into here (the Ctrl+Z handler, `performActivePageUndo`
  // and the swipe-to-delete toast action) reaches this line synchronously from
  // the user's gesture, so this is the last point before the first `await`
  // and the space the user decided to undo IN. See `@/stores/page-rename`.
  const spaceId = useSpaceStore.getState().currentSpaceId
  try {
    const result = await useUndoStore.getState().undo(pageId)
    if (!result) return
    const opKey = `undo.op.${snakeToCamel(result.reversed_op_type)}`
    const message = translate(opKey, { defaultValue: translate('undo.undoneMessage') })
    notify(message, { duration: 1500 })
    announce(translate('announce.undone'))
    await refreshAfterUndoRedo(pageId, spaceId)
  } catch {
    notify.error(translate('undo.undoFailedMessage'))
    announce(translate('announce.undoFailed'))
  }
}

/**
 * Surface feedback for Ctrl+Z/Ctrl+Y in Journal view (#2941) instead of the
 * previous silent no-op. Shared by the keyboard handler and
 * `performActivePageUndo` (its swipe-to-delete fallback path — see
 * `SortableBlock.tsx`) so both routes give identical feedback. Uses the
 * standalone `t` so it is safe to call outside the component tree.
 */
function notifyJournalUndoUnavailable(): void {
  notify(translate('undo.journalUndoUnavailableMessage'), { duration: 2500 })
  announce(translate('announce.undoUnavailableJournal'))
}

/**
 * Resolve the currently-active page (top of the page stack, page-editor view
 * only) and undo its last op. Returns `false` when there is no active page to
 * act on (so callers can decide whether to no-op). Mirrors the pageId
 * derivation used by the Ctrl+Z shortcut handler.
 *
 * #2941 — in Journal view this can't resolve a target page (see the module
 * doc comment), so it surfaces the same "unavailable" feedback the keyboard
 * handler does rather than silently doing nothing.
 */
export async function performActivePageUndo(): Promise<boolean> {
  const navState = useNavigationStore.getState()
  if (navState.currentView === 'journal') {
    notifyJournalUndoUnavailable()
    return false
  }
  const pageStack = selectPageStack(useTabsStore.getState())
  if (navState.currentView !== 'page-editor' || pageStack.length === 0) return false
  const pageId = pageStack.at(-1)?.pageId
  if (!pageId) return false
  await performPageUndo(pageId)
  return true
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

      // Skip while the roving block editor is mounted. A `data-editor-portal`
      // overlay (context menu, date picker) can hold DOM focus on a plain
      // button while the editor's blur is suppressed (useEditorBlur Step 4a),
      // leaving it mounted with UNFLUSHED edits — the tag guard above doesn't
      // catch that target. Running page-level undo/redo then diverges the
      // editor doc from the reloaded store: the next blur flushes the stale
      // content back, silently re-applying the undone edit and wiping the redo
      // stack. While a block is focused, in-editor undo (TipTap history) owns
      // Ctrl+Z; page-level undo resumes once the editor unmounts.
      if (useBlockStore.getState().focusedBlockId != null) {
        return
      }

      const navState = useNavigationStore.getState()

      // #2941 — Journal view (the default landing view) has no reliable
      // signal for which day-page to target (see module doc comment), so
      // instead of the previous silent no-op, tell the user why Ctrl+Z/
      // Ctrl+Y had no effect here. Gated on the shortcut actually matching
      // so unrelated keystrokes in Journal view aren't intercepted.
      if (navState.currentView === 'journal') {
        if (
          matchesShortcutBinding(e, 'undoLastPageOp') ||
          matchesShortcutBinding(e, 'redoLastUndoneOp')
        ) {
          e.preventDefault()
          notifyJournalUndoUnavailable()
        }
        return
      }

      const pageStack = selectPageStack(useTabsStore.getState())
      if (navState.currentView !== 'page-editor' || pageStack.length === 0) return

      const pageId = pageStack.at(-1)?.pageId as string

      // `undoLastPageOp` (Ctrl/Cmd+Z by default) — routed through
      // `matchesShortcutBinding` (#724) so Settings rebinds are honoured.
      // The default binding carries no Shift requirement, so Ctrl+Shift+Z
      // (page-level redo, handled below) does not match it.
      if (matchesShortcutBinding(e, 'undoLastPageOp')) {
        e.preventDefault()
        // Delegate to the shared helper so the keyboard route and the
        // swipe-to-delete "Undo" toast (#927 f7) stay identical.
        void performPageUndo(pageId)
        return
      }

      // `redoLastUndoneOp` (Ctrl+Y / Ctrl+Shift+Z by default — the catalog
      // lists both alternatives) — routed through `matchesShortcutBinding`
      // (#724) so Settings rebinds are honoured.
      if (matchesShortcutBinding(e, 'redoLastUndoneOp')) {
        e.preventDefault()
        // #4391 — capture the space in the keystroke's own tick, before the
        // redo IPC awaits. See `@/stores/page-rename`.
        const spaceId = useSpaceStore.getState().currentSpaceId
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
              await refreshAfterUndoRedo(pageId, spaceId)
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
