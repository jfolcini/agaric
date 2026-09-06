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
 *
 * ## #4729 — these dialogs open ON TOP of a block that is about to be blank
 *
 * A slash command DELETES its trigger text before dispatching (see
 * `slash-command.ts`), and so does the `{{` query picker. So `/query`,
 * `/emoji` and `/assignee` on a block that held nothing else leave that block
 * EMPTY, and the modal they open then takes focus — which blurs the editor,
 * clears `focusedBlockId`, and hands the drop-on-blur cleanup a blank block to
 * delete. The dialog's write-back (the `{{query …}}` expression, the picked
 * emoji, the property value) then has no block left to land in.
 *
 * The overlays that DON'T have this problem — the date picker, the template
 * picker, the block context menu, the formatting toolbar — are spared by
 * `data-editor-portal` (see `useEditorBlur`): their blur never fires at all,
 * so focus never leaves and the cleanup never runs. The four dialogs here
 * deliberately do not carry that tag; they WANT the blur, because the editor
 * must flush and unmount while a full modal owns the screen. So they take the
 * other route: register the block in `preserveEmptyBlockIds` — the same
 * exemption set `handleEnterSave` uses for the blank line an Enter-at-line-
 * start deliberately leaves behind.
 *
 * Registration is SYNCHRONOUS in the open handler, before `startTransition`.
 * The `queryBuilderOpen` / `emojiPickerOpen` state is deliberately NOT the
 * signal: it is committed in a transition, while the blur that clears the
 * focus is urgent, so the cleanup effect can run in a commit where the "a
 * dialog is open" flag is still `false` — a guard reading it would fail open.
 */
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { startTransition, useCallback, useState } from 'react'
import type { StoreApi } from 'zustand'

import { insertEmojiIntoActiveEditor } from '@/editor/insert-emoji'
import { useBlockStore } from '@/stores/blocks'
import type { PageBlockState } from '@/stores/page-blocks'

interface UseBlockDialogsParams {
  /** Currently focused block id (drives which block /query launches against). */
  focusedBlockId: string | null
  /** Per-page store API for the query-builder write. */
  pageStore: StoreApi<PageBlockState>
  /** Reload the page after a query-builder save lands. */
  load: () => Promise<void>
  /**
   * #4729 — BlockTree's set of block ids the focus-leave empty-block cleanup
   * must skip exactly once. See the module docstring: each dialog that writes
   * back into the block it was opened for registers that block here before
   * taking focus.
   */
  preserveEmptyBlockIds: RefObject<Set<string>>
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
  preserveEmptyBlockIds,
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

  /**
   * #4729 — exempt `blockId` from the ONE focus-leave that opening a dialog
   * over it is about to cause (see the module docstring).
   *
   * Gated on the block still holding focus, read LIVE from the store rather
   * than from the render-captured `focusedBlockId` (a `useCallback` with an
   * empty dep list would freeze that at the first render's value). A dialog
   * opened from the gutter has already blurred the editor by the time it gets
   * here — there is no focus-leave left to skip, so registering would leave an
   * unconsumed id behind that eats a later, genuine cleanup of that block.
   */
  const preserveEmptyBlock = useCallback(
    (blockId: string | null) => {
      if (blockId === null) return
      if (useBlockStore.getState().focusedBlockId !== blockId) return
      preserveEmptyBlockIds.current.add(blockId)
    },
    [preserveEmptyBlockIds],
  )

  const handleShowHistory = useCallback(
    (blockId: string) => {
      // No slash command routes here — the sheet is a gutter/context-menu
      // affordance, so the live-focus gate below usually declines. Registered
      // anyway because restoring a version IS a write-back into this block,
      // and the sheet takes focus the same way the other three do.
      preserveEmptyBlock(blockId)
      setHistoryBlockId(blockId)
    },
    [preserveEmptyBlock],
  )

  const handleShowProperties = useCallback(
    (blockId: string) => {
      // #2656 — `/assignee` and `/location` (and their `Custom…` presets)
      // collect their free-text value HERE, so this is a write-back path and
      // not just a gutter affordance.
      preserveEmptyBlock(blockId)
      setPropertyDrawerBlockId(blockId)
    },
    [preserveEmptyBlock],
  )

  // ── Query builder (#215) — /query opens the modal for the focused block;
  // on save, write the generated `{{query …}}` expression to that block. ──
  const openQueryBuilder = () => {
    setQueryBuilderBlockId(focusedBlockId)
    // #4729 — the `{{` picker and `/query` both consumed their trigger text,
    // so this block may already be blank. Claim it BEFORE the modal takes
    // focus (module docstring); `handleQuerySave` below writes back into it.
    preserveEmptyBlock(focusedBlockId)
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
    // #4729 — `handleEmojiSelect` writes into this block's editor, which only
    // exists while the block does.
    preserveEmptyBlock(focusedBlockId)
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
