import { logger } from '@/lib/logger'

// ---------------------------------------------------------------------------
// Deep-link plugin wrappers
// ---------------------------------------------------------------------------
//
// `@tauri-apps/plugin-deep-link` exposes `getCurrent()` which returns the
// URL(s) the OS used to launch the app (Linux / Windows / Android), or
// `null` when the app was started normally.  Used by `useDeepLinkRouter`
// on mount to backfill any deep-link the listener missed before
// registration completed (Linux / Windows deliver the URL as a CLI arg
// before the React tree mounts).  Dynamic-import keeps a plain-browser
// dev session without `__TAURI_INTERNALS__` resolving cleanly.

/**
 * Return the URL(s) the OS used to open Agaric, or `null` if the app
 * was launched normally (no deep link).  Resolves to `null` when the
 * plugin is unavailable so callers can treat "no current URL" and
 * "plugin missing" the same way (the listener still fires on
 * subsequent activations).
 */
export async function getCurrentDeepLink(): Promise<string[] | null> {
  try {
    const { getCurrent } = await import('@tauri-apps/plugin-deep-link')
    return await getCurrent()
  } catch (err) {
    logger.warn('deeplink', 'getCurrent() failed or plugin unavailable', undefined, err)
    return null
  }
}
