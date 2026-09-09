# Session 1656 — the flake that reddened two PRs tonight

`main-boot-error.test.ts` failed `validate / vitest (1)` on #4911 and again on
#4914 — two PRs that share no code, one of them comment-only. Both reruns went
green. The assertion was `expected null not to be null`, after a 15-second
poll.

## Two problems, and the first one hid the second

**The poll.** `main()` runs as an import side effect and its promise was not
exported, so the three cases polled the DOM for its result under a 15 s
`vi.waitFor` budget. When that budget expires the message is about the DOM
being empty, which says nothing about what stalled — and it costs 15 seconds to
say it.

`main.tsx` now exports the promise it already builds. A case awaits the boot
instead of guessing how long it takes. That is inert in the app: the promise is
created and `.catch`ed either way.

That alone fixed nothing. It made the real failure legible: the same case, run
locally, failed in **13 ms** with

    expected "vi.fn()" to not be called at all, but actually been called 1 times

— `createRoot` had been called, so `main()` had not thrown at all. It mounted
the app.

**The cause.** `mockCommonDeps()` registered `@/lib/tauri-mock` with a benign
`setupMock`, and the one case that needs it to THROW called `mockCommonDeps()`
and then registered a second `vi.doMock` for the same module id. Two
registrations for one module do not reliably resolve to the later one. When the
benign one won, `setupMock` did not throw, `main()` completed, and the case
failed on the mount it was asserting could not happen. `afterEach` unmocks only
`@/lib/observability`, so the registration also outlives the test that made it.

`setupMock` is now a parameter of `mockCommonDeps`, so exactly one registration
exists per test.

## Evidence

Locally, on this machine:

| tree | runs | failures |
|---|---|---|
| double registration | 12 | **4** |
| one registration | 20 | **0** |

The 12-run column is the falsification: the double `doMock` was put back on a
copy of the test file, run, and the file restored `cmp`-identical.

## What this cost before it was found

Two spurious reds and two CI reruns tonight alone, on PRs with nothing to do
with boot. The 15-second budget had already been raised once, with a careful
comment measuring 20–238 ms locally against 1029 ms on a loaded shard — a real
measurement of the wrong thing. The budget was never the problem; it was the
reason nobody could see what was.
