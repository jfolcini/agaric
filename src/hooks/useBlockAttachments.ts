import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AttachmentRow } from '../lib/tauri'
import { addAttachment, deleteAttachment, listAttachments } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
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
      .catch(() => toast.error('Failed to load attachments'))
      .finally(() => setLoading(false))
  }, [blockId])

  const handleAddAttachment = useCallback(
    async (filename: string, mimeType: string, sizeBytes: number, fsPath: string) => {
      if (!blockId) return
      try {
        const row = await addAttachment({ blockId, filename, mimeType, sizeBytes, fsPath })
        const { rootParentId } = useBlockStore.getState()
        if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        setAttachments((prev) => [...prev, row])
      } catch {
        toast.error('Failed to add attachment')
      }
    },
    [blockId],
  )

  const handleDeleteAttachment = useCallback(
    async (attachmentId: string) => {
      if (!blockId) return
      try {
        await deleteAttachment(attachmentId)
        const { rootParentId } = useBlockStore.getState()
        if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
      } catch {
        toast.error('Failed to delete attachment')
      }
    },
    [blockId],
  )

  return { attachments, loading, handleAddAttachment, handleDeleteAttachment }
}
