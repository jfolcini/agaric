import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { BlockRow, SpaceRow, StatusInfo } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { isMobilePlatform } from '@/lib/platform'

/** Get materializer queue status and metrics. */
export async function getStatus(): Promise<StatusInfo> {
  return unwrap(await commands.getStatus())
}

/**
 * List every space (id + display name) alphabetical by name. Used by the
 * sidebar `SpaceSwitcher` + the Zustand `useSpaceStore`.
 */
export async function listSpaces(): Promise<SpaceRow[]> {
  return unwrap(await commands.listSpaces())
}

/**
 * Create a new page block and atomically assign it to `spaceId`.
 *
 * Phase 2 — the backend wraps both the `CreateBlock` op and the
 * `SetProperty(space = <spaceId>)` op in a single transaction so a page
 * never exists without its space property. Callers that create
 * top-level pages (PageBrowser new-page, App new-page actions, the
 * link-picker create-new-page affordance) must route through this
 * command rather than `createBlock({ blockType: 'page' })` — the latter
 * leaves the new page unscoped and violates the "nothing outside of
 * spaces" invariant.
 *
 * Returns the new page's ULID.
 */
export async function createPageInSpace(params: {
  parentId?: string | null | undefined
  content: string
  spaceId: string
}): Promise<string> {
  return unwrap(
    await commands.createPageInSpace(params.parentId ?? null, params.content, params.spaceId),
  )
}

/**
 * Create a new space (a top-level page block flagged
 * `is_space = 'true'`).
 *
 * Phase 6 — the backend wraps the `CreateBlock` op, the
 * `SetProperty(is_space = "true")` op, and the optional
 * `SetProperty(accent_color = …)` op in a single transaction so a
 * partial failure never leaves a half-created space (a page block
 * without its `is_space` flag) in the op log.
 *
 * `accentColor` accepts the palette tokens consumed by
 * (e.g. `accent-violet`, `accent-blue`, …). Pass `null` / `undefined`
 * to skip the accent-color property entirely.
 *
 * Returns the new space's ULID.
 */
export async function createSpace(params: {
  name: string
  accentColor?: string | null | undefined
}): Promise<string> {
  return unwrap(await commands.createSpace(params.name, params.accentColor ?? null))
}

// ---------------------------------------------------------------------------
// Quick capture
// ---------------------------------------------------------------------------

// The global-shortcut JS API below is gated on `isMobilePlatform()`
// (a CAPABILITY check, exported from `./platform`) rather than `useIsMobile`
// (a width breakpoint). `tauri-plugin-global-shortcut` is desktop-only — its
// native dependency (`global-hotkey` crate) compiles only on
// Linux/macOS/Windows, and the Rust-side registration in
// `src-tauri/src/lib.rs` is gated behind `#[cfg(desktop)]`. Calling the
// underlying `invoke('plugin:…')` on Android / iOS would throw at runtime, so
// we guard at the wrapper boundary and return a no-op promise on mobile.

/**
 * + drop a single content block onto today's journal
 * page in the active space.
 *
 * Resolves today's journal page in `spaceId` on the backend (creating it
 * if missing) and appends a content block as a child. Used by the
 * global-shortcut quick-capture flow (`QuickCaptureDialog` →
 * `quickCaptureBlock`). The space scoping is required: every journal
 * page belongs to a space, so two devices in different spaces capture
 * into their own daily notes without colliding.
 */
export async function quickCaptureBlock(content: string, spaceId: string): Promise<BlockRow> {
  return unwrap(await commands.quickCaptureBlock(content, spaceId))
}

/**
 * Register a global hotkey via `@tauri-apps/plugin-global-shortcut`.
 *
 * `accelerator` is the chord string (`'CommandOrControl+Alt+N'`) that the
 * plugin recognises. `callback` fires once per press (we filter on
 * `state === 'Pressed'` so users don't get double-fires on key release).
 *
 * **Desktop-only** — on mobile this resolves immediately without
 * registering anything. The plugin's underlying `global-hotkey` crate
 * does not compile for Android / iOS targets, and registration is
 * `#[cfg(desktop)]`-gated in `src-tauri/src/lib.rs`. Throws on the
 * desktop side if the chord conflicts with another app's binding —
 * callers should surface that as a user-visible toast.
 */
export async function registerGlobalShortcut(
  accelerator: string,
  callback: () => void,
): Promise<void> {
  if (isMobilePlatform()) return
  const { register } = await import('@tauri-apps/plugin-global-shortcut')
  await register(accelerator, (event) => {
    // The plugin emits both `Pressed` and `Released` — fire the user
    // callback once per logical activation only.
    if (event.state === 'Pressed') callback()
  })
}

/**
 * Unregister a previously-registered global hotkey.
 *
 * Desktop-only; a no-op on mobile (matches `registerGlobalShortcut`).
 * Safe to call when the chord was never registered — the underlying
 * plugin throws in that case, which we let propagate so callers can
 * decide whether to log or swallow.
 */
export async function unregisterGlobalShortcut(accelerator: string): Promise<void> {
  if (isMobilePlatform()) return
  const { unregister } = await import('@tauri-apps/plugin-global-shortcut')
  await unregister(accelerator)
}

/**
 * Probe whether `accelerator` is currently registered by *this*
 * application. Returns `false` for both "not registered by us" and
 * "registered by another app" cases — the plugin can't distinguish OS-
 * level conflicts from a clean unbound state.
 *
 * Desktop-only; resolves to `false` on mobile.
 */
export async function isGlobalShortcutRegistered(accelerator: string): Promise<boolean> {
  if (isMobilePlatform()) return false
  const { isRegistered } = await import('@tauri-apps/plugin-global-shortcut')
  return isRegistered(accelerator)
}

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
