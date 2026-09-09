# Session 1636 — the `Storage.prototype` spy audit

Session 1633's addendum left one thing owed: every `Storage.prototype` spy in a
happy-dom test file needed an empirical verdict, not an argument from the
mechanism. This is that audit. Eight spies across five files, every one of them
dead, all five files now pinned to jsdom.

The mechanism, restated once: happy-dom's `Storage` is a `Proxy` whose `get`
trap runs `ClassMethodBinder.bind`, which reads the descriptor off
`Storage.prototype` at that moment, copies it onto the instance as an own bound
property, and caches the name so it never rebinds. So the first access to
`localStorage.setItem` anywhere in a file freezes what every later access in
that file resolves to, and a spy installed after that point is invisible —
`vi.restoreAllMocks()` included. jsdom forwards to the prototype on every
access, which is why the same file passes there.

The probe was the same everywhere: against a `cp` backup, insert
`expect(spy).toHaveBeenCalledTimes(99)` immediately after the action that should
have tripped the spy, run `npx vitest run <path>` with no `-t` filter, and read
the number out of "but got N times". That inversion is the point — a passing
test says nothing, and a filtered run says something false, which is how 1633
got it wrong the first two times. For the one `not.toHaveBeenCalled()` spy the
inversion cannot work at all, since a dead spy and a correctly-silent one both
report zero; that one got a direct `localStorage.setItem('__probe__', 'x')`
inside the spied window instead, so the question became whether the spy can
record anything at all.

## The verdicts

`useTheme.test.ts` has two. The `not.toHaveBeenCalled()` in "setting same theme
is a no-op (no re-render, no extra writes)" recorded **0** — it could not even
see a direct write two lines after the spy was installed, so it was asserting
nothing whatsoever, which is exactly the shape the mechanism predicts and the
reason that assertion needed the direct-write probe rather than the inverted
one. The throwing spy in "keeps instances in sync even when localStorage writes
fail" also recorded **0**, so the quota error never reached `setTheme` and the
test was proving that a hook survives a write that succeeded. Nine direct
`localStorage.setItem` calls precede the first spy, and every `setTheme` act
among them writes too; the test at :278 even seeds the preference through
`localStorage.setItem` on the line above its own spy, so it would have been dead
on its own merits.

`useExternalImagePolicy.test.ts` has two throwing spies, "degrades to a no-op
(no throw) when setItem throws (quota/private mode)" and "degrades to a no-op
when setItem throws on addHost". Both recorded **0**. The `setPolicy` test at
:36 is the first toucher. Neither test was exercising the degradation path it
names; both were asserting that a successful write does not throw.

`useAgendaPreferences.test.ts` has one `getItem` spy and one `setItem` spy, both
in "localStorage error handling". They recorded **0** and **0**. The seeding
writes from :31 onward and the hook reads they drive bind both methods well
before line 123.

`useDeepLinkRouter.test.ts` has one, in "still switches view if localStorage
write throws". **0**. `handleOpenSettingsPayload({ tab: 'keyboard' })` at :408
writes the settings tab first. This is one of the two files 1633's earlier
probes had reported as live; unfiltered it is dead, which closes that loop.

`BookmarksSection.test.tsx` has one, in "still toggles when persisting the
preference throws". **0**. Here the toucher is in the test's own body: the
`bookmark()` helper on the line above the spy goes through `writePreference`,
which writes `starred-pages`.

Two files the review's list named — `safe-persist-storage.test.ts` and
`guarded-storage.test.ts` — turned out to be false positives. Each mentions
`vi.spyOn(Storage.prototype, ...)` only in a header comment explaining that it
deliberately uses `vi.stubGlobal` instead, "so behaviour doesn't depend on how
the happy-dom `Storage` class exposes its methods". They were already right and
were left alone.

## After pinning

Each of the five files got `// @vitest-environment jsdom` on line 1 with a short
comment naming its own first toucher, then the same probe again to confirm the
spy had actually come back to life rather than merely passing: 1 and 1 for the
two in `useTheme`, 1 and 1 for the two in `useExternalImagePolicy`, 8 and 3 for
the `getItem`/`setItem` pair in `useAgendaPreferences`, 1 for `useDeepLinkRouter`
and 3 for `BookmarksSection`. Every one of them intercepts now.

No test failed for real. Every one of the eight was vacuous, and every one of
them passes on its own terms once the throw actually reaches the code — which is
the boring outcome, and worth saying plainly, because the interesting outcome
was available and did not happen. The `not.toHaveBeenCalled()` in `useTheme` is
now genuinely load-bearing: with the spy live it records the direct probe write
and nothing else, so the hook's same-theme early return is what keeps it at
zero.

One incidental observation from the probe runs, not acted on:
`useAgendaPreferences.test.ts` restores its spies with an inline
`spy.mockRestore()` at the end of each test rather than from `afterEach`, so a
failure inside one of those two tests leaks a throwing `localStorage` into the
next. It showed up as two extra red tests in the probe run and vanished with the
probe. Nothing reaches a user through it.

## Verification

All five files run unfiltered and green under jsdom — 43, 14, 18, 66 and 14
tests. `npm run typecheck` clean. Every probe was made against a `cp` backup and
restored with `cmp` confirming byte identity; `git diff` shows six added comment
lines and a blank in each of the five test files and nothing else of mine.

A last check outside the audit's scope, because a negative there would have been
much worse news: the instance-level spies elsewhere in the tree
(`vi.spyOn(window.localStorage, …)` in `useWeekStart.test.ts`,
`useJournalDateFormat.test.ts`, `GraphFilterBar.test.tsx`,
`starred-pages.test.ts`) are live under happy-dom. Probed `useWeekStart`: 2 and
1. They go through the proxy's `defineProperty` trap, which calls
`preventBinding` and then defines straight onto the instance, so the freeze
cannot reach them. Those files need no pin.
