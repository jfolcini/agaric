/**
 * HistoryRevertDialog — confirmation dialog wrapping the batch
 * `revertOps` IPC. Owns the in-flight `reverting` state plus the
 * announce / toast surface for the call. The parent supplies the
 * already-sorted (newest-first) `selectedEntries` and an `onSuccess`
 * callback that performs the post-revert reload.
 *
 * Extracted from `HistoryView` (MAINT-128).
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { announce } from '../lib/announcer'
import { reportIpcError } from '../lib/report-ipc-error'
import type { HistoryEntry } from '../lib/tauri'
import { revertOps } from '../lib/tauri'

export interface HistoryRevertDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Selected entries, sorted newest-first. */
  selectedEntries: HistoryEntry[]
  /** Called after the IPC resolves successfully. Parent reloads the list. */
  onSuccess: () => void | Promise<void>
}

export function HistoryRevertDialog({
  open,
  onOpenChange,
  selectedEntries,
  onSuccess,
}: HistoryRevertDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [reverting, setReverting] = useState(false)
  const count = selectedEntries.length

  const handleAction = useCallback(async () => {
    if (count === 0) return
    setReverting(true)
    try {
      const ops = selectedEntries.map((e) => ({ device_id: e.device_id, seq: e.seq }))
      await revertOps({ ops })
      announce(t('announce.opsReverted', { count: ops.length }))
      await onSuccess()
    } catch (err) {
      reportIpcError('HistoryView', 'history.revertFailed', err, t, {
        selectedCount: count,
      })
      announce(t('announce.revertFailed'))
    }
    setReverting(false)
    onOpenChange(false)
  }, [count, selectedEntries, onSuccess, onOpenChange, t])

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('history.revertTitle', { count })}
      description={t('history.revertDescription', { count })}
      cancelLabel={t('history.cancelButton')}
      actionLabel={t('history.revertButton')}
      actionVariant="destructive"
      onAction={handleAction}
      loading={reverting}
    />
  )
}
