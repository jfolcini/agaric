/**
 * Native -> web hand-over of text another Android app shared into Agaric
 * (#6555).
 *
 * `MainActivity` keeps the text of a `text/plain` `ACTION_SEND` intent and
 * exposes it through `AgaricShareBridge`, an object bound to the webview with
 * `addJavascriptInterface` as `AgaricThemeBridge` is. The web layer pulls it:
 * the activity cannot push it into the document, because an intent that starts
 * the app arrives before the document has loaded (#4301).
 */

import { logger } from '@/lib/logger'

export interface AndroidShareBridge {
  /** The shared text, or `null`; reading it clears it on the native side. */
  takePendingText: () => string | null
}

declare global {
  interface Window {
    /** Present only inside the Android wry webview; see module doc. */
    AgaricShareBridge?: AndroidShareBridge
  }
}

/**
 * The text another app shared, once: a second call returns `null` until the
 * next share. `null` too off Android, and when the bridge throws.
 */
export function takePendingSharedText(): string | null {
  const bridge = window.AgaricShareBridge
  if (bridge == null) return null
  try {
    return bridge.takePendingText() || null
  } catch (err) {
    logger.warn('share', 'reading the text shared from another app failed', undefined, err)
    return null
  }
}
