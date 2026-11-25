/**
 * Quick-capture global-shortcut storage helpers.
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

import { isMac } from '@/lib/platform'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'

/** localStorage key under which the user's chosen chord is persisted. */
export const QUICK_CAPTURE_SHORTCUT_STORAGE_KEY = PREFERENCES.quickCaptureShortcut.key

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
  const stored = readPreference(PREFERENCES.quickCaptureShortcut)
  return stored.trim().length > 0 ? stored : defaultQuickCaptureShortcut()
}

/**
 * An accelerator in the plugin's format (`Ctrl+Alt+N`, `Cmd+Alt+N`,
 * `CommandOrControl+Space`) as the catalog's `Ctrl + Alt + N`, which `Kbd`
 * draws. `Cmd` and `CommandOrControl` become the catalog's mod key `Ctrl`
 * (⌘ on macOS); the plugin's `Ctrl` is the Control key, which on macOS is
 * `Control` (⌃), not the mod key; `Option` becomes `Alt`.
 */
const MOD_KEY_NAMES = new Set(['Cmd', 'Command', 'CommandOrControl', 'CmdOrCtrl', 'CmdOrControl'])

export function acceleratorToKeys(accelerator: string): string {
  const mac = isMac()
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .map((part) => {
      if (MOD_KEY_NAMES.has(part)) return 'Ctrl'
      if (part === 'Ctrl' || part === 'Control') return mac ? 'Control' : 'Ctrl'
      return part === 'Option' ? 'Alt' : part
    })
    .join(' + ')
}

/**
 * Persist `shortcut` under the canonical localStorage key. Silently
 * tolerates a missing / disabled `localStorage` so the in-memory
 * registration path still works in private-mode browsers.
 */
export function saveQuickCaptureShortcut(shortcut: string): void {
  if (typeof window === 'undefined') return
  writePreference(PREFERENCES.quickCaptureShortcut, shortcut)
}
