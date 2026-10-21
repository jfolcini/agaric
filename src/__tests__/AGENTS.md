# Frontend test infrastructure — orientation

> Root [AGENTS.md § Testing](../../AGENTS.md#testing) has the conventions every test follows; [`src-tauri/tests/AGENTS.md`](../../src-tauri/tests/AGENTS.md) covers Rust tests. This file: frontend test layout and cross-cutting rules; per-layer rules are linked below.

## Test layers

| Layer | Tool | Scope | Rules live in |
|-------|------|-------|---|
| Unit | Vitest | Pure functions, serializers, tree utils | this file |
| Component | Vitest + RTL + vitest-axe | React components (happy-dom; jsdom opt-in) | [`src/components/__tests__/AGENTS.md`](../components/__tests__/AGENTS.md) |
| Store | Vitest | Zustand stores (global + per-page) | [`src/stores/__tests__/AGENTS.md`](../stores/__tests__/AGENTS.md) |
| Property-based | fast-check | Markdown serializer, date/tree utils; generators compose bottom-up (`arbTextNode` → `arbDoc`) | this file |
| E2E — mock backend | Playwright | Full app in Chromium against a static `vite preview` build | [`e2e/AGENTS.md`](../../e2e/AGENTS.md) |
| E2E — real backend | WebdriverIO + tauri-driver | The desktop binary over real Tauri IPC | [`e2e-tauri/AGENTS.md`](../../e2e-tauri/AGENTS.md) |

**Environment.** Default is happy-dom (`test.environment` in [`vitest.config.ts`](../../vitest.config.ts)). Opt a file into jsdom with a top-of-file `// @vitest-environment jsdom` only for behavior happy-dom does not match. A test that passes in one environment and fails in the other: the environment is the first suspect.

**Spy the storage instance, not `Storage.prototype`, and restore it yourself.** Under happy-dom, `vi.spyOn(window.localStorage, 'setItem')` always intercepts; a `Storage.prototype` spy intercepts only if nothing has touched that method yet, because happy-dom copies each prototype method onto the instance on first access. `vi.restoreAllMocks()` does not reach an instance spy, so call `spy.mockRestore()` in a `finally`, or a throwing `localStorage` leaks into every later test in the file. A file pinned to jsdom is the mirror image (there the instance spy is inert): it uses the prototype spy and says in its header that the pin is load-bearing.

**A zero-call assertion needs a positive control.** `not.toHaveBeenCalled()` passes just as well behind a dead spy or before a debounce fires, and a throwing `mockImplementation` that never reaches the code under test leaves the swallow-and-warn path unexercised. Assert `toHaveBeenCalled()` in a sibling case, or temporarily invert to `toHaveBeenCalledTimes(99)` and read the observed count (before `mockRestore()`, which clears it). **Run the whole file, never `-t` filtered**: a filtered run skips the earlier test whose write froze the binding, so the spy is live under the filter and dead in CI.

**Test shapes that stay green with the fix reverted** (the Rust list is in [`src-tauri/tests/AGENTS.md`](../../src-tauri/tests/AGENTS.md)):

- A regex over source or CSS. happy-dom evaluates neither media queries nor `var()`; measure the rendered result in Playwright.
- A test that fakes the platform API behind which a native-only fix lives (`visualViewport` for a Kotlin fix).
- One gesture that fires two triggers, so deleting either handler stays green: one case per trigger.
- A "does not X twice" test whose stub throws before the count it asserts.
- A test shape justified by a comment about the mock ("the mock ignores X"): read the handler, the comment may be stale.

No vitest globals — import explicitly (`import { describe, expect, it, vi } from 'vitest'`).

## Running tests

```bash
npm run test                   # vitest run (unit / component / a11y / property)
npm run test:watch
npm run test:coverage          # v8 coverage; thresholds (vitest.config.ts) gate CI
npx vitest run src/stores      # one directory
npx vitest run -t "splitBlock" # one name pattern

npm run test:e2e               # playwright — builds and serves the app itself
npm run test:e2e:ui            # playwright interactive UI
npm run test:e2e-tauri         # WebdriverIO against the real Tauri binary
npm run test:e2e-android       # adb against a CONNECTED device — manual, never run by CI
npm run mutation               # Stryker mutation run (stryker.config.mjs)
```

Run `test:e2e-android` ([`scripts/android-e2e-safe-area.mjs`](../../scripts/android-e2e-safe-area.mjs)) by hand after touching `MainActivity.kt` or the mobile header; no workflow can.

**Timeouts are set in config, not per test:** `asyncUtilTimeout` in [`src/test-setup.ts`](../test-setup.ts) (raised so `axe()` survives pre-push contention with `cargo nextest`), `testTimeout` / `hookTimeout` in [`vitest.config.ts`](../../vitest.config.ts). An explicit `waitFor(..., { timeout: n })` or `it(..., n)` lowers the ceiling as often as it raises it; add one only for axe cold-load or a Radix popover `onPointerDown → setTimeout → setState` chain.

## Test layout

```
src/
├── __tests__/            # This file. Root-level smoke/guard tests + shared test assets.
│   ├── fixtures/index.ts # Shared factories (makeBlock, makeBlockRow, makePropertyRow, withOps, makeHistoryEntry, …); add missing ones here, not locally.
│   ├── helpers/          # axe wrapper, mockInvokeCommands, once-residue guard.
│   └── mocks/            # Shared vi.mock implementations (sonner, ui-select, react-virtual).
├── components/__tests__/ # See AGENTS.md in this folder.
├── editor/__tests__/     # Editor logic + extensions.
├── stores/__tests__/     # See AGENTS.md in this folder.
├── hooks/__tests__/      # Hook logic.
└── lib/__tests__/        # Utility + wrapper tests.
```

Suffixes route files to runners, and the `test-file-naming` prek hook rejects a wrong one: Vitest `.test.ts(x)` (property-based `.property.test.ts`), Playwright `.spec.ts`, WebdriverIO `.e2e.ts`.

## Shared setup (`src/test-setup.ts`)

- **Global module mocks:** `@tauri-apps/api/core` (`invoke`, `Channel`, `addPluginListener`), `@tauri-apps/plugin-clipboard-manager`, `sonner`, `@/components/ui/select`, and a `TooltipProvider`-wrapping `@/components/ui/tooltip`. The `invoke` mock sits below both `@/lib/bindings` and the `@/lib/ipc-helpers` floor, so it intercepts every IPC call.
- **Polyfills:** `ResizeObserver`, `IntersectionObserver`, `DOMMatrix`, `matchMedia`, `scrollIntoView`, `Element` / `Range` client rects (TipTap positioning), canvas `getContext`.
- **Per-test cleanup:** RTL `cleanup()`, the singleton TanStack Query cache, and `window.visualViewport` (a leaked mock breaks every later Radix Popover/Tooltip mount in the worker).
- **Strict IPC stubs.** An `invoke` the test never stubbed rejects and fails the test in `afterEach`, naming the command (an unstubbed `undefined` would read as success through `unwrap`). Stub with [`mockInvokeCommands`](helpers/invoke.ts) or `stubInvoke`: `vi.mocked(invoke).mockImplementation(mockInvokeCommands({ list_pages: () => … }))`; suites that render page rows pass `{ fallback: pageRowInvokeFallback }`. Annotate a literal fixture with its generated type so `tsc` catches a missing field. A positional `mockResolvedValueOnce` queue drains in call order regardless of command, so incidental IPC (e.g. `PageRow`'s hover-intent `load_page_subtree` prefetch) steals the slot; use it only in single-call tests.
- A helper that `src/test-setup.ts` imports must not value-import a module setup mocks (use `import type`, or take the caller's `vi.mocked(invoke)`): the cycle hangs every vitest file silently. It imports named subpaths, never a barrel (`date-fns/locale/es`, not `date-fns/locale`): every test file pays the barrel's load at start.
- **No per-file `vi.mock('@tauri-apps/api/core', …)`** — it replaces the strict mock wholesale. The `strict-invoke-optout` prek hook ([`scripts/check-strict-invoke-optout.mjs`](../../scripts/check-strict-invoke-optout.mjs)) fails on any such mock. If you must re-mock the module (e.g. to add `convertFileSrc`), build `invoke` as `vi.fn(strictInvokeFallback)` in an `async` factory.
- **Cross-test `*Once` leak guard.** `vi.clearAllMocks()` does not drain queued `*Once` values, so an unconsumed one is handed to the next test. [`helpers/once-residue.ts`](helpers/once-residue.ts) fails the consuming test, naming the one that queued it. Drain with `mockReset()` / `mockRestore()` or `vi.resetAllMocks()` — not `vi.restoreAllMocks()`, which skips `vi.fn()` mocks in vitest 4. `mockReset()` keeps the shared `invoke` mock's `strictInvokeFallback`; a bare `vi.fn()` needs a re-seed.
- **Radix accessible-description guard (#1505).** Rendering a Radix Dialog / Sheet / AlertDialog without a description fails the test in `afterEach`. Add a `Description` (`sr-only` is fine) or pass `aria-describedby={undefined}`.

Changing `src/lib/tauri-mock/`: [`e2e/AGENTS.md` § The mock is a contract](../../e2e/AGENTS.md#the-mock-is-a-contract-not-a-convenience).

## Mutation triage

- Start from `reports/mutation/<module>/mutation.json` (exact line, column, mutator, replacement), not the HTML summary.
- A new test file kills nothing until it is listed in the module's `tests` in [`stryker.modules.mjs`](../../stryker.modules.mjs). Before writing a test for a survivor, check whether an existing one already pins it and is only missing from that list.
- Locate a survivor by mutator and source text, not the issue's line number, which is from the run's commit. A mutation issue stays open until the next weekly run finds nothing, so `git log origin/main --grep '#N'` before starting.
- A survivor in an unobservable guard: delete the guard, do not write equivalence prose. An "unreachable" claim must match a `NoCoverage` status in that JSON.
- A mutant proven unkillable goes in [`mutation-accepted.tsv`](../../mutation-accepted.tsv), in the PR that proves it, not in an issue body: paste the survivor-block ids into `node scripts/file-mutation-survivors.mjs --accept` (stdin, on the commit they were reported for) and append the output. Entries are keyed by line text, so a line shift keeps them valid and an edit to the line makes them inert. Format and rules: the filer's header.

## Quality standards

1. **Determinism.** No random data in assertions; date-dependent assertions compute the expected value.
2. **Isolation.** Reset stores and module-level state (counters, caches, debounce timers: the module's `_reset…ForTest()`) and `localStorage.clear()` in `beforeEach`; `vi.clearAllMocks()` on every test; pair `vi.useFakeTimers()` with `vi.useRealTimers()` in `afterEach`. A module timer or queue that can fire after a file's last test is reset in the shared `afterEach` of `src/test-setup.ts` (as `__resetAnnouncerForTests` is): firing after teardown, it fails the shard while every test passed.
3. **Debounces** use `vi.useFakeTimers()` + `vi.advanceTimersByTime()`, never a real wait.
4. **Call assertions are exact.** Where a test asserts an `invoke`, pin the exact args, `null` vs `undefined` included.
5. **i18n.** Assert on `t('key')`, not English strings.
6. **Flaky tests are bugs.** Causes seen: debounce races, store or module-state leaks, `vi.doMock` / `resetModules` with a `Promise.all` of imports (use one hoisted `vi.mock`), a DOM node held across an `await`, an assertion made once on state an effect sets later (focus after `findBy*`: use `waitFor`), a stub that answers a post-mutation refetch with pre-mutation rows, an unstubbed hover-intent prefetch (`usePagePrefetchIntent`) that fires once `user.click` slows under load, today's date, weekday or locale, and machine load. Reproduce the cause and A/B it; a raised timeout or a green rerun is not a fix. This holds for Playwright too. A failure you call a known flake names its open issue; if none exists, reproduce it and fix or file it. A fast-check property red once and green on rerun is a counterexample the generator reaches only sometimes: rerun with the logged `seed` and `path`, and pin the shrunk counterexample as an example case.
7. **vitest does not typecheck.** After a rename or signature change run `npm run typecheck`, then grep tests for the old symbol and old `vi.mock` paths, which `tsc` cannot see and which silently stop intercepting.
8. **Locally, the related set stands in for the full suite** (`just test-fe-related` for uncommitted work, `npx vitest --changed origin/main` for the whole branch). CI runs the full suite, which catches what a targeted run misses: tests that pin a class, a label, or a mock name.
