/**
 * Path history — per-space MRU of `path:` / `not-path:` glob strings.
 *
 * Backs the caret-anchored autocomplete popover (Phase 2): when the
 * user types `path:` or `not-path:` in the search input we surface their
 * recently-used globs for that space, newest-first.
 */

import { getKeyedPref, PREFS, removeKeyedPref, setKeyedPref } from './preferences'

export const PATH_HISTORY_LIMIT = 30

function readRaw(spaceId: string): string[] {
  return getKeyedPref(PREFS.pathHistory, spaceId)
}

export function getPathHistory(spaceId: string | null): string[] {
  if (!spaceId) return []
  return readRaw(spaceId)
}

/**
 * Returns true if `glob` looks like a deliberate path glob rather than
 * a half-typed accident. Used to gate `recordPathHistory` so submits
 * with single-character or punctuation-only path tokens don't pollute
 * the per-space MRU.
 *
 * The rule is intentionally lenient: at least 2 characters AND either
 * contains a `/` (directory hint) or a wildcard (`*`, `?`, `[`, `{`).
 * Bare-word globs like `Journal` still qualify because typing
 * `path:Journal` is wrapped by the backend to a `*Journal*` substring
 * match — they're genuine queries, not junk.
 */
function isMeaningfulGlob(glob: string): boolean {
  if (glob.length < 2) return false
  return /[/*?[{]/.test(glob) || /[A-Za-z0-9]{2}/.test(glob)
}

export function recordPathHistory(spaceId: string | null, glob: string): void {
  if (!spaceId) return
  const trimmed = glob.trim()
  if (!trimmed) return
  if (!isMeaningfulGlob(trimmed)) return
  const existing = readRaw(spaceId).filter((g) => g !== trimmed)
  existing.unshift(trimmed)
  if (existing.length > PATH_HISTORY_LIMIT) existing.length = PATH_HISTORY_LIMIT
  // Storage-unavailable write failures (private mode, quota exceeded) are
  // logged and swallowed by setKeyedPref.
  setKeyedPref(PREFS.pathHistory, existing, spaceId)
}

export function clearPathHistory(spaceId: string | null): void {
  if (!spaceId) return
  removeKeyedPref(PREFS.pathHistory, spaceId)
}
