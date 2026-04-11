/**
 * StatusPanel — shows materializer status info (p2-t15, p2-t16).
 *
 * Standalone panel with no props. Polls getStatus() every 5 seconds.
 * Displays 4 metrics: foreground queue depth, background queue depth,
 * total ops dispatched, total background dispatched.
 */

import { Activity, AlertTriangle, RefreshCw } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTimestamp } from '@/lib/format'
import { cn } from '@/lib/utils'
import { usePollingQuery } from '../hooks/usePollingQuery'
import type { StatusInfo } from '../lib/tauri'
import { getStatus } from '../lib/tauri'
import { useSyncStore } from '../stores/sync'

function queueHealthClasses(depth: number): string {
  if (depth === 0) return 'border-status-done text-status-done-foreground'
  if (depth > 10) return 'border-status-pending text-status-pending-foreground'
  return ''
}

function MetricLabel({ label, tooltip }: { label: string; tooltip: string }): React.ReactElement {
  return (
    <dt className="status-metric-label text-sm text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            tabIndex={0}
            className="cursor-help border-b border-dotted border-current bg-transparent p-0 font-inherit text-inherit"
          >
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </dt>
  )
}

function syncStateLabel(state: string): string {
  switch (state) {
    case 'idle':
      return 'Idle'
    case 'discovering':
      return 'Discovering...'
    case 'pairing':
      return 'Pairing...'
    case 'syncing':
      return 'Syncing...'
    case 'error':
      return 'Error'
    case 'offline':
      return 'Offline'
    default:
      return state
  }
}

function syncStateDotClasses(state: string): string {
  switch (state) {
    case 'idle':
      return 'bg-status-done-foreground'
    case 'syncing':
    case 'discovering':
    case 'pairing':
      return 'bg-status-pending-foreground'
    case 'error':
      return 'bg-destructive'
    case 'offline':
      return 'bg-muted-foreground'
    default:
      return 'bg-muted-foreground'
  }
}

export function StatusPanel(): React.ReactElement {
  const queryFn = useCallback(() => getStatus(), [])
  const {
    data: status,
    loading,
    error,
  } = usePollingQuery<StatusInfo>(queryFn, {
    intervalMs: 5000,
    errorMessage: 'Failed to load status',
  })

  const fgErrors = status?.fg_errors ?? 0
  const bgErrors = status?.bg_errors ?? 0
  const fgPanics = status?.fg_panics ?? 0
  const bgPanics = status?.bg_panics ?? 0
  const hasErrors = fgErrors > 0 || bgErrors > 0 || fgPanics > 0 || bgPanics > 0

  const syncState = useSyncStore((s) => s.state)
  const syncError = useSyncStore((s) => s.error)
  const syncPeers = useSyncStore((s) => s.peers)
  const syncLastSynced = useSyncStore((s) => s.lastSyncedAt)
  const syncOpsReceived = useSyncStore((s) => s.opsReceived)
  const syncOpsSent = useSyncStore((s) => s.opsSent)

  const { t } = useTranslation()

  return (
    <TooltipProvider>
      <div className="status-panel space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="status-panel-title flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" />
              {t('status.materializerStatusTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading && !status && (
              <div className="status-panel-loading grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-20 w-full rounded-lg" />
              </div>
            )}

            {error && <p className="status-panel-error text-sm text-destructive">{error}</p>}

            {status && (
              <output className="status-panel-metrics block">
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div
                    className={cn(
                      'status-metric rounded-lg border bg-muted/30 p-4 text-center',
                      queueHealthClasses(status.foreground_queue_depth),
                    )}
                  >
                    <dd className="status-metric-value text-2xl font-bold">
                      {status.foreground_queue_depth}
                    </dd>
                    <MetricLabel
                      label={t('status.foregroundQueueLabel')}
                      tooltip={t('status.foregroundQueueTooltip')}
                    />
                    <dd className="text-xs text-muted-foreground mt-1">
                      {t('status.peakLabel')} {status.fg_high_water ?? 0}
                    </dd>
                  </div>

                  <div
                    className={cn(
                      'status-metric rounded-lg border bg-muted/30 p-4 text-center',
                      queueHealthClasses(status.background_queue_depth),
                    )}
                  >
                    <dd className="status-metric-value text-2xl font-bold">
                      {status.background_queue_depth}
                    </dd>
                    <MetricLabel
                      label={t('status.backgroundQueueLabel')}
                      tooltip={t('status.backgroundQueueTooltip')}
                    />
                    <dd className="text-xs text-muted-foreground mt-1">
                      {t('status.peakLabel')} {status.bg_high_water ?? 0}
                    </dd>
                  </div>

                  <div className="status-metric rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="status-metric-value text-2xl font-bold">
                      {status.total_ops_dispatched + status.total_background_dispatched}
                    </dd>
                    <MetricLabel
                      label={t('status.opsDispatchedLabel')}
                      tooltip={t('status.opsDispatchedTooltip')}
                    />
                  </div>

                  <div className="status-metric rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="status-metric-value text-2xl font-bold">
                      {status.total_background_dispatched}
                    </dd>
                    <MetricLabel
                      label={t('status.backgroundDispatchedLabel')}
                      tooltip={t('status.backgroundDispatchedTooltip')}
                    />
                  </div>
                </dl>

                {hasErrors && (
                  <div className="status-panel-errors mt-4 flex flex-col gap-1 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <p>
                        {[
                          fgErrors > 0 && t('status.foregroundErrorsMessage', { count: fgErrors }),
                          bgErrors > 0 && t('status.backgroundErrorsMessage', { count: bgErrors }),
                          fgPanics > 0 && t('status.foregroundPanicsMessage', { count: fgPanics }),
                          bgPanics > 0 && t('status.backgroundPanicsMessage', { count: bgPanics }),
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </p>
                    </div>
                    {bgErrors > 0 && (
                      <p className="ml-6 text-xs text-muted-foreground">
                        {t('status.cacheStaleHint')}
                      </p>
                    )}
                  </div>
                )}
              </output>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle
              className="sync-panel-title flex items-center gap-2 text-base"
              data-testid="sync-panel-title"
            >
              <RefreshCw className="h-4 w-4" />
              {t('status.syncStatusTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {syncPeers.length === 0 ? (
              <p
                className="sync-panel-not-configured text-sm text-muted-foreground"
                data-testid="sync-panel-not-configured"
              >
                {t('status.notConfigured')}
              </p>
            ) : (
              <div className="sync-panel-details space-y-3">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'sync-state-dot h-2 w-2 rounded-full',
                      syncStateDotClasses(syncState),
                    )}
                    role="status"
                    aria-label={t('status.syncStateLabel', { state: syncStateLabel(syncState) })}
                  />
                  <span className="sync-state-label text-sm font-medium">
                    {syncStateLabel(syncState)}
                  </span>
                </div>

                {syncError && (
                  <p className="sync-panel-error text-sm text-destructive">{syncError}</p>
                )}

                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="sync-peer-count text-2xl font-bold">{syncPeers.length}</dd>
                    <MetricLabel
                      label={t('status.peerLabel', { count: syncPeers.length })}
                      tooltip={t('status.peerCountTooltip')}
                    />
                  </div>

                  <div className="rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="sync-last-synced text-2xl font-bold">
                      {syncLastSynced ? formatTimestamp(syncLastSynced, 'relative') : '--'}
                    </dd>
                    <MetricLabel
                      label={t('status.lastSyncedLabel')}
                      tooltip={t('status.lastSyncedTooltip')}
                    />
                  </div>

                  <div className="rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="sync-ops-received text-2xl font-bold">{syncOpsReceived}</dd>
                    <MetricLabel
                      label={t('status.opsReceivedLabel')}
                      tooltip={t('status.opsReceivedTooltip')}
                    />
                  </div>

                  <div className="rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="sync-ops-sent text-2xl font-bold">{syncOpsSent}</dd>
                    <MetricLabel
                      label={t('status.opsSentLabel')}
                      tooltip={t('status.opsSentTooltip')}
                    />
                  </div>
                </dl>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  )
}
