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
- **Strict IPC stubs.** An `invoke` the test never stubbed rejects and fails the test in `afterEach`, naming the command (an unstubbed `undefined` would read as success through `unwrap`). Stub with [`mockInvokeCommands`](helpers/invoke.ts) or `stubInvoke`: `vi.mocked(invoke).mockImplementation(mockInvokeCommands({ list_pages: () => … }))`; suites that render page rows pass `{ fallback: pageRowInvokeFallback }`. Annotate a literal fixture with its generated type so `tsc` catches a missing field. A positional `mockResolvedValueOnce` queue drains in call order regardless of command, so incidental IPC (e.g. `DensityRow`'s hover-intent `load_page_subtree` prefetch) steals the slot; use it only in single-call tests.
- A helper that `src/test-setup.ts` imports must not value-import a module setup mocks (use `import type`, or take the caller's `vi.mocked(invoke)`): the cycle hangs every vitest file silently.
- **No per-file `vi.mock('@tauri-apps/api/core', …)`** — it replaces the strict mock wholesale. The `strict-invoke-optout` prek hook ([`scripts/check-strict-invoke-optout.mjs`](../../scripts/check-strict-invoke-optout.mjs) + `scripts/strict-invoke-optout-baseline.json`) fails on a new opt-out and on a stale entry. If you must re-mock the module (e.g. to add `convertFileSrc`), build `invoke` as `vi.fn(strictInvokeFallback)` in an `async` factory. To retire an entry, migrate to `mockInvokeCommands` and run `node scripts/check-strict-invoke-optout.mjs --update-baseline`.
- **Cross-test `*Once` leak guard.** `vi.clearAllMocks()` does not drain queued `*Once` values, so an unconsumed one is handed to the next test. [`helpers/once-residue.ts`](helpers/once-residue.ts) fails the consuming test, naming the one that queued it. Drain with `mockReset()` / `mockRestore()` or `vi.resetAllMocks()` — not `vi.restoreAllMocks()`, which skips `vi.fn()` mocks in vitest 4. `mockReset()` keeps the shared `invoke` mock's `strictInvokeFallback`; a bare `vi.fn()` needs a re-seed.
- **Radix accessible-description guard (#1505).** Rendering a Radix Dialog / Sheet / AlertDialog without a description fails the test in `afterEach`. Add a `Description` (`sr-only` is fine) or pass `aria-describedby={undefined}`.

Changing `src/lib/tauri-mock/`: [`e2e/AGENTS.md` § The mock is a contract](../../e2e/AGENTS.md#the-mock-is-a-contract-not-a-convenience).

## Mutation triage

- Start from `reports/mutation/<module>/mutation.json` (exact line, column, mutator, replacement), not the HTML summary.
- A new test file kills nothing until it is listed in the module's `tests` in [`stryker.modules.mjs`](../../stryker.modules.mjs).
- A survivor in an unobservable guard: delete the guard, do not write equivalence prose. An "unreachable" claim must match a `NoCoverage` status in that JSON.

## Quality standards

1. **Determinism.** No random data in assertions; date-dependent assertions compute the expected value.
2. **Isolation.** Reset stores and module-level state (counters, caches, debounce timers: the module's `_reset…ForTest()`) and `localStorage.clear()` in `beforeEach`; `vi.clearAllMocks()` on every test; pair `vi.useFakeTimers()` with `vi.useRealTimers()` in `afterEach`.
3. **Debounces** use `vi.useFakeTimers()` + `vi.advanceTimersByTime()`, never a real wait.
4. **Call assertions are exact.** Where a test asserts an `invoke`, pin the exact args, `null` vs `undefined` included.
5. **i18n.** Assert on `t('key')`, not English strings.
6. **Flaky tests are bugs.** Causes seen: debounce races, store or module-state leaks, `vi.doMock` / `resetModules` with a `Promise.all` of imports (use one hoisted `vi.mock`), a DOM node held across an `await`, today's date, weekday or locale, and machine load. Reproduce the cause and A/B it; a raised timeout or a green rerun is not a fix. This holds for Playwright too.
7. **vitest does not typecheck.** After a rename or signature change run `npm run typecheck`, then grep tests for the old symbol and old `vi.mock` paths, which `tsc` cannot see and which silently stop intercepting.
8. **Full suite before the first push of a UI change** (`npx vitest run --shard=1/4` … `4/4`). Targeted runs miss tests that pin a class, a label, or a mock name.
