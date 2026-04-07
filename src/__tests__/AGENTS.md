# Frontend Test Infrastructure

## Overview

Five test layers, each with distinct tools:

| Layer | Tool | Scope |
|-------|------|-------|
| Unit | Vitest | Pure functions, serializers, tree utils |
| Component | Vitest + @testing-library/react | React components in jsdom |
| Accessibility | vitest-axe | axe-core audit on rendered components |
| Property-based | fast-check | Generative fuzzing (markdown serializer) |
| E2E | Playwright | Full app in Chromium against Vite dev server |

Vitest runs in **jsdom** environment. No vitest globals — all imports are explicit (`import { describe, expect, it, vi } from 'vitest'`).

## Running Tests

```bash
npm run test              # vitest run (all unit/component/a11y/property tests)
npm run test:watch        # vitest in watch mode
npm run test:coverage     # vitest with v8 coverage (text + json + html)
npx vitest run src/stores # run tests in a specific directory
npx vitest run -t "splitBlock" # run tests matching name pattern

npm run test:e2e          # playwright test (requires dev server on :5173)
npm run test:e2e:ui       # playwright with interactive UI
```

Coverage includes `src/**/*.{ts,tsx}`, excludes test files, `main.tsx`, and `test-setup.ts`.

## Test Organization

```
src/
├── __tests__/                    # Root-level store & smoke tests
│   ├── smoke.test.ts
│   └── boot-store.test.ts
├── components/__tests__/         # Component tests (.test.tsx)
│   ├── App.test.tsx
│   ├── PageBrowser.test.tsx
│   ├── EditableBlock.test.tsx
│   ├── SearchPanel.test.tsx
│   └── ... (17 component test files)
├── editor/__tests__/             # Editor logic tests
│   ├── markdown-serializer.test.ts        # Example-based
│   ├── markdown-serializer.property.test.ts # fast-check
│   ├── extensions.test.ts
│   ├── use-block-keyboard.test.ts
│   └── ...
├── stores/__tests__/             # Zustand store tests
│   ├── blocks.test.ts
│   └── navigation.test.ts
├── hooks/__tests__/              # Hook tests
│   └── useViewportObserver.test.ts
├── lib/__tests__/                # Utility & wrapper tests
│   ├── tauri.test.ts             # Invoke wrapper contract tests
│   ├── tauri-mock.test.ts        # Mock layer tests
│   └── tree-utils.test.ts
e2e/
├── smoke.spec.ts                 # App load, nav items, no console errors
└── editor-lifecycle.spec.ts      # CRUD blocks, navigation, deletion
```

**Naming:** Vitest files use `.test.ts` / `.test.tsx`. Playwright files use `.spec.ts`. Property-based tests add `.property` before `.test` (e.g., `markdown-serializer.property.test.ts`).

## Writing Component Tests

### File structure

Every component test file follows this pattern:

```tsx
import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
  // Reset relevant Zustand stores
  useNavigationStore.setState({ currentView: 'journal', pageStack: [], selectedBlockId: null })
  // Set default mock responses
  mockedInvoke.mockResolvedValue(emptyPage)
})
```

### Querying

Prefer accessible queries in this order:
1. `getByRole` — buttons, tabs, inputs (primary choice)
2. `getByText` — visible text content
3. `getByPlaceholderText` — form inputs
4. `getByTestId` — only for mocked sub-components (e.g., `data-testid="editor-content"`)
5. `queryBy*` — for asserting absence (`expect(screen.queryByText('x')).not.toBeInTheDocument()`)

For scoped queries within a DOM subtree, use `within()`:
```tsx
const sidebar = within(document.querySelector('[data-slot="sidebar"]') as HTMLElement)
sidebar.getByText('Journal')
```

### User interaction

Always use `userEvent` (not `fireEvent`) for user-initiated actions:
```tsx
const user = userEvent.setup()
await user.click(screen.getByRole('button', { name: /New Page/i }))
```

Exception: `fireEvent` is used for non-user-initiated events like `blur`, or when you need to bypass debounce:
```tsx
fireEvent.blur(wrapper as Element)
fireEvent.change(input, { target: { value: 'query' } })
```

### Async patterns

Components that call `invoke` on mount need `waitFor` or `findBy*`:
```tsx
render(<PageBrowser />)
expect(await screen.findByText('First page')).toBeInTheDocument()
```

For testing loading states, use never-resolving promises:
```tsx
mockedInvoke.mockReturnValueOnce(new Promise(() => {}))
render(<PageBrowser />)
const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
expect(skeletons.length).toBe(3)
```

### Helper factories

Shared fixture factories live in `src/__tests__/fixtures/index.ts` — use these instead of per-file definitions:
```ts
import { makeBlock, makePage, makeConflict, makeDailyPage, emptyPage } from '../fixtures'

makeBlock({ id: 'BLK_1', content: 'hello' })  // Partial<T> override — everything else gets defaults
makePage({ id: 'PAGE_1' })
```

Per-file `make*` helpers are acceptable only for component-specific structures not in the shared module. When the shared factory doesn't exist yet, add it to `fixtures/index.ts` rather than defining it locally — the next test file will need it too.

## Accessibility Testing

**Every component test file includes an axe audit.** The pattern:

```tsx
it('has no a11y violations', async () => {
  const { container } = render(<MyComponent />)
  await waitFor(async () => {
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
```

Setup in `src/test-setup.ts` extends vitest matchers with `vitest-axe/matchers` and imports `vitest-axe/extend-expect`, making `toHaveNoViolations()` available globally.

Components with multiple visual states (e.g., `EditableBlock` focused vs unfocused) get separate axe audits for each state.

## Property-Based Testing (fast-check)

Used for the markdown serializer (`src/editor/__tests__/markdown-serializer.property.test.ts`). Each property runs 500 iterations by default.

### Arbitrary generators

Custom arbitraries model the domain:
```ts
const arbText = fc.array(fc.constantFrom(...'abcXY 012*`#[\\]'.split('')), { minLength: 1, maxLength: 8 })
  .map(chars => chars.join(''))

const arbMarks = fc.subarray([{ type: 'bold' }, { type: 'italic' }, { type: 'code' }])
  .filter(marks => {
    if (marks.some(m => m.type === 'code')) return marks.length === 1
    return true
  })
```

Generators are composed bottom-up: `arbTextNode` → `arbInlineNode` → `arbParagraph` → `arbDoc`.

### Property categories

1. **Safety** — `parse` never throws for any string, `serialize` never throws for any valid doc
2. **Round-trip stability** — `serialize(parse(s))` is a fixed point; `serialize(parse(serialize(parse(s)))) === serialize(parse(s))`
3. **Content preservation** — ULID tokens and text survive round-trips
4. **Structural invariants** — parse always produces `doc` with `paragraph` children; text nodes are non-empty

### Normalization

Generated docs may have adjacent text nodes with identical marks that the parser would merge. The `normalizeDoc()` helper merges these before comparison.

## Store Testing (Zustand)

### Global stores (useBlockStore, useNavigationStore, etc.)

Global singleton stores are tested by directly calling `getState()` and `setState()` — no React rendering needed.

```ts
beforeEach(() => {
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [], pendingFocusId: null })
  vi.clearAllMocks()
})

it('sets the focused block id', () => {
  useBlockStore.getState().setFocused('BLOCK_A')
  expect(useBlockStore.getState().focusedBlockId).toBe('BLOCK_A')
})
```

### Per-page block store (PageBlockStore)

Per-page stores use the `createPageBlockStore(pageId)` factory — each test gets a fresh instance:

```ts
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '../page-blocks'
import type { StoreApi } from 'zustand'

let store: StoreApi<PageBlockState>

beforeEach(() => {
  store = createPageBlockStore('PAGE_1')
  vi.clearAllMocks()
})

it('loads blocks from the backend', async () => {
  mockedInvoke.mockResolvedValueOnce({ items: [...], next_cursor: null, has_more: false })
  await store.getState().load()
  expect(store.getState().blocks).toHaveLength(2)
})
```

Components that use per-page store hooks (`usePageBlockStore`, `usePageBlockStoreApi`) need a provider wrapper:

```tsx
let pageStore: StoreApi<PageBlockState>

beforeEach(() => {
  pageStore = createPageBlockStore('PAGE_1')
})

function renderWithStore(ui: React.ReactElement) {
  return render(
    <PageBlockContext.Provider value={pageStore}>
      {ui}
    </PageBlockContext.Provider>
  )
}
```

### Key conventions

- **Global stores: reset in `beforeEach`** — singletons, state leaks between tests otherwise
- **Per-page stores: create fresh in `beforeEach`** — each test gets its own instance, no leak risk
- Use **deferred promises** to observe intermediate states (loading, recovering)
- Use `useBootStore.subscribe()` to capture state transition sequences
- Test both success and error paths — verify state doesn't change on backend error

The navigation store (`navigation.test.ts`) tests are pure state machines — no mocks needed, just `setState` and `getState`.

### Undo/redo store (useUndoStore)

Per-page undo state lives in a `Map<string, PageUndoState>` keyed by page ID. Each page tracks `undoDepth`, `redoStack`, and `redoGroupSizes` independently. Tests:

```ts
// Reset per-page state, not global
useUndoStore.setState({ pages: new Map() })
```

**Batch grouping (200ms window):** Consecutive ops within 200ms by the same device are grouped — a single Ctrl+Z undoes the entire group. Tests use `makeHistoryEntry()` with specific timestamps:
```ts
// Ops 50ms apart → grouped (1 undo undoes both)
// Ops 201ms apart → separate groups
// Device change → breaks group even within window
```

**Optimistic update + rollback:** `undo()` increments `undoDepth` immediately. If the backend `undoPageOp` call fails, the depth is rolled back. Tests must verify both the optimistic state and the rollback:
```ts
mockedInvoke.mockRejectedValueOnce(new Error('backend'))
await store.getState().undo('PAGE_1')
expect(store.getState().pages.get('PAGE_1')?.undoDepth).toBe(0) // rolled back
```

**Integration with page-blocks store:** Every mutation (`createBelow`, `edit`, `remove`) calls `onNewAction(pageId)` on success, which clears the redo stack. Tests verify this notification happens on success but **not** on backend error.

**Key helpers:** `makeUndoResult()` (mock UndoResult), `makeHistoryEntry()` (mock HistoryEntry for batch tests). Mocked commands: `undoPageOp`, `redoPageOp`, `listPageHistory`.

## E2E Testing (Playwright)

### Configuration

- **Test dir:** `e2e/`
- **Browser:** Chromium only
- **Base URL:** `http://localhost:5173`
- **Dev server:** auto-started via `npm run dev`, reused if already running
- **Retries:** 2 on CI, 0 locally
- **Workers:** 1 on CI, auto locally
- **Tracing:** on first retry

### Mock backend

E2E tests run against the **Vite dev server** (not the Tauri app). The browser mock (`src/lib/tauri-mock.ts`) auto-activates when `window.__TAURI_INTERNALS__` is absent, providing an in-memory store with seed data. State resets on page reload — tests use `page.reload()` to verify isolation.

### Patterns

```ts
test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('header').getByText('Journal')).toBeVisible()
})

test('creates a block via the input form', async ({ page }) => {
  const input = page.getByPlaceholder('Write something...')
  await input.fill('Hello, world!')
  await input.press('Enter')
  await expect(page.getByText('Hello, world!')).toBeVisible()
})
```

E2E tests verify full user flows: create, delete, navigate, persist across view switches, handle special characters. No page objects — tests are flat and direct.

### Undo/redo E2E helpers

Undo/redo E2E tests need two helpers because Ctrl+Z behaves differently depending on focus:

- **`blurEditors(page)`** — press Escape to leave `contentEditable` focus. Without this, Ctrl+Z triggers ProseMirror's in-editor undo instead of the page-level `useUndoShortcuts` handler.
- **`reopenPage(page)`** — navigate away and back to force a `BlockTree` re-fetch from the mock backend, confirming the undo actually persisted (not just visual).
- Wait for `"Undone"` / `"Redone"` toast text to confirm the action fired before asserting on block count.

### Console error check

```ts
test('no console errors on load', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  await page.goto('/')
  const realErrors = errors.filter(e => !e.includes('favicon'))
  expect(realErrors).toEqual([])
})
```

## Mocking

### Tauri IPC (global)

`src/test-setup.ts` globally mocks `@tauri-apps/api/core`:
```ts
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
```

Every test accesses it via:
```ts
const mockedInvoke = vi.mocked(invoke)
```

Override per-test with `mockResolvedValueOnce` / `mockRejectedValueOnce`. Use `mockImplementation` when different commands need different responses:
```ts
mockedInvoke.mockImplementation(async (cmd: string) => {
  if (cmd === 'get_status') return { foreground_queue_depth: 0, ... }
  return emptyPage
})
```

### Component mocks

Heavy dependencies (TipTap, child components) are mocked at the module level:
```tsx
vi.mock('@tiptap/react', () => ({
  EditorContent: ({ editor }: { editor: unknown }) =>
    editor != null ? <div data-testid="editor-content">TipTap Editor</div> : null,
}))

vi.mock('../StaticBlock', () => ({
  StaticBlock: ({ blockId, content, onFocus }) => (
    <button data-testid={`static-block-${blockId}`} onClick={() => onFocus(blockId)}>
      {content}
    </button>
  ),
}))
```

### Toast mocking

Components using `sonner` toast get it mocked:
```ts
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const mockedToastError = vi.mocked(toast.error)
// ...
expect(mockedToastError).toHaveBeenCalledWith(expect.stringContaining('Failed to load pages'))
```

### Browser mock (tauri-mock.ts)

`src/lib/tauri-mock.ts` provides a full in-memory IPC handler for browser development and E2E tests. It's NOT used in Vitest component tests (those use `vi.mock` directly).

The mock has its own test suite (`src/lib/__tests__/tauri-mock.test.ts`) that captures the IPC handler and tests it in isolation:
```ts
vi.mock('@tauri-apps/api/mocks', () => ({
  mockIPC: vi.fn((handler) => { ipcHandler = handler }),
  mockWindows: vi.fn(),
}))
```

Exports `SEED_IDS` for deterministic test data references and `resetMock()` for test cleanup.

## jsdom Stubs

`src/test-setup.ts` polyfills APIs missing from jsdom that Radix UI / shadcn/ui / TipTap need:
- `ResizeObserver` — no-op stub
- `IntersectionObserver` — no-op stub (hooks that need real IO behavior provide their own mock, e.g., `useViewportObserver.test.ts`)
- `window.matchMedia` — returns `{ matches: false }` for all queries
- `Element.scrollIntoView` — no-op stub (jsdom doesn't implement scrolling)
- `Range.getClientRects` / `Range.getBoundingClientRect` — return empty/zero-rect stubs (required by TipTap/ProseMirror positioning)

RTL `cleanup()` is registered manually in `afterEach` since vitest globals are disabled.

## Quality Standards

1. **Determinism** — no random data in assertions, no date-dependent assertions without computing expected values
2. **Isolation** — stores reset in `beforeEach`, `vi.clearAllMocks()` on every test, cleanup after `vi.useFakeTimers()` with `vi.useRealTimers()` in `afterEach`
3. **No timing hacks** — use `waitFor` / `findBy*` instead of `sleep`. Debounce tests use `vi.useFakeTimers()` + `vi.advanceTimersByTime()`
4. **Both paths** — every store action and component interaction tests success AND error responses
5. **Backend contract** — tests verify exact `invoke` call signatures (command name, argument shape, null vs undefined)
6. **Meaningful assertions** — `toHaveBeenCalledWith` with exact args, not just `toHaveBeenCalled`
7. **Zero flaky tests** — Flaky tests are bugs. Tests must pass 100% of the time. Common causes and fixes:
   - **Debounce races** — use `vi.useFakeTimers()` + `vi.advanceTimersByTime()` for debounced inputs. Never rely on real wall-clock timing.
   - **Render order** — use `waitFor` / `findBy*` for async state updates. Never assert synchronously after an async action.
   - **Store leaks** — always reset Zustand stores in `beforeEach`. Missing resets cause test-order-dependent failures.
   - **Mock ordering** — `mockResolvedValueOnce` consumes in call order. If a component calls `invoke` multiple times on mount, chain `Once` calls in the right order or use `mockImplementation` with command dispatch.

## Common Pitfalls

1. **Null vs undefined in Tauri args** — Tauri 2 requires `null` for Rust `Option<T>`, not `undefined`. The wrapper functions in `src/lib/tauri.ts` handle this with explicit `?? null` defaults. Tests verify this contract.

2. **Store leaks between tests** — Zustand stores are module-level singletons. Forgetting `useBlockStore.setState({...})` in `beforeEach` will cause test-order-dependent failures.

3. **TipTap in jsdom** — TipTap doesn't render in jsdom. Components using `EditorContent` must mock `@tiptap/react`. The `EditableBlock` pattern shows how.

4. **Sidebar query scoping** — The App component renders nav labels in both the sidebar and header. Use `within()` to scope queries: `within(sidebarEl).getByText('Journal')`.

5. **Debounce in tests** — `SearchPanel` has a 300ms debounce. Tests that type and immediately assert will fail. Either: (a) submit the form directly to bypass debounce, or (b) use `vi.useFakeTimers()` + `vi.advanceTimersByTime(300)`.

6. **Never-resolving promises for loading states** — `new Promise(() => {})` is the pattern for testing skeleton/loading UI. The promise never settles, keeping the component in loading state.

7. **`mockResolvedValue` vs `mockResolvedValueOnce`** — Components that call `invoke` multiple times (boot + data load) need chained `.mockResolvedValueOnce()` calls in the right order. Use `mockResolvedValue` (no `Once`) only when all calls should return the same value.

8. **Property-based test filtering** — Some `arbDoc` values contain text with delimiter characters that create structural ambiguity on round-trip. The `hasStructuralAmbiguity()` filter skips these for structural equality checks, but content preservation is still verified.

9. **`afterEach` for fake timers** — Any test using `vi.useFakeTimers()` must restore with `vi.useRealTimers()` in `afterEach`, or subsequent tests will break.

10. **Capture state before async gaps** — If a handler reads editor state or store state, read it *before* any `await`. After the await, the user may have typed more, another handler may have fired, or the selection may have moved. Pattern: `const pos = editor.state.selection.from; const blockId = store.getState().focusedBlockId; await createBlock(...); insertContentAt(pos, ...)`. This caused real bugs in input rules and block keyboard handlers.

11. **Re-entrancy in async handlers** — Fast double-click or double-Enter can invoke an async handler twice before the first completes, creating duplicate blocks or duplicate operations. Guard with a ref: `if (inProgress.current) return; inProgress.current = true; try { ... } finally { inProgress.current = false }`. Tests should verify that rapid double-invocation doesn't produce duplicates.

12. **Store initial state should be `loading: true`** — Stores/slices that fetch data on mount must initialize with `loading: true`, not `false`. Starting with `loading: false` causes a brief render of the "empty/ready" state before the fetch begins, which can trigger child components to act on empty data (e.g., BlockTree rendering zero blocks, then flickering when data arrives).

13. **Map/object merge order for cache updates** — When merging fresh data into a cache, spread fresh data *last*: `new Map([...staleCache, ...freshData])`. Spreading the stale cache last (`new Map([...freshData, ...staleCache])`) silently overwrites fresh entries with stale ones. Tests for cache-updating store actions should verify that fetched data actually overwrites existing entries.

14. **Keyboard handlers must yield to popups** — Capture-phase keyboard listeners (Enter, Tab, Escape, Backspace) in block handlers must check whether a suggestion popup (tag picker, block link picker, slash command) is visible before intercepting. Without this, the handler steals keystrokes from the popup — e.g., Enter confirms the popup selection but also splits the block.

15. **Prefer individual Zustand selectors over destructuring** — Use `useBlockStore(s => s.focusedBlockId)` instead of `const { focusedBlockId } = useBlockStore()`. Destructuring subscribes to the entire store, causing re-renders on any state change. Individual selectors only re-render when the selected slice changes. This matters for components rendered per-block (N instances).

16. **`flushSync()` ordering in editor blur** — When `handleBlur` calls `edit()` then `splitBlock()`, the store update must complete before React unmounts the editor. Wrap both calls in `flushSync()` to force synchronous rendering. Without it, the store renders after the editor unmounts, and the edit is lost. Tests should verify call ordering (edit before split, both before unmount).

17. **Component extraction requires regression verification** — When extracting hooks/components from a large file (e.g., BlockTree → useBlockCollapse, useBlockZoom, BlockListRenderer), each extracted piece needs its own test file. After extraction, run the full test suite to verify no regressions. The M-1 BlockTree refactor (1184→1028 lines) verified 262 tests across 8 extracted modules.

## Known Test Coverage Gaps

Open items in `REVIEW-LATER.md` that represent known untested areas. Reference these when working on related features:

- **T-6:** 5 journal view components have zero test coverage (`DailyView`, `AgendaView`, `DaySection`, `WeeklyView`, `MonthlyView`); 3 test files missing axe audits; 86/104 component test files lack error path tests with `mockRejectedValue`
- **B-7..B-13:** Editor lifecycle bugs with test implications — whitespace-click discards edits, Escape discards edits when editor DOM-unfocused, `handleBlur` naive newline check for split detection (false splits on code blocks), no rollback on optimistic edit failure, sync reload overwrites store during active editing, `unmount()` has no error boundary around `serialize()`, draft autosave race between save and discard
- **B-15:** `BlockContextMenu` missing from `EDITOR_PORTAL_SELECTORS` — blur fires when clicking context menu
