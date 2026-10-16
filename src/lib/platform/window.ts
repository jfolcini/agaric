import { logger } from '@/lib/logger'
import { isMobilePlatform } from '@/lib/platform'

// ---------------------------------------------------------------------------
// Window title — visual-identity surface
// ---------------------------------------------------------------------------
//
// Wrapper around `@tauri-apps/api/window`'s
// `getCurrentWindow().setTitle(title)`. Used by the App-level effect
// that runs on every space change to re-stamp the OS window title as
// `"<SpaceName> · Agaric"` so the user gets a glance-able cue from the
// taskbar, the OS notification centre, and the macOS window menu.
//
// No-op fallback for non-Tauri runtimes (vitest jsdom, storybook,
// plain-browser dev sessions) so callers don't need to gate every
// `setWindowTitle(...)` call on `__TAURI_INTERNALS__` themselves. The
// dynamic import + try/catch matches the `getCurrentDeepLink` /
// `enableAutostart` pattern.

/**
 * Set the OS window title to `title`. No-op when the Tauri window
 * plugin is unavailable (jsdom, storybook, browser dev fallback).
 *
 * Failures are logged at warn level via the shared logger and
 * swallowed — a stale window title is not user-fatal and the next
 * space switch will retry.
 */
export async function setWindowTitle(title: string): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setTitle(title)
  } catch (err) {
    logger.warn('window', 'setTitle() failed or window plugin unavailable', { title }, err)
  }
}

// One shared import, so two quick zoom steps resume in the order they were
// made; separate `import()` calls can resolve out of order and leave the
// webview at the older level.
let webviewApi: Promise<typeof import('@tauri-apps/api/webview')> | undefined

/**
 * Set the webview's page zoom, where `1` is 100% (#5646). Page zoom reflows the
 * layout to the narrower width, as a browser's Ctrl+= does. Desktop only: Tauri
 * registers `set_webview_zoom` behind `#[cfg(desktop)]`, so mobile never calls it.
 * A failure is logged; the zoom just stays where it was.
 */
export async function setWebviewZoom(factor: number): Promise<void> {
  if (isMobilePlatform()) return
  try {
    webviewApi ??= import('@tauri-apps/api/webview')
    const { getCurrentWebview } = await webviewApi
    await getCurrentWebview().setZoom(factor)
  } catch (err) {
    logger.warn('window', 'setZoom() failed or webview API unavailable', { factor }, err)
  }
}
