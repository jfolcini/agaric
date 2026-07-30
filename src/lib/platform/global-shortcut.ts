import { isMobilePlatform } from '@/lib/platform'

// The global-shortcut JS API below is gated on `isMobilePlatform()`
// (a CAPABILITY check, exported from `./index`) rather than `useIsMobile`
// (a width breakpoint). `tauri-plugin-global-shortcut` is desktop-only — its
// native dependency (`global-hotkey` crate) compiles only on
// Linux/macOS/Windows, and the Rust-side registration in
// `src-tauri/src/lib.rs` is gated behind `#[cfg(desktop)]`. Calling the
// underlying `invoke('plugin:…')` on Android / iOS would throw at runtime, so
// we guard at the wrapper boundary and return a no-op promise on mobile.

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
