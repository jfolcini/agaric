/**
 * usePageDelete — thin PageBrowser adapter over the shared page-delete flow.
 *
 * It supplies the browser's established copy, removes a successfully deleted
 * row through the browser-owned setter, and asks the browser to reload after a
 * successful Undo restore. Dialog, IPC, resolve-cache, and toast lifecycle all
 * remain owned by `usePageDeleteAction`.
 */

import type React from 'react'
import { useCallback } from 'react'

import { usePageDeleteAction } from '@/hooks/usePageDeleteAction'
import type { BlockRow } from '@/lib/bindings'

interface DeleteTarget {
  id: string
  name: string
}

interface UsePageDeleteResult {
  /** The ID of the page currently being deleted (for disabling UI). */
  deletingId: string | null
  /** Open the shared confirmation dialog for a PageBrowser row. */
  setDeleteTarget: (target: DeleteTarget | null) => void
  /** Embed once in PageBrowser — the shared hook owns the single dialog. */
  confirmDialog: React.ReactElement
}

export function usePageDelete(
  setPages: (updater: (prev: BlockRow[]) => BlockRow[]) => void,
  onRestored: (pageId: string) => void,
): UsePageDeleteResult {
  const { requestDelete, deletingId, confirmDialog } = usePageDeleteAction()

  const setDeleteTarget = useCallback(
    (target: DeleteTarget | null) => {
      if (!target) return
      requestDelete(target.id, target.name, {
        confirmCopy: {
          titleKey: 'pageBrowser.deletePage',
          descriptionKey: 'pageHeader.deleteConfirm',
          confirmKey: 'pageBrowser.delete',
          cancelKey: 'pageBrowser.cancel',
          values: { name: target.name },
        },
        onDeleted: (pageId) => {
          setPages((prev) => prev.filter((page) => page.id !== pageId))
        },
        onRestored,
      })
    },
    [onRestored, requestDelete, setPages],
  )

  return {
    deletingId,
    setDeleteTarget,
    confirmDialog,
  }
}
