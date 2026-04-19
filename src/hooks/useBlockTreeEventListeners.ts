/**
 * useBlockTreeEventListeners — custom DOM event listeners for BlockTree.
 *
 * Extracted from BlockTree.tsx to reduce orchestrator size.
 * Handles onBlockEvent listeners:
 * - DISCARD_BLOCK_EDIT
 * - CYCLE_PRIORITY
 * - SET_PRIORITY_1/2/3
 * - OPEN_DATE_PICKER
 * - OPEN_DUE_DATE_PICKER
 * - OPEN_SCHEDULED_DATE_PICKER
 * - TOGGLE_TODO_STATE
 * - OPEN_BLOCK_PROPERTIES
 */

import type { RefObject } from 'react'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { StoreApi } from 'zustand'
import { logger } from '@/lib/logger'
import { BLOCK_EVENTS, onBlockEvent } from '../lib/block-events'
import { setPriority as setPriorityCmd } from '../lib/tauri'
import type { PageBlockState } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'
import type { DatePickerMode } from './useBlockDatePicker'

export interface UseBlockTreeEventListenersOptions {
  focusedBlockId: string | null
  rootParentId: string | null
  handleEscapeCancel: () => void
  handleToggleTodo: (id: string) => void
  handleTogglePriority: (id: string) => void
  handleShowProperties: (id: string) => void
  rovingEditor: {
    editor: { state: { selection: { $anchor: { pos: number } } } } | null
  }
  datePickerCursorPos: RefObject<number | undefined>
  setDatePickerMode: (mode: DatePickerMode) => void
  setDatePickerOpen: (open: boolean) => void
  pageStore: StoreApi<PageBlockState>
  t: (key: string) => string
}

export function useBlockTreeEventListeners(options: UseBlockTreeEventListenersOptions): void {
  const {
    focusedBlockId,
    rootParentId,
    handleEscapeCancel,
    handleToggleTodo,
    handleTogglePriority,
    handleShowProperties,
    rovingEditor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    pageStore,
    t,
  } = options

  // Internal ref to access the latest rovingEditor without adding it to
  // every dependency array (matches original BlockTree behaviour).
  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor

  // ── Discard button custom event (from FormattingToolbar) ───────────
  useEffect(() => {
    const handler = () => {
      if (focusedBlockId) {
        handleEscapeCancel()
      }
    }
    return onBlockEvent(document, 'DISCARD_BLOCK_EDIT', handler)
  }, [focusedBlockId, handleEscapeCancel])

  // ── Priority cycling event listener (from FormattingToolbar) ─────────
  useEffect(() => {
    const handler = () => {
      if (focusedBlockId) handleTogglePriority(focusedBlockId)
    }
    return onBlockEvent(document, 'CYCLE_PRIORITY', handler)
  }, [focusedBlockId, handleTogglePriority])

  // ── Direct priority set from keyboard shortcuts (Ctrl+Shift+1/2/3) ──
  useEffect(() => {
    const handleSetPriority = async (e: Event) => {
      if (!focusedBlockId) return
      const priority =
        e.type === BLOCK_EVENTS.SET_PRIORITY_1
          ? '1'
          : e.type === BLOCK_EVENTS.SET_PRIORITY_2
            ? '2'
            : '3'
      try {
        await setPriorityCmd(focusedBlockId, priority)
        if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (b.id === focusedBlockId ? { ...b, priority } : b)),
        }))
      } catch (err) {
        logger.error(
          'BlockTree',
          'Failed to set priority',
          {
            blockId: focusedBlockId,
            priority,
          },
          err,
        )
        toast.error(t('blockTree.setPriorityFailed'))
      }
    }
    const cleanup1 = onBlockEvent(document, 'SET_PRIORITY_1', handleSetPriority)
    const cleanup2 = onBlockEvent(document, 'SET_PRIORITY_2', handleSetPriority)
    const cleanup3 = onBlockEvent(document, 'SET_PRIORITY_3', handleSetPriority)
    return () => {
      cleanup1()
      cleanup2()
      cleanup3()
    }
  }, [focusedBlockId, rootParentId, t, pageStore])

  // ── Listen for toolbar date picker event ────────────────────────────
  useEffect(() => {
    const handleDateEvent = () => {
      if (!focusedBlockId) return
      datePickerCursorPos.current = rovingEditor.editor?.state.selection.$anchor.pos
      setDatePickerMode('date')
      setDatePickerOpen(true)
    }
    return onBlockEvent(document, 'OPEN_DATE_PICKER', handleDateEvent)
  }, [
    focusedBlockId,
    rovingEditor.editor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
  ])

  // ── Listen for toolbar due-date picker event ─────────────────────────
  useEffect(() => {
    const handler = () => {
      if (!focusedBlockId) return
      datePickerCursorPos.current =
        rovingEditorRef.current.editor?.state.selection.$anchor.pos ?? undefined
      setDatePickerMode('due')
      setDatePickerOpen(true)
    }
    return onBlockEvent(document, 'OPEN_DUE_DATE_PICKER', handler)
  }, [focusedBlockId, datePickerCursorPos, setDatePickerMode, setDatePickerOpen])

  // ── Listen for toolbar scheduled-date picker event ──────────────────
  useEffect(() => {
    const handler = () => {
      if (!focusedBlockId) return
      datePickerCursorPos.current =
        rovingEditorRef.current.editor?.state.selection.$anchor.pos ?? undefined
      setDatePickerMode('schedule')
      setDatePickerOpen(true)
    }
    return onBlockEvent(document, 'OPEN_SCHEDULED_DATE_PICKER', handler)
  }, [focusedBlockId, datePickerCursorPos, setDatePickerMode, setDatePickerOpen])

  // ── Listen for toolbar toggle-todo-state event ──────────────────────
  useEffect(() => {
    const handler = () => {
      if (focusedBlockId) handleToggleTodo(focusedBlockId)
    }
    return onBlockEvent(document, 'TOGGLE_TODO_STATE', handler)
  }, [focusedBlockId, handleToggleTodo])

  // ── Listen for toolbar open-block-properties event ──────────────────
  useEffect(() => {
    const handler = () => {
      if (focusedBlockId) handleShowProperties(focusedBlockId)
    }
    return onBlockEvent(document, 'OPEN_BLOCK_PROPERTIES', handler)
  }, [focusedBlockId, handleShowProperties])
}
