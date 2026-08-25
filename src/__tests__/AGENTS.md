# Frontend test infrastructure — orientation

> See also: [AGENTS.md § Frontend Development Guidelines](../../AGENTS.md#frontend-development-guidelines) for component hierarchy, design-system patterns, and mandatory primitives. This file orients you in the test layout; per-test-type rules live in the subdirectory AGENTS.md files linked below.

## Test layers

| Layer | Tool | Scope | Rules live in |
|-------|------|-------|---|
| Unit | Vitest | Pure functions, serializers, tree utils | this file (Quality standards) |
| Component | Vitest + RTL | React components (happy-dom; jsdom opt-in) | [`src/components/__tests__/AGENTS.md`](../components/__tests__/AGENTS.md) |
| Store | Vitest | Zustand stores (global + per-page) | [`src/stores/__tests__/AGENTS.md`](../stores/__tests__/AGENTS.md) |
| Accessibility | vitest-axe | axe-core audit on rendered components | component AGENTS.md |
| Property-based | fast-check | Generative fuzzing (markdown serializer, date/tree utils) | this file |
| E2E — mock backend | Playwright | Full app in Chromium against a static `vite preview` build | [`e2e/AGENTS.md`](../../e2e/AGENTS.md) |
| E2E — real backend | WebdriverIO + tauri-driver | The real desktop binary over real Tauri IPC (`e2e-tauri/*.e2e.ts`) | [`wdio.conf.ts`](../../wdio.conf.ts) |

**Test environment.** The default is **happy-dom** (`test.environment` in [`vitest.config.ts`](../../vitest.config.ts)). A minority of files opt back into **jsdom** with a top-of-file `// @vitest-environment jsdom` pragma — grep for it to find the current set. Reach for the pragma only when a test depends on behavior happy-dom doesn't match. Two documented divergences:

- vitest-axe's `aria-hidden-focus` rule fires differently under happy-dom (Radix focus-guard sentinels trip it). The shared wrapper in [`src/__tests__/helpers/axe.ts`](helpers/axe.ts) disables that rule by default.
- `Storage.prototype.{getItem,setItem}` spies don't intercept under happy-dom — its `Storage` bypasses the prototype methods. localStorage-spy tests pin jsdom.

When a test passes under one environment and fails under the other, the environment is the first suspect.

No vitest globals — all imports explicit (`import { describe, expect, it, vi } from 'vitest'`).

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
npm run mutation               # Stryker mutation run (stryker.config.mjs)
```

Coverage include/exclude globs and the CI-gating thresholds both live in [`vitest.config.ts`](../../vitest.config.ts) — that block is the single source of truth (#749). Read it rather than copying numbers here.

## Test layout

```
src/
├── __tests__/            # This file. Root-level smoke/guard tests + shared test assets.
│   ├── fixtures/index.ts # Shared factories: makeBlock, makePage, makeDailyPage, emptyPage, makeHistoryEntry.
│   ├── helpers/          # Shared test helpers (e.g. the axe wrapper).
│   └── mocks/            # Shared vi.mock implementations (sonner, ui-select, react-virtual).
├── components/__tests__/ # See AGENTS.md in this folder.
├── editor/__tests__/     # Editor logic + extensions.
├── stores/__tests__/     # See AGENTS.md in this folder.
├── hooks/__tests__/      # Hook logic.
└── lib/__tests__/        # Utility + wrapper tests.

e2e/                      # Playwright specs (mock backend). See AGENTS.md in this folder.
e2e-tauri/                # WebdriverIO specs against the real binary.
```

**Naming:** Vitest = `.test.ts` / `.test.tsx`. Playwright = `.spec.ts`. WebdriverIO = `.e2e.ts`. Property-based = `.property.test.ts` (e.g. `markdown-serializer.property.test.ts`).

## Property-based testing (fast-check)

Used for the markdown serializer and the date / tree / import utilities. Each file declares its own `NUM_RUNS` constant (a few hundred runs) — tune it there, not globally.

```ts
const arbText = fc.array(fc.constantFrom(...'abcXY 012*`#[\\]'.split('')), { minLength: 1, maxLength: 8 })
  .map(chars => chars.join(''))

const arbMarks = fc.subarray([{ type: 'bold' }, { type: 'italic' }, { type: 'code' }])
  .filter(marks => marks.some(m => m.type === 'code') ? marks.length === 1 : true)
```

Generators compose bottom-up: `arbTextNode` → `arbInlineNode` → `arbParagraph` → `arbDoc`.

Property categories:

1. **Safety** — `parse` never throws for any string; `serialize` never throws for any valid doc.
2. **Round-trip stability** — `serialize(parse(s))` is a fixed point.
3. **Content preservation** — ULID tokens and text survive round-trips.
4. **Structural invariants** — `parse` always produces `doc` with `paragraph` children; text nodes non-empty.

`normalizeDoc()` merges adjacent text nodes with identical marks before comparison. The `hasStructuralAmbiguity()` filter skips delimiter-edge cases for structural equality checks; content preservation is still verified.

## Shared setup (`src/test-setup.ts`)

Read the file for the current detail; the load-bearing parts:

- **Global module mocks.** `@tauri-apps/api/core` (`invoke`, `Channel`, `addPluginListener`), `@tauri-apps/plugin-clipboard-manager`, `sonner`, `@/components/ui/select`, and a `TooltipProvider`-wrapping `@/components/ui/tooltip`. Because the `invoke` mock sits at the lowest layer, it intercepts calls made through the `@/lib/tauri/*` wrappers **and** calls made directly through the generated `@/lib/bindings` commands.
- **Polyfills** neither happy-dom nor jsdom provide: `ResizeObserver`, `IntersectionObserver`, `DOMMatrix`, `window.matchMedia`, `Element.scrollIntoView`, `Element`/`Range.getClientRects`, `Range.getBoundingClientRect` (required by TipTap/ProseMirror positioning), `HTMLCanvasElement.getContext`.
- **Per-test cleanup.** RTL `cleanup()` is registered manually (vitest globals are off). The TanStack Query client is a process-wide singleton, so its cache is cleared after every test. `window.visualViewport` is restored after every test — a leaked mock without `addEventListener` breaks every later Radix Popover/Tooltip mount in the same worker.
- **Strict IPC stubs (#3225).** An `invoke` call for a command the test never stubbed **rejects** and fails the test in `afterEach`, naming the command. It used to resolve `undefined`, which `typedError` wraps as `{ status: 'ok' }` and `unwrap` reports as SUCCESS — so a missing mock was the *quietest* failure in a suite, and in #3217 it turned a stolen mock slot into a silent behaviour inversion (a failed-delete test exercising a successful delete). A command that legitimately returns nothing still works once stubbed: the *fallback* objects, not the value.
  - Prefer [`mockInvokeCommands`](helpers/invoke.ts) — `vi.mocked(invoke).mockImplementation(mockInvokeCommands({ list_pages: () => … }))` — over positional `mockResolvedValueOnce`/`mockRejectedValueOnce`. The positional queue is consumed in CALL order regardless of command, so any speculative prefetch (e.g. `DensityRow`'s 120ms hover-intent `load_page_subtree`) that fires mid-test steals the slot meant for the command under test.
  - Suites that render page rows can pass `{ fallback: pageRowInvokeFallback }` to model that prefetch and stay strict about everything else.
  - **The guard is opt-out, and the opt-outs are now ratcheted (#3332).** A per-file `vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))` replaces the shared mock wholesale, so the strict base never runs there and an unstubbed command is still silently `undefined` — the pre-#3225 hazard, in full. This rule used to live only in this paragraph; it is now mechanized by [`scripts/check-strict-invoke-optout.mjs`](../../scripts/check-strict-invoke-optout.mjs) + `scripts/strict-invoke-optout-baseline.json` (pre-commit hook `strict-invoke-optout`), which fails on a NEW opt-out and on a STALE baseline entry, so the count can only shrink. Don't add another; if you must re-mock the module (e.g. to add `convertFileSrc`), build the `invoke` mock as `vi.fn(strictInvokeFallback)` from an `async` factory — the guard accepts that shape. To retire an entry, migrate the file to `mockInvokeCommands` and run `node scripts/check-strict-invoke-optout.mjs --update-baseline`. A further set of files installs a blanket `mockResolvedValue(undefined)` on `invoke`, which is an explicit stub and therefore honoured — deliberate, and left to review rather than mechanized (it is textual to detect and trivial to spell differently), but it opts that file out of the guard just as effectively.
  - Roughly a thousand positional `mockResolvedValueOnce` / `mockRejectedValueOnce` call sites remain across the suite. Most are single-call tests where position is unambiguous; the hazard is specifically a queue of two or more in a test that also renders a component capable of speculative IPC. Convert those to `mockInvokeCommands` as you touch them.
- **Cross-test `*Once` leak guard (#4211).** `vi.clearAllMocks()` clears call state and **nothing else** — read `mockClear` in `@vitest/spy`: it never touches `config.onceMockImplementations`. A `mockReturnValueOnce` / `mockResolvedValueOnce` / `mockRejectedValueOnce` / `mockImplementationOnce` value the queuing test's code path does not consume therefore survives into later tests in the same file, and is handed to them *ahead of* both the base implementation and their own queued values. That is #4040 (a leaked hand-resolved promise hung three unrelated tests at ~8s each, each passing in isolation) and #3217 (a leaked rejection inverted a failed-delete test into asserting success). [`helpers/once-residue.ts`](helpers/once-residue.ts) stamps every queued once-value with the test that queued it and fails the consuming test, naming the queuing line and test; its own falsification pair lives in [`once-residue-guard.test.ts`](once-residue-guard.test.ts).
  - **The rule that separates a bug from a non-bug.** Unconsumed residue is a **latent trap, not a defect**. It becomes a defect only when a later test actually consumes it. Do not sweep on the grep: re-measured on this tree, **121 of 783** test files combine a live `*Once` with a `vi.clearAllMocks()`, and **0** of them leak across a test boundary. A residue-at-teardown check (the obvious first design) fails *already-correct* code — `BlockPropertyEditor.test.tsx` leaves residue on purpose to prove its `beforeEach` `mockReset()` drains it — so the guard deliberately fires on consumption, not on residue.
  - **Coverage boundary: module-scope and `beforeAll` once-values are permanently invisible.** The tracker stamps a queued once-value with `currentTestName()`, which is `undefined` at module scope and inside `beforeAll`; a value queued there is exempted unconditionally (`queuedIn === undefined`), not just for the tick in which it was queued. That is correct for a suite-level stub genuinely meant for whichever test calls it first, but it also means a module-scope `mockReturnValueOnce` meant for test 1 and actually consumed by test 5 is never flagged — this is the one queuing site the guard cannot see a leak at, however far the value drifts from its intended caller.
  - **Which drains actually work.** `mockReset()` / `mockRestore()` on the specific mock drain the queue; so does `vi.resetAllMocks()`. `vi.clearAllMocks()` does **not**, and neither does `vi.restoreAllMocks()` for a `vi.fn()` mock — in vitest 4 that only restores `vi.spyOn` spies, so a file whose `afterEach` calls it is *not* protected. `vi.fn(impl)` restores `impl` on `mockReset()`, which is why `mockReset()` is safe on the shared `invoke` mock specifically (it is created as `vi.fn(strictInvokeFallback)`) but needs a re-seed on a bare `vi.fn()`.
  - **Where the residual risk concentrates**, if you are choosing what to harden proactively: a positional `*Once` on the shared **`invoke`** mock (64 of the 121) is worst, because that one mock multiplexes every Tauri command and an incidental IPC can steal the slot *within* the test too (#3217) — migrate those to `mockInvokeCommands`. A queued **never-settling / hand-resolved promise** (36 of the 121) is next, because if it ever does leak the victim burns the full 8s `asyncUtilTimeout` and reports a nonsense assertion. The remaining 43 queue already-settled values on single-purpose mocks.
- **Radix accessible-description guard (#1505).** Any test that renders a Radix Dialog / Sheet / AlertDialog surface without a description fails in `afterEach`. Add a `Description` (`sr-only` is fine) or pass `aria-describedby={undefined}` when one is genuinely N/A.
- **`asyncUtilTimeout`** is raised well above RTL's default so CPU-heavy `axe()` audits survive pre-push contention. See [component AGENTS.md § Timeouts](../components/__tests__/AGENTS.md#timeouts).

## Assert durable, re-queried effect — never call-shape (anti-drift)

A test for a **mutation** must assert the durable, re-queried resulting state — not merely that a mock function was called. `expect(invoke).toHaveBeenCalledWith('set_property', …)` proves the frontend *asked* for a change; it says nothing about whether the change *persisted correctly*. The mock (`src/lib/tauri-mock/`) is a hand-maintained second implementation that silently drifts from the real Rust backend, so a call-shape-only assertion passes against a mock that does the wrong thing.

- **Persist, then re-query, then assert.** Drive the action, then read the state back (`getProperty` / `getBlock` / re-fetch the store) and assert the observable result — the surviving edge, the typed column, the tombstone — not the call.
- **Cautionary example (the tag-space bug).** A test asserted `setProperty` was called with `key: 'space'` and stopped there. It never re-queried, so it never noticed the mock modeled a **retired** schema (`block_properties(key='space')`); in production the tag routed to a native column and vanished. A re-query assertion (`getTagsForBlock` after the add) would have caught it.
- **Behavioral parity is enforced by the #763 conformance harness** (`conformance/fixtures/*.json`, asserted by both the real backend and the mock) and ratcheted by [`conformance-coverage.test.ts`](../lib/tauri-mock/__tests__/conformance-coverage.test.ts) (#3083): a new state-mutating command needs a fixture or a justified waiver. See [`e2e/AGENTS.md` § The mock is a contract](../../e2e/AGENTS.md#the-mock-is-a-contract-not-a-convenience) for the workflow, and root [`AGENTS.md` § Testing invariants (anti-drift)](../../AGENTS.md#testing-invariants-anti-drift).

## Quality standards

1. **Determinism.** No random data in assertions; no date-dependent assertions without computing the expected value. Replace flaky conditional checks with deterministic queries.
2. **Isolation.** Stores reset in `beforeEach`; `vi.clearAllMocks()` on every test. `vi.useFakeTimers()` MUST pair with `vi.useRealTimers()` in `afterEach`. Tests touching `localStorage` add `localStorage.clear()` to `beforeEach`.
3. **No timing hacks.** `waitFor` / `findBy*`, not `sleep`. Debounce tests use `vi.useFakeTimers()` + `vi.advanceTimersByTime()`.
4. **Both paths.** Every store action / component interaction tests success AND error responses.
5. **Backend contract.** Verify exact `invoke` call signatures (command name, argument shape, `null` vs `undefined`).
6. **Meaningful assertions.** `toHaveBeenCalledWith` with exact args, not `toHaveBeenCalled`. `toHaveLength` with an exact count. Scoped row queries for table/list contents.
7. **i18n in tests.** Assert on `t('key')` calls, not hardcoded English. Tests then survive translation changes, and the i18n keys get validated.
8. **Zero flaky tests.** Flaky tests are bugs. Common causes: debounce races (use fake timers), render order (use `waitFor` / `findBy*`), store leaks (reset in `beforeEach`), mock ordering (`mockResolvedValueOnce` consumes in call order — and an unconsumed one survives `vi.clearAllMocks()` into the next test, see the #4211 guard above).

## Cross-references

- [`src/components/__tests__/AGENTS.md`](../components/__tests__/AGENTS.md) — component test patterns + mocking + axe + checklist.
- [`src/stores/__tests__/AGENTS.md`](../stores/__tests__/AGENTS.md) — Zustand store testing (global / per-page / undo).
- [`e2e/AGENTS.md`](../../e2e/AGENTS.md) — Playwright config, mock backend contract, portal-scoped helpers.
- Root [`AGENTS.md`](../../AGENTS.md) — top-level invariants, frontend architecture.
- [`src-tauri/tests/AGENTS.md`](../../src-tauri/tests/AGENTS.md) — Rust test conventions (separate world).
