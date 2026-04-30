/**
 * GoogleCalendarSettingsTab — Settings tab for the FEAT-5 Google Calendar
 * daily-agenda digest push surface.
 *
 * Pushes Agaric's daily agenda into a dedicated, Agaric-owned Google
 * Calendar ("Agaric Agenda"). Currently opt-in and labeled experimental
 * per REVIEW-LATER FEAT-5f.
 *
 * Sections (top to bottom):
 *   1. Experimental warning badge.
 *   2. Account — Connect button (disconnected) or email + disconnect
 *      (connected).
 *   3. Window size — numeric input, range [7, 90], debounced 500 ms.
 *   4. Privacy mode — Switch: full / minimal (hide agenda content).
 *   5. Status — last push (relative), last error, push-lease holder.
 *   6. Actions — Force full resync + Disconnect (with AlertDialog
 *      presenting two options: delete calendar / keep calendar).
 *
 * The backend exposes five Tauri commands consumed here (defined by
 * FEAT-5e in `src-tauri/src/commands/gcal.rs`):
 *   - `get_gcal_status` → GcalStatus
 *   - `set_gcal_window_days(n)` → persist the window size
 *   - `set_gcal_privacy_mode(mode)` → persist 'full' | 'minimal'
 *   - `force_gcal_resync` → reconcile every date in the window
 *   - `disconnect_gcal(deleteCalendar)` → clear tokens + optionally
 *     delete the Agaric Agenda calendar
 *
 * Plus `begin_gcal_oauth` (exposed by FEAT-5b's OAuth wiring) — used by
 * the Connect button.
 *
 * Listens to four Tauri events emitted by the push connector and
 * surfaces them as toasts:
 *   - `gcal:reauth_required` → reauth toast
 *   - `gcal:push_disabled` → re-fetch status + disabled toast
 *   - `gcal:keyring_unavailable` → keyring toast
 *   - `gcal:calendar_recreated` → recreated toast
 *
 * Every IPC call has an error-path fallback per AGENTS.md §Testing
 * Conventions — the component logs via `logger.error` / `logger.warn`,
 * shows a toast, and keeps rendering (no crash on IPC rejection).
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AlertCircle, CheckCircle2, Info } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useIpcCommand } from '@/hooks/useIpcCommand'
import type { GcalStatus } from '@/lib/bindings'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { LoadingSkeleton } from './LoadingSkeleton'

const STATUS_POLL_INTERVAL_MS = 60_000
const WINDOW_DEBOUNCE_MS = 500
const WINDOW_MIN = 7
const WINDOW_MAX = 90

const EVENT_REAUTH = 'gcal:reauth_required'
const EVENT_PUSH_DISABLED = 'gcal:push_disabled'
const EVENT_KEYRING = 'gcal:keyring_unavailable'
const EVENT_CALENDAR_RECREATED = 'gcal:calendar_recreated'

function clampWindow(n: number): number {
  if (!Number.isFinite(n)) return WINDOW_MIN
  if (n < WINDOW_MIN) return WINDOW_MIN
  if (n > WINDOW_MAX) return WINDOW_MAX
  return Math.floor(n)
}

export function GoogleCalendarSettingsTab(): React.ReactElement {
  const { t } = useTranslation()
  const [status, setStatus] = useState<GcalStatus | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [isResyncing, setIsResyncing] = useState<boolean>(false)
  const [disconnectOpen, setDisconnectOpen] = useState<boolean>(false)
  // Separate input state so the user can edit freely before debounce flushes.
  const [windowInput, setWindowInput] = useState<string>('')
  const windowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Force a re-render every 60 s so the "last push" relative-time label
  // refreshes without each mount re-fetching unnecessarily.
  const [, setTick] = useState<number>(0)

  // MAINT-120: load gcal status via the shared useIpcCommand hook. The
  // success path also keeps `windowInput` synced when the server-side value
  // changes (and the user isn't mid-edit on a different value); on error
  // we surface an inline status banner via `setStatusError`.
  const { execute: executeLoadStatus } = useIpcCommand<void, GcalStatus>({
    call: () => invoke<GcalStatus>('get_gcal_status'),
    module: 'GoogleCalendarSettingsTab',
    errorLogMessage: 'failed to load gcal status',
    onSuccess: (result) => {
      setStatus(result)
      setStatusError(null)
      setWindowInput((prev) => {
        const parsed = Number.parseInt(prev, 10)
        if (!Number.isFinite(parsed) || parsed !== result.window_days) {
          return String(result.window_days)
        }
        return prev
      })
    },
    onError: () => {
      setStatusError(t('gcal.loadFailed'))
    },
  })

  const loadStatus = useCallback(async () => {
    await executeLoadStatus()
    setLoading(false)
  }, [executeLoadStatus])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // Periodic 60 s poll so the panel stays fresh while the user is viewing
  // it (last push timestamp, lease ownership, error banner).
  useEffect(() => {
    const id = window.setInterval(() => {
      void loadStatus()
      setTick((n) => n + 1)
    }, STATUS_POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [loadStatus])

  // Subscribe to the four connector events. Each one is fire-and-forget
  // metadata — we surface a toast and, for push-disabled, re-fetch the
  // status so the UI reflects the new (connected=false) state.
  useEffect(() => {
    let cancelled = false
    const unlistens: Array<() => void> = []

    const register = async (name: string, handler: () => void): Promise<void> => {
      try {
        const unlisten = await listen(name, () => {
          if (!cancelled) handler()
        })
        if (cancelled) {
          unlisten()
        } else {
          unlistens.push(unlisten)
        }
      } catch (err) {
        logger.warn('GoogleCalendarSettingsTab', `failed to subscribe to ${name}`, undefined, err)
      }
    }

    void Promise.all([
      register(EVENT_REAUTH, () => {
        toast.error(t('gcal.reauthRequired'))
      }),
      register(EVENT_PUSH_DISABLED, () => {
        void loadStatus()
        toast.info(t('gcal.pushDisabled'))
      }),
      register(EVENT_KEYRING, () => {
        toast.error(t('gcal.keyringUnavailable'))
      }),
      register(EVENT_CALENDAR_RECREATED, () => {
        toast.info(t('gcal.calendarRecreated'))
      }),
    ])

    return () => {
      cancelled = true
      for (const fn of unlistens) {
        try {
          fn()
        } catch (err) {
          logger.warn('GoogleCalendarSettingsTab', 'unlisten threw during cleanup', undefined, err)
        }
      }
    }
  }, [loadStatus, t])

  // Cancel any pending debounce on unmount — avoids a fire-after-unmount
  // IPC call that would log a phantom error.
  useEffect(() => {
    return () => {
      if (windowTimerRef.current) {
        clearTimeout(windowTimerRef.current)
        windowTimerRef.current = null
      }
    }
  }, [])

  // MAINT-120: persist the window-days setting. Optimistic update keeps
  // both the input and status in sync; on rejection we toast and refetch
  // so the UI doesn't drift from the server-side value.
  const { execute: executeSetWindowDays } = useIpcCommand<{ n: number }, void>({
    call: ({ n }) => invoke('set_gcal_window_days', { n }),
    module: 'GoogleCalendarSettingsTab',
    errorLogMessage: 'failed to set window days',
    errorLogContext: ({ n }) => ({ n }),
    optimistic: ({ n }) => {
      setWindowInput(String(n))
      setStatus((s) => (s === null ? s : { ...s, window_days: n }))
    },
    onError: () => {
      toast.error(t('gcal.windowFailed'))
      void loadStatus()
    },
  })

  const persistWindowDays = useCallback(
    async (raw: number) => {
      const clamped = clampWindow(raw)
      await executeSetWindowDays({ n: clamped })
    },
    [executeSetWindowDays],
  )

  const scheduleWindowPersist = useCallback(
    (raw: number) => {
      if (windowTimerRef.current) clearTimeout(windowTimerRef.current)
      windowTimerRef.current = setTimeout(() => {
        void persistWindowDays(raw)
      }, WINDOW_DEBOUNCE_MS)
    },
    [persistWindowDays],
  )

  const handleWindowChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value
      setWindowInput(raw)
      const parsed = Number.parseInt(raw, 10)
      if (Number.isFinite(parsed)) {
        scheduleWindowPersist(parsed)
      }
    },
    [scheduleWindowPersist],
  )

  const handleWindowBlur = useCallback(() => {
    // Cancel any pending debounce and flush immediately with the clamped
    // value so the stored value is always valid after blur.
    if (windowTimerRef.current) {
      clearTimeout(windowTimerRef.current)
      windowTimerRef.current = null
    }
    const parsed = Number.parseInt(windowInput, 10)
    const clamped = clampWindow(Number.isFinite(parsed) ? parsed : (status?.window_days ?? 30))
    // UX-4: notify the user when their typed value was clamped to the valid
    // range. Silent clamping (e.g. typing 100 and getting 90 with no
    // feedback) is a documented anti-pattern.
    if (Number.isFinite(parsed) && (parsed < WINDOW_MIN || parsed > WINDOW_MAX)) {
      toast.info(t('settings.valueClamped', { min: WINDOW_MIN, max: WINDOW_MAX }))
    }
    if (status && clamped === status.window_days) {
      // No-op: just sync the input in case the user typed out-of-range.
      setWindowInput(String(clamped))
      return
    }
    void persistWindowDays(clamped)
  }, [persistWindowDays, status, windowInput, t])

  // MAINT-120: privacy-mode toggle. Optimistic flip; on rejection we
  // restore the captured `previous` snapshot so the Switch reverts.
  const { execute: executeSetPrivacy } = useIpcCommand<
    { mode: 'full' | 'minimal'; previous: GcalStatus | null },
    void
  >({
    call: ({ mode }) => invoke('set_gcal_privacy_mode', { mode }),
    module: 'GoogleCalendarSettingsTab',
    errorLogMessage: 'failed to set privacy mode',
    errorLogContext: ({ mode }) => ({ mode }),
    optimistic: ({ mode }) => {
      setStatus((s) => (s === null ? s : { ...s, privacy_mode: mode }))
    },
    revert: ({ previous }) => {
      setStatus(previous)
    },
    onSuccess: () => {
      toast.success(t('gcal.privacyUpdated'))
    },
    onError: () => {
      toast.error(t('gcal.privacyFailed'))
    },
  })

  const handlePrivacyToggle = useCallback(
    async (nextMinimal: boolean) => {
      const mode: 'full' | 'minimal' = nextMinimal ? 'minimal' : 'full'
      await executeSetPrivacy({ mode, previous: status })
    },
    [executeSetPrivacy, status],
  )

  // MAINT-120: kick off Google OAuth flow. On success refetch so the
  // panel reflects the new connected state once the round-trip completes.
  const { execute: executeBeginOauth } = useIpcCommand<void, void>({
    call: () => invoke('begin_gcal_oauth'),
    module: 'GoogleCalendarSettingsTab',
    errorLogMessage: 'failed to begin gcal oauth',
    onSuccess: () => {
      void loadStatus()
    },
    onError: () => {
      toast.error(t('gcal.connectFailed'))
    },
  })

  const handleConnect = useCallback(async () => {
    await executeBeginOauth()
  }, [executeBeginOauth])

  // MAINT-120: force a full resync. `isResyncing` is tracked outside the
  // hook because it gates aria-busy + spinner on the action button while
  // the IPC is in flight.
  const { execute: executeForceResync } = useIpcCommand<void, void>({
    call: () => invoke('force_gcal_resync'),
    module: 'GoogleCalendarSettingsTab',
    errorLogMessage: 'failed to force resync',
    onSuccess: () => {
      toast.success(t('gcal.resyncStarted'))
      void loadStatus()
    },
    onError: () => {
      toast.error(t('gcal.resyncFailed'))
    },
  })

  const handleForceResync = useCallback(async () => {
    setIsResyncing(true)
    await executeForceResync()
    setIsResyncing(false)
  }, [executeForceResync])

  // MAINT-120: disconnect (with optional calendar deletion). The success
  // toast picks one of two messages based on the `deleteCalendar` arg.
  const { execute: executeDisconnect } = useIpcCommand<{ deleteCalendar: boolean }, void>({
    call: ({ deleteCalendar }) => invoke('disconnect_gcal', { deleteCalendar }),
    module: 'GoogleCalendarSettingsTab',
    errorLogMessage: 'failed to disconnect gcal',
    errorLogContext: ({ deleteCalendar }) => ({ deleteCalendar }),
    onSuccess: (_result, { deleteCalendar }) => {
      toast.success(
        deleteCalendar ? t('gcal.disconnect.successWithDelete') : t('gcal.disconnect.successKeep'),
      )
      void loadStatus()
    },
    onError: () => {
      toast.error(t('gcal.disconnect.failed'))
    },
  })

  const handleDisconnect = useCallback(
    async (deleteCalendar: boolean) => {
      setDisconnectOpen(false)
      await executeDisconnect({ deleteCalendar })
    },
    [executeDisconnect],
  )

  if (loading) {
    return (
      <div className="space-y-4 max-w-xl">
        <LoadingSkeleton count={5} height="h-10" />
      </div>
    )
  }

  const effectiveStatus: GcalStatus = status ?? {
    connected: false,
    account_email: null,
    calendar_id: null,
    window_days: 30,
    privacy_mode: 'full',
    last_push_at: null,
    last_error: null,
    push_lease: { held_by_this_device: false, device_id: null, expires_at: null },
  }

  return (
    <div className="gcal-settings-tab space-y-6 max-w-xl">
      {/* Header + experimental warning */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-medium">{t('gcal.title')}</h2>
          <Badge
            variant="outline"
            className="border-alert-warning-border bg-alert-warning text-alert-warning-foreground"
          >
            {t('gcal.experimentalBadge')}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t('gcal.description')}</p>
        <p
          className="rounded-md border border-alert-warning-border bg-alert-warning p-3 text-xs text-alert-warning-foreground"
          role="status"
        >
          {t('gcal.experimentalWarning')}
        </p>
      </div>

      {statusError !== null && (
        <p className="text-sm text-destructive" role="status">
          {statusError}
        </p>
      )}

      {/* Account section */}
      <div className="space-y-2">
        <Label muted={false}>{t('gcal.accountLabel')}</Label>
        {effectiveStatus.connected && effectiveStatus.account_email !== null ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <code
                className="flex-1 rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono break-all"
                data-testid="gcal-account-email"
              >
                {effectiveStatus.account_email}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDisconnectOpen(true)}
                aria-label={t('gcal.disconnect.button')}
              >
                {t('gcal.disconnect.button')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('gcal.pushingToCalendar')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleConnect()}
              aria-label={t('gcal.connectButton')}
            >
              {t('gcal.connectButton')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('gcal.connectHelp')}</p>
          </div>
        )}
      </div>

      {/* Window size */}
      <div className="space-y-2">
        <Label htmlFor="gcal-window-days" muted={false}>
          {t('gcal.windowLabel')}
        </Label>
        <Input
          id="gcal-window-days"
          type="number"
          min={WINDOW_MIN}
          max={WINDOW_MAX}
          step={1}
          value={windowInput}
          onChange={handleWindowChange}
          onBlur={handleWindowBlur}
          aria-label={t('gcal.windowLabel')}
          className="max-w-[8rem]"
          disabled={!effectiveStatus.connected}
          data-testid="gcal-window-input"
        />
        <p className="text-xs text-muted-foreground">{t('gcal.windowHelp')}</p>
      </div>

      {/* Privacy mode */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Label htmlFor="gcal-privacy-toggle" muted={false}>
            {t('gcal.privacyLabel')}
          </Label>
          <p className="text-xs text-muted-foreground mt-1">{t('gcal.privacyHelp')}</p>
        </div>
        <Switch
          id="gcal-privacy-toggle"
          checked={effectiveStatus.privacy_mode === 'minimal'}
          onCheckedChange={handlePrivacyToggle}
          aria-label={t('gcal.privacyLabel')}
          disabled={!effectiveStatus.connected}
        />
      </div>

      {/* Status panel */}
      <div className="space-y-2" data-testid="gcal-status-panel">
        <Label muted={false}>{t('gcal.statusLabel')}</Label>
        <div className="space-y-1 rounded-md border bg-muted/20 p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t('gcal.lastPushLabel')}</span>
            <span className="tabular-nums" data-testid="gcal-last-push">
              {effectiveStatus.last_push_at !== null
                ? formatRelativeTime(effectiveStatus.last_push_at, t)
                : t('gcal.neverPushed')}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t('gcal.leaseLabel')}</span>
            <LeaseIndicator
              connected={effectiveStatus.connected}
              lease={effectiveStatus.push_lease}
              thisDeviceLabel={t('gcal.leaseThisDevice')}
              otherDeviceLabel={t('gcal.leaseOtherDevice', {
                deviceId: effectiveStatus.push_lease.device_id ?? '—',
              })}
              noLeaseLabel={t('gcal.leaseNone')}
            />
          </div>
          {effectiveStatus.last_error !== null && (
            <p className="text-destructive text-sm pt-1 break-words" data-testid="gcal-last-error">
              {effectiveStatus.last_error}
            </p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleForceResync()}
          disabled={isResyncing || !effectiveStatus.connected}
          aria-label={t('gcal.resyncButton')}
          aria-busy={isResyncing}
          data-testid="gcal-resync-button"
        >
          {isResyncing && <Spinner size="sm" />}
          {t('gcal.resyncButton')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDisconnectOpen(true)}
          disabled={!effectiveStatus.connected}
          aria-label={t('gcal.disconnect.openButton')}
          data-testid="gcal-disconnect-button"
        >
          {t('gcal.disconnect.openButton')}
        </Button>
      </div>

      {/* Disconnect dialog — two destructive-ish choices + cancel */}
      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent data-testid="gcal-disconnect-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('gcal.disconnect.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('gcal.disconnect.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="gcal-disconnect-cancel">
              {t('gcal.disconnect.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: 'outline' }))}
              onClick={() => void handleDisconnect(false)}
              data-testid="gcal-disconnect-keep"
            >
              {t('gcal.disconnect.keepCalendar')}
            </AlertDialogAction>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: 'destructive' }))}
              onClick={() => void handleDisconnect(true)}
              data-testid="gcal-disconnect-delete"
            >
              {t('gcal.disconnect.deleteCalendar')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// LeaseIndicator — presentational: shows which device currently holds
// the push lease. Extracted so the main component stays readable; kept
// in the same file because it is only meaningful inside the status panel.
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
