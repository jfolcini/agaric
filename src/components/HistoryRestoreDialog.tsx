/**
 * HistoryRestoreDialog — confirmation dialog wrapping the
 * `restorePageToOp` IPC. Owns the in-flight `restoring` state plus
 * the announce / toast surface for the call. The parent supplies the
 * `restoreTarget` (the entry the user picked) and an `onSuccess`
 * callback that reloads the list.
 *
 * Extracted from `HistoryView` (MAINT-128).
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { announce } from '../lib/announcer'
import { formatTimestamp } from '../lib/format'
import { reportIpcError } from '../lib/report-ipc-error'
import type { HistoryEntry } from '../lib/tauri'
import { restorePageToOp } from '../lib/tauri'

export interface HistoryRestoreDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The entry the user clicked "Restore to here" on. */
  restoreTarget: HistoryEntry | null
  /** Called after the IPC resolves successfully. Parent reloads the list. */
  onSuccess: () => void | Promise<void>
}

export function HistoryRestoreDialog({
  open,
  onOpenChange,
  restoreTarget,
  onSuccess,
}: HistoryRestoreDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [restoring, setRestoring] = useState(false)

  const handleAction = useCallback(async () => {
    if (!restoreTarget) return
    setRestoring(true)
    try {
      const result = await restorePageToOp({
        pageId: '__all__',
        targetDeviceId: restoreTarget.device_id,
        targetSeq: restoreTarget.seq,
      })
      toast.success(t('history.restoreSuccess', { count: result.ops_reverted }))
      announce(t('announce.restoreToHereSucceeded', { count: result.ops_reverted }))
      if (result.non_reversible_skipped > 0) {
        toast.warning(t('history.restoreSkipped', { count: result.non_reversible_skipped }))
      }
      await onSuccess()
    } catch (err) {
      reportIpcError('HistoryView', 'history.restoreFailed', err, t, {
        deviceId: restoreTarget.device_id,
        seq: restoreTarget.seq,
      })
      announce(t('announce.restoreToHereFailed'))
    }
    setRestoring(false)
    onOpenChange(false)
  }, [restoreTarget, onSuccess, onOpenChange, t])

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('history.restoreToTitle', {
        timestamp: restoreTarget ? formatTimestamp(restoreTarget.created_at, 'full') : '',
      })}
      description={t('history.restoreToDescription')}
      cancelLabel={t('history.cancelButton')}
      actionLabel={t('history.restoreButton')}
      actionVariant="destructive"
      onAction={handleAction}
      loading={restoring}
    />
  )
}
