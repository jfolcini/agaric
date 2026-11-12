/**
 * useUndoShortcuts — global keyboard shortcuts for undo/redo.
 *
 * Registers Ctrl+Z (undo) and Ctrl+Y / Ctrl+Shift+Z (redo) on the document,
 * acting while the focus is NOT inside a contentEditable, input, or textarea
 * element.
 *
 * #6556 — inside a focused block the two stacks are chained, not separate:
 * the editor's own history takes the press while it can undo (redo); once it
 * cannot, `useBlockPageHistory` flushes the block and runs `performPageUndo` /
 * `performPageRedo` for the tree's page (in the journal, the block's day),
 * then puts the caret back. This listener never acts while a block is focused.
 *
 * #6541 — outside a block the shortcuts act on `historyPageId()`: the page
 * open in the page editor, or in the journal, which mounts one page per day,
 * the day last worked in (`last-interacted-tree`). A press never crosses into
 * another day's page.
 */

import { useEffect } from 'react'

import { invalidateDerivedCaches } from '@/hooks/derived-caches'
import { announce } from '@/lib/announcer'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { t as translate } from '@/lib/i18n'
import { isEditableTarget, matchesShortcutBinding } from '@/lib/keyboard-config'
import { lastInteractedTree } from '@/lib/last-interacted-tree'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import { forEachLivePageStoreGroup, getPageStore } from '@/stores/page-blocks'
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
 * is documented best-effort and logs its own failures. Ordering it after
 * would silently make the obligation conditional on that best-effort IPC.
 *
 * #5287 — an undo emits no `block:properties-changed`, and the page store's
 * reload excludes the page root, so the header's property table and template
 * flags learn of a reverted page property only through the property counter.
 *
 * #6049 — the name caches, the property counter and every other derived cache
 * are dropped together by `invalidateDerivedCaches`, as after a sync.
 */
export async function refreshAfterUndoRedo(pageId: string, spaceId: string | null): Promise<void> {
  await getPageStore(pageId)?.getState().load()
  invalidateDerivedCaches()
  try {
    const pageBlock = unwrap(await commands.getBlock(pageId))
    if (pageBlock?.content) {
      // #3322 — one fan-out to every store that holds a title copy (tabs +
      // recents + resolve); see `@/stores/page-rename`.
      renamePage(pageId, pageBlock.content, spaceId)
    }
  } catch (err) {
    logger.warn('useUndoShortcuts', 'Failed to refresh page title after undo/redo', { pageId }, err)
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
 * Returns a promise that resolves once the undo + reload settle, to whether an
 * op was reversed (rejections are surfaced as an error toast and swallowed).
 */
export async function performPageUndo(pageId: string): Promise<boolean> {
  // #4391 — every route into here (the Ctrl+Z handler, `performActivePageUndo`
  // and the swipe-to-delete toast action) reaches this line synchronously from
  // the user's gesture, so this is the last point before the first `await`
  // and the space the user decided to undo IN. See `@/stores/page-rename`.
  const spaceId = useSpaceStore.getState().currentSpaceId
  try {
    const result = await useUndoStore.getState().undo(pageId)
    if (!result) return false
    const opKey = `undo.op.${snakeToCamel(result.reversed_op_type)}`
    const message = translate(opKey, { defaultValue: translate('undo.undoneMessage') })
    notify(message, { duration: 1500 })
    announce(translate('announce.undone'))
    await refreshAfterUndoRedo(pageId, spaceId)
    return true
  } catch {
    notify.error(translate('undo.undoFailedMessage'))
    announce(translate('announce.undoFailed'))
    return false
  }
}

/**
 * #6556 — a focused block's chained page undo / redo is in flight. It clears
 * focus for the reload, so without this the listener below would run a second
 * page undo for a press (or key repeat) landing meanwhile.
 */
let blockPageHistoryRunning = false

/** Runs a block's chained page undo / redo; a press while one runs is dropped. */
export function runBlockPageHistory(run: () => Promise<void>): void {
  if (blockPageHistoryRunning) return
  blockPageHistoryRunning = true
  void run().finally(() => {
    blockPageHistoryRunning = false
  })
}

/** The redo twin of `performPageUndo`, shared by Ctrl+Y / Ctrl+Shift+Z here and in a block. */
export async function performPageRedo(pageId: string): Promise<boolean> {
  // #4391 — capture the space in the gesture's own tick, before the redo IPC
  // awaits. See `@/stores/page-rename`.
  const spaceId = useSpaceStore.getState().currentSpaceId
  try {
    const result = await useUndoStore.getState().redo(pageId)
    if (!result) return false
    const opKey = `redo.op.${snakeToCamel(result.reversed_op_type)}`
    notify(translate(opKey, { defaultValue: translate('undo.redoneMessage') }), { duration: 1500 })
    announce(translate('announce.redone'))
    await refreshAfterUndoRedo(pageId, spaceId)
    return true
  } catch {
    notify.error(translate('undo.redoFailedMessage'))
    announce(translate('announce.redoFailed'))
    return false
  }
}

/** A journal no day of which was worked in yet: say where undo acts. */
function notifyNoJournalDay(): void {
  notify(translate('undo.journalNoDayMessage'), { duration: 2500 })
  announce(translate('announce.journalNoDay'))
}

/** The page of the journal day last worked in, while its tree is mounted. */
function lastInteractedPageId(): string | null {
  const tree = lastInteractedTree()
  let pageId: string | null = null
  forEachLivePageStoreGroup((id, stores) => {
    if (stores.some((store) => store === tree)) pageId = id
  })
  return pageId
}

/**
 * The page undo and redo act on outside a block: the page open in the page
 * editor, or the journal day last worked in. `null` in any other view, and in
 * a journal no day of which was worked in yet.
 */
function historyPageId(): string | null {
  const { currentView } = useNavigationStore.getState()
  if (currentView === 'journal') return lastInteractedPageId()
  if (currentView !== 'page-editor') return null
  return selectPageStack(useTabsStore.getState()).at(-1)?.pageId ?? null
}

/**
 * Undo the last op of `historyPageId()`, the swipe-to-delete toast's fallback
 * outside a page store (`SortableBlock.tsx`). Returns `false` when there is no
 * page to act on, after the journal's feedback for that.
 */
export async function performActivePageUndo(): Promise<boolean> {
  const pageId = historyPageId()
  if (pageId === null) {
    if (useNavigationStore.getState().currentView === 'journal') notifyNoJournalDay()
    return false
  }
  await performPageUndo(pageId)
  return true
}

export function useUndoShortcuts(): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return

      // Skip while the roving block editor is mounted. A `data-editor-portal`
      // overlay (context menu, date picker) can hold DOM focus on a plain
      // button while the editor's blur is suppressed (useEditorBlur Step 4a),
      // leaving it mounted with UNFLUSHED edits — the tag guard above doesn't
      // catch that target. Running page-level undo/redo then diverges the
      // editor doc from the reloaded store: the next blur flushes the stale
      // content back, silently re-applying the undone edit and wiping the redo
      // stack. While a block is focused the block's own key handler owns
      // Ctrl+Z and chains to page undo after a flush (#6556).
      if (useBlockStore.getState().focusedBlockId != null || blockPageHistoryRunning) {
        return
      }

      // `undoLastPageOp` (Ctrl/Cmd+Z by default) and `redoLastUndoneOp` (Ctrl+Y /
      // Ctrl+Shift+Z) — routed through `matchesShortcutBinding` (#724) so
      // Settings rebinds are honoured. The undo binding carries no Shift
      // requirement, so Ctrl+Shift+Z does not match it.
      const undo = matchesShortcutBinding(e, 'undoLastPageOp')
      if (!undo && !matchesShortcutBinding(e, 'redoLastUndoneOp')) return

      const pageId = historyPageId()
      if (pageId === null) {
        if (useNavigationStore.getState().currentView !== 'journal') return
        e.preventDefault()
        notifyNoJournalDay()
        return
      }
      e.preventDefault()
      // The swipe-to-delete "Undo" toast shares `performPageUndo` (#927 f7).
      void (undo ? performPageUndo(pageId) : performPageRedo(pageId))
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])
}
