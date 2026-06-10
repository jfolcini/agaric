/**
 * useAndroidBackButton — bridge the Android system back button/gesture
 * into the in-app back-chain (#716).
 *
 * Mechanism: Tauri 2's built-in Android `AppPlugin`
 * (`tauri-2.x/mobile/android/src/main/java/app/tauri/AppPlugin.kt`)
 * registers an `OnBackPressedCallback`. By default it routes back
 * presses through WebView history (`canGoBack()` — always false here,
 * the SPA never pushes history, see `url-state.ts`), so the FIRST press
 * finishes the activity. BUT: as soon as JS registers a plugin listener
 * for the `back-button` event (`addPluginListener('app', 'back-button')`
 * → `plugin:app|register_listener`, allowed by `core:app:default` ⊂
 * `core:default` in `src-tauri/capabilities/default.json`), the Kotlin
 * side forwards EVERY back press to JS instead — full app control, no
 * History-API sentinel hacks.
 *
 * Per press we walk the priority chain (`runBackChain`):
 *
 *   1. overlay open → close topmost overlay (`overlayBackHandler`)
 *   2. zoomed BlockTree → zoom out one level (registered by
 *      `useBlockZoom` at `BACK_PRIORITY_ZOOM` while zoomed)
 *   3. in-app history → page-stack `goBack()` / non-root view → journal
 *      (`navigationBackHandler`)
 *   4. nothing handled (true root: journal view, no zoom, no overlay) →
 *      exit the app via `@tauri-apps/plugin-process` `exit(0)`
 *      (`process:default` is already granted; matches the platform
 *      behavior the activity's default `finish()` had).
 *
 * Desktop / browser dev: the effect bails before touching any Tauri API
 * unless we're on Android inside a Tauri WebView — desktop behavior is
 * 100% unchanged.
 */

import { addPluginListener, type PluginListener } from '@tauri-apps/api/core'
import { exit } from '@tauri-apps/plugin-process'
import { useEffect } from 'react'

import {
  BACK_PRIORITY_NAVIGATION,
  BACK_PRIORITY_OVERLAY,
  registerBackHandler,
  runBackChain,
} from '../lib/back-chain'
import { navigationBackHandler, overlayBackHandler } from '../lib/back-handlers'
import { logger } from '../lib/logger'
import { isAndroid } from '../lib/platform'

export function useAndroidBackButton(): void {
  useEffect(() => {
    if (!isAndroid()) return
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return

    const unregisterOverlay = registerBackHandler(overlayBackHandler, BACK_PRIORITY_OVERLAY)
    const unregisterNavigation = registerBackHandler(
      navigationBackHandler,
      BACK_PRIORITY_NAVIGATION,
    )

    // `addPluginListener` is async; the effect cleanup can run before the
    // registration resolves (StrictMode double-mount, fast unmount). Track
    // disposal so the late-resolving listener unregisters itself instead
    // of leaking a Kotlin-side channel that would keep swallowing presses.
    let disposed = false
    let listener: PluginListener | null = null

    addPluginListener('app', 'back-button', () => {
      if (runBackChain()) return
      // True root — leave the app like the system default would have.
      exit(0).catch((err: unknown) => {
        logger.warn('android-back', 'exit at back-stack root failed', undefined, err)
      })
    })
      .then((l) => {
        if (disposed) {
          void l.unregister()
          return
        }
        listener = l
      })
      .catch((err: unknown) => {
        logger.warn('android-back', 'failed to register back-button listener', undefined, err)
      })

    return () => {
      disposed = true
      unregisterOverlay()
      unregisterNavigation()
      if (listener !== null) {
        void listener.unregister()
        listener = null
      }
    }
  }, [])
}
