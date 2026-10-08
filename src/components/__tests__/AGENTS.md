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

Import `axe` from [`src/__tests__/helpers/axe.ts`](../../__tests__/helpers/axe.ts), not `vitest-axe`; the wrapper disables the `aria-hidden-focus` rule that Radix focus-guard sentinels trip.

## Querying

Prefer `getByRole`, then `getByText`, `getByPlaceholderText`, `getByTestId` (mocked sub-components only); `queryBy*` for absence. Scope with `within()` when a role/text appears twice (nav labels render in both sidebar and header): `within(document.querySelector('[data-slot="sidebar"]') as HTMLElement).getByText('Journal')`.

## User interaction

`userEvent`, not `fireEvent`; call `userEvent.setup()` before any DOM op, including `.focus()`. `fireEvent` only for non-user events (`blur`, a debounce-bypassing `change`).

## Async patterns

Components that `invoke` on mount, and updates from workers, timers or IPC callbacks (which React 19 does not flush in a bare `await` tick), need one of:

```tsx
expect(await screen.findByText('Loaded')).toBeInTheDocument()            // sync getBy → findBy
await waitFor(() => {                                                      // observable end state
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument()
})
await act(async () => { await new Promise((r) => setTimeout(r, 0)) })     // external source
```

Reference sites: `useGraphSimulation.test.ts` (act, worker), `SearchPanel.test.tsx` (act, timers), `BacklinkFilterBuilder.test.tsx` (waitFor, Radix popover). Loading states: `mockedInvoke.mockReturnValueOnce(new Promise(() => {}))`. Debounced inputs (SearchPanel, 300 ms): submit the form directly, or advance fake timers inside `act()`.

## Accessibility — every file gets an axe audit

Required by the `axe-presence` prek hook, including in a file split off an existing one:

```tsx
it('has no a11y violations', async () => {
  const { container } = render(<MyComponent />)
  await waitFor(async () => {
    expect(await axe(container)).toHaveNoViolations()
  })
})
```

One audit per distinct visual state (focused / unfocused, open / closed). axe cannot see focus loss: every dialog, menu, or popover test that closes it (confirm, cancel, Escape) asserts `document.activeElement` is back on the trigger.

## Mocking

### Tauri IPC

Stub per command with `mockInvokeCommands` ([root § Shared setup](../../__tests__/AGENTS.md#shared-setup-srctest-setupts)). The `ipc-error-path-coverage` prek hook requires every test file for a component that invokes Tauri to carry at least one `mockRejectedValue*` / `Promise.reject` / `throw` test.

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

Both are mocked globally. To assert on toasts, `vi.mocked(toast.error)` from a direct `sonner` import (tests may; production code goes through `@/lib/notify`, enforced by `no-direct-sonner-import`). A per-file `vi.mock` of either overrides the shared one.

## Changing components

- **Adding an enum value** (property type, task state): grep every site that lists its siblings and drive the add flow in a test; prefer one exported set over repeated literals.
- **`react/*` lint fixes:** `vite.config.ts` disables the React Compiler under vitest, so verify them with e2e ([`docs/architecture/frontend.md` § The hazard](../../../docs/architecture/frontend.md#the-hazard-a-reactrefs-fix-can-switch-the-react-compiler-on-4469)).
- **IME and touch behaviour** cannot be verified in happy-dom or desktop Chromium: unit-test the math, and say in the PR that device verification is pending.

## Test-asserted production patterns

Production-code rules pinned by tests here; each fixed a shipped bug. Optimistic rollback rules are in [`src/stores/AGENTS.md`](../../stores/AGENTS.md).

1. **Capture editor / store state before any `await`** — the user may have typed or moved by the time it resolves.
2. **Re-entrancy guard on async handlers** via a hook-level `useRef` (`if (inProgress.current) return`); double Enter / double click must not duplicate.
3. **`flushSync()` around `edit()` + `splitBlock()` in editor blur**, so the store update lands before React unmounts the editor.
4. **`onPointerDown` (with `onClick` keyboard fallback)** for buttons that must fire before a focus/blur cycle, e.g. delete in a hover gutter.
5. **Capture-phase keydown on `parentElement`** for handlers that must beat ProseMirror (Enter for block split); they yield while a suggestion popup is open.
6. **Blur splitting uses `shouldSplitOnBlur()`**, not `content.includes('\n')` — code blocks contain newlines. `useEditorBlur`'s early-persist path checks it too, or `edit()` and `splitBlock()` both run.
7. **Editor-area overlays carry `data-editor-portal=""`** on their outermost portal element (`EDITOR_PORTAL_SELECTOR`, `src/hooks/useEditorBlur.ts`), or clicking them fires `handleBlur`.
8. **`Dialog` for modals with text inputs; `AlertDialog` only for confirm/cancel** — its focus trap makes input `autoFocus` unreliable.
9. **`null`, not `undefined`, for Rust `Option<T>` args.** `commands.*` passes what you give it; `createBlock` in `@/lib/ipc-helpers` is the one helper that still normalizes with `?? null`.
