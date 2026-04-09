/**
 * CompactionConfirmDialog — confirmation dialog before running op log compaction.
 *
 * Uses the shared ConfirmDialog (AlertDialog-based) pattern with destructive
 * variant since compaction is an irreversible action.
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { compactOpLog } from '@/lib/tauri'

interface CompactionConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  eligibleOps: number
  retentionDays: number
  onCompacted: () => void
}

export function CompactionConfirmDialog({
  open,
  onOpenChange,
  eligibleOps,
  retentionDays,
  onCompacted,
}: CompactionConfirmDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)

  const handleCompact = useCallback(async () => {
    setLoading(true)
    try {
      const result = await compactOpLog(retentionDays)
      toast.success(t('compaction.success', { count: result.ops_deleted }))
      onOpenChange(false)
      onCompacted()
    } catch {
      toast.error(t('compaction.failed'))
    } finally {
      setLoading(false)
    }
  }, [retentionDays, onOpenChange, onCompacted, t])

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('compaction.confirmTitle')}
      description={t('compaction.confirmDescription', {
        count: eligibleOps,
        days: retentionDays,
      })}
      cancelLabel={t('compaction.cancel')}
      actionLabel={t('compaction.compactButton')}
      actionVariant="destructive"
      onAction={handleCompact}
      loading={loading}
    />
  )
}
