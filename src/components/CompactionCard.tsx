/**
 * CompactionCard — collapsible card showing op log compaction stats.
 *
 * Self-contained component that fetches compaction status on mount
 * and provides a "Compact Now" button to trigger manual compaction.
 * Shown at the top of the HistoryView.
 */

import { Archive } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CollapsiblePanelHeader } from '@/components/CollapsiblePanelHeader'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import type { CompactionStatus } from '@/lib/tauri'
import { getCompactionStatus } from '@/lib/tauri'
import { CompactionConfirmDialog } from './CompactionConfirmDialog'

export function CompactionCard(): React.ReactElement {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(true)
  const [status, setStatus] = useState<CompactionStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const fetchStatus = useCallback(async () => {
    setLoading(true)
    try {
      const s = await getCompactionStatus()
      setStatus(s)
    } catch {
      toast.error(t('compaction.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const formattedDate =
    status?.oldest_op_date != null ? new Date(status.oldest_op_date).toLocaleDateString() : null

  return (
    <div className="compaction-card rounded-lg border border-border/40 bg-muted/30">
      <CollapsiblePanelHeader
        isCollapsed={collapsed}
        onToggle={() => setCollapsed((prev) => !prev)}
      >
        <Archive className="h-4 w-4" />
        {t('compaction.title')}
      </CollapsiblePanelHeader>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-3">
          {loading ? (
            <LoadingSkeleton count={3} height="h-4" className="compaction-loading" />
          ) : status != null ? (
            <>
              <dl className="space-y-1 text-sm text-muted-foreground">
                <div className="flex justify-between">
                  <dt>{t('compaction.totalOps', { count: status.total_ops }).split(':')[0]}:</dt>
                  <dd data-testid="compaction-total-ops">{status.total_ops}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>
                    {formattedDate != null
                      ? t('compaction.oldestOp', { date: formattedDate }).split(':')[0]
                      : t('compaction.oldestOpNone').split(':')[0]}
                    :
                  </dt>
                  <dd data-testid="compaction-oldest-date">{formattedDate ?? 'N/A'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>
                    {t('compaction.eligibleOps', { count: status.eligible_ops }).split(':')[0]}:
                  </dt>
                  <dd data-testid="compaction-eligible-ops">{status.eligible_ops}</dd>
                </div>
              </dl>

              <Button
                variant="destructive"
                size="sm"
                disabled={status.eligible_ops === 0}
                onClick={() => setConfirmOpen(true)}
              >
                {t('compaction.compactNow')}
              </Button>

              <CompactionConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                eligibleOps={status.eligible_ops}
                retentionDays={status.retention_days}
                onCompacted={fetchStatus}
              />
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}
