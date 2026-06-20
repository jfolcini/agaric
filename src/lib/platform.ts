/**
 * Platform detection helpers (bundled fix).
 *
 * These utilities abstract platform-specific UI decisions — currently the
 * keyboard-modifier label shown in shortcut help / tooltips. macOS users
 * expect ⌘/Cmd where other platforms use Ctrl, even though our
 * `matchesShortcutBinding` matcher already accepts both `ctrlKey` and
 * `metaKey`.
 *
 * Detection preference: `navigator.userAgentData.platform` when available
 * (Chromium 90+), falling back to `navigator.platform`. The result is
 * cached on first read because platform can't change at runtime.
 */

let cachedIsMac: boolean | null = null
let cachedIsAndroid: boolean | null = null

interface NavigatorUAData {
  platform?: string
}

/** Returns true on macOS / iOS-Mac-Catalyst. Cached after first call. */
export function isMac(): boolean {
  if (cachedIsMac !== null) return cachedIsMac
  if (typeof navigator === 'undefined') {
    cachedIsMac = false
    return cachedIsMac
  }
  // `userAgentData.platform` is preferred (UA-CH, not privacy-gated).
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData
  const platformStr =
    (uaData?.platform ?? '').toLowerCase() || (navigator.platform ?? '').toLowerCase()
  cachedIsMac = platformStr.includes('mac')
  return cachedIsMac
}

/**
 * Returns the user-facing label for the primary shortcut-modifier key:
 * `⌘` on macOS, `Ctrl` elsewhere. Use inside `renderKeys`-style display
 * paths and tooltips. Stored shortcut binding strings in
 * `keyboard-config.ts` remain `Ctrl + …` so settings export/import stays
 * portable across devices.
 */
export function modKey(): string {
  return isMac() ? '\u2318' : 'Ctrl'
}

/**
 * Returns true when running on Android (Tauri Android WebView or a mobile
 * browser). UA-sniff based — mirrors the coarse mobile detection in
 * `tauri.ts` / `useUpdateCheck.ts` but narrowed to Android only, because
 * the system back button (#716) is an Android-only navigation concept.
 * Cached after first call (platform can't change at runtime).
 */
export function isAndroid(): boolean {
  if (cachedIsAndroid !== null) return cachedIsAndroid
  if (typeof navigator === 'undefined') {
    cachedIsAndroid = false
    return cachedIsAndroid
  }
  cachedIsAndroid = /android/i.test(navigator.userAgent ?? '')
  return cachedIsAndroid
}

/**
 * Returns true on a mobile platform (Android / iOS) via a coarse
 * user-agent sniff. This is a CAPABILITY check — "can this device run the
 * desktop-only Tauri plugins?" — and is deliberately distinct from the
 * width-based layout breakpoint in `useIsMobile` (which answers "is the
 * viewport narrow?"). An Android tablet ≥ 768 px is `isMobilePlatform()`
 * === true but `useIsMobile()` === false.
 *
 * Use this to gate capability-dependent SETTINGS — e.g. the global-
 * shortcut JS API (`registerGlobalShortcut`), the Tauri updater
 * (`useUpdateCheck`), and the desktop-only Quick Capture chord row — so
 * the gate matches the platform the underlying native plugin compiles
 * for, not the current window size.
 *
 * Intentionally NOT cached: callers (and tests) may need it to re-read a
 * mutated `navigator.userAgent` per call, mirroring the three former
 * inline copies it replaced.
 */
export function isMobilePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent ?? ''
  return /Android|iPhone|iPad|iPod/i.test(ua)
}

/** Test-only reset hook — lets tests swap `navigator.platform` between runs. */
export function __resetPlatformCacheForTests(): void {
  cachedIsMac = null
  cachedIsAndroid = null
}
