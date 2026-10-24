/**
 * HistoryRestoreDialog — confirmation dialog wrapping the
 * `restorePageToOp` IPC. Owns the in-flight `restoring` state plus
 * the announce / toast surface for the call. The parent supplies the
 * `restoreTarget` (the entry the user picked) and an `onSuccess`
 * callback that reloads the list.
 *
 * Extracted from `HistoryView`.
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { announce } from '@/lib/announcer'
import { takenNameReason, unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { HistoryEntry } from '@/lib/bindings'
import { formatTimestamp } from '@/lib/format'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { reportIpcError } from '@/lib/report-ipc-error'

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
      const result = unwrap(
        await commands.restorePageToOp('__all__', restoreTarget.device_id, restoreTarget.seq),
      )
      notify.success(t('history.restoreSuccess', { count: result.ops_reverted }))
      announce(t('announce.restoreToHereSucceeded', { count: result.ops_reverted }))
      if (result.non_reversible_skipped > 0) {
        notify.warning(t('history.restoreSkipped', { count: result.non_reversible_skipped }))
      }
      await onSuccess()
    } catch (err) {
      const context = { deviceId: restoreTarget.device_id, seq: restoreTarget.seq }
      const takenName = takenNameReason(err)
      if (takenName === null) {
        reportIpcError('HistoryView', 'history.restoreFailed', err, t, context)
      } else {
        logger.warn('HistoryView', 'restore refused: a name is taken', context, err)
        notify.error(takenName)
      }
      announce(t('announce.restoreToHereFailed'))
    }
    setRestoring(false)
    onOpenChange(false)
  }, [restoreTarget, onSuccess, onOpenChange, t])

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      titleKey="history.restoreToTitle"
      descriptionKey="history.restoreToDescription"
      cancelKey="history.cancelButton"
      confirmKey="history.restoreButton"
      values={{
        timestamp: restoreTarget ? formatTimestamp(restoreTarget.created_at, 'full') : '',
      }}
      variant="destructive"
      onConfirm={handleAction}
      loading={restoring}
    />
  )
}
