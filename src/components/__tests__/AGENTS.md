# Component test patterns

> Root [`src/__tests__/AGENTS.md`](../../__tests__/AGENTS.md) covers layers, commands, shared setup, naming, and quality standards. This file covers `src/components/__tests__/*.test.tsx`.

## File structure

Every component test starts with this skeleton:

```tsx
import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { emptyPage } from '@/__tests__/fixtures'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  // Reset any global Zustand store you touch — they are module singletons.
  useNavigationStore.setState({ currentView: 'journal', selectedBlockId: null })
  mockedInvoke.mockImplementation(mockInvokeCommands({ list_pages: () => [emptyPage] }))
})
```

Import `axe` from [`src/__tests__/helpers/axe.ts`](../../__tests__/helpers/axe.ts), not `vitest-axe`; the wrapper disables the `aria-hidden-focus` rule that Radix focus-guard sentinels trip under happy-dom. Factories (`makeBlock`, `makePage`, `makeDailyPage`, `makeHistoryEntry`, `emptyPage`) live in `src/__tests__/fixtures/index.ts`; add missing ones there, not locally.

## Querying

Prefer `getByRole`, then `getByText`, `getByPlaceholderText`, `getByTestId` (mocked sub-components only); `queryBy*` for absence. Scope with `within()` when a role/text appears twice (nav labels render in both sidebar and header): `within(document.querySelector('[data-slot="sidebar"]') as HTMLElement).getByText('Journal')`.

## User interaction

`userEvent`, not `fireEvent`; call `userEvent.setup()` before any DOM op, including `.focus()`. `fireEvent` only for non-user events (`blur`, a debounce-bypassing `change`).

## Async patterns

Components that `invoke` on mount need `findBy*` / `waitFor`: `expect(await screen.findByText('First page')).toBeInTheDocument()`. Loading states: `mockedInvoke.mockReturnValueOnce(new Promise(() => {}))`. Debounced inputs (SearchPanel, 300 ms): submit the form directly, or `vi.useFakeTimers()` + `vi.advanceTimersByTime(300)` inside `act()`. Never `await sleep(n)`.

## React 19 test timing

React 19 does not flush updates that originate outside its event system (workers, timers, IPC callbacks) within a bare `await` tick. Three fixes, by assertion style:

```tsx
// External-source wait wrapped in act:
await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
expect(onWorkerError).toHaveBeenCalled()

// Sync getByText → async findByText:
expect(await screen.findByText('Loaded')).toBeInTheDocument()

// waitFor on the observable end state:
await waitFor(() => {
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument()
})
```

Reference sites: `useGraphSimulation.test.ts` (act, worker), `SearchPanel.test.tsx` (act, timers), `BacklinkFilterBuilder.test.tsx` (waitFor, Radix popover).

## Timeouts

Set in config, not per test: `asyncUtilTimeout` in [`src/test-setup.ts`](../../test-setup.ts) (raised so `axe()` survives pre-push contention with `cargo nextest`), `testTimeout` / `hookTimeout` in [`vitest.config.ts`](../../../vitest.config.ts). An explicit `waitFor(..., { timeout: n })` or `it(..., n)` lowers the ceiling as often as it raises it; add one only for axe cold-load or a Radix popover `onPointerDown → setTimeout → setState` chain, never to paper over a regression.

## Accessibility — every file gets an axe audit

Required by the `axe-presence` prek hook:

```tsx
it('has no a11y violations', async () => {
  const { container } = render(<MyComponent />)
  await waitFor(async () => {
    expect(await axe(container)).toHaveNoViolations()
  })
})
```

One audit per distinct visual state (focused / unfocused, open / closed). `src/test-setup.ts` also fails any test rendering a Radix Dialog / Sheet / AlertDialog without an accessible description (#1505).

## Mocking

### Tauri IPC

`src/test-setup.ts` mocks `@tauri-apps/api/core` globally, below the `@/lib/tauri/*` wrappers and `@/lib/bindings`, so one mock intercepts both. Stub per command with `mockInvokeCommands` (root § Shared setup); an unstubbed command rejects. Positional `mockResolvedValueOnce` / `mockRejectedValueOnce` queues drain in call order regardless of command — single-call tests only.

The `ipc-error-path-coverage` prek hook requires every test file for a component that invokes Tauri to carry at least one `mockRejectedValue*` / `Promise.reject` / `throw` test.

### Component mocks

TipTap does not render in the test DOM; mock it and other heavy children at module level:

```tsx
vi.mock('@tiptap/react', () => ({
  EditorContent: ({ editor }: { editor: unknown }) =>
    editor != null ? <div data-testid="editor-content">TipTap Editor</div> : null,
}))
```

### Virtualized lists (`@tanstack/react-virtual`)

The test DOM gives the scroll container zero height, so the real `useVirtualizer` renders no rows. `vi.mock('@tanstack/react-virtual', () => mockReactVirtual())` from [`src/__tests__/mocks/react-virtual.ts`](../../__tests__/mocks/react-virtual.ts) renders every row; `{ windowSize: 80 }` mounts the first N (getter accepted); `{ scrollToOffset }` captures calls — pass `vi.hoisted` spies.

### Toast (sonner) and Radix Select

Mocked globally from `src/__tests__/mocks/` (`sonner.ts`, `ui-select.tsx`). To assert on toasts, `vi.mocked(toast.error)` from a direct `sonner` import (tests may; production code goes through `@/lib/notify`, enforced by `no-direct-sonner-import`). A per-file `vi.mock` of either still overrides the shared one.

## File checklist

- `beforeEach`: `vi.clearAllMocks()`, global store resets, per-page stores created fresh (with provider wrapper).
- One happy-path and one error-path test (`ipc-error-path-coverage`); an axe audit (`axe-presence`).
- `findBy*` / `waitFor` / `act` for async and external-source updates; no `setTimeout` waits.
- `userEvent` for user actions; `within()` when a role/text repeats.
- `vi.useFakeTimers()` paired with `vi.useRealTimers()` in `afterEach`.

## Assert durable, re-queried effect — never call-shape (anti-drift)

When an interaction mutates backend state, `expect(invoke).toHaveBeenCalledWith('set_property', …)` is not enough — the tauri mock drifts from the real backend. Re-render / re-fetch and assert the block, chip, or field the user would see. Rule and enforcement: [`src/__tests__/AGENTS.md` § anti-drift](../../__tests__/AGENTS.md#assert-durable-re-queried-effect--never-call-shape-anti-drift).

## Test-asserted production patterns

Production-code rules pinned by tests here; each fixed a shipped bug.

1. **Capture editor / store state before any `await`** — the user may have typed or moved by the time it resolves.
2. **Re-entrancy guard on async handlers** via a hook-level `useRef` (`if (inProgress.current) return`); double Enter / double click must not duplicate.
3. **Optimistic edits roll back.** `edit()` captures the previous content; on backend failure restore it and toast.
4. **`flushSync()` around `edit()` + `splitBlock()` in editor blur**, so the store update lands before React unmounts the editor.
5. **`onPointerDown` (with `onClick` keyboard fallback)** for buttons that must fire before a focus/blur cycle, e.g. delete in a hover gutter.
6. **Capture-phase keydown on `parentElement`** for handlers that must beat ProseMirror (Enter for block split); they yield while a suggestion popup is open.
7. **Blur splitting uses `shouldSplitOnBlur()`**, not `content.includes('\n')` — code blocks contain newlines. `useEditorBlur`'s early-persist path checks it too, or `edit()` and `splitBlock()` both run.
8. **Editor-area overlays carry `data-editor-portal=""`** on their outermost portal element (`EDITOR_PORTAL_SELECTOR` in `src/hooks/useEditorBlur.ts`); untagged overlays fire `handleBlur` when clicked.
9. **`Dialog` for modals with text inputs; `AlertDialog` only for confirm/cancel** — its focus trap makes input `autoFocus` unreliable.
10. **`null`, not `undefined`, for Rust `Option<T>` args.** The `src/lib/tauri/` wrappers normalize with `?? null`.
