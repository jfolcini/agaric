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
 * ## Why there IS a mount-time query (#4035), and why it is not a backfill
 *
 * Note first what this is *not* about. The subscription below is not tied to
 * the pairing dialog being open: `DeviceManagement` mounts `PairingDialog`
 * unconditionally and the dialog's `if (!open) return null` sits after every
 * hook, so this listener is really created when the Settings "Sync & Devices"
 * tab mounts, and closing and reopening the dialog neither unsubscribes it nor
 * resets `status`. A second dialog session on a still-live block already shows
 * the banner with no query at all, and a test in `PairingDialog.test.tsx`
 * pins that.
 *
 * The gap is a block that was **already in progress before this listener
 * existed**. The daemon emits only on a *transition* and the dedup behind that
 * rule is process-global, so the single event announcing such a block was
 * emitted while nothing here was subscribed, and nothing further will be
 * emitted until the block ends. That is the ordinary case, not an exotic one:
 * a user reaches Settings → Sync & Devices *because* pairing stopped working,
 * i.e. after the block started; and leaving that tab unmounts the listener, so
 * coming back during one continuous block lands in the same silence. Without
 * this query they are shown a clean pairing UI on a device whose network is
 * cut — #3852's failure mode, one navigation later.
 *
 * The earlier note here argued against a backfill on the grounds that "a status
 * queried at mount could describe a block that ended seconds ago". That is an
 * argument against replaying a past *transition*, and `getOsNetworkBlockStatus`
 * does not: it returns the platform's most recent statement about the
 * **present**, updated on every `onBlockedStatusChanged` delivery including the
 * repeats the event stream swallows. A block that ended produced a recovery
 * delivery, so the query answers `false` for it.
 *
 * Two rules keep that honest, each pinned by a test in this hook's suite:
 *
 *  1. **The query is issued only once `listen()` has resolved**, via
 *     `onSubscribed`. `useTauriEventListener` does not buffer, so anything the
 *     daemon emits before the subscription is live is dropped. Querying at
 *     mount instead would leave a window in which a *recovery* is lost while
 *     the answer already in flight says `blocked: true` — a banner nothing
 *     would ever clear, because the next event is only the next transition.
 *     Subscribing first means every transition is either already reflected in
 *     the answer or arrives as an event.
 *  2. **A live event that has already been applied wins over a query still in
 *     flight.** The two still race by one IPC round trip, and the event is the
 *     newer fact — without this, the read could resurrect a block the user
 *     just watched clear, which is the small lie the earlier note was right to
 *     refuse.
 *
 * No-op outside Tauri (browser dev sessions without `__TAURI_INTERNALS__`).
 */

import { useEffect, useRef, useState } from 'react'

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
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
  // Set as soon as a well-formed live event has been applied. The status query
  // below defers to it: the query and a concurrent event race by exactly one
  // IPC round trip, and if the event wins that race it is the newer fact.
  const liveEventApplied = useRef(false)
  // The query outlives the component if the tab unmounts mid-flight. Reset on
  // mount, not just declared false, so a StrictMode remount re-arms it.
  const unmounted = useRef(false)
  useEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
    }
  }, [])

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
      liveEventApplied.current = true
      setStatus(blocked && reasonKey != null ? { blocked: true, reasonKey } : CLEAR)
    },
    {
      enabled,
      // #4035 — ask what is true NOW, and only once the subscription above is
      // live. A block already in progress produced its one event before this
      // listener existed, and the daemon's dedup means it will not produce
      // another until the block ends, so this query is the only thing that can
      // put the banner on screen for it. Running it from `onSubscribed` rather
      // than a mount effect is what keeps it from stranding a banner: an event
      // emitted before `listen()` resolves is dropped, and the one that hurts
      // is a *recovery* — it would leave the query's `blocked: true` on screen
      // with nothing left to clear it until the next transition.
      onSubscribed: () => {
        commands
          .getOsNetworkBlockStatus()
          .then((res) => {
            const current = unwrap(res)
            // A live event that has already been applied is the newer fact —
            // it is also the only thing that can have moved `status` off CLEAR
            // by now, so this guard is what makes the assignment below safe to
            // apply in either direction rather than raise-only.
            if (unmounted.current || liveEventApplied.current) return
            // Narrowed exactly as the event path narrows, and for the same
            // reason: a block with no key names no catalog entry, the hook has
            // no fallback wording, and the alternative to ignoring it is an
            // empty banner.
            setStatus(
              current.blocked && current.reason_key != null
                ? { blocked: true, reasonKey: current.reason_key }
                : CLEAR,
            )
          })
          .catch((err: unknown) => {
            logger.warn('DeviceManagement', 'getOsNetworkBlockStatus() rejected', undefined, err)
          })
      },
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
