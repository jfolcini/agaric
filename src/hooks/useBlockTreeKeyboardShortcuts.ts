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

import { serializeBlockSubtree } from '../lib/block-clipboard'
import { readText, writeText } from '../lib/clipboard'
import { matchesShortcutBinding } from '../lib/keyboard-config'
import {
  clearTreeInteractionIfHolder,
  isLastInteractedTree,
  markTreeInteracted,
} from '../lib/last-interacted-tree'
import { logger } from '../lib/logger'
import { computeSelectionRoots } from '../lib/tree-utils'
import { useBlockStore } from '../stores/blocks'
import type { PageBlockState } from '../stores/page-blocks'
import { storeOwnsBlock } from '../stores/page-blocks'
import { keyFor, useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'
import type { DatePickerMode } from './useBlockDatePicker'

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
  selectedBlockIds: string[]
  hasChildrenSet: Set<string>
  blocks: Array<{ id: string }>
  /**
   * Visible block ids in rendered order (collapsed/zoomed filtering already
   * applied — `collapsedVisible`, or the zoomed slice). Keyboard range-select
   * (#922) steps through THIS list so Shift+Arrow matches what the user sees.
   */
  visibleIds: string[]
  toggleCollapse: (id: string) => void
  rawSelectAll: (ids: string[]) => void
  /** Extend the block selection by one visible block (#922 — Shift+Arrow). */
  extendSelection: (direction: 'up' | 'down', visibleIds: string[]) => void
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

export function useBlockTreeKeyboardShortcuts(options: UseBlockTreeKeyboardShortcutsOptions): void {
  const {
    focusedBlockId,
    pageStore,
    selectedBlockIds,
    hasChildrenSet,
    blocks,
    visibleIds,
    toggleCollapse,
    rawSelectAll,
    extendSelection,
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
  useEffect(() => {
    return () => clearTreeInteractionIfHolder(pageStore)
  }, [pageStore])

  // ── Keyboard shortcut for collapse toggle (`collapseExpand`, default
  // Mod+. — routed through matchesShortcutBinding so rebinds work, #724) ──
  useEffect(() => {
    const handleCollapseKey = (e: KeyboardEvent) => {
      if (matchesShortcutBinding(e, 'collapseExpand')) {
        // #713 — only the tree that owns the focused block may act, and
        // `preventDefault()` must stay inside the handled branch so the
        // chord passes through when this tree doesn't handle it.
        if (!storeOwnsBlock(pageStore, focusedBlockId)) return
        if (!hasChildrenSet.has(focusedBlockId)) return
        e.preventDefault()
        toggleCollapse(focusedBlockId)
      }
    }
    document.addEventListener('keydown', handleCollapseKey)
    return () => document.removeEventListener('keydown', handleCollapseKey)
  }, [focusedBlockId, pageStore, hasChildrenSet, toggleCollapse])

  // ── Keyboard shortcuts for multi-selection (Ctrl+A, Escape) ─────────
  // #713 note: these fire only when NO block is focused, so there is no
  // ownership signal to gate on. Select-all/clear act on the global
  // selection store (no per-block IPC side effects); deliberately ungated.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // `selectAllBlocks` (Ctrl/Cmd+A by default) — select all blocks (only
      // when not editing). Routed through matchesShortcutBinding (#724).
      if (matchesShortcutBinding(e, 'selectAllBlocks') && !focusedBlockId) {
        e.preventDefault()
        rawSelectAll(blocks.map((b) => b.id))
      }
      // `clearSelection` (Escape by default) — clear selection (when not
      // editing and there's an active selection).
      if (
        matchesShortcutBinding(e, 'clearSelection') &&
        !e.defaultPrevented &&
        !focusedBlockId &&
        selectedBlockIds.length > 0
      ) {
        e.preventDefault()
        clearSelected()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [focusedBlockId, selectedBlockIds.length, rawSelectAll, blocks, clearSelected])

  // ── Keyboard shortcut: extend selection (#922 — Shift+Arrow) ────────
  // Shift+ArrowDown / Shift+ArrowUp grow (or shrink) a contiguous block
  // selection from a single selected block, the keyboard counterpart to
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
  // store owns the anchoring selected block may extend (and preventDefault);
  // a non-owning tree falls through so the chord isn't double-handled.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Editor active → browser owns Shift+Arrow text selection.
      if (focusedBlockId) return
      if (e.defaultPrevented) return
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
      const direction = e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowUp' ? 'up' : null
      if (direction === null) return
      // Need a selection to anchor on (block-select mode entry point).
      if (selectedBlockIds.length === 0) return
      // #713 — only act when this tree's store owns the anchoring block (the
      // last selected). Otherwise another tree owns the selection; fall
      // through WITHOUT preventDefault so it isn't claimed here.
      const anchorId = selectedBlockIds[selectedBlockIds.length - 1]
      if (anchorId == null || !storeOwnsBlock(pageStore, anchorId)) return
      e.preventDefault()
      extendSelection(direction, visibleIds)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [focusedBlockId, pageStore, selectedBlockIds, visibleIds, extendSelection])

  // ── Keyboard shortcuts: block cut / copy / paste (#913) ─────────────
  // Copy/cut serialize the SELECTION ROOTS (+ subtrees) to indented markdown
  // on the system clipboard; paste reverses it into a real block subtree after
  // the anchor block. These operate on BLOCK SELECTIONS only, so they must NOT
  // fire (or `preventDefault`) when a roving editor is focused — the browser's
  // native text copy/cut/paste owns those keystrokes inside an editor.
  //
  // #713 ownership gate: these chords read the GLOBAL `selectedBlockIds` /
  // `focusedBlockId`, but each mounted tree (journal week/month) must only act
  // on blocks IN ITS OWN store. Copy/cut filter the selection to ids this store
  // owns; paste anchors on an owned block. A non-owning tree returns WITHOUT
  // side effects and WITHOUT `preventDefault()` so the chord passes through.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only in block-select mode: no block is being edited. A focused block
      // means the editor is active — leave copy/cut/paste to the browser.
      if (focusedBlockId) return

      const isCopy = matchesShortcutBinding(e, 'copyBlocks')
      const isCut = matchesShortcutBinding(e, 'cutBlocks')
      const isPaste = matchesShortcutBinding(e, 'pasteBlocks')
      if (!isCopy && !isCut && !isPaste) return

      const state = pageStore.getState()

      if (isCopy || isCut) {
        if (selectedBlockIds.length === 0) return
        // Restrict to the selection this store owns (the #713 gate). If none
        // of the selected blocks live here, another tree owns them — fall
        // through without claiming the chord.
        const ownedSelected = selectedBlockIds.filter((id) => state.blocksById.has(id))
        if (ownedSelected.length === 0) return
        // #1440 — render internal references human-readably for the SYSTEM
        // clipboard (`[[Page Name]]` / `#tag` / `((Name))`), reusing the same
        // title/tag source page-export uses: the global resolve cache
        // (`useResolveStore`, populated on boot + as pages/tags load). We read
        // the cache directly (composed against the active space, mirroring
        // `useBlockResolve.resolveBlockTitle`) and return `undefined` on a miss
        // so a dangling/uncached ULID falls back to its opaque token instead of
        // the store's `[[xxxx…]]` placeholder. The internal copy→paste paths
        // (duplicate) call `serializeBlockSubtree` WITHOUT a resolver, keeping
        // their content ULID-canonical for re-import.
        const resolveCache = useResolveStore.getState().cache
        const spaceId = useSpaceStore.getState().currentSpaceId
        const markdown = serializeBlockSubtree(
          state.blocks,
          ownedSelected,
          (ulid) => resolveCache.get(keyFor(spaceId, ulid))?.title,
        )
        if (markdown.length === 0) return
        e.preventDefault()
        void writeText(markdown).catch((err) =>
          logger.warn('block-clipboard', 'copy writeText failed', undefined, err),
        )
        if (isCut) {
          // Remove only the selection ROOTS — `remove()` cascades each subtree,
          // so a nested selected descendant travels with its ancestor and must
          // NOT be deleted independently (avoids a redundant IPC on an
          // already-cascaded id). `clearSelected` resets the now-stale set.
          const roots = computeSelectionRoots(state.blocks, ownedSelected)
          for (const id of roots) void state.remove(id)
          clearSelected()
        }
        return
      }

      // Paste: anchor on the LAST selected owned block (the user's most recent
      // selection), insert the clipboard outline after it.
      const ownedSelected = selectedBlockIds.filter((id) => state.blocksById.has(id))
      const anchorId = ownedSelected[ownedSelected.length - 1]
      if (anchorId == null) return
      e.preventDefault()
      void readText()
        .then((text) => {
          if (text.length === 0) return
          return state.pasteBlocks(anchorId, text)
        })
        .catch((err) => logger.warn('block-clipboard', 'paste readText failed', undefined, err))
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [focusedBlockId, pageStore, selectedBlockIds, clearSelected])

  // ── Keyboard shortcut: Escape closes unfocused editor (UX-M8) ──────
  // The TipTap-level Escape handler (use-block-keyboard.ts) only fires when
  // the editor DOM has focus.  This document-level handler covers the case
  // where the user clicked elsewhere on the page and presses Escape — the
  // editor is still mounted but not focused.
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

  // ── Keyboard shortcut: Escape zooms out when zoomed in (UX-214) ──
  // Fires only when:
  //   - the user is actually zoomed into a block (zoomedBlockId !== null)
  //   - no block is focused in the editor (Escape would blur the editor)
  //   - no multi-selection is active (Escape clears selection)
  //   - no popup/overlay is open (suggestion popups handle their own Escape)
  useEffect(() => {
    const handleZoomOutEscape = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (!matchesShortcutBinding(e, 'zoomOut')) return
      if (zoomedBlockId === null) return
      // #774 — break the mount-order tie: with several zoomed trees, only the
      // most-recently-interacted one claims Escape (others fall through). The
      // old `defaultPrevented` race let the earliest-MOUNTED zoomed tree win.
      if (!isLastInteractedTree(pageStore)) return
      const { focusedBlockId: fid, selectedBlockIds: sel } = useBlockStore.getState()
      if (fid) return
      if (sel.length > 0) return
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
  useEffect(() => {
    const handleZoomInKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (!matchesShortcutBinding(e, 'zoomIn')) return
      // #713 — ownership gate keeps the flush/zoom side effects provably
      // scoped to the tree whose store owns the focused block.
      if (!storeOwnsBlock(pageStore, focusedBlockId)) return
      e.preventDefault()
      // Flush any pending editor edits before navigating so the zoom
      // doesn't strand an unsaved buffer (mirrors the drag/zoom-out paths).
      handleFlush()
      setFocused(null)
      zoomIn(focusedBlockId)
    }
    document.addEventListener('keydown', handleZoomInKey)
    return () => document.removeEventListener('keydown', handleZoomInKey)
  }, [focusedBlockId, pageStore, zoomIn, handleFlush, setFocused])

  // ── Keyboard shortcut for task cycling (`cycleTaskState`, default
  // Ctrl+Enter / Cmd+Enter — routed through matchesShortcutBinding, #724) ──
  useEffect(() => {
    const handleTaskKey = (e: KeyboardEvent) => {
      if (matchesShortcutBinding(e, 'cycleTaskState')) {
        // #713 — without this gate every mounted tree (journal week/month)
        // fired its own `handleToggleTodo`, each computing the next state
        // from its OWN store (where the block may not exist → `current =
        // null` → 'TODO'), racing N conflicting `set_todo_state` IPCs.
        if (!storeOwnsBlock(pageStore, focusedBlockId)) return
        e.preventDefault()
        handleToggleTodo(focusedBlockId)
      }
    }
    document.addEventListener('keydown', handleTaskKey)
    return () => document.removeEventListener('keydown', handleTaskKey)
  }, [focusedBlockId, pageStore, handleToggleTodo])

  // ── Keyboard shortcut: open date picker (configurable) ───────────────
  useEffect(() => {
    const handleDateShortcut = (e: KeyboardEvent) => {
      if (matchesShortcutBinding(e, 'openDatePicker')) {
        // #713 — gate BEFORE preventDefault: a non-owning tree must neither
        // open its own dialog nor swallow the chord.
        if (!storeOwnsBlock(pageStore, focusedBlockId)) return
        e.preventDefault()
        datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos ?? undefined
        setDatePickerMode('date')
        setDatePickerOpen(true)
      }
    }
    document.addEventListener('keydown', handleDateShortcut)
    return () => document.removeEventListener('keydown', handleDateShortcut)
  }, [
    focusedBlockId,
    pageStore,
    rovingEditor.editor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
  ])

  // ── Keyboard shortcut: heading level (configurable) ──────────────────
  useEffect(() => {
    const handleHeadingShortcut = (e: KeyboardEvent) => {
      for (let level = 1; level <= 6; level++) {
        if (matchesShortcutBinding(e, `heading${level}`)) {
          // #713 — a non-owning tree's slash-command path would route into
          // `applyContentEdit` against ITS idle editor (content-overwrite
          // risk); only the owning tree may handle the chord.
          if (!storeOwnsBlock(pageStore, focusedBlockId)) return
          e.preventDefault()
          handleSlashCommand({ id: `h${level}`, label: `Heading ${level}` })
          return
        }
      }
    }
    document.addEventListener('keydown', handleHeadingShortcut)
    return () => document.removeEventListener('keydown', handleHeadingShortcut)
  }, [focusedBlockId, pageStore, handleSlashCommand])
}
