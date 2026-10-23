/**
 * StatusPanel — shows materializer status info (p2-t15, p2-t16).
 *
 * The Settings › App health tab's body (#5269), below the integrity check
 * (#5360, #5629), so it renders no `<h1>` of its own: SettingsView owns the
 * page heading. Polls getStatus() every 5 seconds.
 * Displays 6 metrics: foreground queue depth, background queue depth,
 * grand-total ops dispatched (foreground + background combined), the
 * background-only dispatched count, and the two counts of writes the sync
 * engine missed (`sql_only_fallback_count`, `descendant_fanout_dropped`),
 * which stay at zero unless a block has stopped syncing (#6047).
 *
 * SyncStatusCard — the overall sync state, at the top of Settings › Sync &
 * devices once a device is paired (#5629). Status only: the device list below
 * owns every sync action. It lives here because it shares the metric-card
 * helpers.
 */

import type { TFunction } from 'i18next'
import { AlertCircle, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MetricCard } from '@/components/ui/metric-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMinuteClock } from '@/hooks/useMinuteClock'
import { usePollingQuery } from '@/hooks/usePollingQuery'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { StatusInfo } from '@/lib/bindings'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { cn } from '@/lib/utils'
import { type SyncState, useSyncStore } from '@/stores/sync'

function queueHealthClasses(depth: number): string {
  return depth > 10 ? 'border-status-pending text-status-pending-foreground' : ''
}

/**
 * Assemble the comma-joined error summary line. Pure helper so the component
 * body doesn't carry the `&&` chain (keeps its cyclomatic complexity under
 * the lint ceiling).
 *
 * #3382: the former `fgPanics` / `bgPanics` terms are gone with the counters
 * that fed them. `panic = "abort"` in the release profile means a handler
 * panic aborts the process, so those two numbers were zero in every shipped
 * build no matter what happened — a panel that reassured rather than reported.
 * A panic that a debug build can still observe now arrives as an error.
 */
function errorSummaryText(counts: { fgErrors: number; bgErrors: number }, t: TFunction): string {
  return [
    counts.fgErrors > 0 && t('status.foregroundErrorsMessage', { count: counts.fgErrors }),
    counts.bgErrors > 0 && t('status.backgroundErrorsMessage', { count: counts.bgErrors }),
  ]
    .filter(Boolean)
    .join(', ')
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

function syncStateLabel(state: SyncState, t: (key: string) => string): string {
  switch (state) {
    case 'idle': {
      return t('status.syncIdle')
    }
    case 'syncing': {
      return t('status.syncSyncing')
    }
    case 'error': {
      return t('status.syncError')
    }
    case 'offline': {
      return t('status.syncOffline')
    }
    default: {
      return state
    }
  }
}

function syncStateDotClasses(state: SyncState): string {
  switch (state) {
    case 'idle': {
      return 'bg-status-done-foreground'
    }
    case 'syncing': {
      return 'bg-status-pending-foreground'
    }
    case 'error': {
      return 'bg-destructive'
    }
    case 'offline': {
      return 'bg-muted-foreground'
    }
    default: {
      return 'bg-muted-foreground'
    }
  }
}

/**
 * Per-state icon next to the sync-state dot. Adds a non-color signal so
 * states are distinguishable beyond colour. The icon is decorative — the
 * adjacent text label carries the canonical state name for assistive
 * Tech, so we mark it `aria-hidden`. See.
 *
 * #1076: the `discovering` / `pairing` branches were removed alongside
 * those (dead, never-written) SyncState members.
 */
function SyncStateIcon({ state }: { state: SyncState }): React.ReactElement {
  const className = 'sync-state-icon h-3 w-3 shrink-0 text-muted-foreground'
  switch (state) {
    case 'syncing': {
      return (
        <RefreshCw
          className={cn(className, 'animate-spin')}
          data-testid="sync-state-icon-syncing"
          aria-hidden="true"
        />
      )
    }
    case 'error':
    case 'offline': {
      return (
        <AlertCircle
          className={cn(className, 'text-destructive')}
          data-testid={`sync-state-icon-${state}`}
          aria-hidden="true"
        />
      )
    }
    default: {
      return (
        <CheckCircle2
          className={className}
          data-testid={`sync-state-icon-${state}`}
          aria-hidden="true"
        />
      )
    }
  }
}

/**
 * Bounded-staleness cue (#2471). Cache-backed reads — search (`fts_blocks`),
 * the agenda, backlinks, and per-page/per-tag counts — can lag primary state
 * by up to the materializer's 1h retry-queue backoff cap after a background
 * rebuild is dropped and persisted. This notice makes that otherwise-silent
 * degraded state visible: a search missing a recent edit is no longer
 * indistinguishable from the note not existing.
 *
 * Rendered only when a background rebuild has been dropped this session
 * (`bg_dropped > 0`) AND rows are still waiting in the persistent retry queue
 * (`retry_queue_pending > 0`). Gating on the live pending count rather than
 * the monotonic `bg_dropped` alone means a drop that has since flushed clears
 * the notice instead of leaving it stuck lit. Extracted as its own component
 * so its conditional stays out of `StatusPanel`'s body (complexity ceiling).
 */
function BoundedStalenessNotice({ status }: { status: StatusInfo }): React.ReactElement | null {
  const { t } = useTranslation()
  const bgDropped = status.bg_dropped
  const retryPending = status.retry_queue_pending ?? 0
  if (bgDropped <= 0 || retryPending <= 0) return null

  return (
    <div
      className="status-panel-stale mt-4 flex flex-col gap-1 rounded-md border border-alert-warning-border bg-alert-warning p-4 text-sm text-alert-warning-foreground"
      data-testid="status-panel-stale"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{t('status.bgStaleMessage', { count: retryPending })}</p>
      </div>
      <p className="ml-6 text-xs text-muted-foreground">{t('status.bgStaleHint')}</p>
    </div>
  )
}

export function StatusPanel(): React.ReactElement {
  const queryFn = useCallback(() => commands.getStatus().then(unwrap), [])
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
  const hasErrors = fgErrors > 0 || bgErrors > 0

  const { t } = useTranslation()

  return (
    <Card className="status-panel">
      <CardHeader>
        <CardTitle className="status-panel-title">{t('status.materializerStatusTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && !status && (
          <LoadingSkeleton
            count={4}
            height="h-20"
            loading
            ariaLabel={t('status.loadingLabel')}
            className="status-panel-loading grid grid-cols-2 gap-4 space-y-0"
          />
        )}

        {error && <p className="status-panel-error text-sm text-destructive">{error}</p>}

        {status && (
          <output className="status-panel-metrics block">
            <dl className="grid grid-cols-2 gap-4">
              <MetricCard
                className={cn('status-metric', queueHealthClasses(status.foreground_queue_depth))}
                value={<span className="status-metric-value">{status.foreground_queue_depth}</span>}
                labelSlot={
                  <MetricLabel
                    label={t('status.foregroundQueueLabel')}
                    tooltip={t('status.foregroundQueueTooltip')}
                  />
                }
                footer={
                  <>
                    {t('status.peakLabel')} {status.fg_high_water}
                  </>
                }
              />

              <MetricCard
                className={cn('status-metric', queueHealthClasses(status.background_queue_depth))}
                value={<span className="status-metric-value">{status.background_queue_depth}</span>}
                labelSlot={
                  <MetricLabel
                    label={t('status.backgroundQueueLabel')}
                    tooltip={t('status.backgroundQueueTooltip')}
                  />
                }
                footer={
                  <>
                    {t('status.peakLabel')} {status.bg_high_water}
                  </>
                }
              />

              <MetricCard
                className="status-metric"
                value={
                  <span className="status-metric-value">
                    {/* Grand total: foreground ops + background tasks dispatched
                          (the next card breaks out the background-only figure). */}
                    {status.total_ops_dispatched + status.total_background_dispatched}
                  </span>
                }
                labelSlot={
                  <MetricLabel
                    label={t('status.opsDispatchedLabel')}
                    tooltip={t('status.opsDispatchedTooltip')}
                  />
                }
              />

              <MetricCard
                className="status-metric"
                value={
                  <span className="status-metric-value">{status.total_background_dispatched}</span>
                }
                labelSlot={
                  <MetricLabel
                    label={t('status.backgroundDispatchedLabel')}
                    tooltip={t('status.backgroundDispatchedTooltip')}
                  />
                }
              />

              <MetricCard
                className="status-metric"
                value={
                  <span className="status-metric-value">{status.sql_only_fallback_count}</span>
                }
                labelSlot={
                  <MetricLabel
                    label={t('status.sqlOnlyFallbackLabel')}
                    tooltip={t('status.sqlOnlyFallbackTooltip')}
                  />
                }
              />

              <MetricCard
                className="status-metric"
                value={
                  <span className="status-metric-value">{status.descendant_fanout_dropped}</span>
                }
                labelSlot={
                  <MetricLabel
                    label={t('status.fanoutDroppedLabel')}
                    tooltip={t('status.fanoutDroppedTooltip')}
                  />
                }
              />
            </dl>

            {hasErrors && (
              <div className="status-panel-errors mt-4 flex flex-col gap-1 rounded-md border border-alert-error-border bg-alert-error p-4 text-sm text-alert-error-foreground">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>{errorSummaryText({ fgErrors, bgErrors }, t)}</p>
                </div>
                {bgErrors > 0 && (
                  <p className="ml-6 text-xs text-muted-foreground">{t('status.cacheStaleHint')}</p>
                )}
              </div>
            )}

            <BoundedStalenessNotice status={status} />
          </output>
        )}
      </CardContent>
    </Card>
  )
}

export function SyncStatusCard(): React.ReactElement | null {
  const syncState = useSyncStore((s) => s.state)
  const syncError = useSyncStore((s) => s.error)
  const syncPeers = useSyncStore((s) => s.peers)
  const syncLastSynced = useSyncStore((s) => s.lastSyncedAt)
  const syncOpsReceived = useSyncStore((s) => s.opsReceived)
  const syncOpsSent = useSyncStore((s) => s.opsSent)
  const now = useMinuteClock()

  const { t } = useTranslation()

  // With nothing paired the device list's empty state already says so.
  if (syncPeers.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="sync-panel-title" data-testid="sync-panel-title">
          {t('status.syncStatusTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="sync-panel-details space-y-3">
          <div className="flex items-center gap-2">
            <output
              className={cn('sync-state-dot h-2 w-2 rounded-full', syncStateDotClasses(syncState))}
              aria-label={t('status.syncStateLabel', { state: syncStateLabel(syncState, t) })}
            />
            <SyncStateIcon state={syncState} />
            <span className="sync-state-label text-sm font-medium">
              {syncStateLabel(syncState, t)}
            </span>
          </div>

          {syncError && (
            <p className="sync-panel-error text-sm text-destructive" role="alert">
              {syncError}
            </p>
          )}

          <dl className="grid grid-cols-2 gap-4">
            <MetricCard
              value={<span className="sync-peer-count">{syncPeers.length}</span>}
              labelSlot={
                <MetricLabel
                  label={t('status.peerLabel', { count: syncPeers.length })}
                  tooltip={t('status.peerCountTooltip')}
                />
              }
            />

            <MetricCard
              value={
                <span className="sync-last-synced">
                  {syncLastSynced ? formatRelativeTime(syncLastSynced, t, now) : '--'}
                </span>
              }
              labelSlot={
                <MetricLabel
                  label={t('status.lastSyncedLabel')}
                  tooltip={t('status.lastSyncedTooltip')}
                />
              }
            />

            <MetricCard
              value={<span className="sync-ops-received">{syncOpsReceived}</span>}
              labelSlot={
                <MetricLabel
                  label={t('status.opsReceivedLabel')}
                  tooltip={t('status.opsReceivedTooltip')}
                />
              }
            />

            <MetricCard
              value={<span className="sync-ops-sent">{syncOpsSent}</span>}
              labelSlot={
                <MetricLabel
                  label={t('status.opsSentLabel')}
                  tooltip={t('status.opsSentTooltip')}
                />
              }
            />
          </dl>
        </div>
      </CardContent>
    </Card>
  )
}
