/**
 * useBindExposure — surface a sync endpoint bound to a globally-routable
 * address (#3864).
 *
 * #3853 had to widen the sync transport's locality gate from "RFC 1918" to
 * "any address this host actually holds", because the reporting maintainer's
 * home LAN is numbered out of real public space (`192.160.160.0/24`). The
 * cost is that a host with a genuinely public NIC — a VPS, a cloud box, a
 * non-NAT ISP link — now starts a QUIC listener where the daemon previously
 * refused to bind at all. Nothing observable from inside the app separates
 * those two situations, so the daemon states what it knows and leaves the
 * verdict to the user; this hook is how that reaches the screen.
 *
 * Mirrors `useMdnsStatus`'s "live event + query-on-mount backfill" shape, but
 * the backfill carries more weight here: the endpoint binds within the first
 * moments of `daemon_loop`, well before a mounting webview can register a
 * listener, so `getBindExposureStatus()` is the path that actually delivers
 * the signal on almost every boot. The live event covers the case where the
 * daemon starts later (dormant until the first pairing).
 *
 * No-op outside Tauri (browser dev sessions without `__TAURI_INTERNALS__`).
 */

import { useEffect, useState } from 'react'

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import { unwrap } from '@/lib/app-error'
import type { InternetFacingBind } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'

/** Event name — must mirror `EVENT_SYNC_INTERNET_FACING_BIND` in
 *  `src-tauri/agaric-sync/src/sync_events.rs`. */
export const SYNC_INTERNET_FACING_BIND_EVENT = 'sync:internet_facing_bind'

function isInternetFacingBind(p: unknown): p is InternetFacingBind {
  if (typeof p !== 'object' || p === null) return false
  const candidate = p as { address: unknown; port: unknown }
  return typeof candidate.address === 'string' && typeof candidate.port === 'number'
}

/**
 * The globally-routable bind the daemon reported, or `null` when the sync
 * endpoint is on a private address (or has not bound yet) — the two cases
 * being indistinguishable to a user and equally uninteresting.
 */
export function useBindExposure(): InternetFacingBind | null {
  const enabled = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const [bind, setBind] = useState<InternetFacingBind | null>(null)

  // Live event: emitted once per daemon start, and the daemon can restart
  // (dormant → active) onto a different address within one app session.
  useTauriEventListener<unknown>(
    SYNC_INTERNET_FACING_BIND_EVENT,
    (event) => {
      if (!isInternetFacingBind(event.payload)) {
        logger.warn('DeviceManagement', 'sync:internet_facing_bind payload malformed', {
          payload: JSON.stringify(event.payload),
        })
        return
      }
      setBind({ address: event.payload.address, port: event.payload.port })
    },
    {
      enabled,
      onError: (err) => {
        logger.warn(
          'DeviceManagement',
          `Failed to listen to ${SYNC_INTERNET_FACING_BIND_EVENT}`,
          undefined,
          err,
        )
      },
    },
  )

  // Backfill — see the header: this is the primary path, not the fallback.
  // A live event arriving afterwards still wins (last write), which is
  // correct: it reflects a fresh bind.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    commands
      .getBindExposureStatus()
      .then((res) => {
        const backfill = unwrap(res)
        if (cancelled || backfill == null || backfill.internet_facing == null) return
        setBind(backfill.internet_facing)
      })
      .catch((err: unknown) => {
        logger.warn('DeviceManagement', 'getBindExposureStatus() rejected', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  return bind
}
