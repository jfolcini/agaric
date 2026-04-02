/**
 * StatusPanel — shows materializer status info (p2-t15, p2-t16).
 *
 * Standalone panel with no props. Polls getStatus() every 5 seconds.
 * Displays 4 metrics: foreground queue depth, background queue depth,
 * total ops dispatched, total background dispatched.
 */

import { Activity, AlertTriangle, RefreshCw } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTimestamp } from '@/lib/format'
import type { StatusInfo } from '../lib/tauri'
import { getStatus } from '../lib/tauri'
import { useSyncStore } from '../stores/sync'
import { DeviceManagement } from './DeviceManagement'

const TOOLTIP_TEXT: Record<string, string> = {
  'Foreground Queue': 'Operations waiting to be applied to the database. Should stay near zero.',
  'Background Queue': 'Cache rebuild and FTS indexing tasks. Non-critical, best-effort processing.',
  'Ops Dispatched': 'Total operations processed since app start.',
  'Background Dispatched': 'Total background cache tasks completed since app start.',
  Peer: 'Number of paired devices',
  Peers: 'Number of paired devices',
  'Last Synced': 'Time since last successful sync',
  'Ops Received': 'Total operations received from peers (resets on app restart)',
  'Ops Sent': 'Total operations sent to peers (resets on app restart)',
}

function queueHealthClasses(depth: number): string {
  if (depth === 0) return 'border-emerald-200 text-emerald-600'
  if (depth > 10) return 'border-amber-200 text-amber-600'
  return ''
}

function MetricLabel({ label }: { label: string }): React.ReactElement {
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
        <TooltipContent>{TOOLTIP_TEXT[label]}</TooltipContent>
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
    default:
      return state
  }
}

function syncStateDotClasses(state: string): string {
  switch (state) {
    case 'idle':
      return 'bg-emerald-500'
    case 'syncing':
    case 'discovering':
    case 'pairing':
      return 'bg-amber-500'
    case 'error':
      return 'bg-destructive'
    default:
      return 'bg-muted-foreground'
  }
}

export function StatusPanel(): React.ReactElement {
  const [status, setStatus] = useState<StatusInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await getStatus()
      setStatus(resp)
      setError(null)
    } catch {
      setError('Failed to load status')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadStatus()
    const interval = setInterval(loadStatus, 5000)
    return () => clearInterval(interval)
  }, [loadStatus])

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

  return (
    <TooltipProvider>
      <div className="status-panel space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="status-panel-title flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" />
              Materializer Status
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
                    className={`status-metric rounded-lg border bg-muted/30 p-4 text-center ${queueHealthClasses(status.foreground_queue_depth)}`}
                  >
                    <dd className="status-metric-value text-2xl font-bold">
                      {status.foreground_queue_depth}
                    </dd>
                    <MetricLabel label="Foreground Queue" />
                    <dd className="text-xs text-muted-foreground mt-1">
                      Peak: {status.fg_high_water ?? 0}
                    </dd>
                  </div>

                  <div
                    className={`status-metric rounded-lg border bg-muted/30 p-4 text-center ${queueHealthClasses(status.background_queue_depth)}`}
                  >
                    <dd className="status-metric-value text-2xl font-bold">
                      {status.background_queue_depth}
                    </dd>
                    <MetricLabel label="Background Queue" />
                    <dd className="text-xs text-muted-foreground mt-1">
                      Peak: {status.bg_high_water ?? 0}
                    </dd>
                  </div>

                  <div className="status-metric rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="status-metric-value text-2xl font-bold">
                      {status.total_ops_dispatched}
                    </dd>
                    <MetricLabel label="Ops Dispatched" />
                  </div>

                  <div className="status-metric rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="status-metric-value text-2xl font-bold">
                      {status.total_background_dispatched}
                    </dd>
                    <MetricLabel label="Background Dispatched" />
                  </div>
                </dl>

                {hasErrors && (
                  <div className="status-panel-errors mt-4 flex flex-col gap-1 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-destructive dark:border-red-900 dark:bg-red-950">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <p>
                        {[
                          fgErrors > 0 && `${fgErrors} foreground error${fgErrors !== 1 ? 's' : ''}`,
                          bgErrors > 0 && `${bgErrors} background error${bgErrors !== 1 ? 's' : ''}`,
                          fgPanics > 0 && `${fgPanics} foreground panic${fgPanics !== 1 ? 's' : ''}`,
                          bgPanics > 0 && `${bgPanics} background panic${bgPanics !== 1 ? 's' : ''}`,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </p>
                    </div>
                    {bgErrors > 0 && (
                      <p className="ml-6 text-xs text-muted-foreground">
                        Cache data may be stale. Restart the app to retry.
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
            <CardTitle className="sync-panel-title flex items-center gap-2 text-base">
              <RefreshCw className="h-4 w-4" />
              Sync Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {syncPeers.length === 0 ? (
              <p className="sync-panel-not-configured text-sm text-muted-foreground">
                Not configured
              </p>
            ) : (
              <div className="sync-panel-details space-y-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`sync-state-dot h-2 w-2 rounded-full ${syncStateDotClasses(syncState)}`}
                    role="status"
                    aria-label={`Sync state: ${syncStateLabel(syncState)}`}
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
                      label={`Peer${syncPeers.length !== 1 ? 's' : ''}`}
                    />
                  </div>

                  <div className="rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="sync-last-synced text-2xl font-bold">
                      {syncLastSynced ? formatTimestamp(syncLastSynced, 'relative') : '--'}
                    </dd>
                    <MetricLabel label="Last Synced" />
                  </div>

                  <div className="rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="sync-ops-received text-2xl font-bold">{syncOpsReceived}</dd>
                    <MetricLabel label="Ops Received" />
                  </div>

                  <div className="rounded-lg border bg-muted/30 p-4 text-center">
                    <dd className="sync-ops-sent text-2xl font-bold">{syncOpsSent}</dd>
                    <MetricLabel label="Ops Sent" />
                  </div>
                </dl>
              </div>
            )}
          </CardContent>
        </Card>

        <Separator className="my-4" />
        <DeviceManagement />
      </div>
    </TooltipProvider>
  )
}
