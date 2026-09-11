# Session 1704 — the `UnlinkedReferences.countIntegrity` CI flake

`src/components/backlinks/__tests__/UnlinkedReferences.countIntegrity.test.tsx` →
"a failed expand › keeps the measured count and says the load failed, rather than
'no results'" reddened the first run of #4967 and of #4973 on the same day, and
nearly a third. #4970 had already tried to absorb it (re-querying `waitFor`, an
explicit 5 s budget) and it failed again. This session found the cause rather
than widening the wait.

## The two CI reds

1. 08:30 UTC, pre-#4970: `expect(element).toHaveTextContent()` — expected
   "Failed to load unlinked references", received **"Loading…"**, on the node
   `findByTestId('unlinked-references-error')` had just returned.
2. 10:3x UTC, on #4970's base: `Unable to find an element by:
   [data-testid="unlinked-references-error"]` after 5 s.

## Hypotheses and what each one showed

**A — a module-level counter leaks across tests. HOLDS; this is the cause.**
Since #4967 `handleLinkIt` calls `recordGraphStructureChange()`, which arms a
**150 ms trailing debounce** (`DEBOUNCE_MS`, `src/lib/graph-structure-events.ts`)
on a module-level counter. Neither "Link it" test in this file waits that window
out before its last assertion, and nothing reset the counter between tests. So
the bump settles inside *whichever test happens to be running 150 ms after the
click*. Instrumented run (a subscriber logging `expect.getState().currentTestName`
on each notify), before the fix:

```
>>> STRUCTURE BUMP to 1 during: … > a failed expand > Retry re-runs the fetch and the rows arrive
```

— a test that never touches "Link it". Locally the first test takes ~330 ms and
its successors ~40 ms each, so the bump lands in the third or fourth test; on a
loaded CI box each test is slower and it lands in the failed-expand test. That is
the whole flake: which test eats the bump is a function of machine speed.

What the bump does when it lands there: `useInvalidateOnGraphStructure` →
`useInvalidateOnCounter` → `queryClient.invalidateQueries({ queryKey: prefix })`
→ the errored expanded query refetches. In query-core's `fetchState`
(`node_modules/@tanstack/query-core/build/modern/query.js`), a refetch of a query
whose `data === undefined` resets it to `{ error: null, status: 'pending' }` — so
an errored, data-less query goes **back to pending**, `isError` flips false,
`isLoading` flips true, and `ListViewState` swaps its `empty` slot for the
skeleton. Because both are a bare `<div>` in the same slot, React patches the
element in place: the captured handle keeps its identity, loses `data-testid`,
and reads "Loading…". Verbatim CI red 1.

**B — the error card is gated on a state the expand never reaches. Does not
hold.** The panel does re-enter loading across an invalidate, but only while the
refetch is genuinely in flight (measured: under 3 ms on an idle box), and it
settles straight back to the error card. Showing a spinner while a failed load is
actually being retried is honest feedback, not a defect, so `UnlinkedReferences.tsx`
and `ListViewState.tsx` are unchanged. No path was found that leaves the panel
stuck: the queryFn never reads `signal`, so `Query.removeObserver` takes the
`cancelRetry()` branch, not the `cancel({ revert: true })` one that could strand a
query at `status: 'pending' / fetchStatus: 'idle'`.

**C — the mock implementation or a `releaseExpanded` resolver leaks between
tests. Does not hold.** Every test in the file installs its own
`mockImplementation` before rendering, and `vi.clearAllMocks()` does not carry one
across. The `Error: load boom` line in the #4973 log is from
`src/components/AdvancedQuery/__tests__/SavedViews.test.tsx` in another worker —
interleaved output, not a leak (vitest isolates the module registry per file).

**D — #4970's `{ timeout: 5000 }` was a budget *cut*, not a raise.**
`src/test-setup.ts` sets `configure({ asyncUtilTimeout: 8000 })`, so the
`findByTestId` #4970 replaced already had 8 s; its comment ("above RTL's 1 s
default") is wrong for this repo. Red 2 therefore ran with 5 s where red 1 had
had 8 s, which is consistent with its shape — a plain timeout on a saturated
shard rather than a wrong-state assertion.

## The fix

Taken class-wide rather than per-file, because the defect is "a test arms a
debounce the next test inherits" and any file that drives one of these counters
can do it.

1. `src/test-setup.ts` — a teardown `afterEach` that disarms **both** module-level
   invalidation counters: `_resetGraphStructureEventsForTest()` and
   `_resetBlockPropertyEventsForTest()`. Registered before the RTL `cleanup()`
   registration so that under `sequence.hooks: 'stack'` it runs *after* it: the
   subscriber sets these resets clear belong to components that are unmounted by
   then. The property reset is imported **dynamically**, and the comment says why
   it must stay that way — `block-property-events` pulls in
   `property-change-dispatch` and through it `@tauri-apps/api/event`, and a module
   this setup file imports statically is instantiated before a test file's
   `vi.mock` of that dependency applies. Measured: a static import reds 8 tests
   across `property-change-dispatch.test.ts` and `useBlockPropertyEvents.test.ts`,
   which end up bound to the real `listen`.
2. `UnlinkedReferences.countIntegrity.test.tsx` — dropped the `{ timeout: 5000 }`
   override so the wait inherits the suite's configured 8 s, and corrected the
   comment. The re-querying `waitFor` stays: a graph-structure bump can
   legitimately land there at any moment in production. No per-file reset: the
   shared teardown covers it.

Ten test files already call `_resetGraphStructureEventsForTest()` themselves
(and two call `_resetBlockPropertyEventsForTest()`), always mid-test to make a
counter assertion their own. They are left alone — harmless, and the intent is
local to those assertions.

`src/__tests__/AGENTS.md` § Shared setup lists the per-test cleanups
(RTL `cleanup()`, the query cache, `window.visualViewport`); the counters belong
in that bullet, but AGENTS.md edits need maintainer approval, so it is not
touched here.

## Falsification

*The flake mechanism (red).* Against a scratch copy of the test file with the
counter reset removed, the leaked bump modelled at the point the debounce would
settle and the refetch given a starved-box delay:

```
Error: expect(element).toHaveTextContent()
Expected element to have text content:
  Failed to load unlinked references
Received:
  Loading…
 ❯ src/components/backlinks/__tests__/zzrepro.test.tsx:311:25
```

— CI red 1, reproduced verbatim. With the reset in place, the instrumented run
shows the only bump is the one raised inside the test that raises it ("Link it
while expanded"); no bump reaches any other test, so the mechanism cannot fire.

*The test still pins production (red).* Against a `cp` copy of
`UnlinkedReferences.tsx` with the error branch of the `empty` slot forced off
(`isError ? …` → `false ? …`), the test fails at the `waitFor`, printing the
"No unlinked references found." empty state — and takes 8.16 s to do it, which is
also the measurement that the inherited budget is 8 s. Copy restored, `cmp` clean.

## Verification

The teardown change touches every test file, so the whole vitest estate was run,
one lane at a time:

| Lane | Result |
|---|---|
| `src/components/` | 389 files, 9295 passed / 37 skipped |
| `src/lib/` + `src/workers/` + `e2e-tauri/` | 198 files, 4848 passed / 1 expected fail |
| `src/hooks/` + `BlockTree.scoped-property-invalidation` | 133 files, 1824 passed |
| `src/stores/` + `src/editor/` + `src/__tests__/` | 112 files, 3173 passed |
| `src/components/graph/` (GraphView reads both counters) | 5 files, 138 passed |
| counter suites (`useInvalidateOnCounter`, `useInvalidateOnGraphStructure`, `useBatchCounts`, `useBlockPropertyEvents`, `property-change-dispatch`) | 25 passed |

Five consecutive runs of the flaky file alongside `TrashView.test.tsx` and
`LinkedReferences.test.tsx`: `3 passed (3) / 170 passed (170)` each time.
`npm run typecheck` exit 0.

## Also covered

`src/components/backlinks/__tests__/UnlinkedReferences.test.tsx` drives "Link it"
and never reset the counter either, so it carried the same latent leak. The
shared teardown covers it without a change to that file.
