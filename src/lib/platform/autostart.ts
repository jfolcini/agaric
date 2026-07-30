import { logger } from '@/lib/logger'

// ---------------------------------------------------------------------------
// Autostart — launch-on-login support
// ---------------------------------------------------------------------------
//
// Thin wrappers around `@tauri-apps/plugin-autostart`'s three exports
// (`enable`, `disable`, `isEnabled`).  Desktop-only — the Rust side
// Gates registration with `#[cfg(desktop)]` (see lib.rs block),
// so on Android / iOS the underlying IPC will reject with "command not
// found".  Each wrapper uses a dynamic `import(...)` (matching the
// `clipboard.ts` / `relaunch-app.ts` pattern) so a plain-browser dev
// session without `__TAURI_INTERNALS__` can still resolve the module
// and surface a clean error to the caller's catch block (no module-load
// crash at app boot).
//
// Errors are propagated to the caller — the Settings UI uses the
// rejection both to (a) hide the toggle row when the plugin / IPC is
// unavailable and (b) surface a `toast.error` when a user-initiated
// enable / disable round-trip fails.

/**
 * Return whether Agaric is currently registered to launch on login.
 *
 * Rejects when the plugin is unavailable (mobile build, browser dev
 * fallback, IPC denied).  Callers that need a tri-state (enabled /
 * disabled / unavailable) view should treat the rejection as the third
 * state — see `SettingsView`'s general-tab autostart row.
 */
export async function isAutostartEnabled(): Promise<boolean> {
  const { isEnabled } = await import('@tauri-apps/plugin-autostart')
  return isEnabled()
}

/**
 * Register Agaric to launch when the user signs into their computer.
 *
 * Rejects when the plugin is unavailable; the `SettingsView` toggle
 * surfaces the failure via `toast.error(t('settings.autostart.toggleFailed'))`
 * and reverts the optimistic UI update.
 */
export async function enableAutostart(): Promise<void> {
  try {
    const { enable } = await import('@tauri-apps/plugin-autostart')
    await enable()
  } catch (err) {
    logger.warn('autostart', 'enable() failed or plugin unavailable', undefined, err)
    throw err
  }
}

/**
 * Unregister Agaric from launching at login.
 *
 * Same error semantics as `enableAutostart` — the rejection is the
 * caller's signal to revert its optimistic UI update and surface
 * `t('settings.autostart.toggleFailed')`.
 */
export async function disableAutostart(): Promise<void> {
  try {
    const { disable } = await import('@tauri-apps/plugin-autostart')
    await disable()
  } catch (err) {
    logger.warn('autostart', 'disable() failed or plugin unavailable', undefined, err)
    throw err
  }
}
