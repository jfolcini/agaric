import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { i18n } from '../lib/i18n'
import type { AttachmentRow } from '../lib/tauri'
import { addAttachment, deleteAttachment, listAttachments } from '../lib/tauri'
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
}

export function useBlockAttachments(blockId: string | null): UseBlockAttachmentsReturn {
  const pageStore = usePageBlockStoreApi()
  const [attachments, setAttachments] = useState<AttachmentRow[]>([])
  const [loading, setLoading] = useState(false)
  // MAINT-131: when this hook is rendered inside a BatchAttachmentsProvider
  // (BlockTree mounts one), mutations need to invalidate the page-level
  // batch cache so StaticBlock's batch-derived view stays consistent with
  // the AttachmentList drawer's local state. Outside a provider the hook
  // is `null` and the optional-chain calls below are no-ops.
  const batchProvider = useBatchAttachments()

  // Load attachments when blockId changes
  useEffect(() => {
    setAttachments([])
    if (!blockId) {
      setLoading(false)
      return
    }
    setLoading(true)
    listAttachments(blockId)
      .then(setAttachments)
      .catch((err) => {
        logger.warn('useBlockAttachments', 'list attachments failed', { blockId }, err)
        toast.error(i18n.t('attachments.loadFailed'))
      })
      .finally(() => setLoading(false))
  }, [blockId])

  const handleAddAttachment = useCallback(
    async (filename: string, mimeType: string, sizeBytes: number, fsPath: string) => {
      if (!blockId) return
      try {
        const row = await addAttachment({ blockId, filename, mimeType, sizeBytes, fsPath })
        const { rootParentId } = pageStore.getState()
        if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        setAttachments((prev) => [...prev, row])
        // MAINT-131: invalidate the page-level batch cache so StaticBlock
        // sees the new attachment without firing its own listAttachments IPC.
        batchProvider?.invalidate(blockId)
      } catch (err) {
        logger.error('useBlockAttachments', 'Failed to add attachment', { blockId }, err)
        toast.error(i18n.t('attachments.addFailed'))
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
        // MAINT-131: invalidate the page-level batch cache.
        batchProvider?.invalidate(blockId)
      } catch (err) {
        logger.error(
          'useBlockAttachments',
          'Failed to delete attachment',
          { blockId, attachmentId },
          err,
        )
        toast.error(i18n.t('attachments.deleteFailed'))
      }
    },
    [blockId, pageStore, batchProvider],
  )

  return { attachments, loading, handleAddAttachment, handleDeleteAttachment }
}
