/**
 * usePageDelete — hook for managing page deletion state including
 * confirmation dialog target, in-flight tracking, and toast feedback.
 *
 * Extracted from PageBrowser for testability and reuse.
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { BlockRow } from '../lib/tauri'
import { deleteBlock } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'

interface DeleteTarget {
  id: string
  name: string
}

interface UsePageDeleteResult {
  /** The page currently targeted for deletion (shown in confirm dialog). */
  deleteTarget: DeleteTarget | null
  /** The ID of the page currently being deleted (for disabling UI). */
  deletingId: string | null
  /** Set the delete target to show the confirmation dialog. */
  setDeleteTarget: (target: DeleteTarget | null) => void
  /** Confirm deletion of the current target — call from the dialog's action button. */
  handleConfirmDelete: () => void
  /** Execute delete for a specific page ID. */
  handleDeletePage: (pageId: string) => Promise<void>
}

export function usePageDelete(
  setPages: (updater: (prev: BlockRow[]) => BlockRow[]) => void,
): UsePageDeleteResult {
  const { t } = useTranslation()
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleDeletePage = useCallback(
    async (pageId: string) => {
      setDeletingId(pageId)
      try {
        await deleteBlock(pageId)
        setPages((prev) => prev.filter((p) => p.id !== pageId))
        useResolveStore.getState().set(pageId, '(deleted)', true)
        toast.success(t('pageBrowser.deleteSuccess'))
      } catch (error) {
        toast.error(t('pageBrowser.deleteFailed', { error: String(error) }), {
          action: { label: t('pageBrowser.retry'), onClick: () => handleDeletePage(pageId) },
        })
      } finally {
        setDeletingId(null)
      }
    },
    [setPages, t],
  )

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      handleDeletePage(deleteTarget.id)
      setDeleteTarget(null)
    }
  }, [deleteTarget, handleDeletePage])

  return {
    deleteTarget,
    deletingId,
    setDeleteTarget,
    handleConfirmDelete,
    handleDeletePage,
  }
}
