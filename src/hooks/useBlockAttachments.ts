import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import i18n from '../lib/i18n'
import type { AttachmentRow } from '../lib/tauri'
import { addAttachment, deleteAttachment, listAttachments } from '../lib/tauri'
import { usePageBlockStoreApi } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'

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
      .catch(() => toast.error(i18n.t('attachments.loadFailed')))
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
      } catch {
        toast.error(i18n.t('attachments.addFailed'))
      }
    },
    [blockId, pageStore],
  )

  const handleDeleteAttachment = useCallback(
    async (attachmentId: string) => {
      if (!blockId) return
      try {
        await deleteAttachment(attachmentId)
        const { rootParentId } = pageStore.getState()
        if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
      } catch {
        toast.error(i18n.t('attachments.deleteFailed'))
      }
    },
    [blockId, pageStore],
  )

  return { attachments, loading, handleAddAttachment, handleDeleteAttachment }
}
