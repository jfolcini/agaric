import { logger } from './logger'

/**
 * Relaunch the Agaric app.
 *
 * Uses the Tauri process plugin when available (desktop + Android), which
 * restarts both the WebView and the Rust side. In browser/dev fallback mode
 * where the plugin import fails, we degrade gracefully to `window.location.reload()`
 * (which only reloads the WebView — fine for web-only dev but insufficient if
 * the error is in managed Rust state).
 */
export async function relaunchApp(): Promise<void> {
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (err) {
    logger.warn('relaunch-app', 'process plugin unavailable, reloading webview', undefined, err)
    window.location.reload()
  }
}
