/**
 * useBlockTreeEventListeners — per-block command handlers for BlockTree.
 *
 * Extracted from BlockTree.tsx to reduce orchestrator size. Registers this
 * tree's handlers for the toolbar/inline-control commands:
 * - DISCARD_BLOCK_EDIT
 * - CYCLE_PRIORITY
 * - SET_PRIORITY_1/2/3
 * - OPEN_DATE_PICKER
 * - OPEN_DUE_DATE_PICKER
 * - OPEN_SCHEDULED_DATE_PICKER
 * - TOGGLE_TODO_STATE
 * - OPEN_BLOCK_PROPERTIES
 * - INSERT_ORDERED_LIST / INSERT_DIVIDER / INSERT_CALLOUT (#253)
 *
 * #1250 — these no longer install ~13 `document` CustomEvent listeners per
 * mounted BlockTree. Instead each tree registers its handler set ONCE with the
 * focus-keyed block command bus (`registerBlockCommandTarget`). A producer's
 * `dispatchBlockEvent` routes the command DIRECTLY to the single tree whose
 * page store owns the global `focusedBlockId`, so the bus already performed the
 * old `storeOwnsBlock(pageStore, focusedBlockId)` gate — the resolved owning
 * `blockId` is handed to each handler. This removes the per-tree listener
 * fan-out (and the N-way ownership re-check) that the #713/#774/#1064 race
 * history traced back to, while preserving identical behaviour: exactly one
 * handler runs per command, only for the focused tree, with the same payloads.
 */

import type { TFunction } from 'i18next'
import type { RefObject } from 'react'
import { useEffect, useRef } from 'react'
import type { StoreApi } from 'zustand'

import {
  type BlockTypeToken,
  convertBlockContent,
  stripBlockMarker,
} from '@/lib/block-type-convert'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { type BlockCommandHandler, registerBlockCommandTarget } from '../lib/block-command-bus'
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
  handleOpenQueryBuilder: () => void
  handleOpenEmojiPicker: () => void
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
    rootParentId,
    handleEscapeCancel,
    handleToggleTodo,
    handleTogglePriority,
    handleShowProperties,
    handleOpenQueryBuilder,
    handleOpenEmojiPicker,
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

  // #713 / #1250 — every handler below acts on the block the bus resolved as
  // owned by THIS tree's page store: the focus-keyed `dispatchBlockCommand`
  // only routes a command to the single tree whose store contains the global
  // `focusedBlockId`, so the handler's `blockId` argument IS that focused,
  // owned block. The old per-listener `storeOwnsBlock` gate (which prevented
  // journal week/month's N trees from racing conflicting side effects:
  // duplicate IPCs, N dialogs, todo-cycle values computed from a foreign store)
  // is now performed once by the bus, by construction.
  useEffect(() => {
    // ── Discard button command (from FormattingToolbar) ───────────────
    const onDiscard: BlockCommandHandler = () => {
      handleEscapeCancel()
    }

    // ── Priority cycling command (from FormattingToolbar) ─────────────
    const onCyclePriority: BlockCommandHandler = (blockId) => {
      handleTogglePriority(blockId)
    }

    // ── Direct priority set from keyboard shortcuts (Ctrl+Shift+1/2/3) ──
    const setPriorityHandler =
      (priority: '1' | '2' | '3'): BlockCommandHandler =>
      (blockId) => {
        void (async () => {
          try {
            await setPriorityCmd(blockId, priority)
            if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
            pageStore.setState((s) => ({
              blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, priority } : b)),
            }))
          } catch (err) {
            logger.error('BlockTree', 'Failed to set priority', { blockId, priority }, err)
            notify.error(t('blockTree.setPriorityFailed'))
          }
        })()
      }

    // ── Toolbar date-picker commands (date / due / scheduled) ─────────
    const openDatePicker =
      (mode: DatePickerMode): BlockCommandHandler =>
      () => {
        datePickerCursorPos.current =
          rovingEditorRef.current.editor?.state.selection.$anchor.pos ?? undefined
        setDatePickerMode(mode)
        setDatePickerOpen(true)
      }

    // ── Toolbar toggle-todo-state command ─────────────────────────────
    // #713 — computing the next state from a non-owning tree's store (where
    // the block doesn't exist → `current = null` → 'TODO') is exactly the
    // race the focus-keyed routing now prevents: only the owning tree's
    // `handleToggleTodo` runs, against the store that holds the block.
    const onToggleTodo: BlockCommandHandler = (blockId) => {
      handleToggleTodo(blockId)
    }

    // ── Toolbar open-block-properties command ─────────────────────────
    const onShowProperties: BlockCommandHandler = (blockId) => {
      handleShowProperties(blockId)
    }

    // ── Toolbar / `{{` picker open-query-builder command (#215) ──────────
    // openQueryBuilder targets the focused block itself, so the routed
    // blockId is unused here.
    const onOpenQueryBuilder: BlockCommandHandler = () => {
      handleOpenQueryBuilder()
    }

    // #281 — toolbar emoji button opens the browse-grid dialog for the focused
    // block (targets the focused block itself, so the routed blockId is unused).
    const onOpenEmojiPicker: BlockCommandHandler = () => {
      handleOpenEmojiPicker()
    }

    // ── Structural toolbar inserts: ordered-list / divider / callout (#253) ──
    // Wire to the SAME content-edit path the matching slash commands use
    // (`useSlashCommandStructural`): build a minimal SlashCommandContext from
    // the focused block and reuse the canonical `applyContentEdit` (which
    // Preserves the undo contract + remount).
    const buildCtx = (blockId: string): SlashCommandContext => ({
      blockId,
      rootParentId,
      rovingEditor: rovingEditorRef.current,
      pageStore,
      datePickerCursorPos,
      setDatePickerMode,
      setDatePickerOpen,
      t: t as unknown as TFunction,
      // Not used by `applyContentEdit`/`readCurrentContent`; structural inserts
      // never open the template picker, query builder, or emoji picker.
      openTemplatePicker: async () => {},
      openQueryBuilder: () => {},
      openEmojiPicker: () => {},
    })

    const onOrderedList: BlockCommandHandler = (blockId) => {
      const ctx = buildCtx(blockId)
      void applyContentEdit(ctx, `1. ${readCurrentContent(ctx)}`, 'slash.numberedListFailed')
    }
    const onDivider: BlockCommandHandler = (blockId) => {
      void applyContentEdit(buildCtx(blockId), '---', 'slash.dividerFailed')
    }
    const onCallout: BlockCommandHandler = (blockId, detail) => {
      // #215 — the toolbar callout type picker sends the chosen variant in
      // `detail.type`; fall back to `info` (slash `/callout` + the plain
      // toolbar button send no detail). Validate against the known set so a
      // stray payload can't inject arbitrary `[!TEXT]`.
      const raw = (detail as { type?: string } | undefined)?.type
      const type = raw && CALLOUT_TYPES.has(raw) ? raw : 'info'
      const ctx = buildCtx(blockId)
      // #1960 — strip any existing block marker first so re-applying a callout
      // (e.g. changing an existing callout's type via the Turn-into contextual
      // picker) REPLACES the marker rather than nesting `> [!X] > [!Y] …`.
      void applyContentEdit(
        ctx,
        `> [!${type.toUpperCase()}] ${stripBlockMarker(readCurrentContent(ctx))}`,
        'slash.calloutFailed',
      )
    }

    // #1960 — Turn-into menu: convert the focused block to `detail.type`
    // (a BlockTypeToken) via the shared markdown convert + content-edit path,
    // identical to the slash `/turn-*` family and the context-menu Turn-into.
    const onTurnInto: BlockCommandHandler = (blockId, detail) => {
      const type = (detail as { type?: BlockTypeToken } | undefined)?.type
      if (!type) return
      const ctx = buildCtx(blockId)
      void applyContentEdit(
        ctx,
        convertBlockContent(readCurrentContent(ctx), type),
        'slash.turnIntoFailed',
      )
    }

    // #1439 — converted clipboard-HTML outline. The editor's HTML-paste handler
    // emits the indented-markdown outline (`detail.markdown`); materialize it as
    // real blocks via `pasteBlocks`, anchored on the focused block (`blockId` is
    // the focused, owned block — the bus only routes here when this tree's store
    // owns the focus). The outline lands AFTER the anchor (siblings/children),
    // exactly like the keyboard/context-menu outline paste.
    const onPasteHtmlBlocks: BlockCommandHandler = (blockId, detail) => {
      const markdown = (detail as { markdown?: string } | undefined)?.markdown
      if (!markdown) return
      void pageStore
        .getState()
        .pasteBlocks(blockId, markdown)
        .catch((err: unknown) => {
          logger.error('BlockTree', 'Failed to paste HTML blocks', { blockId }, err)
          notify.error(t('error.pasteBlocksFailed'))
        })
    }

    return registerBlockCommandTarget(pageStore, {
      PASTE_HTML_BLOCKS: onPasteHtmlBlocks,
      DISCARD_BLOCK_EDIT: onDiscard,
      CYCLE_PRIORITY: onCyclePriority,
      SET_PRIORITY_1: setPriorityHandler('1'),
      SET_PRIORITY_2: setPriorityHandler('2'),
      SET_PRIORITY_3: setPriorityHandler('3'),
      OPEN_DATE_PICKER: openDatePicker('date'),
      OPEN_DUE_DATE_PICKER: openDatePicker('due'),
      OPEN_SCHEDULED_DATE_PICKER: openDatePicker('schedule'),
      TOGGLE_TODO_STATE: onToggleTodo,
      OPEN_BLOCK_PROPERTIES: onShowProperties,
      OPEN_QUERY_BUILDER: onOpenQueryBuilder,
      OPEN_EMOJI_PICKER: onOpenEmojiPicker,
      INSERT_ORDERED_LIST: onOrderedList,
      INSERT_DIVIDER: onDivider,
      INSERT_CALLOUT: onCallout,
      TURN_INTO_BLOCK: onTurnInto,
    })
  }, [
    rootParentId,
    handleEscapeCancel,
    handleToggleTodo,
    handleTogglePriority,
    handleShowProperties,
    handleOpenQueryBuilder,
    handleOpenEmojiPicker,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    pageStore,
    t,
  ])
}
