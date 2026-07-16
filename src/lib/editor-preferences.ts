/**
 * Editor preferences read live (synchronously) by editor extensions, kept in
 * localStorage so they're shared between the Settings UI and every mounted
 * editor without a store/prop dependency. The Settings toggle writes the key
 * (via `useLocalStoragePreference`); the editor reads it on demand — so a
 * change takes effect on the next keystroke, no editor remount needed.
 *
 * (#2666) These non-hook getters are intentionally NOT the reactive
 * `usePreference` path: they are documented thin read-on-demand views over
 * the same registry keys, because editor extensions run outside React and
 * always want the freshest value at keystroke time.
 */

import { PREFERENCES, readPreference } from '@/lib/preferences'

/** Inline `:` emoji picker enable/disable (#130). Default: enabled. */
export const EMOJI_PICKER_ENABLED_KEY = PREFERENCES.emojiPickerEnabled.key

/**
 * Whether the inline `:` emoji picker is enabled. Defaults to `true` (absent
 * key) and on any read/parse failure, so the feature is on unless the user
 * has explicitly turned it off.
 */
export function isEmojiPickerEnabled(): boolean {
  return readPreference(PREFERENCES.emojiPickerEnabled)
}

/**
 * Whether Tab / Shift+Tab indent and dedent blocks (#912). Default: enabled —
 * the universal outliner behaviour (Logseq/Notion/Workflowy).
 *
 * This is the accessibility opt-out: a keyboard-only or screen-reader user who
 * relies on Tab for focus traversal can turn it OFF, restoring Tab as the
 * browser's focus-navigation key (block indent/dedent then remains available
 * on `Ctrl/Cmd+Shift+Arrow`). Per WCAG 2.1.2, even with Tab-indent ON the
 * editor is never a keyboard trap: Escape exits the block (focus returns to the
 * document), so Tab can move focus away again.
 */
export const TAB_INDENTS_BLOCKS_KEY = PREFERENCES.tabIndentsBlocks.key

/**
 * Whether Tab/Shift+Tab indent blocks. Defaults to `true` (absent key) and on
 * any read/parse failure, so the outliner behaviour is on unless the user has
 * explicitly turned it off for accessibility.
 */
export function isTabIndentEnabled(): boolean {
  return readPreference(PREFERENCES.tabIndentsBlocks)
}
