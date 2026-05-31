/**
 * Editor preferences read live (synchronously) by editor extensions, kept in
 * localStorage so they're shared between the Settings UI and every mounted
 * editor without a store/prop dependency. The Settings toggle writes the key
 * (via `useLocalStoragePreference`); the editor reads it on demand — so a
 * change takes effect on the next keystroke, no editor remount needed.
 */

/** Inline `:` emoji picker enable/disable (#130). Default: enabled. */
export const EMOJI_PICKER_ENABLED_KEY = 'agaric-emoji-picker-enabled'

/**
 * Whether the inline `:` emoji picker is enabled. Defaults to `true` (absent
 * key) and on any read/parse failure, so the feature is on unless the user
 * has explicitly turned it off.
 */
export function isEmojiPickerEnabled(): boolean {
  try {
    const raw = localStorage.getItem(EMOJI_PICKER_ENABLED_KEY)
    return raw === null ? true : (JSON.parse(raw) as boolean) !== false
  } catch {
    return true
  }
}
