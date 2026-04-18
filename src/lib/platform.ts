/**
 * Platform detection helpers (UX-223 / BUG-31 bundled fix).
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

/** Test-only reset hook — lets tests swap `navigator.platform` between runs. */
export function __resetPlatformCacheForTests(): void {
  cachedIsMac = null
}
