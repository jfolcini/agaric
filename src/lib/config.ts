/**
 * Build-time configuration constants.
 *
 * Single source of truth for values that must stay in sync with
 * `src-tauri/tauri.conf.json`. The bug-report dialog reads
 * `BUG_TRACKER` when composing the prefilled GitHub issue URL; the
 * owner/repo below must match the updater endpoint pinned in
 * `tauri.conf.json`:
 *
 *   "https://github.com/jfolcini/agaric/releases/..."
 */

/** Where an Android install gets the newest APK; the phone has no updater (#6538). */
export const RELEASES_URL = 'https://github.com/jfolcini/agaric/releases/latest'

/** The custom CSS help and its versioned token list (#6558). */
export const CUSTOM_CSS_DOCS_URL =
  'https://github.com/jfolcini/agaric/blob/main/docs/features/appearance.md#custom-css'

export const BUG_TRACKER = {
  kind: 'github',
  owner: 'jfolcini',
  repo: 'agaric',
} as const
