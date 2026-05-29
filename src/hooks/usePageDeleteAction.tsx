/**
 * usePageDeleteAction — orchestrates the page-delete user flow (confirm
 * dialog → IPC → success toast with Undo → restore on click).
 *
 * Sits one layer above `usePageDelete` and `deleteBlock`. Two surfaces
 * (PageHeader, journal DaySection) need the same UX:
 *
 *   1. Click delete → open a ConfirmDialog.
 *   2. On confirm → call `deleteBlock(pageId)` (soft-delete → Trash).
 *   3. On success → show a success toast with an "Undo" action that
 *      calls `restoreBlocksByIds([pageId])` (single-id restore).
 *   4. On failure → show an error toast with a Retry action.
 *
 * The hook owns:
 *   - The pending `deleteTarget` (`null` when no dialog open).
 *   - The in-flight `deletingId` (drives disabled state on buttons).
 *   - A `confirmDialog` React node — the host just embeds `{confirmDialog}`
 *     once in its JSX and forwards `requestDelete()` to any number of
 *     trigger buttons. Only ONE dialog instance ever renders, so there's
 *     no double-confirm risk when the same host has multiple delete
 *     entry points (e.g. PageHeader's dedicated trash button AND its
 *     kebab "Delete page" item).
 *
 * The hook does NOT mutate any list state — `usePageDelete` covers that
 * case for `PageBrowser`. Callers that need post-delete side effects
 * (e.g. `PageHeader` calling `onBack`) pass an `onDeleted(pageId)`
 * callback. The optional `confirmCopy` lets the journal override the
 * default "Delete page" copy with "Delete the note for {date}?".
 *
 * Undo is wired to the existing `restoreBlocksByIds` IPC, which accepts
 * a list and cascade-restores the root + descendants in a single
 * transaction (PEND-35 Tier 2.2). For a single page that's effectively a
 * one-element call.
 */

import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/ConfirmDialog'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { deleteBlock, restoreBlocksByIds } from '@/lib/tauri'

/** Locked-in copy slots a caller can override per-invocation. */
export interface PageDeleteConfirmCopy {
  /** Dialog title. Default: `t('pageHeader.deletePageTitle')`. */
  title?: string
  /** Dialog body. Default: `t('pageHeader.deletePageDescription')`. */
  description?: string
}

export interface RequestDeleteOptions {
  /** Override the default confirm-dialog copy (used by the journal). */
  confirmCopy?: PageDeleteConfirmCopy
  /**
   * Called once the delete IPC resolves successfully. Used by hosts that
   * need post-delete UI side effects (PageHeader → `onBack()` + AT
   * `announce(...)`).
   */
  onDeleted?: (pageId: string) => void
  /**
   * Called when the delete IPC rejects. Lets the host surface an AT
   * announcement or any other failure-only side effect; the shared
   * error toast (with Retry) still fires unconditionally.
   */
  onFailed?: (pageId: string, error: unknown) => void
}

interface DeleteTarget {
  id: string
  title: string
  copy: PageDeleteConfirmCopy
  onDeleted: ((pageId: string) => void) | undefined
  onFailed: ((pageId: string, error: unknown) => void) | undefined
}

export interface UsePageDeleteActionReturn {
  /** Open the confirm dialog for the given page. */
  requestDelete: (pageId: string, title: string, options?: RequestDeleteOptions) => void
  /** `true` while the IPC is in flight. */
  isDeleting: boolean
  /** The id currently being deleted (or `null`). */
  deletingId: string | null
  /** Embed once in the host's JSX — owns the single ConfirmDialog instance. */
  confirmDialog: React.ReactElement
}

export function usePageDeleteAction(): UsePageDeleteActionReturn {
  const { t } = useTranslation()
  const [target, setTarget] = useState<DeleteTarget | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const requestDelete = useCallback(
    (pageId: string, title: string, options?: RequestDeleteOptions) => {
      setTarget({
        id: pageId,
        title,
        copy: options?.confirmCopy ?? {},
        onDeleted: options?.onDeleted,
        onFailed: options?.onFailed,
      })
    },
    [],
  )

  const handleUndo = useCallback(
    (pageId: string) => {
      restoreBlocksByIds([pageId])
        .then(() => {
          notify.success(t('pageDeleteAction.restored'))
        })
        .catch((err: unknown) => {
          logger.error('usePageDeleteAction', 'Failed to restore page', { pageId }, err)
          notify.error(t('pageDeleteAction.restoreFailed'))
        })
    },
    [t],
  )

  const handleConfirm = useCallback(async () => {
    if (!target) return
    const { id, onDeleted, onFailed } = target
    setDeletingId(id)
    try {
      await deleteBlock(id)
      notify.success(t('pageDeleteAction.deleted'), {
        action: {
          label: t('pageDeleteAction.undo'),
          onClick: () => handleUndo(id),
        },
      })
      onDeleted?.(id)
    } catch (err) {
      logger.error('usePageDeleteAction', 'Failed to delete page', { pageId: id }, err)
      onFailed?.(id, err)
      notify.error(t('pageDeleteAction.deleteFailed'), {
        action: {
          label: t('pageDeleteAction.retry'),
          onClick: () => {
            handleConfirm().catch(() => {
              /* error already surfaced */
            })
          },
        },
      })
      // Re-throw so ConfirmDialog stays open per its async-rejection contract.
      throw err
    } finally {
      setDeletingId(null)
    }
  }, [handleUndo, t, target])

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setTarget(null)
  }, [])

  const dialogTitle = target?.copy.title ?? t('pageHeader.deletePageTitle')
  const dialogDescription = target?.copy.description ?? t('pageHeader.deletePageDescription')

  const confirmDialog = useMemo(
    () => (
      <ConfirmDialog
        open={target != null}
        onOpenChange={handleOpenChange}
        title={dialogTitle}
        description={dialogDescription}
        actionLabel={t('pageHeader.deletePage')}
        cancelLabel={t('pageHeader.cancel')}
        variant="destructive"
        onConfirm={handleConfirm}
      />
    ),
    [dialogDescription, dialogTitle, handleConfirm, handleOpenChange, target, t],
  )

  return {
    requestDelete,
    isDeleting: deletingId != null,
    deletingId,
    confirmDialog,
  }
}
