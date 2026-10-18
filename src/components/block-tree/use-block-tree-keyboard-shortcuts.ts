/**
 * useBlockTreeKeyboardShortcuts — document-level keyboard shortcut listeners.
 *
 * Extracted from BlockTree.tsx to reduce orchestrator size.
 * Handles:
 * - Collapse toggle (Mod+.)
 * - Multi-selection Ctrl+A / Escape
 * - Unfocused Escape closes editor
 * - Zoom-out Escape (when zoomed in, nothing else claims Escape)
 * - Task cycling Ctrl+Enter
 * - Date picker Ctrl+Shift+D
 * - Heading shortcut Ctrl+1-6
 */

import type { RefObject } from 'react'
import { useEffect } from 'react'
import type { StoreApi } from 'zustand'

import type { DatePickerMode } from '@/components/block-tree/use-block-date-picker'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { readText, writeText } from '@/lib/clipboard'
import { t } from '@/lib/i18n'
import { isEditableTarget, matchesShortcutBinding } from '@/lib/keyboard-config'
import {
  clearTreeInteractionIfHolder,
  isLastInteractedTree,
  markTreeInteracted,
} from '@/lib/last-interacted-tree'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { computeSelectionRoots } from '@/lib/tree-utils'
import type { MountedIds, SelectAllScopeIds } from '@/lib/zoom-scope'
import { selectCursorBlockId, useBlockStore } from '@/stores/blocks'
import type { PageBlockState } from '@/stores/page-blocks'
import { addOwnedBlockListener, forEachPageStore, storeOwnsBlock } from '@/stores/page-blocks'

export interface UseBlockTreeKeyboardShortcutsOptions {
  focusedBlockId: string | null
  /**
   * This tree's own page store — #713 ownership gate. Journal week/month
   * views mount one BlockTree (and one copy of these document-level
   * listeners) per day, all sharing the GLOBAL `focusedBlockId`. Handlers
   * with block-level side effects must only act when the focused block
   * lives in THIS store, and must not `preventDefault()` otherwise.
   */
  pageStore: StoreApi<PageBlockState>
  hasChildrenSet: Set<string>
  /**
   * IDs Ctrl/Cmd+A selects. At the page root this is the full page; while
   * zoomed it is the complete (uncapped) zoom projection. This is separate
   * from `visibleIds`, whose rendered-list contract intentionally respects
   * the mount cap for range navigation.
   *
   * #3344 — brand-gated (`SelectAllScopeIds`). #3252 was this shortcut calling
   * `rawSelectAll(blocks.map(b => b.id))` with the page-wide list while
   * zoomed; the resulting selection then drove batch delete / batch TODO over
   * rows the pane never rendered. Only `useBlockZoom` derives this type.
   *
   * A DIFFERENT brand kind from `visibleIds`: at the page root this list
   * legitimately contains collapse-hidden rows, so the two are not
   * interchangeable and the compiler now says so.
   */
  selectAllIds: SelectAllScopeIds
  /**
   * Visible block ids in rendered order (collapsed/zoomed filtering already
   * applied — `collapsedVisible`, or the zoomed slice). Keyboard range-select
   * (#922) steps through THIS list so Shift+Arrow matches what the user sees.
   *
   * #3344 — brand-gated for the same reason as `selectAllIds`: Shift+Arrow is
   * the other way ids enter the selection that batch actions consume.
   */
  visibleIds: MountedIds
  toggleCollapse: (id: string) => void
  /**
   * Replace the global selection. Narrowed to `SelectAllScopeIds` so this hook
   * has no way to pass anything but Ctrl/Cmd+A's derived scope — the selection
   * is what the batch delete / batch TODO handlers act on. Note this is NOT
   * `MountedIds`: handing it the mount-capped rendered list would silently make
   * Ctrl+A stop at the mount envelope.
   */
  rawSelectAll: (ids: SelectAllScopeIds) => void
  /** Extend the block selection by one visible block (#922 — Shift+Arrow). */
  extendSelection: (direction: 'up' | 'down', visibleIds: MountedIds) => void
  /** Move the block-select cursor one visible block (#5734 — Ctrl+Arrow). */
  moveCursor: (direction: 'up' | 'down', visibleIds: MountedIds) => void
  /** Toggle a single block in/out of the selection (#1733 — keyboard toggle). */
  toggleSelected: (blockId: string) => void
  clearSelected: () => void
  handleFlush: () => string | null
  setFocused: (id: string | null) => void
  handleToggleTodo: (id: string) => void
  handleSlashCommand: (item: { id: string; label: string }) => void
  rovingEditor: {
    editor: { state: { selection: { $anchor: { pos: number } } } } | null
  }
  datePickerCursorPos: RefObject<number | undefined>
  setDatePickerMode: (mode: DatePickerMode) => void
  setDatePickerOpen: (open: boolean) => void
  /** Current zoomed-in block id, or null when viewing the page root. */
  zoomedBlockId: string | null
  /** Exit zoom and return to the page root. */
  zoomToRoot: () => void
  /** Zoom into the given block (D1, #217 — keyboard zoom-in). */
  zoomIn: (blockId: string) => void
}

/**
 * Put each page's `roots` and their subtrees on the system clipboard as the
 * backend renders them, one page after another. The backend renders one page
 * per call. The chord runs only with no block focused, so no draft is pending.
 * Resolves `false` when there was nothing to copy.
 */
async function copySelection(rootsByPage: string[][]): Promise<boolean> {
  const texts = await Promise.all(
    rootsByPage.map(async (roots) => unwrap(await commands.getBlocksSource(roots, true))),
  )
  const text = texts.join('')
  if (text.length === 0) return false
  await writeText(text)
  return true
}

interface PageSelection {
  state: PageBlockState
  roots: string[]
}

/**
 * The selection roots of `selected` in `pageStore`, which owns the anchor, and
 * in every other mounted page, pages in document order. The journal week and
 * stream views mount one tree per day, and one selection can span them.
 */
function selectionByPage(
  pageStore: StoreApi<PageBlockState>,
  selected: readonly string[],
): PageSelection[] {
  const stores = [pageStore]
  forEachPageStore((_pageId, store) => {
    if (!storeOwnsBlock(store, selected.at(-1) ?? null)) stores.push(store)
  })
  const pages: (PageSelection & { row: Element | undefined })[] = []
  for (const store of stores) {
    const state = store.getState()
    const owned = selected.filter((id) => state.blocksById.has(id))
    if (owned.length === 0) continue
    const roots = computeSelectionRoots(state.blocks, owned)
    const row = roots
      .map((id) => document.querySelector(`[data-block-id="${id}"]`))
      .find((el) => el != null)
    pages.push({ state, roots, row })
  }
  return pages.toSorted((a, b) =>
    a.row == null || b.row == null
      ? 0
      : a.row.compareDocumentPosition(b.row) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1,
  )
}

/**
 * Whether keyboard focus is on, or inside, one of this tree's rows. The cursor
 * chords act only then, as a list's keys belong to the list that has focus
 * (WAI-ARIA); with focus on a toolbar button, the sidebar or the page, they
 * keep their other meanings.
 */
function focusIsInRows(pageStore: StoreApi<PageBlockState>): boolean {
  const rowId = document.activeElement?.closest('li[data-block-id]')?.getAttribute('data-block-id')
  return storeOwnsBlock(pageStore, rowId ?? null)
}

export function useBlockTreeKeyboardShortcuts(options: UseBlockTreeKeyboardShortcutsOptions): void {
  const {
    focusedBlockId,
    pageStore,
    hasChildrenSet,
    selectAllIds,
    visibleIds,
    toggleCollapse,
    rawSelectAll,
    extendSelection,
    moveCursor,
    toggleSelected,
    clearSelected,
    handleFlush,
    setFocused,
    handleToggleTodo,
    handleSlashCommand,
    rovingEditor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    zoomedBlockId,
    zoomToRoot,
    zoomIn,
  } = options

  // ── #774 — track this tree as "last interacted" for the shared
  // zoom-out Escape tie-break ──────────────────────────────────────────
  // The interaction signal is focus ownership: when this tree's store owns
  // the focused block, the user is acting in THIS tree. Recording it here
  // means a later Escape (fired with no block focused) zooms out the tree
  // the user last edited, rather than the earliest-mounted one. Cleared on
  // unmount so a stale token can't keep claiming Escape.
  useEffect(() => {
    if (storeOwnsBlock(pageStore, focusedBlockId)) markTreeInteracted(pageStore)
  }, [pageStore, focusedBlockId])
  useEffect(() => () => clearTreeInteractionIfHolder(pageStore), [pageStore])

  // ── Keyboard shortcut for collapse toggle (`collapseExpand`, default
  // Mod+. — routed through matchesShortcutBinding so rebinds work, #724) ──
  useEffect(
    () =>
      addOwnedBlockListener(pageStore, focusedBlockId, 'keydown', (e, ownedBlockId) => {
        if (!matchesShortcutBinding(e, 'collapseExpand')) return
        // #713 — the ownership gate is enforced by addOwnedBlockListener; only
        // the tree that owns the focused block reaches here, and
        // `preventDefault()` stays inside the handled branch so the chord
        // passes through when this tree doesn't handle it.
        if (!hasChildrenSet.has(ownedBlockId)) return
        e.preventDefault()
        toggleCollapse(ownedBlockId)
      }),
    [focusedBlockId, pageStore, hasChildrenSet, toggleCollapse],
  )

  // ── Keyboard shortcuts for multi-selection (Ctrl+A, Escape) ─────────
  // #713 note: these fire only when NO block is focused, so block ownership
  // cannot gate them. Select-all instead uses the last-interacted tree token
  // (#774) so journal views with several mounted trees cannot race to replace
  // the global selection. `defaultPrevented` lets an earlier shortcut owner
  // retain the chord without this listener overwriting its result.
  //
  // #5447 — this handler and the selection/clipboard ones below read the GLOBAL
  // focus and selection from the store at dispatch: BlockTree subscribes only
  // to its own slice of both, so a focus move in another tree re-renders
  // nothing here.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const state = useBlockStore.getState()
      // `selectAllBlocks` (Ctrl/Cmd+A by default) — select all blocks (only
      // when not editing; in a text field such as the page title it selects
      // that field's text). Routed through matchesShortcutBinding (#724).
      if (
        !e.defaultPrevented &&
        matchesShortcutBinding(e, 'selectAllBlocks') &&
        !state.focusedBlockId &&
        !isEditableTarget(e.target) &&
        isLastInteractedTree(pageStore)
      ) {
        e.preventDefault()
        rawSelectAll(selectAllIds)
      }
      // `clearSelection` (Escape by default) — clear the selection and its
      // cursor (when not editing and there is a cursor, which a selection
      // always has, #5734).
      if (
        matchesShortcutBinding(e, 'clearSelection') &&
        !e.defaultPrevented &&
        !state.focusedBlockId &&
        selectCursorBlockId(state) !== null
      ) {
        e.preventDefault()
        clearSelected()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [pageStore, selectAllIds, rawSelectAll, clearSelected])

  // ── Keyboard shortcut: extend selection (#922 — Shift+Arrow) ────────
  // Shift+ArrowDown / Shift+ArrowUp grow (or shrink) a contiguous block
  // selection from the cursor block, the keyboard counterpart to
  // Shift+Click. The built selection IS the same `selectedBlockIds` the
  // batch-action toolbar + Ctrl/Shift+Click drive, so the toolbar lights up
  // with no extra wiring.
  //
  // Only fires in BLOCK-SELECT mode: when a block is focused the editor is
  // active and Shift+Arrow is the editor's own text selection — leave it to
  // the browser (do not intercept, do not preventDefault).
  //
  // #713 ownership gate: each mounted tree (journal week/month) shares the
  // GLOBAL selection but renders its OWN `visibleIds`. Only the tree whose
  // store owns the cursor block may extend (and preventDefault); a non-owning
  // tree falls through so the chord isn't double-handled.
  //
  // NOT routed through `addOwnedBlockListener`: the cursor is GLOBAL state,
  // read at dispatch because BlockTree renders only on its own share of the
  // selection (#5447). A null cursor (nothing selected) fails the gate too.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const state = useBlockStore.getState()
      if (!storeOwnsBlock(pageStore, selectCursorBlockId(state))) return
      // Editor active → browser owns Shift+Arrow text selection.
      if (state.focusedBlockId) return
      if (e.defaultPrevented) return
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
      const direction = e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowUp' ? 'up' : null
      if (direction === null) return
      e.preventDefault()
      extendSelection(direction, visibleIds)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [pageStore, visibleIds, extendSelection])

  // ── Keyboard shortcuts: the block-select cursor (#1733, #5734) ──────
  // Block-select mode follows the WAI-ARIA multi-select listbox: keyboard focus
  // (the cursor) is separate from the selection. Ctrl+ArrowUp / Ctrl+ArrowDown
  // move the cursor without changing the selection, and Ctrl+Space adds or
  // removes the cursor block, the keyboard counterpart to Ctrl+Click. Inside a
  // block's editor Ctrl+Space belongs to the editor keymap
  // (`use-block-keyboard.ts`), which leaves the block selected with the cursor
  // on it. #713 ownership gate mirrors extendSelection: only the tree whose
  // store owns the cursor block may handle (and preventDefault); other trees
  // fall through so the chord isn't double-handled. They act only while focus
  // is in the tree's rows.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const state = useBlockStore.getState()
      const cursorId = selectCursorBlockId(state)
      if (!storeOwnsBlock(pageStore, cursorId)) return
      // Editor active → leave the chords to the editor / browser.
      if (state.focusedBlockId) return
      if (e.defaultPrevented) return
      if (!focusIsInRows(pageStore)) return
      if (matchesShortcutBinding(e, 'toggleBlockSelectionKbd')) {
        // A cursor this tree no longer renders (a collapse hid it) selects nothing,
        // or a batch action would act on a block the user cannot see.
        if (!visibleIds.includes(cursorId)) return
        e.preventDefault()
        toggleSelected(cursorId)
        return
      }
      const direction = matchesShortcutBinding(e, 'blockCursorDown')
        ? 'down'
        : matchesShortcutBinding(e, 'blockCursorUp')
          ? 'up'
          : null
      if (direction === null) return
      e.preventDefault()
      moveCursor(direction, visibleIds)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [pageStore, visibleIds, toggleSelected, moveCursor])

  // ── Keyboard shortcuts: block cut / copy / paste (#913) ─────────────
  // Copy/cut put the SELECTION ROOTS (+ subtrees) on the system clipboard as
  // the backend renders them (`get_blocks_source`); paste hands the clipboard
  // text to `paste_blocks`, which parses it back into a block subtree after
  // the anchor block. These operate on BLOCK SELECTIONS only, so they must NOT
  // fire (or `preventDefault`) when a roving editor is focused — the browser's
  // native text copy/cut/paste owns those keystrokes inside an editor.
  //
  // #713 ownership gate: every mounted tree (journal week and stream) runs this
  // listener over the one GLOBAL selection, so only the tree that owns the
  // anchor (the last selected id, read at dispatch, #5447) acts. Copy and cut
  // take the whole selection across every mounted page; paste lands once,
  // after the anchor. Any other tree returns without side effects and without
  // `preventDefault()`.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { focusedBlockId: fid, selectedBlockIds: sel } = useBlockStore.getState()
      // Only in block-select mode: no block is being edited. A focused block
      // means the editor is active — leave copy/cut/paste to the browser.
      if (fid) return

      const isCopy = matchesShortcutBinding(e, 'copyBlocks')
      const isCut = matchesShortcutBinding(e, 'cutBlocks')
      const isPaste = matchesShortcutBinding(e, 'pasteBlocks')
      if (!isCopy && !isCut && !isPaste) return

      const anchorId = sel.at(-1) ?? null
      if (!storeOwnsBlock(pageStore, anchorId)) return
      e.preventDefault()

      if (isCopy || isCut) {
        // Only the selection ROOTS: a nested selected descendant travels with
        // its ancestor, both on the clipboard (`with_children`) and through
        // cut's cascading `remove()`. Sending every selected id would also trip
        // the backend's id-list cap on a large Select All.
        const pages = selectionByPage(pageStore, sel)
        void copySelection(pages.map((p) => p.roots))
          .then((copied) => {
            // Cut removal is gated on the clipboard write RESOLVING: deleting
            // the blocks before the content reached the clipboard would be
            // silent destruction (and a later paste would insert stale data).
            if (!copied || !isCut) return
            // `clearSelected` resets the now-stale set.
            for (const { state, roots } of pages) for (const id of roots) void state.remove(id)
            clearSelected()
          })
          .catch((err) => {
            logger.warn('block-clipboard', 'copy failed', undefined, err)
            notify.error(t('palette.copyFailed'))
          })
        return
      }

      // Paste: insert the clipboard outline after the anchor.
      const state = pageStore.getState()
      void readText()
        .then((text) => {
          if (text.length === 0) return
          return state.pasteBlocks(anchorId, { kind: 'text', text })
        })
        .catch((err) => {
          // `pasteBlocks` toasts its own failures; this catch fires only when
          // the clipboard read itself rejects — surface it, don't swallow.
          logger.warn('block-clipboard', 'paste readText failed', undefined, err)
          notify.error(t('error.pasteBlocksFailed'))
        })
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [pageStore, clearSelected])

  // ── Keyboard shortcut: Escape closes unfocused editor ──────
  // The TipTap-level Escape handler (use-block-keyboard.ts) only fires when
  // the editor DOM has focus.  This document-level handler covers the case
  // where the user clicked elsewhere on the page and presses Escape — the
  // editor is still mounted but not focused.
  //
  // #2903 — NOT routed through `addOwnedBlockListener`: the gate here is on the
  // LIVE store focus (`fid` re-read from `useBlockStore` at dispatch, because
  // the point of this path is that the render prop / editor DOM focus has
  // diverged), not the render-time `focusedBlockId` the helper captures. Keeping
  // it raw preserves the live-read gate.
  useEffect(() => {
    const handleUnfocusedEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const { focusedBlockId: fid, selectedBlockIds: sel } = useBlockStore.getState()
      if (!fid) return
      // #713 — only the tree whose store owns the focused block may flush
      // and close; other mounted trees (journal week/month) must not touch
      // their own idle editors.
      if (!storeOwnsBlock(pageStore, fid)) return
      // Don't interfere when there's an active multi-selection (handled above)
      if (sel.length > 0) return
      // Only act when the TipTap editor is NOT the active element
      const proseMirror = document.querySelector('.ProseMirror')
      if (proseMirror?.contains(document.activeElement)) return
      e.preventDefault()
      // Save any pending edits before closing (unfocused Escape should persist content)
      handleFlush()
      setFocused(null)
    }
    document.addEventListener('keydown', handleUnfocusedEscape)
    return () => document.removeEventListener('keydown', handleUnfocusedEscape)
  }, [handleFlush, setFocused, pageStore])

  // ── Keyboard shortcut: Escape zooms out when zoomed in ──
  // Fires only when:
  //   - the user is actually zoomed into a block (zoomedBlockId !== null)
  //   - no block is focused in the editor (Escape would blur the editor)
  //   - no selection or block-select cursor (Escape clears them first)
  //   - no popup/overlay is open (suggestion popups handle their own Escape)
  //
  // #2903 — NOT routed through `addOwnedBlockListener`: zoom-out Escape fires
  // with NO block focused, so there is no owned block to gate on. The tie-break
  // is `isLastInteractedTree` (#774), a different mechanism than the
  // `storeOwnsBlock` gate the helper wraps.
  useEffect(() => {
    const handleZoomOutEscape = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (!matchesShortcutBinding(e, 'zoomOut')) return
      if (zoomedBlockId === null) return
      // #774 — break the mount-order tie: with several zoomed trees, only the
      // most-recently-interacted one claims Escape (others fall through). The
      // old `defaultPrevented` race let the earliest-MOUNTED zoomed tree win.
      if (!isLastInteractedTree(pageStore)) return
      const state = useBlockStore.getState()
      if (state.focusedBlockId) return
      if (selectCursorBlockId(state) !== null) return
      // Respect open suggestion popups / overlays
      const popupOpen = document.querySelector(
        '.suggestion-renderer, [role="dialog"][data-state="open"], [data-radix-popper-content-wrapper]',
      )
      if (popupOpen) return
      e.preventDefault()
      zoomToRoot()
    }
    document.addEventListener('keydown', handleZoomOutEscape)
    return () => document.removeEventListener('keydown', handleZoomOutEscape)
  }, [zoomedBlockId, zoomToRoot, pageStore])

  // ── Keyboard shortcut: zoom IN to the focused block (D1, #217) ──
  // Mirrors the context-menu "Zoom in" action. Fires only when:
  //   - a block is focused (the zoom target)
  //   - the binding matches (`Alt + .`, layout-stable — see catalog note)
  // Zoom-out stays on Escape; this completes the in/out pair.
  //
  // #922 — the `hasChildrenSet` gate is GONE: any block, leaf or not, may be
  // zoomed (matching Logseq/Workflowy). A zoomed leaf shows an empty view, so
  // BlockTree seeds a first child under the zoom root (`useBlockZoomEmptySeed`)
  // — keyboard zoom-in must not pre-reject leaves or that seeding never runs.
  useEffect(
    () =>
      addOwnedBlockListener(pageStore, focusedBlockId, 'keydown', (e, ownedBlockId) => {
        if (e.defaultPrevented) return
        if (!matchesShortcutBinding(e, 'zoomIn')) return
        // #713 — the gate (addOwnedBlockListener) keeps the flush/zoom side
        // effects provably scoped to the tree whose store owns the focused block.
        e.preventDefault()
        // Flush any pending editor edits before navigating so the zoom
        // doesn't strand an unsaved buffer (mirrors the drag/zoom-out paths).
        handleFlush()
        setFocused(null)
        zoomIn(ownedBlockId)
      }),
    [focusedBlockId, pageStore, zoomIn, handleFlush, setFocused],
  )

  // ── Keyboard shortcut for task cycling (`cycleTaskState`, default
  // Ctrl+Enter / Cmd+Enter — routed through matchesShortcutBinding, #724) ──
  useEffect(
    () =>
      addOwnedBlockListener(pageStore, focusedBlockId, 'keydown', (e, ownedBlockId) => {
        if (!matchesShortcutBinding(e, 'cycleTaskState')) return
        // #713 — without this gate every mounted tree (journal week/month)
        // fired its own `handleToggleTodo`, each computing the next state
        // from its OWN store (where the block may not exist → `current =
        // null` → 'TODO'), racing N conflicting `set_todo_state` IPCs.
        // addOwnedBlockListener now enforces it structurally.
        e.preventDefault()
        handleToggleTodo(ownedBlockId)
      }),
    [focusedBlockId, pageStore, handleToggleTodo],
  )

  // ── Keyboard shortcut: open date picker (configurable) ───────────────
  useEffect(
    () =>
      addOwnedBlockListener(pageStore, focusedBlockId, 'keydown', (e) => {
        if (!matchesShortcutBinding(e, 'openDatePicker')) return
        // #713 — the gate (addOwnedBlockListener) runs BEFORE preventDefault: a
        // non-owning tree neither opens its own dialog nor swallows the chord.
        e.preventDefault()
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos ?? undefined
        setDatePickerMode('date')
        setDatePickerOpen(true)
      }),
    [
      focusedBlockId,
      pageStore,
      rovingEditor.editor,
      datePickerCursorPos,
      setDatePickerMode,
      setDatePickerOpen,
    ],
  )

  // ── Keyboard shortcut: heading level (configurable) ──────────────────
  useEffect(
    () =>
      addOwnedBlockListener(pageStore, focusedBlockId, 'keydown', (e) => {
        for (let level = 1; level <= 6; level++) {
          if (matchesShortcutBinding(e, `heading${level}`)) {
            // #713 — a non-owning tree's slash-command path would route into
            // `applyContentEdit` against ITS idle editor (content-overwrite
            // risk); the gate (addOwnedBlockListener) confines the chord to the
            // owning tree.
            e.preventDefault()
            handleSlashCommand({ id: `h${level}`, label: `Heading ${level}` })
            return
          }
        }
      }),
    [focusedBlockId, pageStore, handleSlashCommand],
  )
}
