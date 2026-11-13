/**
 * useAndroidShareTarget — text shared from another Android app opens Quick
 * Capture holding it (#6555), as an `agaric://capture?text=` link does: the
 * user still presses Capture.
 *
 * The text is read when the app mounts (a share that started the app) and
 * each time the page becomes visible (a share into the running app: Android
 * pauses the activity before it delivers the intent and resumes it after).
 * A no-op where there is no `AgaricShareBridge`.
 *
 * Call it after `useAppDialogs`, whose listener opens the dialog.
 */

import { useEffect } from 'react'

import { capturePayloadForText, handleCapturePayload } from '@/hooks/useDeepLinkRouter'
import { takePendingSharedText } from '@/lib/platform/android-share-bridge'

export function useAndroidShareTarget(): void {
  useEffect(() => {
    const openSharedText = (): void => {
      const text = takePendingSharedText()
      if (text != null) handleCapturePayload(capturePayloadForText(text))
    }
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') openSharedText()
    }
    openSharedText()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])
}
