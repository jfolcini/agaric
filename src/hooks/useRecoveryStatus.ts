/**
 * useRecoveryStatus — surface a degraded boot to the user (#1255).
 *
 * The backend's C-2b boot op-log replay can fail wholesale (a corrupted
 * `op_log`, a stuck foreground queue, or the #412 multi-device hard-abort).
 * Previously that error was downgraded to a `tracing::warn!` and the app
 * booted into an incomplete/stale materialized view with ZERO UI signal —
 * the user kept editing/querying stale data, and writes layered on top
 * compounded the divergence.
 *
 * The backend now (a) records the failure in `RecoveryReport::replay_errors`,
 * (b) emits a durable `recovery:degraded` Tauri event, and (c) stores the
 * status in managed state for `get_recovery_status`. This hook consumes
 * both, exactly mirroring `useDeepLinkRouter`'s "emit + query-on-mount
 * backfill" shape: boot runs (and emits) before the webview registers its
 * listener, so the live event can be missed — the mount-time backfill via
 * `getRecoveryStatus()` covers that race.
 *
 * The signal is a PERSISTENT (`duration: Infinity`) warning toast, deduped
 * by a fixed id so the live event and the backfill collapse into a single
 * banner. Nothing is lost (the op log is canonical); the message tells the
 * user a restart usually re-runs recovery cleanly and to avoid large edits
 * until then.
 *
 * No-op outside Tauri (browser dev sessions without `__TAURI_INTERNALS__`).
 * Mount once in `App.tsx`.
 */

import { useEffect, useRef } from 'react'

import { i18n } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { getRecoveryStatus } from '@/lib/tauri'
import type { RecoveryStatus } from '@/lib/tauri'

import { useTauriEventListener } from './useTauriEventListener'

/** Event name — must mirror `EVENT_RECOVERY_DEGRADED` in
 *  `src-tauri/src/recovery/mod.rs`. */
export const RECOVERY_DEGRADED_EVENT = 'recovery:degraded'

/** Fixed sonner id so the live event and the mount backfill collapse into
 *  one persistent banner instead of stacking two. */
export const RECOVERY_DEGRADED_TOAST_ID = 'recovery-degraded'

/** Defensive shape check for the `RecoveryStatus` payload. */
function isRecoveryStatus(p: unknown): p is RecoveryStatus {
  return (
    typeof p === 'object' &&
    p !== null &&
    'degraded' in p &&
    typeof (p as { degraded: unknown }).degraded === 'boolean'
  )
}

/**
 * Show the persistent degraded-boot banner. Idempotent: sonner dedupes by
 * `id`, so calling this from both the live listener and the backfill only
 * ever shows one toast. Only fires when `status.degraded` is true.
 */
export function showRecoveryDegradedBanner(status: RecoveryStatus): void {
  if (!status.degraded) return
  logger.warn('boot', 'boot op-log replay degraded — materialized view may be stale', {
    replayErrors: status.replay_errors,
  })
  notify.warning(i18n.t('boot.recoveryDegradedBody'), {
    id: RECOVERY_DEGRADED_TOAST_ID,
    // Persist until the user dismisses it — a transient toast would scroll
    // away before a user who stepped away from a crashed session sees it.
    duration: Number.POSITIVE_INFINITY,
  })
}

export function useRecoveryStatus(): void {
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  // Live event: emitted once by the backend at boot when replay failed.
  useTauriEventListener<unknown>(
    RECOVERY_DEGRADED_EVENT,
    (event) => {
      if (!isRecoveryStatus(event.payload)) {
        logger.warn('boot', 'recovery:degraded payload malformed', {
          payload: JSON.stringify(event.payload),
        })
        return
      }
      showRecoveryDegradedBanner(event.payload)
    },
    {
      enabled,
      onError: (err) => {
        logger.warn('boot', `Failed to listen to ${RECOVERY_DEGRADED_EVENT}`, undefined, err)
      },
    },
  )

  // Backfill: boot emits before this listener registers, so query the
  // stored status on mount and show the banner if the boot was degraded.
  const backfilled = useRef(false)
  useEffect(() => {
    if (!enabled || backfilled.current) return
    backfilled.current = true
    let cancelled = false
    getRecoveryStatus()
      .then((status) => {
        if (cancelled) return
        showRecoveryDegradedBanner(status)
      })
      .catch((err: unknown) => {
        logger.warn('boot', 'getRecoveryStatus() rejected', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
}
