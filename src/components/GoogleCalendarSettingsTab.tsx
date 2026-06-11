/**
 * GoogleCalendarSettingsTab — orchestrator for the FEAT-5 Google
 * Calendar daily-agenda digest push surface (opt-in, experimental — FEAT-5f).
 * Phase 3b split: rendering lives in
 * `./GoogleCalendarSettingsTab/{OAuthStatusSection,SettingsForm,
 * SyncStatusSection}.tsx`; this file keeps every IPC call, the 60 s
 * status poll, the four Tauri event subscriptions, the window-days
 * debounce, and the disconnect-dialog wiring. Backend commands defined
 * in `src-tauri/src/commands/gcal.rs`. Tauri events: `gcal:reauth_required`,
 * `gcal:push_disabled` (also re-fetches), `gcal:keyring_unavailable`,
 * `gcal:calendar_recreated`. Every IPC has an error-path fallback per
 * AGENTS.md §Testing Conventions — log, toast, keep rendering.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { useIpcCommand } from '@/hooks/useIpcCommand'
import type { GcalStatus } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

import { connectErrorMessage } from './GoogleCalendarSettingsTab/connectErrorMessage'
import { OAuthStatusSection } from './GoogleCalendarSettingsTab/OAuthStatusSection'
import { SettingsForm } from './GoogleCalendarSettingsTab/SettingsForm'
import { SyncStatusSection } from './GoogleCalendarSettingsTab/SyncStatusSection'

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

// Disconnected fallback rendered when `status` is null after a failed
// initial load — lets JSX skip a null-branch on every property read.
const DISCONNECTED_FALLBACK_STATUS: GcalStatus = {
  connected: false,
  account_email: null,
  calendar_id: null,
  window_days: 30,
  privacy_mode: 'full',
  last_push_at: null,
  last_error: null,
  reauth_required: false,
  push_lease: { held_by_this_device: false, device_id: null, expires_at: null },
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
  // 60 s tick: re-renders so the "last push" relative-time label refreshes.
  const [, setTick] = useState<number>(0)

  // MAINT-120: load status. Keeps `windowInput` synced with the server
  // value unless the user is mid-edit; on error sets the inline banner.
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

  // Periodic 60 s poll keeps the panel fresh while open.
  useEffect(() => {
    const id = window.setInterval(() => {
      void loadStatus()
      setTick((n) => n + 1)
    }, STATUS_POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [loadStatus])

  // Connector events → toasts; `push_disabled` also re-fetches status.
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
        // Backend re-emits the reauth event on every failed call until
        // the user reconnects — dedup so the toast updates in place.
        notify.error(t('gcal.reauthRequired'), { id: 'gcal-reauth' })
      }),
      register(EVENT_PUSH_DISABLED, () => {
        void loadStatus()
        notify.info(t('gcal.pushDisabled'))
      }),
      register(EVENT_KEYRING, () => {
        notify.error(t('gcal.keyringUnavailable'), { id: 'gcal-keyring' })
      }),
      register(EVENT_CALENDAR_RECREATED, () => {
        notify.info(t('gcal.calendarRecreated'))
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

  // Cancel pending debounce on unmount (avoid fire-after-unmount IPC).
  useEffect(() => {
    return () => {
      if (windowTimerRef.current) {
        clearTimeout(windowTimerRef.current)
        windowTimerRef.current = null
      }
    }
  }, [])

  // MAINT-120: persist window-days. Optimistic; on rejection toast + refetch.
  const { execute: executeSetWindowDays } = useIpcCommand<{ n: number }, void>({
    call: ({ n }) => invoke('set_gcal_window_days', { n }),
    module: 'GoogleCalendarSettingsTab',
    errorLogMessage: 'failed to set window days',
    errorLogContext: ({ n }) => ({ n }),
    optimistic: ({ n }) => {
      setWindowInput(String(n))
      setStatus((s) => (s === null ? s : { ...s, window_days: n }))
    },
    onSuccess: () => {
      notify.success(t('gcal.windowUpdated'))
    },
    onError: () => {
      notify.error(t('gcal.windowFailed'))
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
    // Flush any pending debounce immediately with the clamped value.
    if (windowTimerRef.current) {
      clearTimeout(windowTimerRef.current)
      windowTimerRef.current = null
    }
    const parsed = Number.parseInt(windowInput, 10)
    const clamped = clampWindow(Number.isFinite(parsed) ? parsed : (status?.window_days ?? 30))
    // UX-4: surface a notice when the typed value was clamped; silent
    // clamping is a documented anti-pattern.
    if (Number.isFinite(parsed) && (parsed < WINDOW_MIN || parsed > WINDOW_MAX)) {
      notify.info(t('settings.valueClamped', { min: WINDOW_MIN, max: WINDOW_MAX }))
    }
    if (status && clamped === status.window_days) {
      setWindowInput(String(clamped))
      return
    }
    void persistWindowDays(clamped)
  }, [persistWindowDays, status, windowInput, t])

  // MAINT-120: privacy toggle. Optimistic; revert from `previous` on reject.
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
      notify.success(t('gcal.privacyUpdated'))
    },
    onError: () => {
      notify.error(t('gcal.privacyFailed'))
    },
  })

  const handlePrivacyToggle = useCallback(
    async (nextMinimal: boolean) => {
      const mode: 'full' | 'minimal' = nextMinimal ? 'minimal' : 'full'
      await executeSetPrivacy({ mode, previous: status })
    },
    [executeSetPrivacy, status],
  )

  // MAINT-120 / PEND-gcal-oauth: kick off Google OAuth. IPC takes 30s+
  // in the happy path, so `loading` from the hook gates the button.
  const { execute: executeBeginOauth, loading: oauthInFlight } = useIpcCommand<void, void>({
    call: () => invoke('begin_gcal_oauth'),
    module: 'GoogleCalendarSettingsTab',
    errorLogMessage: 'failed to begin gcal oauth',
    onSuccess: () => {
      void loadStatus()
    },
    onError: (err) => {
      notify.error(connectErrorMessage(err, t))
    },
  })

  const handleConnect = useCallback(async () => {
    await executeBeginOauth()
  }, [executeBeginOauth])

  // MAINT-120: force resync. `isResyncing` lives outside the hook to
  // gate aria-busy + spinner on the action button.
  const { execute: executeForceResync } = useIpcCommand<void, void>({
    call: () => invoke('force_gcal_resync'),
    module: 'GoogleCalendarSettingsTab',
    errorLogMessage: 'failed to force resync',
    onSuccess: () => {
      notify.success(t('gcal.resyncStarted'))
      void loadStatus()
    },
    onError: () => {
      notify.error(t('gcal.resyncFailed'))
    },
  })

  const handleForceResync = useCallback(async () => {
    setIsResyncing(true)
    await executeForceResync()
    setIsResyncing(false)
  }, [executeForceResync])

  // MAINT-120: disconnect. Success toast picks one of two messages.
  const { execute: executeDisconnect } = useIpcCommand<{ deleteCalendar: boolean }, void>({
    call: ({ deleteCalendar }) => invoke('disconnect_gcal', { deleteCalendar }),
    module: 'GoogleCalendarSettingsTab',
    errorLogMessage: 'failed to disconnect gcal',
    errorLogContext: ({ deleteCalendar }) => ({ deleteCalendar }),
    onSuccess: (_result, { deleteCalendar }) => {
      notify.success(
        deleteCalendar ? t('gcal.disconnect.successWithDelete') : t('gcal.disconnect.successKeep'),
      )
      void loadStatus()
    },
    onError: () => {
      notify.error(t('gcal.disconnect.failed'))
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

  const effectiveStatus: GcalStatus = status ?? DISCONNECTED_FALLBACK_STATUS

  return (
    <div className="gcal-settings-tab space-y-4 max-w-xl">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {t('gcal.title')}
            <Badge
              tone="outline"
              className="border-alert-warning-border bg-alert-warning text-alert-warning-foreground"
            >
              {t('gcal.experimentalBadge')}
            </Badge>
          </CardTitle>
          <CardDescription>{t('gcal.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <p
            className="rounded-md border border-alert-warning-border bg-alert-warning p-3 text-xs text-alert-warning-foreground"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role lives on a <p> warning paragraph; swapping to <output> would lose the paragraph semantics and is not a valid p replacement
            role="status"
          >
            {t('gcal.experimentalWarning')}
          </p>

          {statusError !== null && (
            <p className="text-sm text-destructive" role="alert">
              {statusError}
            </p>
          )}

          <OAuthStatusSection
            connected={effectiveStatus.connected}
            accountEmail={effectiveStatus.account_email}
            oauthInFlight={oauthInFlight}
            onConnect={() => void handleConnect()}
            onRequestDisconnect={() => setDisconnectOpen(true)}
          />

          <SettingsForm
            connected={effectiveStatus.connected}
            windowInput={windowInput}
            windowMin={WINDOW_MIN}
            windowMax={WINDOW_MAX}
            privacyMode={effectiveStatus.privacy_mode}
            onWindowChange={handleWindowChange}
            onWindowBlur={handleWindowBlur}
            onPrivacyToggle={handlePrivacyToggle}
          />

          <SyncStatusSection status={effectiveStatus} />

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
        </CardContent>
      </Card>

      {/* Disconnect dialog — Cancel + Keep Calendar + Delete Calendar via
          ConfirmDialog's `secondaryAction` (UX-review-2026-05-09 item 11). */}
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        titleKey="gcal.disconnect.title"
        descriptionKey="gcal.disconnect.description"
        cancelKey="gcal.disconnect.cancel"
        confirmKey="gcal.disconnect.deleteCalendar"
        variant="destructive"
        onConfirm={() => handleDisconnect(true)}
        secondaryAction={{
          labelKey: 'gcal.disconnect.keepCalendar',
          variant: 'outline',
          onConfirm: () => handleDisconnect(false),
          testId: 'gcal-disconnect-keep',
        }}
        contentTestId="gcal-disconnect-dialog"
        cancelTestId="gcal-disconnect-cancel"
        actionTestId="gcal-disconnect-delete"
      />
    </div>
  )
}
