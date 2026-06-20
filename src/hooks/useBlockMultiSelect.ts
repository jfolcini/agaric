import type { TFunction } from 'i18next'
import { useCallback, useRef, useState } from 'react'
import type { StoreApi } from 'zustand'

import { notify } from '@/lib/notify'

import { deleteBlocksByIds, setTodoStateBatch } from '../lib/tauri'
import type { PageBlockState } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'

export interface UseBlockMultiSelectParams {
  selectedBlockIds: string[]
  clearSelected: () => void
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  t: TFunction
  /**
   * #1734 — single-block priority cycle, fanned out across the selection by
   * `handleBatchSetPriority`. Mirrors the bulk priority path the context menu
   * already exposes; passed in so the hook reuses the canonical cycle logic
   * (configurable level set, optimistic update, undo bookkeeping).
   */
  handleTogglePriority: (blockId: string) => void | Promise<void>
}

export interface UseBlockMultiSelectReturn {
  batchDeleteConfirm: boolean
  batchInProgress: boolean
  setBatchDeleteConfirm: (v: boolean) => void
  handleBatchSetTodo: (state: string | null) => Promise<void>
  handleBatchSetPriority: () => Promise<void>
  handleBatchDelete: () => Promise<void>
}

export function useBlockMultiSelect({
  selectedBlockIds,
  clearSelected,
  rootParentId,
  pageStore,
  t,
  handleTogglePriority,
}: UseBlockMultiSelectParams): UseBlockMultiSelectReturn {
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false)
  // `batchInProgress` (state) is surfaced to the UI (disables buttons in
  // BlockContextMenu). `batchInProgressRef` is the reentrancy guard — using a
  // ref here prevents cascade re-renders caused by rebuilding the useCallback
  // Identity on every flag flip (#).
  const [batchInProgress, setBatchInProgress] = useState(false)
  const batchInProgressRef = useRef(false)

  const handleBatchSetTodo = useCallback(
    async (state: string | null) => {
      if (batchInProgressRef.current) return
      batchInProgressRef.current = true
      setBatchInProgress(true)
      try {
        const ids = [...selectedBlockIds]
        const idSet = new Set(ids)
        // Optimistic FE update — flip the badge instantly while the
        // single-IPC batch round-trips. On failure the catch below
        // surfaces an error toast; the next page load will re-read
        // the truthful state from the backend.
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (idSet.has(b.id) ? { ...b, todo_state: state } : b)),
        }))
        // One IPC for the whole batch (was N).
        // Backend wraps the per-block op_log appends + materialised
        // `blocks.todo_state` writes in a single IMMEDIATE tx.
        let successCount = 0
        let failCount = 0
        try {
          successCount = await setTodoStateBatch(ids, state)
          // Treat any id we asked for that the backend silently
          // skipped (missing / already-deleted) as a "fail" for the
          // toast counter so the user sees an honest summary.
          failCount = Math.max(0, ids.length - successCount)
        } catch {
          failCount = ids.length
        }
        if (successCount > 0 && rootParentId) {
          useUndoStore.getState().onNewAction(rootParentId)
        }
        clearSelected()
        if (failCount > 0) {
          notify.error(
            t('blockTree.updateFailedMessage', {
              failCount,
              totalCount: ids.length,
            }),
          )
        } else {
          notify.success(
            t('blockTree.setStateMessage', {
              successCount,
              state: state ?? 'none',
            }),
          )
        }
      } finally {
        batchInProgressRef.current = false
        setBatchInProgress(false)
      }
    },
    [selectedBlockIds, clearSelected, rootParentId, t, pageStore],
  )

  // #1734 — cycle priority across the whole selection. Unlike TODO/delete there
  // is no dedicated single-IPC batch priority endpoint, so this fans out the
  // canonical per-block cycle (the exact path the bulk context menu uses),
  // awaiting each in turn so one failure surfaces a toast (raised inside
  // `handleTogglePriority`) without aborting the rest. Selection is cleared
  // afterwards, matching the toolbar's other batch actions.
  const handleBatchSetPriority = useCallback(async () => {
    if (batchInProgressRef.current) return
    batchInProgressRef.current = true
    setBatchInProgress(true)
    try {
      const ids = [...selectedBlockIds]
      for (const id of ids) {
        await Promise.resolve(handleTogglePriority(id))
      }
      clearSelected()
    } finally {
      batchInProgressRef.current = false
      setBatchInProgress(false)
    }
  }, [selectedBlockIds, handleTogglePriority, clearSelected])

  const handleBatchDelete = useCallback(async () => {
    if (batchInProgressRef.current) return
    batchInProgressRef.current = true
    setBatchInProgress(true)
    try {
      const ids = [...selectedBlockIds]
      // The ancestor pre-walk is no
      // longer needed. The single-row `deleteBlock` IPC required the
      // FE to filter selected descendants client-side because each
      // root ran in its own IMMEDIATE tx and the cascade-races would
      // surface as spurious "delete failed" toast counts. The batch
      // endpoint `delete_blocks_by_ids` walks descendants in one
      // recursive CTE seeded from every root simultaneously, so
      // duplicate descendant ids in the input set are coalesced
      // server-side. Send the raw selection unchanged.
      const idsSet = new Set(ids)
      let successCount = 0
      let failCount = 0
      try {
        // Backend returns the number of blocks soft-deleted (roots +
        // descendants combined). For UX we report against the
        // selection size: a 1:1 mapping is the common case for a
        // flat selection; ancestor-coalescing makes the returned
        // count >= selectedRoots, which still represents "every
        // requested row is gone".
        const affected = await deleteBlocksByIds(ids)
        // The selection itself was processed atomically. Count
        // successful "selected rows that are now deleted" by
        // re-reading the in-memory state shape: since the call
        // succeeded, every selected id is either a deleted root or
        // a descendant of a selected ancestor — both gone. Use the
        // selection size for the toast counter.
        successCount = ids.length
        // `affected` is unused in the toast (it would surface
        // descendants we did not explicitly select), but keeping
        // the local makes the intent explicit.
        void affected
        // Splice the selected ids out of the page store in one go.
        pageStore.setState((s) => ({
          blocks: s.blocks.filter((b) => !idsSet.has(b.id)),
        }))
        // C4 (#217) — the batch delete appended DeleteBlock ops to the
        // page op-log (one per root), so Ctrl+Z genuinely reverses it
        // via undo_page_op. Mark a new action so the redo stack/depth
        // reset to a clean slate (mirrors handleBatchSetTodo) and the
        // toast below can honestly advertise the undo path.
        if (rootParentId) {
          useUndoStore.getState().onNewAction(rootParentId)
        }
      } catch {
        failCount = ids.length
      }
      clearSelected()
      setBatchDeleteConfirm(false)
      if (failCount > 0) {
        notify.error(
          t('blockTree.deleteFailedMessage', {
            failCount,
            totalCount: ids.length,
          }),
        )
      } else {
        // Reassure the user the destructive batch is recoverable.
        notify.success(t('blockTree.deletedMessageUndo', { count: successCount }))
      }
    } finally {
      batchInProgressRef.current = false
      setBatchInProgress(false)
    }
  }, [selectedBlockIds, clearSelected, rootParentId, t, pageStore])

  return {
    batchDeleteConfirm,
    batchInProgress,
    setBatchDeleteConfirm,
    handleBatchSetTodo,
    handleBatchSetPriority,
    handleBatchDelete,
  }
}
