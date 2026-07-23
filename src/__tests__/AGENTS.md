# Frontend test infrastructure — orientation

> See also: [AGENTS.md § Frontend Development Guidelines](../../AGENTS.md#frontend-development-guidelines) for component hierarchy, design system patterns, and mandatory primitives. This document is the **orientation** for the test layout; per-test-type rules live in subdirectory AGENTS.md files (linked below).

## Test layers

| Layer | Tool | Scope | Rules live in |
|-------|------|-------|---|
| Unit | Vitest | Pure functions, serializers, tree utils | this file (Quality Standards) |
| Component | Vitest + RTL | React components (happy-dom; jsdom opt-in) | [`src/components/__tests__/AGENTS.md`](../components/__tests__/AGENTS.md) |
| Store | Vitest | Zustand stores (global + per-page) | [`src/stores/__tests__/AGENTS.md`](../stores/__tests__/AGENTS.md) |
| Accessibility | vitest-axe | axe-core audit on rendered components | see component AGENTS.md |
| Property-based | fast-check | Generative fuzzing (markdown serializer, date utils) | this file |
| E2E | Playwright | Full app in Chromium against Vite dev server | [`e2e/AGENTS.md`](../../e2e/AGENTS.md) |

**Test environment.** Vitest's default DOM environment is **happy-dom** (set as `test.environment` in [`vitest.config.ts`](../../vitest.config.ts); switched from jsdom on 2026-05-16 for speed). A minority of files opt back into **jsdom** with a top-of-file `// @vitest-environment jsdom` pragma — grep `@vitest-environment jsdom` to find the current set. Reach for the pragma only when a test depends on jsdom-specific behavior happy-dom doesn't match (the documented divergence is vitest-axe's `aria-hidden-focus` rule, which fires differently under happy-dom; the virtualizer-mock component tests pin jsdom for deterministic layout). Treat the environment as the single most behavior-sensitive choice in the suite — when a test passes under one and fails under the other, the environment is the first suspect.

No vitest globals — all imports explicit (`import { describe, expect, it, vi } from 'vitest'`).

## Running tests

```bash
npm run test              # vitest run (all unit/component/a11y/property tests)
npm run test:watch        # vitest in watch mode
npm run test:coverage     # vitest with v8 coverage
npx vitest run src/stores # run tests in a specific directory
npx vitest run -t "splitBlock" # run tests matching name pattern

npm run test:e2e          # playwright test (requires dev server on :5173)
npm run test:e2e:ui       # playwright with interactive UI
```

Coverage includes `src/**/*.{ts,tsx}`; excludes test files, `main.tsx`, `test-setup.ts`.

## Test layout

```
src/
├── __tests__/              # This file. Root-level smoke + shared fixtures.
│   ├── smoke.test.ts
│   ├── boot-store.test.ts
│   ├── mocks/              # Shared vi.mock implementations (sonner, ui-select, react-virtual, …).
│   └── fixtures/index.ts   # Shared factories: makeBlock, makePage, …
├── components/__tests__/   # See AGENTS.md in this folder.
├── editor/__tests__/       # Editor logic + extensions.
├── stores/__tests__/       # See AGENTS.md in this folder.
├── hooks/__tests__/        # Hook logic.
└── lib/__tests__/          # Utility + wrapper tests.

e2e/                        # Playwright specs. See AGENTS.md in this folder.
```

**Naming:** Vitest = `.test.ts` / `.test.tsx`. Playwright = `.spec.ts`. Property-based = `.property.test.ts` (e.g. `markdown-serializer.property.test.ts`).

## Property-based testing (fast-check)

Used for the markdown serializer and date utilities. 500 iterations per property by default.

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

## DOM environment stubs

`src/test-setup.ts` polyfills APIs that Radix / shadcn / TipTap need but neither happy-dom (default) nor jsdom (opt-in) implement:

- `ResizeObserver` — no-op.
- `IntersectionObserver` — no-op (hooks needing real IO provide their own mock; see `useViewportObserver.test.ts`).
- `window.matchMedia` — returns `{ matches: false }` for all queries.
- `Element.scrollIntoView` — no-op.
- `Range.getClientRects` / `Range.getBoundingClientRect` — zero-rect stubs (required by TipTap/ProseMirror positioning).

RTL `cleanup()` registered manually in `afterEach` (vitest globals disabled).

## Assert durable, re-queried effect — never call-shape (anti-drift)

A test for a **mutation** must assert the durable, re-queried resulting state — not merely that a mock function was called. `expect(invoke).toHaveBeenCalledWith('set_property', …)` proves the frontend *asked* for a change; it says nothing about whether the change *persisted correctly*. The mock (`src/lib/tauri-mock/`) is a hand-maintained second implementation that silently drifts from the real Rust backend, so a call-shape-only assertion passes against a mock that does the wrong thing.

- **Persist, then re-query, then assert.** Drive the action, then read the state back (`getProperty` / `getBlock` / re-fetch the store) and assert the observable result — the surviving edge, the typed column, the tombstone — not the call.
- **Cautionary example (the tag-space bug).** A test asserted `setProperty` was called with `key: 'space'` and stopped there. It never re-queried, so it never noticed the mock modeled a **retired** schema (`block_properties(key='space')`); in production the tag routed to a native column and the tag vanished. A re-query assertion (`getTagsForBlock` after the add) would have caught it.
- **Behavioral parity is enforced by the #763 conformance harness** (`conformance/fixtures/*.json`, asserted by both the real backend and the mock) and ratcheted by [`src/lib/tauri-mock/__tests__/conformance-coverage.test.ts`](../lib/tauri-mock/__tests__/conformance-coverage.test.ts) (#3083): a new state-mutating command needs a fixture or a justified waiver. See root [`AGENTS.md` § Testing invariants (anti-drift)](../../AGENTS.md#testing-invariants-anti-drift).

## Quality standards

1. **Determinism.** No random data in assertions; no date-dependent assertions without computing expected values. Replace flaky conditional checks with deterministic queries.
2. **Isolation.** Stores reset in `beforeEach`; `vi.clearAllMocks()` on every test. `vi.useFakeTimers()` MUST pair with `vi.useRealTimers()` in `afterEach`. Tests using `localStorage` add `localStorage.clear()` to `beforeEach`.
3. **No timing hacks.** `waitFor` / `findBy*`, not `sleep`. Debounce tests use `vi.useFakeTimers()` + `vi.advanceTimersByTime()`.
4. **Both paths.** Every store action / component interaction tests success AND error responses.
5. **Backend contract.** Verify exact `invoke` call signatures (command name, argument shape, `null` vs `undefined`).
6. **Meaningful assertions.** `toHaveBeenCalledWith` with exact args, not `toHaveBeenCalled`. `toHaveLength(N)` with exact counts. Scoped row queries for table/list contents.
7. **i18n in tests.** Use `t('key')` calls in assertions, not hardcoded English strings. Tests don't break when translations change; i18n keys are validated.
8. **Zero flaky tests.** Flaky tests are bugs. Common causes: debounce races (use fake timers), render order (use `waitFor` / `findBy*`), store leaks (reset in `beforeEach`), mock ordering (`mockResolvedValueOnce` consumes in call order).

## Cross-references

- [`src/components/__tests__/AGENTS.md`](../components/__tests__/AGENTS.md) — component test patterns + mocking + axe + checklist.
- [`src/stores/__tests__/AGENTS.md`](../stores/__tests__/AGENTS.md) — Zustand store testing (global / per-page / undo).
- [`e2e/AGENTS.md`](../../e2e/AGENTS.md) — Playwright config, mock backend, portal-scoped helpers.
- Root [`AGENTS.md`](../../AGENTS.md) — top-level invariants, frontend architecture.
- [`src-tauri/tests/AGENTS.md`](../../src-tauri/tests/AGENTS.md) — Rust test conventions (separate world).
