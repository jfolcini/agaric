/**
 * SyncStatusSection — Read-only status panel for the Google Calendar
 * settings tab.
 *
 * Extracted from `GoogleCalendarSettingsTab.tsx` per Phase 3b of
 * `pending/design-system-maintainability-2026-05-09.md`. Renders:
 *  - Last push (relative time) row.
 *  - Push-lease ownership indicator (this device / other device /
 *    none) via the inline `LeaseIndicator`.
 *  - Optional last-error banner when `status.last_error` is non-null.
 *
 * The orchestrator owns the 60 s polling + status fetch and passes the
 * resolved `GcalStatus` shape down; this component is purely
 * presentational. `LeaseIndicator` lives here (rather than in its own
 * file) because it is only meaningful inside the status panel.
 *
 * The `formatRelativeTime` import takes the translator so the parent
 * does NOT need to translate every relative label; the section calls
 * it directly with the i18n `t` it already has.
 */

import { AlertCircle, CheckCircle2, Info } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import type { GcalStatus } from '@/lib/bindings'
import { formatRelativeTime } from '@/lib/format-relative-time'

export interface SyncStatusSectionProps {
  status: GcalStatus
}

export function SyncStatusSection({ status }: SyncStatusSectionProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div className="space-y-2" data-testid="gcal-status-panel">
      <Label muted={false}>{t('gcal.statusLabel')}</Label>
      <div className="space-y-1 rounded-md border bg-muted/20 p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('gcal.lastPushLabel')}</span>
          <span className="tabular-nums" data-testid="gcal-last-push">
            {status.last_push_at !== null
              ? formatRelativeTime(status.last_push_at, t)
              : t('gcal.neverPushed')}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('gcal.leaseLabel')}</span>
          <LeaseIndicator
            connected={status.connected}
            lease={status.push_lease}
            thisDeviceLabel={t('gcal.leaseThisDevice')}
            otherDeviceLabel={t('gcal.leaseOtherDevice', {
              deviceId: status.push_lease.device_id ?? '—',
            })}
            noLeaseLabel={t('gcal.leaseNone')}
          />
        </div>
        {status.last_error !== null && (
          <p className="text-destructive text-sm pt-1 break-words" data-testid="gcal-last-error">
            {status.last_error}
          </p>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// LeaseIndicator — presentational: shows which device currently holds
// the push lease. Kept in this file because it is only meaningful inside
// the status panel and removing it would force a fourth tiny file.
// ────────────────────────────────────────────────────────────────────────

interface LeaseIndicatorProps {
  connected: boolean
  lease: GcalStatus['push_lease']
  thisDeviceLabel: string
  otherDeviceLabel: string
  noLeaseLabel: string
}

function LeaseIndicator({
  connected,
  lease,
  thisDeviceLabel,
  otherDeviceLabel,
  noLeaseLabel,
}: LeaseIndicatorProps): React.ReactElement {
  if (!connected || (lease.device_id === null && !lease.held_by_this_device)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Info className="size-3.5" aria-hidden="true" />
        <span data-testid="gcal-lease-none">{noLeaseLabel}</span>
      </span>
    )
  }
  if (lease.held_by_this_device) {
    return (
      <span className="inline-flex items-center gap-1.5 text-status-done-foreground">
        <CheckCircle2 className="size-3.5" aria-hidden="true" />
        <span data-testid="gcal-lease-this-device">{thisDeviceLabel}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <AlertCircle className="size-3.5" aria-hidden="true" />
      <span data-testid="gcal-lease-other-device">{otherDeviceLabel}</span>
    </span>
  )
}
