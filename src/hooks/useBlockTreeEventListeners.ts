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

import type { TFunction } from 'i18next'
import type { RefObject } from 'react'
import { useEffect, useRef } from 'react'
import type { StoreApi } from 'zustand'

import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { BLOCK_EVENTS, onBlockEvent } from '../lib/block-events'
import { setPriority as setPriorityCmd } from '../lib/tauri'
import type { PageBlockState } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'
import type { DatePickerMode } from './useBlockDatePicker'
import { applyContentEdit, readCurrentContent } from './useBlockSlashCommands/helpers'
import type { SlashCommandContext } from './useBlockSlashCommands/types'

/** Known callout variants (mirrors `CALLOUT_CONFIG` in RichContentRenderer). */
const CALLOUT_TYPES = new Set(['info', 'warning', 'tip', 'error', 'note'])

export interface UseBlockTreeEventListenersOptions {
  focusedBlockId: string | null
  rootParentId: string | null
  handleEscapeCancel: () => void
  handleToggleTodo: (id: string) => void
  handleTogglePriority: (id: string) => void
  handleShowProperties: (id: string) => void
  // Full handle (BlockTree passes the real `RovingEditorHandle`): the
  // date-picker handlers read `editor.state.selection`, while the structural
  // toolbar handlers (#253) need `editor.getJSON()` + `mount` to edit content.
  rovingEditor: RovingEditorHandle
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
        notify.error(t('blockTree.setPriorityFailed'))
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
      datePickerCursorPos.current =
        rovingEditorRef.current.editor?.state.selection.$anchor.pos ?? undefined
      setDatePickerMode('date')
      setDatePickerOpen(true)
    }
    return onBlockEvent(document, 'OPEN_DATE_PICKER', handleDateEvent)
  }, [focusedBlockId, datePickerCursorPos, setDatePickerMode, setDatePickerOpen])

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

  // ── Structural toolbar inserts: ordered-list / divider / callout (#253) ──
  // These toolbar buttons dispatch DOM events but previously had NO consumer,
  // so they were silent no-ops. Wire them to the SAME content-edit path the
  // matching slash commands use (`useSlashCommandStructural`): build a minimal
  // SlashCommandContext from the focused block and reuse the canonical
  // `applyContentEdit` (which preserves the MAINT-116 undo contract + remount).
  useEffect(() => {
    if (!focusedBlockId) return

    const buildCtx = (): SlashCommandContext => ({
      blockId: focusedBlockId,
      rootParentId,
      rovingEditor: rovingEditorRef.current,
      pageStore,
      datePickerCursorPos,
      setDatePickerMode,
      setDatePickerOpen,
      t: t as unknown as TFunction,
      // Not used by `applyContentEdit`/`readCurrentContent`; structural inserts
      // never open the template picker.
      openTemplatePicker: async () => {},
    })

    const onOrderedList = () => {
      const ctx = buildCtx()
      void applyContentEdit(ctx, `1. ${readCurrentContent(ctx)}`, 'slash.numberedListFailed')
    }
    const onDivider = () => {
      void applyContentEdit(buildCtx(), '---', 'slash.dividerFailed')
    }
    const onCallout = (e: Event) => {
      // #215 — the toolbar callout type picker dispatches the chosen variant in
      // `detail.type`; fall back to `info` (slash `/callout` + the plain
      // toolbar button send no detail). Validate against the known set so a
      // stray payload can't inject arbitrary `[!TEXT]`.
      const raw = (e as CustomEvent<{ type?: string }>).detail?.type
      const type = raw && CALLOUT_TYPES.has(raw) ? raw : 'info'
      const ctx = buildCtx()
      void applyContentEdit(
        ctx,
        `> [!${type.toUpperCase()}] ${readCurrentContent(ctx)}`,
        'slash.calloutFailed',
      )
    }

    const cleanups = [
      onBlockEvent(document, 'INSERT_ORDERED_LIST', onOrderedList),
      onBlockEvent(document, 'INSERT_DIVIDER', onDivider),
      onBlockEvent(document, 'INSERT_CALLOUT', onCallout),
    ]
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [
    focusedBlockId,
    rootParentId,
    pageStore,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    t,
  ])
}
