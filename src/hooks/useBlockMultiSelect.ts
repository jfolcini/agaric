import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { StoreApi } from 'zustand'
import { deleteBlock, setTodoState as setTodoStateCmd } from '../lib/tauri'
import type { PageBlockState } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'

export interface UseBlockMultiSelectParams {
  selectedBlockIds: string[]
  clearSelected: () => void
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  // biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
  t: (...args: any[]) => any
}

export interface UseBlockMultiSelectReturn {
  batchDeleteConfirm: boolean
  batchInProgress: boolean
  setBatchDeleteConfirm: (v: boolean) => void
  handleBatchSetTodo: (state: string | null) => Promise<void>
  handleBatchDelete: () => Promise<void>
}

export function useBlockMultiSelect({
  selectedBlockIds,
  clearSelected,
  rootParentId,
  pageStore,
  t,
}: UseBlockMultiSelectParams): UseBlockMultiSelectReturn {
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false)
  // `batchInProgress` (state) is surfaced to the UI (disables buttons in
  // BlockContextMenu). `batchInProgressRef` is the reentrancy guard — using a
  // ref here prevents cascade re-renders caused by rebuilding the useCallback
  // identity on every flag flip (#MAINT-9).
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
        pageStore.setState((s) => ({
          blocks: s.blocks.map((b) => (idSet.has(b.id) ? { ...b, todo_state: state } : b)),
        }))
        let successCount = 0
        let failCount = 0
        for (const id of ids) {
          try {
            await setTodoStateCmd(id, state)
            successCount++
          } catch {
            failCount++
          }
        }
        if (successCount > 0 && rootParentId) {
          useUndoStore.getState().onNewAction(rootParentId)
        }
        clearSelected()
        if (failCount > 0) {
          toast.error(
            t('blockTree.updateFailedMessage', {
              failCount,
              totalCount: ids.length,
            }),
          )
        } else {
          toast.success(
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

  const handleBatchDelete = useCallback(async () => {
    if (batchInProgressRef.current) return
    batchInProgressRef.current = true
    setBatchInProgress(true)
    try {
      const ids = [...selectedBlockIds]
      const idsSet = new Set(ids)
      // Walk the parent chain (not just the direct parent) so transitive
      // descendants of a selected ancestor are filtered out — otherwise the
      // ancestor's server-side cascade races extra deleteBlock() calls and
      // surfaces as spurious "delete failed" toast counts (#MAINT-173).
      const blocks = pageStore.getState().blocks
      const parentOf = new Map<string, string | null>()
      for (const b of blocks) parentOf.set(b.id, b.parent_id ?? null)
      const hasAncestorInSet = (id: string): boolean => {
        let cursor = parentOf.get(id) ?? null
        for (let i = 0; cursor !== null && i < 1000; i++) {
          if (idsSet.has(cursor)) return true
          if (!parentOf.has(cursor)) return false
          cursor = parentOf.get(cursor) ?? null
        }
        return false
      }
      const toDelete = ids.filter((id) => !hasAncestorInSet(id))
      let successCount = 0
      let failCount = 0
      for (const id of toDelete) {
        try {
          await deleteBlock(id)
          pageStore.setState((s) => ({
            blocks: s.blocks.filter((b) => b.id !== id),
          }))
          successCount++
        } catch {
          failCount++
        }
      }
      clearSelected()
      setBatchDeleteConfirm(false)
      if (failCount > 0) {
        toast.error(
          t('blockTree.deleteFailedMessage', {
            failCount,
            totalCount: toDelete.length,
          }),
        )
      } else {
        toast.success(t('blockTree.deletedMessage', { count: successCount }))
      }
    } finally {
      batchInProgressRef.current = false
      setBatchInProgress(false)
    }
  }, [selectedBlockIds, clearSelected, t, pageStore])

  return {
    batchDeleteConfirm,
    batchInProgress,
    setBatchDeleteConfirm,
    handleBatchSetTodo,
    handleBatchDelete,
  }
}
