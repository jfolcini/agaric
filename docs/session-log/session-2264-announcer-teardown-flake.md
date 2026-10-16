# Session 2264 — A vitest run failed on an announcement after teardown

#5661, a docs-only PR, failed a vitest shard with every test passing and one
unhandled error: `document is not defined` in `announcer.ts`'s `getOrCreate`,
reached from `flushQueue`.

**Cause.** Announcing two distinct messages shows the first and arms a real
`setTimeout(flushQueue, FLUSH_GAP_MS)` for the second. A test file that ends
inside that gap leaves the timer pending. The environment teardown removes
`document`, and the worker stays alive just long enough for the timer to
fire. That window is longer on a loaded CI runner. Any file that announces
twice near its end could hit it. A copy of
`use-block-action-orchestration.enter-split-race.test.ts` that removes
`document` and waits out the gap reproduced the exact CI error.

**Fix.** The shared `afterEach` in `src/test-setup.ts` calls the existing
`__resetAnnouncerForTests()` after `cleanup()`. That empties the queue, so a
leftover timer finds nothing to flush. No production code changed.
`src/__tests__/announcer-teardown.test.ts` announces twice and ends. Its
`afterAll` stands in for teardown: it removes `document` and waits out the
timer. Without the reset line, that run reports the unhandled
`ReferenceError`. With it, the run is clean.

Gates: the announcer tests, the new test and the named file looped 20 times
with no errors; the 37 files that mock the announcer; one full vitest shard
with no "Errors" line; `npm run typecheck`; oxlint and oxfmt on the changed
files.
