import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import { useBatchAttachments, useBatchAttachmentsLoading } from '@/hooks/useBatchAttachments'
import { unwrap } from '@/lib/app-error'
import {
  getAttachmentInvalidationKey,
  subscribeToAttachmentInvalidation,
} from '@/lib/attachment-invalidation'
import type { AttachmentRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { usePageBlockStoreApi } from '@/stores/page-blocks'
import { useUndoStore } from '@/stores/undo'

export interface UseBlockAttachmentsReturn {
  attachments: AttachmentRow[]
  loading: boolean
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
  const batchLoading = useBatchAttachmentsLoading()
  const batchRows = batchProvider?.get(blockId ?? '')

  // #4335 review — a revert/restore issued from the History view mutates
  // `attachments` directly, bypassing `handleDeleteAttachment` /
  // `handleRenameAttachment` below (and the `batchProvider?.invalidate`
  // calls they make). This counter bumps when that happens; depending on
  // it below re-runs the non-batch fetch. The batch-active branch doesn't
  // need it here — `BatchAttachmentsProvider` subscribes on its own — but
  // is left dependent for symmetry with the non-batch effect below.
  const attachmentInvalidationKey = useSyncExternalStore(
    subscribeToAttachmentInvalidation,
    getAttachmentInvalidationKey,
  )

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
    // local state in sync after delete/rename mutations.
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
    commands
      .listAttachments(blockId)
      .then((result) => unwrap(result))
      .then(setAttachments)
      .catch((err) => {
        logger.warn('useBlockAttachments', 'list attachments failed', { blockId }, err)
        notify.error(i18n.t('attachments.loadFailed'), { id: 'attachments-load-failed' })
      })
      .finally(() => setLoading(false))
  }, [blockId, batchActive, batchLoading, batchRows, attachmentInvalidationKey])

  const handleDeleteAttachment = useCallback(
    async (attachmentId: string) => {
      if (!blockId) return
      try {
        unwrap(await commands.deleteAttachment(attachmentId))
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
        unwrap(await commands.renameAttachment(attachmentId, newFilename))
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
    handleDeleteAttachment,
    handleRenameAttachment,
  }
}
