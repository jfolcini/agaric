/**
 * useBlockPageHistory — Ctrl+Z / Ctrl+Y in a focused block whose editor history
 * is spent runs the page's undo / redo and keeps editing (#6556).
 *
 * The block is flushed first, so the page undo never runs under unsaved text
 * (the next flush would write it back over the undo). Focus is cleared for
 * the undo because a reload keeps the focused block's old text, then the
 * editor goes back on the same block with its reloaded text, or, when the
 * undo removed that block, on the row above it (the one Enter came from).
 *
 * Page editor only: the journal's undo is a later stage, so there the press
 * goes on to ProseMirror as before.
 */

import type { RefObject } from 'react'
import { useCallback } from 'react'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { performPageRedo, performPageUndo, runBlockPageHistory } from '@/hooks/useUndoShortcuts'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import type { usePageBlockStoreApi } from '@/stores/page-blocks'
import { runUnmountFlush } from '@/stores/unmount-flush'

export interface UseBlockPageHistoryParams {
  rovingEditorRef: RefObject<RovingEditorHandle | null>
  rootParentId: string | null
  pageStore: ReturnType<typeof usePageBlockStoreApi>
  visibleIdsRef: RefObject<readonly string[]>
  /** BlockTree's empty-block cleanup skips a block listed here once, on focus leaving it. */
  preserveEmptyBlockIdsRef: RefObject<Set<string>>
  edit: (blockId: string, content: string) => Promise<boolean> | void
  splitBlock: (blockId: string, content: string) => Promise<boolean> | void
}

export function useBlockPageHistory({
  rovingEditorRef,
  rootParentId,
  pageStore,
  visibleIdsRef,
  preserveEmptyBlockIdsRef,
  edit,
  splitBlock,
}: UseBlockPageHistoryParams): (direction: 'undo' | 'redo') => boolean {
  const run = useCallback(
    async (handle: RovingEditorHandle, blockId: string, pageId: string, redo: boolean) => {
      const ids = visibleIdsRef.current
      const at = ids.indexOf(blockId)
      const above = at > 0 ? ids[at - 1] : undefined
      const loaded = handle.originalMarkdown
      const changed = handle.unmount()
      // Leaving the block for the undo is not leaving it empty: an Enter stub stays.
      preserveEmptyBlockIdsRef.current.add(blockId)
      useBlockStore.getState().setFocused(null)
      if (changed !== null) {
        const flushed = runUnmountFlush({
          blockId,
          loaded,
          changed,
          edit,
          splitBlock,
          rootParentId: pageId,
          pageStore,
        })
        await flushed.outcome
      }
      await (redo ? performPageRedo(pageId) : performPageUndo(pageId))
      const { blocksById } = pageStore.getState()
      const target =
        blocksById.get(blockId) ?? (above === undefined ? undefined : blocksById.get(above))
      if (!target || useBlockStore.getState().focusedBlockId !== null) return
      useBlockStore.getState().setFocused(target.id)
      handle.mount(target.id, target.content ?? '')
    },
    [visibleIdsRef, preserveEmptyBlockIdsRef, edit, splitBlock, pageStore],
  )

  return useCallback(
    (direction: 'undo' | 'redo'): boolean => {
      const handle = rovingEditorRef.current
      const blockId = handle?.activeBlockId
      if (!handle || !blockId || !rootParentId) return false
      if (useNavigationStore.getState().currentView !== 'page-editor') return false
      runBlockPageHistory(() => run(handle, blockId, rootParentId, direction === 'redo'))
      return true
    },
    [rovingEditorRef, rootParentId, run],
  )
}
