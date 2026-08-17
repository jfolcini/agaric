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

/**
 * The i18n key the daemon names for a block.
 *
 * Mirrors `BLOCKED_REASON_KEY` in
 * `agaric-sync/src/sync_daemon/android_network_block.rs`, which pins the same
 * literal from its side. The daemon sends a key rather than a sentence because
 * a sentence built in Rust is English for every user in every locale — the
 * daemon cannot know what language the window is in.
 *
 * Exported so the catalog entry has a *statically visible* reference: the
 * translation happens through a value read off the payload, which no static
 * scan (nor the `catalog-parity` orphan sweep) can follow back to a key.
 */
export const OS_NETWORK_BLOCKED_REASON_KEY = 'pairing.osNetworkBlocked'

/**
 * Live-event payload shape (`SyncEvent::NetworkBlockedByOs`).
 *
 * `reason_key` is snake_case because the Rust enum renames only its variant
 * tags (`rename_all = "snake_case"` on the enum), never its fields.
 */
interface NetworkBlockedPayload {
  blocked: boolean
  reason_key?: string | null
}

function isNetworkBlockedPayload(p: unknown): p is NetworkBlockedPayload {
  if (typeof p !== 'object' || p === null) return false
  const candidate = p as { blocked: unknown; reason_key: unknown }
  if (typeof candidate.blocked !== 'boolean') return false
  // A block MUST name the string to show. There is no fallback wording here on
  // purpose: the daemon is the only source of the key, so "blocked, but no key"
  // is a broken contract, not a state worth rendering an empty banner for.
  if (candidate.blocked) return typeof candidate.reason_key === 'string'
  return candidate.reason_key == null || typeof candidate.reason_key === 'string'
}

/**
 * A discriminated union, not `{ blocked: boolean; reasonKey: string | null }`.
 *
 * The nullable-field shape forced every consumer to write a `?? fallback` that
 * could never run, because the key is present exactly when `blocked` is true.
 * Narrowing on `blocked` hands the caller a `string` with no branch to leave
 * unreachable.
 */
export type UseOsNetworkBlockResult =
  | { blocked: false; reasonKey: null }
  | { blocked: true; reasonKey: string }

const CLEAR: UseOsNetworkBlockResult = { blocked: false, reasonKey: null }

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
      const { blocked, reason_key: reasonKey } = event.payload
      setStatus(blocked && reasonKey != null ? { blocked: true, reasonKey } : CLEAR)
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
