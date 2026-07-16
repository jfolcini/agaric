/**
 * useMdnsStatus — surface mDNS peer-discovery unavailability (#2506).
 *
 * The sync daemon emits `SyncEvent::MdnsDisabled` when mDNS initialization
 * fails (sandboxed platforms, missing multicast permissions, etc.) — sync
 * still works via manual IP entry, but until this hook the frontend had no
 * listener for the event at all, so the peers/device-management surface
 * just showed an empty peer list with no explanation.
 *
 * Mirrors `useRecoveryStatus`'s "emit + query-on-mount backfill" shape: the
 * daemon can start (and emit) before the webview finishes mounting its
 * listener — `start_if_peers_exist_with_lifecycle` skips dormant mode
 * (mDNS init runs almost immediately) whenever a peer is already paired —
 * so `getMdnsStatus()` backfills the same status on mount for the case
 * where the live event was missed.
 *
 * No-op outside Tauri (browser dev sessions without `__TAURI_INTERNALS__`).
 */

import { useEffect, useState } from 'react'

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { logger } from '@/lib/logger'
import { getMdnsStatus } from '@/lib/tauri'
import type { MdnsStatus } from '@/lib/tauri'

/** Event name — must mirror `EVENT_SYNC_MDNS_DISABLED` in
 *  `src-tauri/src/sync_events.rs`. */
export const SYNC_MDNS_DISABLED_EVENT = 'sync:mdns_disabled'

/** Live-event payload shape (`SyncEvent::MdnsDisabled`). */
interface MdnsDisabledPayload {
  reason: string
}

function isMdnsDisabledPayload(p: unknown): p is MdnsDisabledPayload {
  return (
    typeof p === 'object' && p !== null && typeof (p as { reason: unknown }).reason === 'string'
  )
}

export interface UseMdnsStatusResult {
  /** `true` once mDNS initialization has failed at least once. */
  disabled: boolean
  /** The failure reason, present iff `disabled`. */
  reason: string | null
}

const HEALTHY: UseMdnsStatusResult = { disabled: false, reason: null }

export function useMdnsStatus(): UseMdnsStatusResult {
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const [status, setStatus] = useState<UseMdnsStatusResult>(HEALTHY)

  // Live event: emitted whenever mDNS init fails (may fire more than once
  // across dormant → active transitions with different reasons).
  useTauriEventListener<unknown>(
    SYNC_MDNS_DISABLED_EVENT,
    (event) => {
      if (!isMdnsDisabledPayload(event.payload)) {
        logger.warn('DeviceManagement', 'sync:mdns_disabled payload malformed', {
          payload: JSON.stringify(event.payload),
        })
        return
      }
      setStatus({ disabled: true, reason: event.payload.reason })
    },
    {
      enabled,
      onError: (err) => {
        logger.warn(
          'DeviceManagement',
          `Failed to listen to ${SYNC_MDNS_DISABLED_EVENT}`,
          undefined,
          err,
        )
      },
    },
  )

  // Backfill: the daemon can emit before this listener registers, so query
  // the stored status on mount and adopt it if it reports disabled. A live
  // event that arrives after the backfill resolves still wins (last write),
  // which is correct — it reflects a fresh init attempt.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    getMdnsStatus()
      .then((backfill: MdnsStatus) => {
        if (cancelled || backfill == null || !backfill.disabled) return
        setStatus({ disabled: true, reason: backfill.reason ?? null })
      })
      .catch((err: unknown) => {
        logger.warn('DeviceManagement', 'getMdnsStatus() rejected', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  return status
}
