/**
 * useScreenWakeLock — hold a screen wake lock for as long as a flag is true (#3852).
 *
 * ## Why pairing needs this
 *
 * Android 15+ runs a per-uid firewall chain (`FIREWALL_CHAIN_BACKGROUND`) that
 * drops **every** packet for an app that is not top-of-stack. "Not top-of-stack"
 * includes the case where the app *is* the top activity and the screen has
 * merely gone to sleep: `dumpsys netpolicy` reports `procState=TPSL`
 * (`TOP_SLEEPING`) with `blocked_state={blocked=APP_BACKGROUND, allowed=NONE}`.
 *
 * Measured on the reporting Pixel 8: the mDNS announce went out during the ~28 s
 * the screen was on, the screen slept, and from that instant the device answered
 * nothing — 300 datagrams aimed at its bound `0.0.0.0:5353` raised
 * `/proc/net/udp`'s drop counter by exactly 300 with `rx_queue` never leaving 0.
 * Both devices then showed "Waiting for the other device…" until the 5-minute
 * pairing window expired. **A first-ever pair could not complete at all.**
 *
 * Keeping the screen awake keeps `procState` at `TOP`, which keeps the uid out
 * of the background chain, for the seconds-to-minutes a first pair takes.
 *
 * ## Scope
 *
 * Deliberately parameterised on a flag rather than mounted app-wide. Holding a
 * device awake is a real cost to the user (battery, screen burn, a phone that
 * will not lock in a pocket) and the only window that needs it is the one where
 * a pairing handshake is in flight. The lock is released on every exit path:
 * the flag going false, unmount, and the browser's own release.
 *
 * ## Why the Web API and not `FLAG_KEEP_SCREEN_ON` over JNI
 *
 * `Window.addFlags` needs the **Activity**, and the only Android handle Agaric
 * holds is the process-wide Application context installed by `JNI_OnLoad` (see
 * `agaric-sync/src/android_context.rs` — an Activity reference is deliberately
 * not kept, because it dangles across configuration changes). Chromium
 * implements `navigator.wakeLock.request('screen')` on Android by setting that
 * same window flag on the hosting activity, so this reaches the identical
 * mechanism from the side that actually has the reference. It also costs no
 * Kotlin, no manifest permission, and it works on desktop too.
 *
 * The API needs a secure context; `http://tauri.localhost` qualifies (Chromium
 * treats `localhost` and any `.localhost` host as potentially trustworthy),
 * which is the same reason the QR scanner's `getUserMedia` works in this
 * WebView.
 *
 * ## Not a silent dependency
 *
 * Everything here degrades to "no lock" rather than throwing: an unsupported
 * browser, a denied request, and a page that is not visible all resolve to
 * `held: false`, which the caller can surface. A pairing dialog that crashed
 * because a wake lock was unavailable would be a worse bug than the one this
 * fixes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { useSyncLatestRef } from '@/hooks/useSyncLatestRef'
import { logger } from '@/lib/logger'

/**
 * The slice of the Screen Wake Lock API this hook uses.
 *
 * Declared locally rather than relying on ambient DOM lib types: the
 * `WakeLockSentinel` types are not in every TS DOM lib version, and a hook whose
 * compilation depends on the checker's DOM vintage is a build hazard.
 */
interface WakeLockSentinelLike {
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
  removeEventListener: (type: 'release', listener: () => void) => void
}

interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>
}

function getWakeLock(): WakeLockLike | null {
  if (typeof navigator === 'undefined') return null
  const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock
  return wakeLock ?? null
}

export interface ScreenWakeLockState {
  /** `true` while this hook is holding a screen wake lock. */
  held: boolean
  /**
   * `true` when the platform offers no Screen Wake Lock API at all, so no
   * amount of retrying will help. Distinct from a request that was *refused*
   * (which leaves `held: false` and `unsupported: false`) because only this
   * case is worth telling the user about.
   */
  unsupported: boolean
}

/**
 * Hold a screen wake lock while `active` is `true`.
 *
 * @param active whether the lock should be held right now.
 */
export function useScreenWakeLock(active: boolean): ScreenWakeLockState {
  const [held, setHeld] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  // The live sentinel, so the release path does not depend on React state
  // having flushed — a dialog can close in the same tick it opened.
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null)
  // The in-flight `request('screen')` promise, or `null` when none is pending.
  //
  // `sentinelRef` only becomes non-null once a request has *settled*, so it
  // cannot by itself stop a second `acquire()` — and `visibilitychange` fires
  // whenever the user swipes back to the app, which is exactly while the first
  // request is still pending. Both would then resolve, the second sentinel
  // would overwrite the first in `sentinelRef`, and the first would never be
  // released: the screen stays awake after the pairing dialog closes.
  //
  // Held as the promise rather than a boolean so the handlers can clear it only
  // when it is still *their own* request. A stale request from a previous
  // effect run resolves after the cleanup below nulled this, and must not clear
  // a newer run's pending request out from under it.
  const pendingRef = useRef<Promise<WakeLockSentinelLike> | null>(null)
  // Guards against a request that resolves after the flag already went false:
  // without it, a fast open/close leaves a lock held with nothing to release it.
  const activeRef = useRef(active)
  useSyncLatestRef(activeRef, active)

  const release = useCallback(() => {
    const sentinel = sentinelRef.current
    sentinelRef.current = null
    setHeld(false)
    if (sentinel == null) return
    void sentinel.release().catch((err: unknown) => {
      logger.warn('PairingDialog', 'screen wake lock release failed', undefined, err)
    })
  }, [])

  useEffect(() => {
    const wakeLock = getWakeLock()
    if (wakeLock == null) {
      setUnsupported(true)
      return
    }
    setUnsupported(false)

    let cancelled = false
    let onRelease: (() => void) | null = null

    const acquire = () => {
      // Already holding one, or a request is in flight for a sentinel we still
      // want — asking twice would leak the first sentinel.
      if (sentinelRef.current != null || pendingRef.current != null || !activeRef.current) return
      const pending = wakeLock.request('screen')
      pendingRef.current = pending
      const settle = () => {
        if (pendingRef.current === pending) pendingRef.current = null
      }
      void pending
        .then((sentinel) => {
          settle()
          if (cancelled || !activeRef.current) {
            // The window closed while the request was in flight.
            void sentinel.release().catch(() => {})
            return
          }
          sentinelRef.current = sentinel
          setHeld(true)
          // The platform releases the lock by itself whenever the page stops
          // being visible. Reflect that rather than reporting a lock we no
          // longer hold.
          onRelease = () => {
            if (sentinelRef.current === sentinel) {
              sentinelRef.current = null
              setHeld(false)
            }
          }
          sentinel.addEventListener('release', onRelease)
        })
        .catch((err: unknown) => {
          // Cleared on the rejection path too, otherwise one refusal would
          // wedge `pendingRef` non-null forever and no later `visibilitychange`
          // could ever retry.
          settle()
          // A refusal is not a failure worth escalating: the pair may still
          // complete if the user keeps the screen on themselves.
          logger.warn('PairingDialog', 'screen wake lock request refused', undefined, err)
          setHeld(false)
        })
    }

    acquire()

    // Re-acquire when the page comes back to the foreground. The browser
    // auto-releases on hide and does NOT restore the lock on show, so without
    // this a single app-switch mid-pair silently removes the protection —
    // which is the exact failure mode this hook exists to prevent.
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        acquire()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }

    return () => {
      cancelled = true
      // A request still in flight for THIS run can no longer produce a sentinel
      // worth keeping (its `.then` will see `cancelled` and release). Dropping
      // the reference lets the next effect run acquire immediately instead of
      // being blocked by a request whose result is already discarded.
      pendingRef.current = null
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      const sentinel = sentinelRef.current
      if (sentinel != null && onRelease != null) {
        sentinel.removeEventListener('release', onRelease)
      }
      release()
    }
  }, [active, release])

  return { held, unsupported }
}
