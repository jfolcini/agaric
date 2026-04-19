/**
 * Build-time configuration constants.
 *
 * Single source of truth for values that must stay in sync with
 * `src-tauri/tauri.conf.json`. The bug-report dialog (FEAT-5) reads
 * `BUG_TRACKER` when composing the prefilled GitHub issue URL; the
 * owner/repo below must match the updater endpoint pinned in
 * `tauri.conf.json`:
 *
 *   "https://github.com/agaric-app/org-mode-for-the-rest-of-us/releases/..."
 */

export const BUG_TRACKER = {
  kind: 'github',
  owner: 'agaric-app',
  repo: 'org-mode-for-the-rest-of-us',
} as const

export type BugTrackerConfig = typeof BUG_TRACKER
