/**
 * Build-time configuration constants.
 *
 * Single source of truth for values that must stay in sync with
 * `src-tauri/tauri.conf.json`. The bug-report dialog (FEAT-5) reads
 * `BUG_TRACKER` when composing the prefilled GitHub issue URL; the
 * owner/repo below must match the updater endpoint pinned in
 * `tauri.conf.json`:
 *
 *   "https://github.com/jfolcini/agaric/releases/..."
 */

export const BUG_TRACKER = {
  kind: 'github',
  owner: 'jfolcini',
  repo: 'agaric',
} as const
