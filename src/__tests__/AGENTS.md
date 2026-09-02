# Frontend test infrastructure — orientation

> Root [AGENTS.md § Frontend Development Guidelines](../../AGENTS.md#frontend-development-guidelines) covers component hierarchy and mandatory primitives; [`src-tauri/tests/AGENTS.md`](../../src-tauri/tests/AGENTS.md) covers Rust tests. This file: frontend test layout and cross-cutting rules; per-layer rules are linked below.

## Test layers

| Layer | Tool | Scope | Rules live in |
|-------|------|-------|---|
| Unit | Vitest | Pure functions, serializers, tree utils | this file |
| Component | Vitest + RTL | React components (happy-dom; jsdom opt-in) | [`src/components/__tests__/AGENTS.md`](../components/__tests__/AGENTS.md) |
| Store | Vitest | Zustand stores (global + per-page) | [`src/stores/__tests__/AGENTS.md`](../stores/__tests__/AGENTS.md) |
| Accessibility | vitest-axe | axe-core audit on rendered components | this file + component AGENTS.md |
| Property-based | fast-check | Generative fuzzing (markdown serializer, date/tree utils) | this file |
| E2E — mock backend | Playwright | Full app in Chromium against a static `vite preview` build | [`e2e/AGENTS.md`](../../e2e/AGENTS.md) |
| E2E — real backend | WebdriverIO + tauri-driver | The desktop binary over real Tauri IPC (`e2e-tauri/*.e2e.ts`) | [`wdio.conf.ts`](../../wdio.conf.ts) |

**Environment.** Default is happy-dom (`test.environment` in [`vitest.config.ts`](../../vitest.config.ts)). Opt a file into jsdom with a top-of-file `// @vitest-environment jsdom` only for behavior happy-dom does not match — known cases: vitest-axe's `aria-hidden-focus` rule fires on Radix focus-guard sentinels (the shared wrapper [`src/__tests__/helpers/axe.ts`](helpers/axe.ts) disables it), and `Storage.prototype` spies do not intercept `localStorage`. A test that passes in one environment and fails in the other: the environment is the first suspect.

No vitest globals — import explicitly (`import { describe, expect, it, vi } from 'vitest'`).

## Running tests

```bash
npm run test                   # vitest run (unit / component / a11y / property)
npm run test:watch
npm run test:coverage          # v8 coverage; thresholds gate CI
npx vitest run src/stores      # one directory
npx vitest run -t "splitBlock" # one name pattern

npm run test:e2e               # playwright — builds and serves the app itself
npm run test:e2e:ui            # playwright interactive UI
npm run test:e2e-tauri         # WebdriverIO against the real Tauri binary (weekly CI)
npm run test:e2e-android       # adb against a CONNECTED device — manual, never run by CI
npm run mutation               # Stryker mutation run (stryker.config.mjs)
```

`test:e2e-android` ([`scripts/android-e2e-safe-area.mjs`](../../scripts/android-e2e-safe-area.mjs)) needs a connected, unlocked device, so no workflow runs it; run it by hand after touching `MainActivity.kt` or the mobile header. Coverage globs and thresholds: [`vitest.config.ts`](../../vitest.config.ts).

## Test layout

```
src/
├── __tests__/            # This file. Root-level smoke/guard tests + shared test assets.
│   ├── fixtures/index.ts # Shared factories: makeBlock, makePage, makeDailyPage, emptyPage, makeHistoryEntry.
│   ├── helpers/          # axe wrapper, mockInvokeCommands, once-residue guard.
│   └── mocks/            # Shared vi.mock implementations (sonner, ui-select, react-virtual).
├── components/__tests__/ # See AGENTS.md in this folder.
├── editor/__tests__/     # Editor logic + extensions.
├── stores/__tests__/     # See AGENTS.md in this folder.
├── hooks/__tests__/      # Hook logic.
└── lib/__tests__/        # Utility + wrapper tests.

e2e/                      # Playwright specs (mock backend). See AGENTS.md in this folder.
e2e-tauri/                # WebdriverIO specs against the real binary.
```

## Test file naming

- Vitest (under `src/`): `.test.ts` / `.test.tsx`; property-based files: `.property.test.ts`.
- Playwright (under `e2e/`): `.spec.ts`.
- WebdriverIO (under `e2e-tauri/`): `.e2e.ts`.

A wrong suffix routes the file to the wrong runner; the `test-file-naming` prek hook (`scripts/check-test-file-naming.sh`) rejects it.

## Accessibility audit

Every `src/components/__tests__/*.test.tsx` file carries at least one audit through the shared wrapper; the `axe-presence` prek hook (`scripts/check-axe-presence.sh`) rejects a file without one.

```tsx
import { axe } from '@/__tests__/helpers/axe'

const { container } = render(<MyComponent />)
await waitFor(async () => {
  expect(await axe(container)).toHaveNoViolations()
})
```

Details: [component AGENTS.md § Accessibility](../components/__tests__/AGENTS.md#accessibility--every-file-gets-an-axe-audit).

## Property-based testing (fast-check)

Markdown serializer and date / tree / import utilities; each file owns its `NUM_RUNS`. Generators compose bottom-up (`arbTextNode` → `arbInlineNode` → `arbParagraph` → `arbDoc`). Properties: `parse` / `serialize` never throw, `serialize(parse(s))` is a fixed point, ULID tokens and text survive round-trips, `parse` yields a `doc` of non-empty `paragraph` children.

## Shared setup (`src/test-setup.ts`)

- **Global module mocks:** `@tauri-apps/api/core` (`invoke`, `Channel`, `addPluginListener`), `@tauri-apps/plugin-clipboard-manager`, `sonner`, `@/components/ui/select`, and a `TooltipProvider`-wrapping `@/components/ui/tooltip`. The `invoke` mock is the lowest layer, so it intercepts both the `@/lib/tauri/*` wrappers and direct `@/lib/bindings` calls.
- **Polyfills:** `ResizeObserver`, `IntersectionObserver`, `DOMMatrix`, `matchMedia`, `scrollIntoView`, `Element` / `Range` client rects (TipTap positioning), canvas `getContext`.
- **Per-test cleanup:** RTL `cleanup()`, the singleton TanStack Query cache, and `window.visualViewport` (a leaked mock breaks every later Radix Popover/Tooltip mount in the worker).
- **Strict IPC stubs.** An `invoke` for a command the test never stubbed rejects and fails the test in `afterEach`, naming the command (an unstubbed `undefined` reads as success through `unwrap`). Stub with [`mockInvokeCommands`](helpers/invoke.ts): `vi.mocked(invoke).mockImplementation(mockInvokeCommands({ list_pages: () => … }))`; suites that render page rows pass `{ fallback: pageRowInvokeFallback }`. A positional `mockResolvedValueOnce` queue is consumed in call order regardless of command, so incidental IPC (e.g. `DensityRow`'s hover-intent `load_page_subtree` prefetch) steals the slot.
- **No per-file `vi.mock('@tauri-apps/api/core', …)`** — it replaces the strict mock wholesale. [`scripts/check-strict-invoke-optout.mjs`](../../scripts/check-strict-invoke-optout.mjs) + `scripts/strict-invoke-optout-baseline.json` (prek hook `strict-invoke-optout`) fail on a new opt-out and on a stale entry. If you must re-mock the module (e.g. to add `convertFileSrc`), build `invoke` as `vi.fn(strictInvokeFallback)` in an `async` factory. To retire an entry, migrate to `mockInvokeCommands` and run `node scripts/check-strict-invoke-optout.mjs --update-baseline`.
- **Cross-test `*Once` leak guard.** `vi.clearAllMocks()` does not drain queued `*Once` values, so an unconsumed `mockResolvedValueOnce` is handed to the next test in the file. [`helpers/once-residue.ts`](helpers/once-residue.ts) fails the test that consumes a leaked value, naming the test that queued it (self-test: [`once-residue-guard.test.ts`](once-residue-guard.test.ts)). Drains: `mockReset()` / `mockRestore()` on the mock, or `vi.resetAllMocks()` — not `vi.restoreAllMocks()`, which skips `vi.fn()` mocks in vitest 4. `mockReset()` keeps the shared `invoke` mock's `strictInvokeFallback`; a bare `vi.fn()` needs a re-seed.
- **Radix accessible-description guard (#1505).** Rendering a Radix Dialog / Sheet / AlertDialog without a description fails the test in `afterEach`. Add a `Description` (`sr-only` is fine) or pass `aria-describedby={undefined}`.
- **`asyncUtilTimeout`** is raised well above RTL's default so `axe()` audits survive pre-push contention. See [component AGENTS.md § Timeouts](../components/__tests__/AGENTS.md#timeouts).

## Assert durable, re-queried effect — never call-shape (anti-drift)

A mutation test asserts the re-queried resulting state, not that a mock was called: `expect(invoke).toHaveBeenCalledWith('set_property', …)` proves the frontend asked, and the tauri mock (`src/lib/tauri-mock/`) is a hand-maintained second implementation that drifts from the Rust backend. Drive the action, read the state back (`getProperty` / `getBlock` / re-`load()`), assert the result. Mock↔backend parity is enforced by the conformance harness (`conformance/fixtures/*.json`, run against both) and ratcheted by [`conformance-coverage.test.ts`](../lib/tauri-mock/__tests__/conformance-coverage.test.ts): a new state-mutating command needs a fixture or a justified waiver ([`e2e/AGENTS.md` § The mock is a contract](../../e2e/AGENTS.md#the-mock-is-a-contract-not-a-convenience)). Root rule: [`AGENTS.md` § Testing invariants](../../AGENTS.md#testing-invariants-anti-drift).

## Quality standards

1. **Determinism.** No random data in assertions; date-dependent assertions compute the expected value.
2. **Isolation.** Stores reset in `beforeEach`; `vi.clearAllMocks()` on every test; `vi.useFakeTimers()` pairs with `vi.useRealTimers()` in `afterEach`; `localStorage.clear()` in `beforeEach` where used.
3. **No timing hacks.** `waitFor` / `findBy*`, never `sleep`. Wrap non-React event sources (workers, timers, IPC callbacks) in `act` — React 19 does not flush them in a bare `await` tick. Debounces: `vi.useFakeTimers()` + `vi.advanceTimersByTime()`.
4. **Both paths.** Every store action / component interaction tests the success and the error response.
5. **Backend contract.** Exact `invoke` signatures (command, argument shape, `null` vs `undefined`); exact args in `toHaveBeenCalledWith`, exact counts in `toHaveLength`.
6. **i18n.** Assert on `t('key')`, not English strings.
7. **Flaky tests are bugs.** Usual causes: debounce races, render order, store leaks, `*Once` queue order.
