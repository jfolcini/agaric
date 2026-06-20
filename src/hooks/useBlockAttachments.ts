import { useCallback, useEffect, useState } from 'react'

import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

import { i18n } from '../lib/i18n'
import type { AttachmentRow } from '../lib/tauri'
import { addAttachment, deleteAttachment, listAttachments, renameAttachment } from '../lib/tauri'
import { usePageBlockStoreApi } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'
import { useBatchAttachments } from './useBatchAttachments'

export interface UseBlockAttachmentsReturn {
  attachments: AttachmentRow[]
  loading: boolean
  handleAddAttachment: (
    filename: string,
    mimeType: string,
    sizeBytes: number,
    fsPath: string,
  ) => Promise<void>
  handleDeleteAttachment: (attachmentId: string) => Promise<void>
  handleRenameAttachment: (attachmentId: string, newFilename: string) => Promise<void>
}

export function useBlockAttachments(blockId: string | null): UseBlockAttachmentsReturn {
  const pageStore = usePageBlockStoreApi()
  const [attachments, setAttachments] = useState<AttachmentRow[]>([])
  const [loading, setLoading] = useState(false)
  // When this hook is rendered inside a BatchAttachmentsProvider
  // (BlockTree mounts one), mutations need to invalidate the page-level
  // batch cache so StaticBlock's batch-derived view stays consistent with
  // the AttachmentList drawer's local state. Outside a provider the hook
  // is `null` and the optional-chain calls below are no-ops.
  const batchProvider = useBatchAttachments()
  // When a BatchAttachmentsProvider is mounted, defer
  // entirely to it — the provider is the page-level source of truth and
  // already issues a single batched IPC for every block on the page. We
  // read the rows reference and the loading flag so the effect re-runs
  // when the batch transitions from in-flight → resolved. The
  // per-block `listAttachments` IPC only runs when no provider wraps us
  // (e.g. isolated unit tests, dialogs rendered outside the BlockTree).
  const batchActive = batchProvider !== null
  const batchLoading = batchProvider?.loading ?? false
  const batchRows = batchProvider?.get(blockId ?? '')

  // Load attachments when blockId changes
  useEffect(() => {
    setAttachments([])
    if (!blockId) {
      setLoading(false)
      return
    }
    // Defer to the batch provider when one is mounted.
    // While the batch is in flight we mirror its loading flag (no per-block
    // IPC fires); once it resolves we read `get(blockId) ?? []` (absent
    // keys mean "no attachments"). The provider's `invalidate` path keeps
    // local state in sync after add/delete mutations.
    if (batchActive) {
      if (batchLoading) {
        setLoading(true)
        return
      }
      setAttachments(batchRows ?? [])
      setLoading(false)
      return
    }
    setLoading(true)
    listAttachments(blockId)
      .then(setAttachments)
      .catch((err) => {
        logger.warn('useBlockAttachments', 'list attachments failed', { blockId }, err)
        notify.error(i18n.t('attachments.loadFailed'), { id: 'attachments-load-failed' })
      })
      .finally(() => setLoading(false))
  }, [blockId, batchActive, batchLoading, batchRows])

  const handleAddAttachment = useCallback(
    async (filename: string, mimeType: string, sizeBytes: number, fsPath: string) => {
      if (!blockId) return
      try {
        const row = await addAttachment({ blockId, filename, mimeType, sizeBytes, fsPath })
        const { rootParentId } = pageStore.getState()
        if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        setAttachments((prev) => [...prev, row])
        // Invalidate the page-level batch cache so StaticBlock
        // sees the new attachment without firing its own listAttachments IPC.
        batchProvider?.invalidate(blockId)
      } catch (err) {
        logger.error('useBlockAttachments', 'Failed to add attachment', { blockId }, err)
        notify.error(i18n.t('attachments.addFailed'))
      }
    },
    [blockId, pageStore, batchProvider],
  )

  const handleDeleteAttachment = useCallback(
    async (attachmentId: string) => {
      if (!blockId) return
      try {
        await deleteAttachment(attachmentId)
        const { rootParentId } = pageStore.getState()
        if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
        // Invalidate the page-level batch cache.
        batchProvider?.invalidate(blockId)
      } catch (err) {
        logger.error(
          'useBlockAttachments',
          'Failed to delete attachment',
          { blockId, attachmentId },
          err,
        )
        notify.error(i18n.t('attachments.deleteFailed'))
      }
    },
    [blockId, pageStore, batchProvider],
  )

  const handleRenameAttachment = useCallback(
    async (attachmentId: string, newFilename: string) => {
      if (!blockId) return
      try {
        await renameAttachment({ attachmentId, newFilename })
        setAttachments((prev) =>
          prev.map((a) => (a.id === attachmentId ? { ...a, filename: newFilename } : a)),
        )
        // Invalidate the page-level batch cache.
        batchProvider?.invalidate(blockId)
      } catch (err) {
        logger.error(
          'useBlockAttachments',
          'Failed to rename attachment',
          { blockId, attachmentId },
          err,
        )
        notify.error(i18n.t('attachments.renameFailed'))
      }
    },
    [blockId, batchProvider],
  )

  return {
    attachments,
    loading,
    handleAddAttachment,
    handleDeleteAttachment,
    handleRenameAttachment,
  }
}
