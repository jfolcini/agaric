/**
 * useFailedOnce — surface a transient IPC failure once per session per
 * surface, then go quiet.
 *
 * Background. The search surfaces (palette, panel, autocomplete) each
 * fire IPCs on every keystroke. Real (non-cancellation) failures are
 * RARE — SQLite/FTS would have to hit an actual fault mid-query — but
 * when they happen, the user gets zero feedback: the catch sites
 * `logger.warn` and otherwise sit silent. Toasting on
 * EVERY failure is the obvious-wrong fix because a transient fault
 * (e.g. the DB pool saturating during a backup) would spam the user
 * with a toast per keystroke.
 *
 * Compromise. Surface the toast once per surface (palette / panel /
 * autocomplete) per browser session. The user gets the signal
 * without the spam; logs still capture every failure for debugging.
 *
 * Implementation. A module-level `Set<string>` tracks the surfaces
 * that have already surfaced a toast in this session. The hook
 * returns a `tryNotify(key, run)` predicate that fires `run` iff `key`
 * hasn't already been recorded. Identity is by key string so two
 * effect re-mounts on the same surface share the same gate. The Set
 * is intentionally NOT persisted — a real page reload (different
 * session) earns a fresh toast.
 */

import { useCallback } from 'react'

const firedThisSession = new Set<string>()

/**
 * @returns A predicate that, when called with `(key, run)`, invokes
 *          `run()` if `key` hasn't already triggered this session.
 *          Returns `true` if `run` was called, `false` if it was
 *          suppressed by the once-per-session gate.
 *
 * The hook itself is stable across re-renders (no state, no refs);
 * it's a hook only so future implementations can add cross-tab
 * coordination via `BroadcastChannel` or `localStorage` without
 * breaking call sites.
 */
export function useFailedOnce(): (key: string, run: () => void) => boolean {
  return useCallback((key, run) => {
    if (firedThisSession.has(key)) return false
    firedThisSession.add(key)
    run()
    return true
  }, [])
}

/**
 * Test-only: clear the per-session record. Tests that simulate a
 * fresh-session-each-test pattern can call this in their `beforeEach`
 * to reset the gate.
 */
export function _resetFailedOnceForTests(): void {
  firedThisSession.clear()
}
