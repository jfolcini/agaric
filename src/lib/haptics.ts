/**
 * haptics — tiny feature-detected wrapper around the Vibration API.
 *
 * `navigator.vibrate` is present on Android Chrome / WebView (the only
 * place Agaric's mobile haptics matter) and absent on desktop and iOS
 * Safari/WKWebView. We feature-detect once per call and no-op when the
 * API is missing so call sites never have to guard — a desktop session
 * and a jsdom test both silently do nothing.
 *
 * #137 — fired on a handful of mobile-search interactions (scope pin,
 * voice-input start, sheet pull-to-dismiss). Kept intentionally small:
 * one named-pattern vocabulary so every consumer speaks the same
 * language and the feel stays consistent.
 *
 * The patterns are deliberately short. A long buzz reads as an error /
 * notification on most devices; these are confirmations, so they sit at
 * the "subtle tick" end (≤ 20 ms) — matching the platform convention
 * for selection feedback.
 */

/** Named haptic patterns. Values are `navigator.vibrate` arguments (ms). */
const PATTERNS = {
  /** A single subtle tick — a discrete action landed (scope pin, voice start). */
  tick: 10,
  /** A slightly firmer confirmation — a surface was dismissed. */
  dismiss: 15,
} as const

export type HapticPattern = keyof typeof PATTERNS

/**
 * Fire a haptic pulse if the platform supports it.
 *
 * No-ops (and never throws) when `navigator.vibrate` is unavailable —
 * desktop, iOS, jsdom/happy-dom. Some platforms throw `NotAllowedError`
 * when vibrate is called outside a user gesture; we swallow that too so
 * a stray call can never bubble into the UI.
 */
export function haptic(pattern: HapticPattern = 'tick'): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(PATTERNS[pattern])
  } catch {
    // Vibration outside a user gesture, or a hostile UA — best-effort.
  }
}
