// ---------------------------------------------------------------------------
// Unit tests for the session-vs-per-test log-rescue label collision (#4457,
// item 2 — from the final review of #4449).
//
// These are VITEST tests, not WDIO specs — see the header comment in
// `visibility-probe.test.ts` for why unit tests for `wdio.conf.ts` live under
// `e2e-tauri/` instead of `src/__tests__/`. Split into a sibling file rather
// than added to `visibility-probe.test.ts` because that file is scoped to the
// on-failure VISIBILITY diagnostic (#4428) — its own header comment says so —
// and this is a different concern: the log-rescue LABEL namespace `afterTest`
// and `afterSession` share.
//
// THE DEFECT THIS PINS. `wdio.conf.ts` used to claim, in a comment, that the
// session-level log rescue (`SESSION_LOG_LABEL`, the bare string "session")
// "is never the same directory as a per-test rescue" — but nothing enforced
// that. `rescueAppLogs` is idempotent PER LABEL (first caller wins, later
// callers are skipped as "already rescued"). A root-level test titled
// "session" has no enclosing `describe`, so `test.parent` is `''`, and
// `afterTest`'s label expression `${test.parent ?? 'suite'}-${test.title ??
// 'test'}` — i.e. `-session` — sanitizes to exactly `session`. `afterTest`
// would run FIRST (per test, mid-session) and claim `app-logs/session`, so
// `afterSession`'s call — the MORE COMPLETE one, taken after the driver is
// killed — would then be silently skipped.
//
// The fix makes `sanitizeForFilename` reserve `SESSION_LOG_LABEL`: any input
// that sanitizes to exactly that string gets a suffix instead, so a per-test
// label can no longer collide with the session-level directory. These tests
// assert concrete expected strings throughout (not mere inequality), so a
// vacuous pass — e.g. both sides sanitizing to `''` or `undefined` — cannot
// slip through.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { SESSION_LOG_LABEL, sanitizeForFilename } from '../wdio.conf'

describe('SESSION_LOG_LABEL', () => {
  it('is the concrete string the collision is about', () => {
    // Pinned by value, not just referenced, so a future rename of the
    // constant can't quietly change what this suite is protecting without a
    // test failure calling it out.
    expect(SESSION_LOG_LABEL).toBe('session')
  })
})

describe('sanitizeForFilename — SESSION_LOG_LABEL reservation (#4457)', () => {
  it('suffixes a label that sanitizes to exactly SESSION_LOG_LABEL', () => {
    const result = sanitizeForFilename(SESSION_LOG_LABEL)
    expect(result).toBe('session-test')
    // Reasserted explicitly (not merely "not SESSION_LOG_LABEL"): a suffixed
    // value that happened to be '' or undefined would also be "not session",
    // which would make this test pass for the wrong reason.
    expect(result).not.toBe(SESSION_LOG_LABEL)
  })

  it('reproduces the exact reachable collision: a root-level test titled "session"', () => {
    // Mirrors afterTest's own label expression in wdio.conf.ts:
    //   sanitizeForFilename(`${test.parent ?? 'suite'}-${test.title ?? 'test'}`)
    // for a root-level test (no enclosing `describe`), where WDIO reports
    // `test.parent` as `''`.
    const testParent = ''
    const testTitle = 'session'
    const label = sanitizeForFilename(`${testParent ?? 'suite'}-${testTitle ?? 'test'}`)

    expect(label).toBe('session-test')
    expect(label).not.toBe(SESSION_LOG_LABEL)
  })

  it('leaves an ordinary per-test label untouched (round-trips, no spurious suffix)', () => {
    // The symmetric arm: the reservation must not relabel every per-test
    // artifact, only the one string it exists to protect.
    const testParent = 'MySuite'
    const testTitle = 'does a thing'
    const label = sanitizeForFilename(`${testParent ?? 'suite'}-${testTitle ?? 'test'}`)

    expect(label).toBe('MySuite-does-a-thing')
  })

  it('leaves the session rescue itself pointed at SESSION_LOG_LABEL, unsanitized', () => {
    // afterSession calls `rescueAppLogs(SESSION_LOG_LABEL)` directly — it
    // never passes the constant through `sanitizeForFilename`. Confirms the
    // reservation added to the sanitizer has no effect on the session-level
    // call site itself; the session rescue still lands at "session".
    expect(SESSION_LOG_LABEL).toBe('session')
    expect(sanitizeForFilename(SESSION_LOG_LABEL)).not.toBe(SESSION_LOG_LABEL)
  })
})
