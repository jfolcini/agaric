/**
 * useBlockTreeKeyboardShortcuts — document-level keyboard shortcut listeners.
 *
 * Extracted from BlockTree.tsx to reduce orchestrator size.
 * Handles:
 * - Collapse toggle (Mod+.)
 * - Multi-selection Ctrl+A / Escape
 * - Unfocused Escape closes editor
 * - Task cycling Ctrl+Enter
 * - Date picker Ctrl+Shift+D
 * - Heading shortcut Ctrl+1-6
 */

import { useEffect } from 'react'
import { useBlockStore } from '../stores/blocks'
import type { DatePickerMode } from './useBlockDatePicker'

export interface UseBlockTreeKeyboardShortcutsOptions {
  focusedBlockId: string | null
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
  rovingEditor: { editor: unknown }
  datePickerCursorPos: React.MutableRefObject<number | undefined>
  setDatePickerMode: (mode: DatePickerMode) => void
  setDatePickerOpen: (open: boolean) => void
}

export function useBlockTreeKeyboardShortcuts(options: UseBlockTreeKeyboardShortcutsOptions): void {
  const {
    focusedBlockId,
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
  } = options

  // ── Keyboard shortcut for collapse toggle (Mod+.) ──────────────────
  useEffect(() => {
    const handleCollapseKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault()
        if (focusedBlockId && hasChildrenSet.has(focusedBlockId)) {
          toggleCollapse(focusedBlockId)
        }
      }
    }
    document.addEventListener('keydown', handleCollapseKey)
    return () => document.removeEventListener('keydown', handleCollapseKey)
  }, [focusedBlockId, hasChildrenSet, toggleCollapse])

  // ── Keyboard shortcuts for multi-selection (Ctrl+A, Escape) ─────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+A / Cmd+A — select all blocks (only when not editing)
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !focusedBlockId) {
        e.preventDefault()
        rawSelectAll(blocks.map((b) => b.id))
      }
      // Escape — clear selection (when not editing and there's an active selection)
      if (
        e.key === 'Escape' &&
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
  }, [handleFlush, setFocused])

  // ── Keyboard shortcut for task cycling (Ctrl+Enter / Cmd+Enter) ────
  useEffect(() => {
    const handleTaskKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (focusedBlockId) {
          handleToggleTodo(focusedBlockId)
        }
      }
    }
    document.addEventListener('keydown', handleTaskKey)
    return () => document.removeEventListener('keydown', handleTaskKey)
  }, [focusedBlockId, handleToggleTodo])

  // ── Keyboard shortcut: Ctrl+Shift+D -> open date picker ─────────────
  useEffect(() => {
    const handleDateShortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        if (!focusedBlockId) return
        datePickerCursorPos.current =
          (rovingEditor.editor as { state: { selection: { $anchor: { pos: number } } } } | null)
            ?.state.selection.$anchor.pos ?? undefined
        setDatePickerMode('date')
        setDatePickerOpen(true)
      }
    }
    document.addEventListener('keydown', handleDateShortcut)
    return () => document.removeEventListener('keydown', handleDateShortcut)
  }, [
    focusedBlockId,
    rovingEditor.editor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
  ])

  // ── Keyboard shortcut: Ctrl+1-6 -> toggle heading level ─────────────
  useEffect(() => {
    const handleHeadingShortcut = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.key < '1' || e.key > '6') return
      if (!focusedBlockId) return
      e.preventDefault()
      const level = Number.parseInt(e.key, 10)
      handleSlashCommand({ id: `h${level}`, label: `Heading ${level}` })
    }
    document.addEventListener('keydown', handleHeadingShortcut)
    return () => document.removeEventListener('keydown', handleHeadingShortcut)
  }, [focusedBlockId, handleSlashCommand])
}
