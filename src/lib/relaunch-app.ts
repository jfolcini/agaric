import { relaunch } from '@tauri-apps/plugin-process'

import { logger } from './logger'

/**
 * Relaunch the Agaric app.
 *
 * Uses the Tauri process plugin when available (desktop + Android), which
 * restarts both the WebView and the Rust side. In browser/dev fallback mode
 * where the `relaunch()` call has no Tauri backend, we degrade gracefully to
 * `window.location.reload()` (which only reloads the WebView — fine for
 * web-only dev but insufficient if the error is in managed Rust state).
 *
 * `relaunch` is imported statically (not `await import(...)`) because
 * `useUpdateCheck` already pulls `@tauri-apps/plugin-process` into the entry
 * chunk on purpose (pre-fetching the relaunch path so an install can't fail
 * mid-flight). A dynamic import here is therefore ineffective — Rolldown
 * can't move an already-statically-imported module into a separate chunk —
 * and emitted an `INEFFECTIVE_DYNAMIC_IMPORT` build warning. The module is
 * pure JS that loads everywhere; only the `relaunch()` *call* needs Tauri,
 * and the `try`/`catch` below still degrades gracefully without it.
 */
export async function relaunchApp(): Promise<void> {
  try {
    await relaunch()
  } catch (err) {
    logger.warn('relaunch-app', 'process plugin unavailable, reloading webview', undefined, err)
    window.location.reload()
  }
}
