# Component test patterns

> Frontend component testing. Root [`src/__tests__/AGENTS.md`](../../__tests__/AGENTS.md) covers the test-layer table, run commands, shared setup, and cross-cutting conventions. This file covers what's specific to `*.test.tsx` files in `src/components/__tests__/`.

## File structure

Every component test starts with this skeleton:

```tsx
import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { emptyPage } from '@/__tests__/fixtures'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  // Reset any global Zustand stores you touch.
  useNavigationStore.setState({ currentView: 'journal', pageStack: [], selectedBlockId: null })
  mockedInvoke.mockResolvedValue(emptyPage)
})
```

Imports are explicit — no Vitest globals. Prefer the shared `axe` wrapper in [`src/__tests__/helpers/axe.ts`](../../__tests__/helpers/axe.ts) over a bare `vitest-axe` import; it disables the `aria-hidden-focus` rule that Radix focus-guard sentinels trip under happy-dom. Import `axe` from `vitest-axe` directly only when you *want* that rule.

## Querying

Order of preference:

1. `getByRole` — buttons, tabs, inputs.
2. `getByText` — visible text content.
3. `getByPlaceholderText` — form inputs.
4. `getByTestId` — only for mocked sub-components.
5. `queryBy*` — for asserting absence.

Use `within()` whenever the same role/text appears twice (e.g. the App renders nav labels in both sidebar and header):

```tsx
const sidebar = within(document.querySelector('[data-slot="sidebar"]') as HTMLElement)
sidebar.getByText('Journal')
```

## User interaction

`userEvent`, not `fireEvent`:

```tsx
const user = userEvent.setup()
await user.click(screen.getByRole('button', { name: /New Page/i }))
```

`userEvent.setup()` must come before any DOM op (including `.focus()`). Exception: `fireEvent` for non-user events (`blur`, bypass-debounce `change`).

## Async patterns

Components that call `invoke` on mount need `findBy*` or `waitFor`:

```tsx
render(<PageBrowser />)
expect(await screen.findByText('First page')).toBeInTheDocument()
```

Loading-state tests use never-resolving promises:

```tsx
mockedInvoke.mockReturnValueOnce(new Promise(() => {}))
```

Never use `await sleep(n)` — flake painted over.

## React 19 test timing

React 19 doesn't flush updates originating outside React's event system within a bare `await Promise(...)` tick. Three fixes — pick whichever matches the assertion style:

```tsx
// External-source wait wrapped in act:
await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
expect(onWorkerError).toHaveBeenCalled()

// Switch sync getByText → async findByText:
expect(await screen.findByText('Loaded')).toBeInTheDocument()

// waitFor on the observable end state:
await waitFor(() => {
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument()
})
```

Reference sites: `useGraphSimulation.test.ts` (act around worker dispatch), `SearchPanel.test.tsx` (act around `advanceTimersByTime`), `BacklinkFilterBuilder.test.tsx` (waitFor on a Radix popover label).

## Timeouts

The defaults are already generous and are set in config, not per test — read them there rather than assuming RTL/Vitest stock values:

- `waitFor` / `findBy*` — `asyncUtilTimeout` in [`src/test-setup.ts`](../../test-setup.ts), raised so a CPU-heavy `axe()` audit survives pre-push contention (vitest runs concurrently with `cargo nextest`).
- Per-test and per-hook — `testTimeout` / `hookTimeout` in [`vitest.config.ts`](../../../vitest.config.ts).

Because of that, an explicit `waitFor(..., { timeout: n })` or trailing `it(..., n)` **lowers** the ceiling as often as it raises it. Add one only when it genuinely helps a load-sensitive path (axe cold-load per worker; Radix popover `onPointerDown → setTimeout → setState → re-render` chains), and never to paper over a regression.

## Helper factories

Shared factories at `src/__tests__/fixtures/index.ts` (`makeBlock`, `makePage`, `makeDailyPage`, `makeHistoryEntry`, `emptyPage`):

```ts
import { makeBlock, makePage, emptyPage } from '@/__tests__/fixtures'
makeBlock({ id: 'BLK_1', content: 'hello' })  // Partial<T> override
```

When the shared factory doesn't exist, add it to `fixtures/index.ts` rather than defining it locally — the next file will need it too.

## Accessibility — every file gets an axe audit

The `axe-presence` prek hook enforces this. Pattern:

```tsx
it('has no a11y violations', async () => {
  const { container } = render(<MyComponent />)
  await waitFor(async () => {
    expect(await axe(container)).toHaveNoViolations()
  })
})
```

`src/test-setup.ts` extends matchers with `vitest-axe/matchers`. Components with multiple visual states (focused vs unfocused) get separate audits per state.

Related: `src/test-setup.ts` fails any test that renders a Radix Dialog/Sheet/AlertDialog surface without an accessible description (#1505).

## Mocking

### Tauri IPC

`src/test-setup.ts` globally mocks `@tauri-apps/api/core`. That is the lowest layer, so the same mock intercepts calls routed through the `@/lib/tauri/*` wrappers and calls made directly against the generated `@/lib/bindings` commands — assert on the `invoke` command name and argument shape either way. Override per test:

```ts
mockedInvoke.mockResolvedValueOnce(payload)
mockedInvoke.mockRejectedValueOnce(new Error('backend'))
mockedInvoke.mockImplementation(async (cmd) => cmd === 'get_status' ? statusPayload : emptyPage)
```

The `ipc-error-path-coverage` prek hook requires every component-that-invokes test file to carry at least one `mockRejectedValue*` / `Promise.reject` / `throw` test.

### Component mocks

Heavy dependencies (TipTap, child components) mocked at module level:

```tsx
vi.mock('@tiptap/react', () => ({
  EditorContent: ({ editor }: { editor: unknown }) =>
    editor != null ? <div data-testid="editor-content">TipTap Editor</div> : null,
}))
```

### Virtualized lists (`@tanstack/react-virtual`)

The DOM environment gives the scroll container zero height, so the real
`useVirtualizer` lays out zero rows and the list renders empty. Use the shared
factory in [`src/__tests__/mocks/react-virtual.ts`](../../__tests__/mocks/react-virtual.ts)
instead of re-pasting the mock (#762):

```ts
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'

// Default: render every row, honest summed total height.
vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

// Windowed (only the first N rows mount — overflow/perf tests):
vi.mock('@tanstack/react-virtual', () => mockReactVirtual({ windowSize: 80 }))

// Capture scroll / estimate calls (pass vi.hoisted spies so the factory stays
// hoist-safe):
const { scrollToOffset } = vi.hoisted(() => ({ scrollToOffset: vi.fn() }))
vi.mock('@tanstack/react-virtual', () => mockReactVirtual({ scrollToOffset }))
```

A getter `windowSize: () => currentWindow` is supported for files that mutate
the window between tests.

### Toast (sonner) and Radix Select

Both are mocked **globally** in `src/test-setup.ts` from the shared
implementations in `src/__tests__/mocks/` (`sonner.ts`, `ui-select.tsx`), so a
test that just needs them not to crash does nothing. To assert on toast calls,
import `toast` from `sonner` directly and `vi.mocked(...)` it; a per-file
`vi.mock('sonner', …)` / `vi.mock('@/components/ui/select', …)` still overrides
the shared mock when custom capture is needed:

```ts
const mockedToastError = vi.mocked(toast.error)
expect(mockedToastError).toHaveBeenCalledWith(expect.stringContaining('Failed to load'))
```

The `no-direct-sonner-import` prek hook enforces routing through `@/lib/notify` in production code; tests can import `sonner` directly to assert.

## File checklist

Before committing a new test file, verify:

- Explicit imports (no Vitest globals).
- `beforeEach` resets `vi.clearAllMocks()` + relevant Zustand stores.
- At least one happy-path test.
- At least one error-path test (`mockRejectedValueOnce`). Required by `ipc-error-path-coverage` if the component invokes Tauri.
- Axe audit. Required by `axe-presence`.
- Async expectations use `findBy*` / `waitFor`, never bare `setTimeout`.
- React 19 timing handled where external sources update state (see § React 19 test timing).
- `vi.mocked(invoke)` for Tauri; `mockResolvedValueOnce` / `mockRejectedValueOnce` per call.
- Per-page stores created fresh in `beforeEach`; provider wrapper used when the component reads them.
- `userEvent` for user-initiated actions; `fireEvent` only for `blur` / debounce-bypass.
- `within()` scoping when the same role/text appears twice.

## Assert durable, re-queried effect — never call-shape (anti-drift)

When a component interaction **mutates backend state**, `expect(invoke).toHaveBeenCalledWith('set_property', …)` is not enough — it proves the component *asked* for the change, not that the change *persisted correctly*, and the tauri mock is a hand-maintained second implementation that drifts from the real backend. Assert the observable, re-queried result instead: re-render / re-fetch and assert the block, chip, or field the user would see. The tag-space bug shipped exactly this way.

Full rule, cautionary example, and the conformance harness that enforces mock↔backend parity: root [`AGENTS.md` § Testing invariants (anti-drift)](../../../AGENTS.md#testing-invariants-anti-drift) and [`e2e/AGENTS.md` § The mock is a contract](../../../e2e/AGENTS.md#the-mock-is-a-contract-not-a-convenience).

## Test-asserted production patterns

These are caught by tests but the rules are about how the **production code** must be written. Each one came from a real bug.

1. **Capture state before async gaps.** A handler that reads editor or store state must read it BEFORE any `await` — after the await the user may have typed more, selection may have moved, another handler may have fired. `const pos = editor.state.selection.from; const blockId = store.getState().focusedBlockId; await createBlock(...)`.
2. **Re-entrancy in async handlers.** Fast double-click / double-Enter can invoke an async handler twice before the first completes. Guard with a ref: `if (inProgress.current) return; inProgress.current = true; try { … } finally { inProgress.current = false }`. Tests verify rapid double-invocation doesn't produce duplicates.
3. **Re-entrancy guard refs must be hook/component level.** `useRef` at the top, not inside a non-hook function — declaring it inside a regular function recreates the ref on every call.
4. **Optimistic edits need rollback.** `edit()` must capture `previousContent` before the update; on backend failure, roll back and show a toast. Tests must cover the rejection path.
5. **`flushSync()` ordering in editor blur.** When `handleBlur` calls `edit()` then `splitBlock()`, the store update must complete before React unmounts the editor. Wrap both calls in `flushSync()`.
6. **`onPointerDown` vs `onClick` for timing-sensitive buttons.** Buttons that must fire before a focus/blur cycle (e.g. delete in a hover gutter) use `onPointerDown` with an `onClick` fallback for keyboard. Pure `onClick` can leave the button unreachable as focus moves.
7. **Capture-phase keydown on `parentElement`.** Handlers that must fire BEFORE ProseMirror (e.g. Enter for block splitting) attach to `parentElement` with `capture: true` + `stopPropagation()`. Direct listeners on the editor element race with ProseMirror.
8. **Keyboard handlers must yield to popups.** Capture-phase listeners (Enter / Tab / Escape / Backspace) must check whether a suggestion popup is visible before intercepting, or they steal keystrokes.
9. **`shouldSplitOnBlur()` not a naive newline check.** `handleBlur` must NOT use `content.includes('\n')` — code blocks contain newlines that aren't split boundaries.
10. **Early-persist in `useEditorBlur` must check `shouldSplitOnBlur()`.** The early-persist path falls through to the normal blur logic; if content has newlines, both `edit()` and `splitBlock()` run → duplicate ops.
11. **New editor-area overlays must carry `data-editor-portal`.** Menus, pickers, and toolbars that mount inside the editor area opt out of blur-on-focus-loss by tagging their outermost portal element with `data-editor-portal=""` (matched by `EDITOR_PORTAL_SELECTOR` in `src/hooks/useEditorBlur.ts`). Untagged overlays fire `handleBlur` prematurely when clicked.
12. **Radix Dialog vs AlertDialog for user input.** Use `Dialog` for modals with text inputs; `AlertDialog` traps focus in a way that makes `autoFocus` on inputs unreliable. `ConfirmDialog` uses `AlertDialog` (confirm/cancel only).
13. **Guard `Array.isArray()` on IPC responses.** Some Tauri commands may return non-array values on unexpected backend types; guard before `.map()`.
14. **Hook dep arrays must include all read variables.** Use `oxlint-disable-next-line react-hooks/exhaustive-deps` with a justification only when intentionally omitting.
15. **Map/object merge order for cache updates.** Spread fresh data LAST: `new Map([...staleCache, ...freshData])`. Stale-last silently overwrites fresh with stale.
16. **Stores start `loading: true` for fetch-on-mount.** Starting `loading: false` causes a brief empty/ready render before the fetch begins, triggering child components to act on empty data.
17. **Prefer individual Zustand selectors.** `useBlockStore(s => s.focusedBlockId)`, not `const { focusedBlockId } = useBlockStore()`. Destructuring subscribes to the entire store; it matters for per-block components rendered N times.
18. **Draft autosave race.** `saveDraft()` and `discardDraft()` can race on editor blur. Version counter: capture the version before the async call; if it incremented, silently drop.
19. **`null` vs `undefined` in Tauri args.** Tauri 2 requires `null` for Rust `Option<T>`, not `undefined`. The per-domain wrappers under `src/lib/tauri/` normalize this with `?? null` before calling the generated bindings.

## Common test pitfalls

1. **Store leaks.** Zustand stores are module-level singletons. Forgetting a `setState` reset in `beforeEach` causes test-order-dependent failures.
2. **TipTap doesn't render in the test DOM.** Mock `@tiptap/react`.
3. **Sidebar query scoping.** Nav labels appear in both sidebar and header. Use `within()`.
4. **Debounce in tests.** SearchPanel debounces 300ms. Either submit the form directly to bypass it, or `vi.useFakeTimers()` + `vi.advanceTimersByTime(300)` inside `act()`.
5. **`mockResolvedValue` vs `mockResolvedValueOnce`.** Components calling `invoke` multiple times need chained `Once` in call order. Use plain `mockResolvedValue` only when all calls return the same value.
6. **`afterEach` for fake timers.** `vi.useFakeTimers()` REQUIRES `vi.useRealTimers()` in `afterEach`, else subsequent tests break.
7. **Component extraction requires regression verification.** When extracting hooks/components from a large file, each extracted piece needs its own test file. Maintain backward-compatible re-exports from the original.
