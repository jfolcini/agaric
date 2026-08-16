/**
 * useOsNetworkBlock — surface an OS-level block on this app's network (#3852).
 *
 * The sync daemon emits `SyncEvent::NetworkBlockedByOs` when the platform tells
 * it — authoritatively, about this uid — that it is dropping the app's traffic.
 * On Android 15+ that is `FIREWALL_CHAIN_BACKGROUND`, which fires whenever the
 * app is not top-of-stack, *including when the screen merely sleeps while the
 * app is the top activity*.
 *
 * Without this, the failure is invisible: the daemon keeps running, keeps its
 * sockets, keeps its multicast lock, `sendto` keeps returning success, and both
 * devices show "Waiting for the other device…" until the pairing window expires.
 * A first-ever pair could not complete at all, and nothing anywhere said why.
 *
 * There is deliberately **no mount-time backfill command** here, unlike
 * `useMdnsStatus`: a firewall block is a live, reversible condition, not a
 * latched one. A status queried at mount could describe a block that ended
 * seconds ago, and telling a user to keep their screen on for a block that is
 * over is its own small lie. The event stream is the only truth, and the
 * pairing dialog is mounted for the entire window in which the answer matters.
 *
 * No-op outside Tauri (browser dev sessions without `__TAURI_INTERNALS__`).
 */

import { useState } from 'react'

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { logger } from '@/lib/logger'

/** Event name — must mirror `EVENT_SYNC_NETWORK_BLOCKED` in
 *  `agaric-sync/src/sync_events.rs`. */
export const SYNC_NETWORK_BLOCKED_EVENT = 'sync:network_blocked'

/** Live-event payload shape (`SyncEvent::NetworkBlockedByOs`). */
interface NetworkBlockedPayload {
  blocked: boolean
  reason: string
}

function isNetworkBlockedPayload(p: unknown): p is NetworkBlockedPayload {
  if (typeof p !== 'object' || p === null) return false
  const candidate = p as { blocked: unknown; reason: unknown }
  return typeof candidate.blocked === 'boolean' && typeof candidate.reason === 'string'
}

export interface UseOsNetworkBlockResult {
  /** `true` while the OS is dropping this app's traffic. */
  blocked: boolean
  /** The explanation to show the user, present iff `blocked`. */
  reason: string | null
}

const CLEAR: UseOsNetworkBlockResult = { blocked: false, reason: null }

export function useOsNetworkBlock(): UseOsNetworkBlockResult {
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const [status, setStatus] = useState<UseOsNetworkBlockResult>(CLEAR)

  useTauriEventListener<unknown>(
    SYNC_NETWORK_BLOCKED_EVENT,
    (event) => {
      if (!isNetworkBlockedPayload(event.payload)) {
        logger.warn('DeviceManagement', 'sync:network_blocked payload malformed', {
          payload: JSON.stringify(event.payload),
        })
        return
      }
      // The daemon emits `blocked: false` only as a recovery, so clearing on it
      // is safe: it cannot arrive before a block.
      setStatus(event.payload.blocked ? { blocked: true, reason: event.payload.reason } : CLEAR)
    },
    {
      enabled,
      onError: (err) => {
        logger.warn(
          'DeviceManagement',
          `Failed to listen to ${SYNC_NETWORK_BLOCKED_EVENT}`,
          undefined,
          err,
        )
      },
    },
  )

  return status
}
