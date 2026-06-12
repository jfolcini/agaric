import type { TFunction } from 'i18next'
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef } from 'react'

import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

import { parse } from '../editor/markdown-serializer'
import { pmEndOfFirstBlock } from '../editor/types'
import type { DeleteBlockOpts } from '../editor/use-block-keyboard'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { announce } from '../lib/announcer'
import type { FlatBlock } from '../lib/tree-utils'

/**
 * UX-241: scroll the block's DOM node into view after a reorder so the
 * viewport tracks the moved block instead of jumping to the top. Wrapped
 * in requestAnimationFrame to let React commit the new layout before we
 * read it. Uses `block: 'nearest'` (not smooth, not center) to keep
 * already-visible blocks in place and only pull off-screen blocks into view.
 *
 * Silently no-ops when the DOM node is absent (e.g. virtualised away or
 * still being remounted by the roving editor).
 */
function scrollFocusedBlockIntoView(blockId: string): void {
  requestAnimationFrame(() => {
    document.querySelector(`[data-block-id="${blockId}"]`)?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * R6 (#405): announce a move's REAL outcome once the store action resolves.
 * The store resolves `true` on a committed move and `false` on a no-op
 * (boundary reached) or a caught backend error (which also toasts). Announcing
 * synchronously before the promise settled meant assistive tech reported a
 * phantom "moved" even when nothing changed. Runs `onSuccess` (e.g. scroll)
 * only on a real move.
 */
function announceMoveResult(
  result: Promise<boolean>,
  t: TFunction,
  successKey: string,
  onSuccess?: () => void,
): Promise<void> {
  return result
    .then((ok) => {
      announce(t(ok ? successKey : 'announce.moveFailed'))
      if (ok) onSuccess?.()
    })
    .catch(() => {
      announce(t('announce.moveFailed'))
    })
}

/**
 * #921 f2 — Backspace-at-start merge must not let the current block's text
 * re-parse as a NEW block construct once it is concatenated onto the previous
 * block's paragraph.
 *
 * The merge stores `prevContent + currentContent` as the previous block's
 * markdown. If `currentContent` begins with a LEADING block-markdown token
 * (`- bar`, `# h`, `> q`, `1. x`, `- [ ] task`), a plain concat would turn the
 * joined-in text into a list item / heading / blockquote appended to (or
 * absorbing) the previous paragraph — mangling the markup. Backspace at the
 * start of a block is a textual join, so the leading construct marker should be
 * dropped and only its inline text carried over.
 *
 * This strips exactly ONE leading block-marker from the FIRST line so the
 * joined content stays inline. It is intentionally conservative: it only fires
 * when the previous block is non-empty (a real join) and only touches the
 * leading token — interior lines and inline marks (`**bold**`, `_em_`) are
 * untouched.
 */
const LEADING_BLOCK_MARKER_RE =
  /^(?:\s{0,3})(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/

export function stripLeadingBlockMarker(content: string): string {
  // Operate only on the first line so a multi-line current block keeps its
  // remaining structure; the join only affects where it meets the prev block.
  const newlineIdx = content.indexOf('\n')
  const firstLine = newlineIdx === -1 ? content : content.slice(0, newlineIdx)
  const rest = newlineIdx === -1 ? '' : content.slice(newlineIdx)
  const stripped = firstLine.replace(LEADING_BLOCK_MARKER_RE, '')
  // Only rewrite when a marker was actually present (avoid mangling plain text
  // and avoid trimming legitimate leading whitespace on unmarked lines).
  return stripped === firstLine ? content : stripped + rest
}

/**
 * Build the merged markdown for a Backspace-at-start join: the previous
 * block's content followed by the current block's content with any leading
 * block-construct marker neutralized (see {@link stripLeadingBlockMarker}).
 * When the previous block is empty there is no paragraph to absorb the text,
 * so the current content is carried over verbatim (nothing to mangle).
 */
function joinMergedContent(prevContent: string, currentContent: string): string {
  if (prevContent === '') return currentContent
  return prevContent + stripLeadingBlockMarker(currentContent)
}

export interface UseBlockKeyboardHandlersParams {
  focusedBlockId: string | null
  collapsedVisible: FlatBlock[]
  rovingEditor: Pick<
    RovingEditorHandle,
    'editor' | 'mount' | 'unmount' | 'getMarkdown' | 'splitAtCaret'
  >
  setFocused: (id: string | null) => void
  handleFlush: () => string | null
  remove: (id: string) => Promise<void>
  edit: (id: string, content: string) => Promise<boolean>
  indent: (id: string) => Promise<boolean>
  dedent: (id: string) => Promise<boolean>
  moveUp: (id: string) => Promise<boolean>
  moveDown: (id: string) => Promise<boolean>
  createBelow: (afterBlockId: string, content?: string) => Promise<string | null>
  justCreatedBlockIds: RefObject<Set<string>>
  /** Discard any persisted draft for the given block (called on Escape). */
  discardDraft: (blockId: string) => void
  t: TFunction
}

export interface UseBlockKeyboardHandlersReturn {
  handleFocusPrev: () => void
  handleFocusNext: () => void
  handleDeleteBlock: (opts?: DeleteBlockOpts) => void
  handleIndent: () => void
  handleDedent: () => void
  handleMoveUp: () => void
  handleMoveDown: () => void
  handleMoveUpById: (id: string) => void
  handleMoveDownById: (id: string) => void
  handleMergeWithPrev: () => Promise<void>
  handleMergeById: (blockId: string) => Promise<void>
  handleEnterSave: () => Promise<void>
  handleEscapeCancel: () => void
}

export function useBlockKeyboardHandlers({
  focusedBlockId,
  collapsedVisible,
  rovingEditor,
  setFocused,
  handleFlush,
  remove,
  edit,
  indent,
  dedent,
  moveUp,
  moveDown,
  createBelow,
  justCreatedBlockIds,
  discardDraft,
  t,
}: UseBlockKeyboardHandlersParams): UseBlockKeyboardHandlersReturn {
  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor

  // Tracks the post-merge setTextSelection setTimeout so we can cancel it on
  // unmount. Without this, a late-firing callback could call
  // `setTextSelection` on a stale editor instance and move the user's cursor
  // on the NEXT mounted block (#MAINT-15).
  const pendingMergeSelectionRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (pendingMergeSelectionRef.current !== null) {
        window.clearTimeout(pendingMergeSelectionRef.current)
        pendingMergeSelectionRef.current = null
      }
    },
    [],
  )

  const handleFocusPrev = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx > 0) {
      const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]
      setFocused(prevBlock.id)
      rovingEditorRef.current.mount(prevBlock.id, prevBlock.content ?? '')
      const preview = prevBlock.content?.slice(0, 50) ?? ''
      announce(t('announce.editingBlock', { preview: preview || t('announce.emptyBlock') }))
    }
  }, [collapsedVisible, focusedBlockId, setFocused, t])

  const handleFocusNext = useCallback(() => {
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx >= 0 && idx < collapsedVisible.length - 1) {
      const nextBlock = collapsedVisible[idx + 1] as (typeof collapsedVisible)[number]
      setFocused(nextBlock.id)
      rovingEditorRef.current.mount(nextBlock.id, nextBlock.content ?? '')
      const preview = nextBlock.content?.slice(0, 50) ?? ''
      announce(t('announce.editingBlock', { preview: preview || t('announce.emptyBlock') }))
    }
  }, [collapsedVisible, focusedBlockId, setFocused, t])

  const handleDeleteBlock = useCallback(
    (opts?: DeleteBlockOpts) => {
      if (!focusedBlockId) return
      if (deleteInProgress.current) return
      if (collapsedVisible.length <= 1) {
        notify.error(t('blockTree.cannotDeleteLastBlock'))
        return
      }
      deleteInProgress.current = true
      const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
      rovingEditorRef.current.unmount()
      remove(focusedBlockId).finally(() => {
        deleteInProgress.current = false
      })
      announce(t('announce.blockDeleted'))
      if (idx > 0) {
        const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]
        setFocused(prevBlock.id)
        // #752 — honour the caller's cursor-placement hint (Backspace on an
        // empty block lands the caret at the END of the previous block, the
        // way a plain-text backspace would).
        rovingEditorRef.current.mount(prevBlock.id, prevBlock.content ?? '', {
          cursorPlacement: opts?.cursorPlacement,
        })
      } else if (idx + 1 < collapsedVisible.length) {
        // Deleting the FIRST block focuses the NEXT one. The 'end' hint is
        // intentionally NOT applied here: the caret belongs at the default
        // (start) position when focus moves forward.
        const nextBlock = collapsedVisible[idx + 1] as (typeof collapsedVisible)[number]
        setFocused(nextBlock.id)
        rovingEditorRef.current.mount(nextBlock.id, nextBlock.content ?? '')
      } else {
        setFocused(null)
      }
    },
    [focusedBlockId, collapsedVisible, remove, setFocused, t],
  )

  const handleIndent = useCallback(() => {
    if (!focusedBlockId) return
    const blockId = focusedBlockId
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    // R6 (#405): announce on RESOLUTION so assistive tech reports the real
    // outcome — a no-op (already at outermost level) or a backend rejection
    // must not announce a phantom "indented".
    void announceMoveResult(indent(blockId), t, 'announce.blockIndented')
    rovingEditorRef.current.mount(blockId, content)
  }, [focusedBlockId, handleFlush, indent, t])

  const handleDedent = useCallback(() => {
    if (!focusedBlockId) return
    const blockId = focusedBlockId
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    void announceMoveResult(dedent(blockId), t, 'announce.blockDedented')
    rovingEditorRef.current.mount(blockId, content)
  }, [focusedBlockId, handleFlush, dedent, t])

  const handleMoveUp = useCallback(() => {
    if (!focusedBlockId) return
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    const blockId = focusedBlockId
    // R6 (#405): announce + scroll on RESOLUTION — a boundary no-op or backend
    // rejection must not announce a phantom "moved up".
    void announceMoveResult(moveUp(blockId), t, 'announce.blockMovedUp', () =>
      scrollFocusedBlockIntoView(blockId),
    )
    rovingEditorRef.current.mount(blockId, content)
  }, [focusedBlockId, handleFlush, moveUp, t])

  const handleMoveDown = useCallback(() => {
    if (!focusedBlockId) return
    const content = rovingEditorRef.current.getMarkdown?.() ?? ''
    handleFlush()
    const blockId = focusedBlockId
    void announceMoveResult(moveDown(blockId), t, 'announce.blockMovedDown', () =>
      scrollFocusedBlockIntoView(blockId),
    )
    rovingEditorRef.current.mount(blockId, content)
  }, [focusedBlockId, handleFlush, moveDown, t])

  const handleMoveUpById = useCallback(
    (id: string) => {
      const content = id === focusedBlockId ? (rovingEditorRef.current.getMarkdown?.() ?? '') : null
      handleFlush()
      moveUp(id)
        .then(() => scrollFocusedBlockIntoView(id))
        .catch((err: unknown) => {
          logger.warn('useBlockKeyboardHandlers', 'moveUp by id failed', { blockId: id }, err)
        })
      if (content !== null) {
        rovingEditorRef.current.mount(id, content)
      }
    },
    [focusedBlockId, handleFlush, moveUp],
  )

  const handleMoveDownById = useCallback(
    (id: string) => {
      const content = id === focusedBlockId ? (rovingEditorRef.current.getMarkdown?.() ?? '') : null
      handleFlush()
      moveDown(id)
        .then(() => scrollFocusedBlockIntoView(id))
        .catch((err: unknown) => {
          logger.warn('useBlockKeyboardHandlers', 'moveDown by id failed', { blockId: id }, err)
        })
      if (content !== null) {
        rovingEditorRef.current.mount(id, content)
      }
    },
    [focusedBlockId, handleFlush, moveDown],
  )

  /**
   * Shared merge orchestration: edit `prevBlockId` with the merged content,
   * remove `removeBlockId`, and revert the edit on remove failure. The
   * caller supplies the per-handler log messages, log metadata blockIds,
   * and editor-remount cleanup callbacks so the two handlers preserve
   * their original log lines (`(edit step)` vs. `by ID (edit step)` etc.)
   * while sharing the revert + toast error path.
   *
   * Returns `true` on success, `false` if edit or remove failed (in which
   * case cleanup ran and the merge toast was shown).
   */
  const mergeBlocksAndHandle = useCallback(
    async (params: {
      prevBlockId: string
      removeBlockId: string
      prevContent: string
      mergedContent: string
      editLogMessage: string
      editLogBlockId: string
      removeLogMessage: string
      removeLogBlockId: string
      onEditFailureCleanup: () => void
      onRemoveFailureCleanup: () => void
    }): Promise<boolean> => {
      try {
        await edit(params.prevBlockId, params.mergedContent)
      } catch (err) {
        logger.error(
          'useBlockKeyboardHandlers',
          params.editLogMessage,
          {
            blockId: params.editLogBlockId,
          },
          err,
        )
        params.onEditFailureCleanup()
        notify.error(t('blockTree.mergeBlocksFailed'))
        return false
      }
      try {
        await remove(params.removeBlockId)
      } catch (err) {
        logger.error(
          'useBlockKeyboardHandlers',
          params.removeLogMessage,
          {
            blockId: params.removeLogBlockId,
          },
          err,
        )
        // Revert the edit to avoid partial state (merged content in prev + original in current)
        await edit(params.prevBlockId, params.prevContent).catch((revertErr: unknown) => {
          logger.warn(
            'useBlockKeyboardHandlers',
            'Failed to revert edit after merge failure',
            {
              blockId: params.prevBlockId,
            },
            revertErr,
          )
        })
        params.onRemoveFailureCleanup()
        notify.error(t('blockTree.mergeBlocksFailed'))
        return false
      }
      return true
    },
    [edit, remove, t],
  )

  const handleMergeWithPrev = useCallback(async () => {
    if (!focusedBlockId) return
    const idx = collapsedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx <= 0) return

    const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]

    const currentContent = rovingEditorRef.current.unmount() ?? collapsedVisible[idx]?.content ?? ''
    const prevContent = prevBlock.content ?? ''

    // #921 f2 — neutralize a leading block-marker so the joined-in text doesn't
    // re-parse as a list item / heading / blockquote on the previous block.
    const mergedContent = joinMergedContent(prevContent, currentContent)
    const prevDoc = parse(prevContent)
    const joinPoint = pmEndOfFirstBlock(prevDoc)

    const remount = () => rovingEditorRef.current.mount(focusedBlockId, currentContent)
    const ok = await mergeBlocksAndHandle({
      prevBlockId: prevBlock.id,
      removeBlockId: focusedBlockId,
      prevContent,
      mergedContent,
      editLogMessage: 'Failed to merge blocks (edit step)',
      editLogBlockId: prevBlock.id,
      removeLogMessage: 'Failed to merge blocks (remove step)',
      removeLogBlockId: focusedBlockId,
      onEditFailureCleanup: remount,
      onRemoveFailureCleanup: remount,
    })
    if (!ok) return

    setFocused(prevBlock.id)
    rovingEditorRef.current.mount(prevBlock.id, mergedContent)

    if (pendingMergeSelectionRef.current !== null) {
      window.clearTimeout(pendingMergeSelectionRef.current)
    }
    pendingMergeSelectionRef.current = window.setTimeout(() => {
      pendingMergeSelectionRef.current = null
      const editor = rovingEditorRef.current.editor
      if (editor) {
        const pmPos = Math.min(joinPoint, editor.state.doc.content.size - 1)
        editor.commands.setTextSelection(pmPos)
      }
    }, 0)
  }, [focusedBlockId, collapsedVisible, mergeBlocksAndHandle, setFocused])

  const handleMergeById = useCallback(
    async (blockId: string) => {
      const idx = collapsedVisible.findIndex((b) => b.id === blockId)
      if (idx <= 0) return

      const prevBlock = collapsedVisible[idx - 1] as (typeof collapsedVisible)[number]

      const editorContent = focusedBlockId === blockId ? rovingEditorRef.current.unmount() : null
      const currentContent = editorContent ?? collapsedVisible[idx]?.content ?? ''
      const prevContent = prevBlock.content ?? ''

      // #921 f2 — see handleMergeWithPrev: strip a leading block-marker so the
      // joined-in text stays inline instead of forming a new construct.
      const mergedContent = joinMergedContent(prevContent, currentContent)

      const remountIfNeeded = () => {
        if (editorContent !== null) {
          rovingEditorRef.current.mount(blockId, currentContent)
        }
      }

      const ok = await mergeBlocksAndHandle({
        prevBlockId: prevBlock.id,
        removeBlockId: blockId,
        prevContent,
        mergedContent,
        editLogMessage: 'Failed to merge blocks by ID (edit step)',
        editLogBlockId: blockId,
        removeLogMessage: 'Failed to merge blocks by ID (remove step)',
        removeLogBlockId: blockId,
        onEditFailureCleanup: remountIfNeeded,
        onRemoveFailureCleanup: remountIfNeeded,
      })
      if (!ok) return

      setFocused(prevBlock.id)
      rovingEditorRef.current.mount(prevBlock.id, mergedContent)
    },
    [collapsedVisible, focusedBlockId, mergeBlocksAndHandle, setFocused],
  )

  // Re-entrancy guard: prevents rapid Backspace presses from duplicating deletes.
  const deleteInProgress = useRef(false)

  // Re-entrancy guard: prevents rapid Enter presses from creating duplicate blocks.
  const enterSaveInProgress = useRef(false)

  const handleEnterSave = useCallback(async () => {
    if (!focusedBlockId) return
    if (enterSaveInProgress.current) {
      logger.warn(
        'useBlockKeyboardHandlers',
        'Enter press dropped — previous save still in progress',
        {
          blockId: focusedBlockId,
        },
      )
      return
    }
    enterSaveInProgress.current = true
    try {
      // Capture content before flush so we can re-mount on failure
      const savedContent = rovingEditorRef.current.getMarkdown?.() ?? ''

      // #909 — split the block at the caret. When there is text AFTER the
      // caret, keep the before-text in the current block and move the
      // after-text into the new block (Logseq/Notion/ProseMirror splitBlock).
      // When the caret is at the end (after === '') or no caret split is
      // available (range selection / no editor), fall back to the legacy
      // path: flush the whole block and create an EMPTY block below.
      const split = rovingEditorRef.current.splitAtCaret?.() ?? null
      if (split && split.after !== '') {
        rovingEditorRef.current.unmount()
        await edit(focusedBlockId, split.before)
        const newBlockId = await createBelow(focusedBlockId, split.after)
        if (newBlockId) {
          // NOT added to justCreatedBlockIds: the new block carries real
          // content, so Escape must not auto-delete it as an empty stub.
          setFocused(newBlockId)
          announce(t('announce.blockCreated'))
        } else {
          // Backend error — restore the original (unsplit) block so the user
          // isn't left with a truncated block and no place to type.
          rovingEditorRef.current.mount(focusedBlockId, savedContent)
        }
        return
      }

      handleFlush()
      const newBlockId = await createBelow(focusedBlockId)
      if (newBlockId) {
        justCreatedBlockIds.current.add(newBlockId)
        setFocused(newBlockId)
        announce(t('announce.blockCreated'))
      } else {
        // createBelow returned null (e.g. backend error) — re-mount editor
        // so the user isn't stuck with an unmounted block.
        rovingEditorRef.current.mount(focusedBlockId, savedContent)
      }
    } finally {
      enterSaveInProgress.current = false
    }
  }, [focusedBlockId, handleFlush, createBelow, edit, setFocused, justCreatedBlockIds, t])

  const handleEscapeCancel = useCallback(() => {
    if (!focusedBlockId) return
    // Discard any persisted draft BEFORE unmounting so the autosave
    // cleanup cannot flush stale content to the database.
    discardDraft(focusedBlockId)
    const changed = rovingEditorRef.current.unmount()
    if (changed !== null) {
      notify(t('blockTree.changesDiscarded'), { duration: 2000 })
    }
    // If the block was just created and the user made no edits (changed === null),
    // delete the empty block instead of leaving it around.
    if (justCreatedBlockIds.current.has(focusedBlockId) && changed === null) {
      justCreatedBlockIds.current.delete(focusedBlockId)
      remove(focusedBlockId).catch((err: unknown) => {
        logger.warn(
          'useBlockKeyboardHandlers',
          'Failed to remove empty just-created block on Escape',
          { blockId: focusedBlockId },
          err,
        )
      })
    }
    setFocused(null)
  }, [focusedBlockId, setFocused, justCreatedBlockIds, remove, discardDraft, t])

  return {
    handleFocusPrev,
    handleFocusNext,
    handleDeleteBlock,
    handleIndent,
    handleDedent,
    handleMoveUp,
    handleMoveDown,
    handleMoveUpById,
    handleMoveDownById,
    handleMergeWithPrev,
    handleMergeById,
    handleEnterSave,
    handleEscapeCancel,
  }
}
