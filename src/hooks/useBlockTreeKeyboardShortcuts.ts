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

import { matchesShortcutBinding } from '../lib/keyboard-config'
import {
  clearTreeInteractionIfHolder,
  isLastInteractedTree,
  markTreeInteracted,
} from '../lib/last-interacted-tree'
import { useBlockStore } from '../stores/blocks'
import type { PageBlockState } from '../stores/page-blocks'
import { storeOwnsBlock } from '../stores/page-blocks'
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
  toggleCollapse: (id: string) => void
  rawSelectAll: (ids: string[]) => void
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
    toggleCollapse,
    rawSelectAll,
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
  // Mirrors the context-menu "Zoom in" action, which is gated on
  // `hasChildren` (a leaf has nothing to zoom into). Fires only when:
  //   - a block is focused (the zoom target)
  //   - that block actually has children
  //   - the binding matches (`Alt + .`, layout-stable — see catalog note)
  // Zoom-out stays on Escape; this completes the in/out pair.
  useEffect(() => {
    const handleZoomInKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (!matchesShortcutBinding(e, 'zoomIn')) return
      // #713 — ownership gate (hasChildrenSet only holds this tree's ids,
      // but the explicit check keeps the flush/zoom side effects provably
      // scoped to the owning tree).
      if (!storeOwnsBlock(pageStore, focusedBlockId)) return
      if (!hasChildrenSet.has(focusedBlockId)) return
      e.preventDefault()
      // Flush any pending editor edits before navigating so the zoom
      // doesn't strand an unsaved buffer (mirrors the drag/zoom-out paths).
      handleFlush()
      setFocused(null)
      zoomIn(focusedBlockId)
    }
    document.addEventListener('keydown', handleZoomInKey)
    return () => document.removeEventListener('keydown', handleZoomInKey)
  }, [focusedBlockId, pageStore, hasChildrenSet, zoomIn, handleFlush, setFocused])

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
