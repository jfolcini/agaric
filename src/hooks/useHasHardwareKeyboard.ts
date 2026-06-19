/**
 * useHasHardwareKeyboard — sticky-true probe for a hardware keyboard.
 *
 * Returns `false` until the FIRST signal that a hardware keyboard is
 * present, then `true` for the rest of the session. Two signals OR-
 * combined (per PEND-68):
 *
 *   1. `navigator.keyboard.getLayoutMap()` — Chromium-only; resolves
 *      when a keyboard layout is exposed → keyboard is present. Safari
 *      and Firefox fall through to signal 2 silently. We DO NOT prompt
 *      for permissions; the API call is a best-effort probe.
 *   2. First non-modifier `keydown` at `document` — universal fallback.
 *      Once it fires, install removes itself; we trust the user has a
 *      keyboard for the rest of the session.
 *
 * Sticky-true. We deliberately do NOT flip back to `false` on
 * inactivity. A Bluetooth-keyboard user who briefly disconnects then
 * types again would otherwise lose the desktop UI mid-session — jarring
 * and unhelpful.
 *
 * Pure-touch iPad (no Bluetooth keyboard ever attached) never fires a
 * keydown, so the hook stays `false` forever — exactly what
 * `useShouldShowMobileChrome` needs to keep the mobile sheet trigger
 * mounted on that device.
 */

import { useEffect, useState } from 'react'

/**
 * Module-level latch shared across all consumers in the session. Once
 * any consumer's effect detects a keyboard, every later mount of the
 * hook reads `true` synchronously on first render — no flicker between
 * "checking" and "yes" if the user opens a second surface that calls
 * the hook.
 */
let sessionLatch = false
const latchListeners = new Set<() => void>()

function setLatch() {
  if (sessionLatch) return
  sessionLatch = true
  for (const listener of latchListeners) listener()
}

export function useHasHardwareKeyboard(): boolean {
  const [hasKeyboard, setHasKeyboard] = useState<boolean>(sessionLatch)

  useEffect(() => {
    if (sessionLatch) {
      setHasKeyboard(true)
      return
    }

    const notify = () => setHasKeyboard(true)
    latchListeners.add(notify)

    // Signal 1 — `navigator.keyboard.getLayoutMap()`. Chromium-only;
    // Safari and Firefox return `undefined` for `navigator.keyboard`.
    // The Promise rejecting (permissions denied / not implemented) is
    // not a signal in either direction — fall through to signal 2.
    const nav = navigator as Navigator & {
      keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> }
    }
    if (typeof nav.keyboard?.getLayoutMap === 'function') {
      nav.keyboard.getLayoutMap().then(
        (map) => {
          if (map.size > 0) setLatch()
        },
        () => {
          // Permission denied / not supported. No-op; signal 2 will
          // catch the first real keydown.
        },
      )
    }

    // Signal 2 — first non-modifier keydown anywhere in the document.
    // Modifier-only keypresses (pure Shift / Ctrl / Alt / Meta presses
    // with no following keystroke) don't count — a touch user can
    // briefly tap a physical modifier on an attached-but-passive
    // accessory and we should not treat that as "fully attached".
    //
    // Soft-keyboard / synthetic keydowns must NOT latch either. On
    // Android/iOS WebViews the on-screen keyboard can emit real keydown
    // events; in the 768–1024px tablet band a stray latch would demote
    // the surface out of mobile chrome mid-session. We reject events
    // that are not browser-trusted (`isTrusted === false`), IME/soft
    // composition events (`keyCode === 229`), and the soft-keyboard
    // `key === 'Unidentified'` sentinel. Only a genuine hardware
    // keydown sets the latch.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
        return
      }
      if (e.isTrusted === false || e.keyCode === 229 || e.key === 'Unidentified') {
        return
      }
      setLatch()
      document.removeEventListener('keydown', onKeyDown, true)
    }
    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      latchListeners.delete(notify)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  return hasKeyboard
}

/**
 * Test-only: reset the module-level latch + listener set. Tests that
 * exercise the "first keydown flips the flag" path need a clean session
 * each run; expose a reset rather than coupling tests to module
 * internals.
 */
export function _resetHardwareKeyboardLatchForTests(): void {
  sessionLatch = false
  latchListeners.clear()
}
