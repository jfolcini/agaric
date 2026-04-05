import { useCallback, useState } from 'react'
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
  const [batchInProgress, setBatchInProgress] = useState(false)

  const handleBatchSetTodo = useCallback(
    async (state: string | null) => {
      if (batchInProgress) return
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
        setBatchInProgress(false)
      }
    },
    [selectedBlockIds, clearSelected, batchInProgress, rootParentId, t, pageStore],
  )

  const handleBatchDelete = useCallback(async () => {
    if (batchInProgress) return
    setBatchInProgress(true)
    try {
      const ids = [...selectedBlockIds]
      const idsSet = new Set(ids)
      const toDelete = ids.filter((id) => {
        const block = pageStore.getState().blocks.find((b) => b.id === id)
        if (block?.parent_id && idsSet.has(block.parent_id)) return false
        return true
      })
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
      setBatchInProgress(false)
    }
  }, [selectedBlockIds, clearSelected, batchInProgress, t, pageStore])

  return {
    batchDeleteConfirm,
    batchInProgress,
    setBatchDeleteConfirm,
    handleBatchSetTodo,
    handleBatchDelete,
  }
}
