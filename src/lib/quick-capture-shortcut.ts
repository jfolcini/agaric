/**
 * FEAT-12 — Quick-capture global-shortcut storage helpers.
 *
 * The user-configured chord lives in `localStorage` under
 * `agaric:quickCaptureShortcut`. Reads are SSR-safe (`typeof window`
 * guard) and corruption-tolerant (try/catch around `getItem`). The
 * default chord is platform-specific:
 *
 *   - macOS:        Cmd + Option + N
 *   - Linux/Windows: Ctrl + Alt + N
 *
 * Strings use the `tauri-plugin-global-shortcut` accelerator format —
 * `'CommandOrControl+Alt+N'` is the cross-platform spelling that the
 * plugin maps to the native modifier on each OS, but we keep the two
 * variants split out for users who explicitly customize per device.
 */

import { isMac } from './platform'

/** localStorage key under which the user's chosen chord is persisted. */
export const QUICK_CAPTURE_SHORTCUT_STORAGE_KEY = 'agaric:quickCaptureShortcut'

/**
 * Default global-shortcut accelerator for the quick-capture flow.
 *
 *   - macOS uses Option (Alt on the keymap) + Cmd as the multi-modifier
 *     convention — matches Apple's HIG ("⌘⌥N") and the popular Logseq /
 *     Obsidian quick-capture shortcuts.
 *   - Other desktop OSes default to Ctrl + Alt + N which avoids the
 *     ubiquitous Ctrl+N "new document" convention while staying within
 *     three-finger reach.
 */
export function defaultQuickCaptureShortcut(): string {
  return isMac() ? 'Cmd+Alt+N' : 'Ctrl+Alt+N'
}

/**
 * Read the user-configured chord from localStorage, falling back to
 * [`defaultQuickCaptureShortcut`] when the key is unset, the value is
 * empty, or the storage API is unavailable (SSR / corrupted profile).
 */
export function loadQuickCaptureShortcut(): string {
  if (typeof window === 'undefined') return defaultQuickCaptureShortcut()
  try {
    const stored = window.localStorage.getItem(QUICK_CAPTURE_SHORTCUT_STORAGE_KEY)
    if (stored != null && stored.trim().length > 0) return stored
  } catch {
    // localStorage unavailable (Safari private mode, sandboxed iframe).
  }
  return defaultQuickCaptureShortcut()
}

/**
 * Persist `shortcut` under the canonical localStorage key. Silently
 * tolerates a missing / disabled `localStorage` so the in-memory
 * registration path still works in private-mode browsers.
 */
export function saveQuickCaptureShortcut(shortcut: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(QUICK_CAPTURE_SHORTCUT_STORAGE_KEY, shortcut)
  } catch {
    // localStorage unavailable — registration in-memory still works.
  }
}
