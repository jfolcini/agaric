/**
 * useFocusedBlockActions — the focused-block command handlers extracted from
 * BlockTree (#2930). Each callback runs its action against the currently
 * focused block; together they are the sole source of the `on*` bindings the
 * document-level `useBlockKeyboard` listener consumes.
 *
 * Stable identities (verbatim `useCallback`s from BlockTree) so `useBlockKeyboard`
 * doesn't detach/re-attach the document keydown listener on every BlockTree
 * render (block edits, selection changes, text input). A mechanical move with
 * zero behavior change.
 */
import { useCallback } from 'react'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'

interface UseFocusedBlockActionsParams {
  focusedBlockId: string | null
  handleToggleTodo: (blockId: string) => Promise<void>
  toggleCollapse: (blockId: string) => void
  handleShowProperties: (blockId: string) => void
  handleShowHistory: (blockId: string) => void
  handleDuplicate: (blockId: string) => Promise<void>
  rovingEditor: RovingEditorHandle
}

export interface UseFocusedBlockActionsResult {
  handleToggleFocusedTodo: () => void
  handleToggleFocusedCollapse: () => void
  handleShowFocusedProperties: () => void
  handleShowFocusedHistory: () => void
  handleDuplicateFocused: () => void
  handleTurnIntoFocused: () => void
}

export function useFocusedBlockActions({
  focusedBlockId,
  handleToggleTodo,
  toggleCollapse,
  handleShowProperties,
  handleShowHistory,
  handleDuplicate,
  rovingEditor,
}: UseFocusedBlockActionsParams): UseFocusedBlockActionsResult {
  const handleToggleFocusedTodo = useCallback(() => {
    if (focusedBlockId) handleToggleTodo(focusedBlockId)
  }, [focusedBlockId, handleToggleTodo])
  const handleToggleFocusedCollapse = useCallback(() => {
    if (focusedBlockId) toggleCollapse(focusedBlockId)
  }, [focusedBlockId, toggleCollapse])
  const handleShowFocusedProperties = useCallback(() => {
    if (focusedBlockId) handleShowProperties(focusedBlockId)
  }, [focusedBlockId, handleShowProperties])
  // #976 (item 15) — open the block-history drawer for the focused block via
  // the `openBlockHistory` keyboard binding, mirroring the properties path.
  const handleShowFocusedHistory = useCallback(() => {
    if (focusedBlockId) handleShowHistory(focusedBlockId)
  }, [focusedBlockId, handleShowHistory])
  // #976 (item 13) — duplicate the focused block + its subtree via the
  // `duplicateBlock` keyboard binding, reusing the same `handleDuplicate` the
  // context-menu row and `/duplicate` slash command fire.
  const handleDuplicateFocused = useCallback(() => {
    if (focusedBlockId) void handleDuplicate(focusedBlockId)
  }, [focusedBlockId, handleDuplicate])
  // #976 (item 14) — open the "Turn into" type picker for the focused block via
  // the `turnIntoBlock` keyboard binding. Rather than reimplement the type list,
  // insert the `/turn` slash trigger into the live editor so the existing slash
  // suggestion plugin surfaces the same conversion family (`turn-*`) the context
  // menu submenu and `/turn` command expose.
  const handleTurnIntoFocused = useCallback(() => {
    if (!focusedBlockId) return
    rovingEditor.editor?.chain().focus().insertContent('/turn').run()
  }, [focusedBlockId, rovingEditor])

  return {
    handleToggleFocusedTodo,
    handleToggleFocusedCollapse,
    handleShowFocusedProperties,
    handleShowFocusedHistory,
    handleDuplicateFocused,
    handleTurnIntoFocused,
  }
}
