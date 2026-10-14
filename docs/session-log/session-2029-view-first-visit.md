# Session 2029 — Views: first visit without the Suspense throttle

Set out to work #5444: each view's first visit took about 800 ms against the mock, later visits about 60 ms, with the chunks in well under that.

What the trace showed: the first click on Search commits `ViewFallback` at about 18 ms and the chunk is in a millisecond later, but the view commits only at about 318 ms, from a timer React reschedules to fallback-commit + 300 ms. That is react-dom's Suspense fallback throttle. A sidebar click updates the store through `useSyncExternalStore`, so the render is synchronous and a suspending `lazy()` commits its fallback at once; `lazy()` always suspends on its first render because its factory's promise settles a microtask late. The rest of the 800 ms was Playwright's `waitFor` backoff rounding a 320 ms wait up to its next poll.

What shipped: `lazyView` in `ViewDispatcher` wraps `lazy()` with a `preload()`, and once preloaded hands React the module through a synchronously resolving thenable, so the first render does not suspend. `preloadViews` loads every view chunk at idle after mount through `scheduleIdle` (now exported from `useLazyRovingEditor`). In-page first visits went from about 320–400 ms to 20–100 ms; second visits are unchanged. `e2e/perf.spec.ts` gained an opt-in `first and second visit to each view` journey that times in the page.

Traps: preloading alone changes nothing; a preload-only build still showed the fallback on every first visit and the same 300 ms. The lazy views are module singletons, so the preload test lives in its own file. Left: the Pages view's first mount still costs about 100 ms of real work, and other `lazy()` boundaries can hit the same throttle.

Ran: vitest over `src/components/pages`, `App.test.tsx`, `useLazyRovingEditor` and `TagsView`, the `src/__tests__` guard suites, `npm run typecheck`, oxlint, oxfmt, and the `smoke`, `nav-active-item` and `perf` specs.
