# Session 3094 — App.test loads the lazy views up front

App.test's "switches to Pages view" failed once on a heavily loaded machine: `expected null not to be null` at its `.page-browser-header` `waitFor`, after the 8 s `asyncUtilTimeout`.

**Cause.** `ViewDispatcher` preloads every lazy view chunk at idle after the first App mount. The Pages test is the first to open a lazy view, and under load its `waitFor` was spent waiting for the PageBrowser chunk to load behind the others. A slow chunk then leaves only React's Suspense throttle and a render. The Tags, Trash, Settings, Search and page-editor tests are each the first into their own chunk too.

**Fix.** The test file imports the lazy view modules for their side effect, so they load in the file's import phase, which has no timeout. App's own `import()` calls then hit the module cache. No assertion or timeout changed, and no production code changed. In production a slow chunk shows the `ViewFallback` skeleton, the click is kept, and a failed preload is logged and retried by the render, so there is nothing to fix there.

**Red first.** Natural failures did not recur in about 130 loaded runs, so the failure was forced. A 9 s top-level await appended to `PageBrowser.tsx`, applied and restored in one command, fails the test on the same assertion without the imports and passes with them. The builder and the reviewer each ran it.

**Suites:** vitest over `App.test.tsx`, `src/components/mobile` and `src/components/common` (553 tests), typecheck, lint.
