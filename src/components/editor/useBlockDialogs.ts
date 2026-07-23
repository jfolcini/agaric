/**
 * useBlockDialogs — owns the STATE + open/close/act handlers for BlockTree's
 * four block-level dialog surfaces:
 *   - block-history sheet
 *   - property drawer
 *   - visual query builder (#215)
 *   - emoji picker (#286)
 *
 * Extracted verbatim from BlockTree (#2930) — a mechanical move with zero
 * behavior change. The dialog MOUNTS themselves render in `<BlockTreeDialogs/>`,
 * fed by this hook's returned state + handlers.
 */
import type { Dispatch, SetStateAction } from 'react'
import { startTransition, useCallback, useState } from 'react'
import type { StoreApi } from 'zustand'

import { insertEmojiIntoActiveEditor } from '@/editor/insert-emoji'
import type { PageBlockState } from '@/stores/page-blocks'

interface UseBlockDialogsParams {
  /** Currently focused block id (drives which block /query launches against). */
  focusedBlockId: string | null
  /** Per-page store API for the query-builder write. */
  pageStore: StoreApi<PageBlockState>
  /** Reload the page after a query-builder save lands. */
  load: () => Promise<void>
}

export interface UseBlockDialogsResult {
  historyBlockId: string | null
  setHistoryBlockId: Dispatch<SetStateAction<string | null>>
  propertyDrawerBlockId: string | null
  setPropertyDrawerBlockId: Dispatch<SetStateAction<string | null>>
  queryBuilderOpen: boolean
  setQueryBuilderOpen: Dispatch<SetStateAction<boolean>>
  emojiPickerOpen: boolean
  setEmojiPickerOpen: Dispatch<SetStateAction<boolean>>
  handleShowHistory: (blockId: string) => void
  handleShowProperties: (blockId: string) => void
  openQueryBuilder: () => void
  openEmojiPicker: () => void
  handleEmojiSelect: (char: string) => void
  handleQuerySave: (expression: string) => Promise<void>
}

export function useBlockDialogs({
  focusedBlockId,
  pageStore,
  load,
}: UseBlockDialogsParams): UseBlockDialogsResult {
  // ── History sheet state ────────────────────────────────────────────
  const [historyBlockId, setHistoryBlockId] = useState<string | null>(null)

  // ── Property drawer state ──────────────────────────────────────────
  const [propertyDrawerBlockId, setPropertyDrawerBlockId] = useState<string | null>(null)

  // ── Query builder (#215): /query opens the visual builder; on save we
  // write `{{query …}}` to the block it was launched from. ──────────────
  const [queryBuilderOpen, setQueryBuilderOpen] = useState(false)
  const [queryBuilderBlockId, setQueryBuilderBlockId] = useState<string | null>(null)

  // ── Emoji picker (#286): /emoji opens the browse-grid dialog; on select we
  // insert the chosen native emoji at the caret of the focused block editor. ─
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)

  const handleShowHistory = useCallback((blockId: string) => {
    setHistoryBlockId(blockId)
  }, [])

  const handleShowProperties = useCallback((blockId: string) => {
    setPropertyDrawerBlockId(blockId)
  }, [])

  // ── Query builder (#215) — /query opens the modal for the focused block;
  // on save, write the generated `{{query …}}` expression to that block. ──
  const openQueryBuilder = () => {
    setQueryBuilderBlockId(focusedBlockId)
    // Mark the open as a non-urgent transition: opening it synchronously
    // inside the slash-command handler blurs the editor while React is
    // mid-render, and the editor's blur flush (`flushSync` in useEditorBlur)
    // then warns "flushSync called from inside a lifecycle method".
    // startTransition lets the current commit settle first, avoiding that.
    startTransition(() => setQueryBuilderOpen(true))
  }
  // ── Emoji picker (#286) — /emoji opens the browse-grid dialog for the
  // focused block. Mark the open as a non-urgent transition for the same
  // reason as the query builder (avoid a flushSync-in-render warning from
  // the editor blur flush when the dialog steals focus mid-commit). ──────────
  const openEmojiPicker = () => {
    startTransition(() => setEmojiPickerOpen(true))
  }
  // Insert the chosen native emoji at the caret via the active roving editor.
  // The dialog dismisses itself on select (closeOnSelect default).
  const handleEmojiSelect = useCallback((char: string) => {
    insertEmojiIntoActiveEditor(char)
  }, [])

  const handleQuerySave = async (expression: string) => {
    // Capture the target block once at entry; `queryBuilderBlockId` is read
    // from closure and may change while we await the write (#1016).
    const blockId = queryBuilderBlockId
    if (!blockId) return
    // `edit()` handles its own error path (rollback + generic save-failed
    // toast) and resolves `false` on failure rather than throwing. Keep the
    // dialog open in that case so the user doesn't lose the query they built;
    // only close + reload once the write actually landed.
    const ok = await pageStore.getState().edit(blockId, `{{query ${expression}}}`)
    if (!ok) return
    // Re-validate after the await: if the dialog closed or moved to a
    // different block mid-flight, don't clobber the now-current state.
    if (queryBuilderBlockId !== blockId) return
    setQueryBuilderOpen(false)
    await load()
  }

  return {
    historyBlockId,
    setHistoryBlockId,
    propertyDrawerBlockId,
    setPropertyDrawerBlockId,
    queryBuilderOpen,
    setQueryBuilderOpen,
    emojiPickerOpen,
    setEmojiPickerOpen,
    handleShowHistory,
    handleShowProperties,
    openQueryBuilder,
    openEmojiPicker,
    handleEmojiSelect,
    handleQuerySave,
  }
}
