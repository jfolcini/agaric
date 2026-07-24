# Zustand store test patterns

> Frontend store testing. Root [`src/__tests__/AGENTS.md`](../../__tests__/AGENTS.md) covers cross-cutting conventions. This file covers what's specific to `src/stores/__tests__/`.

## Global stores

Singletons (`useBlockStore`, `useNavigationStore`, etc.) — test via direct `getState()` / `setState()`, no React rendering.

```ts
beforeEach(() => {
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  vi.clearAllMocks()
})

it('sets the focused block id', () => {
  useBlockStore.getState().setFocused('BLOCK_A')
  expect(useBlockStore.getState().focusedBlockId).toBe('BLOCK_A')
})
```

## Per-page block store

`createPageBlockStore(pageId)` factory — each test gets a fresh instance.

```ts
import type { StoreApi } from 'zustand'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'

let store: StoreApi<PageBlockState>

beforeEach(() => {
  store = createPageBlockStore('PAGE_1')
  vi.clearAllMocks()
})

it('loads blocks from the backend', async () => {
  mockedInvoke.mockResolvedValueOnce({ blocks: [...], truncated: false, total: 2 })
  await store.getState().load()
  expect(store.getState().blocks).toHaveLength(2)
})
```

Components that consume per-page hooks (`usePageBlockStore`, `usePageBlockStoreApi`) need the provider:

```tsx
function renderWithStore(ui: React.ReactElement) {
  return render(
    <PageBlockContext.Provider value={store}>{ui}</PageBlockContext.Provider>
  )
}
```

## Choosing the mock layer

Two levels work, and they are not interchangeable:

- **`@tauri-apps/api/core`'s `invoke`** — mocked globally in `src/test-setup.ts`. This is the lowest layer, so it intercepts calls routed through the `@/lib/tauri/*` wrappers *and* calls made directly against the generated `@/lib/bindings` commands. Prefer it.
- **`vi.mock('@/lib/tauri', …)`** — a per-file module mock of the wrapper barrel. Convenient for asserting on named wrapper functions (`undo.test.ts` does this), but it only intercepts code that imports through the barrel. Store code that has migrated to importing `@/lib/bindings` directly bypasses it entirely and will hit the real generated command. Check the store's imports before reaching for this.

Several page-blocks suites go further and drive the tauri mock's `dispatch` directly, so the assertion reads the settled projection rather than the call — see § anti-drift below.

## Conventions

- **Global stores: reset in `beforeEach`** — singletons leak between tests.
- **Per-page stores: create fresh in `beforeEach`** — no leak risk, but keep the per-test instance explicit.
- **Deferred promises** to observe intermediate states (loading, recovering).
- **`useBootStore.subscribe()`** to capture state-transition sequences.
- **Both paths** — verify state does *not* change on backend error.

Pure state-machine stores like `navigation.test.ts` need no mocks — `setState` + `getState` only.

## Assert durable, re-queried effect — never call-shape (anti-drift)

For a store action that **mutates backend state**, `expect(invoke).toHaveBeenCalledWith(…)` is insufficient — it proves the store *asked* for the change, not that the change *persisted correctly*. The tauri mock is a second implementation that drifts from the real backend, so a call-shape-only assertion passes against a mock that does the wrong thing. Re-query and assert the resulting state: after the action, re-`load()` / read the projection and assert the observable result (the surviving row, the typed column, the cleared field).

The tag-space bug shipped exactly here — a test asserted `setProperty(key: 'space')` was called, never re-queried, and the tag silently vanished in production (the mock modeled the retired `block_properties(key='space')` schema). See root [`AGENTS.md` § Testing invariants (anti-drift)](../../../AGENTS.md#testing-invariants-anti-drift) and [`e2e/AGENTS.md` § The mock is a contract](../../../e2e/AGENTS.md#the-mock-is-a-contract-not-a-convenience).

## Undo / redo store

Per-page state lives in a `Map<string, PageUndoState>` keyed by page ID; each page tracks `undoDepth`, `redoStack`, and `redoGroupSizes` independently.

```ts
// Reset per-page state, not global:
useUndoStore.setState({ pages: new Map() })
```

### Two revert paths

Entries whose op refs were captured at `onNewAction` time are reverted **by exact ref** (`undoOp` for one op, a single atomic `undoOps` for a coalesced group). Ref-less entries and pre-tracking history fall back to the **positional** `undoPageGroup`, with `undoDepth` as the positional anchor. Tests must cover both — a ref-based test says nothing about the fallback.

### Batch grouping

Consecutive ops by the same device within `UNDO_GROUP_WINDOW_MS` (exported from `src/stores/undo.ts` — import it, don't hardcode the number) group into one undo unit, both at capture time in `onNewAction` and in the positional fallback. Tests use `makeHistoryEntry()` from the shared fixtures with explicit timestamps, and assert:

- well inside the window → grouped (one Ctrl+Z undoes both)
- just past the window → separate groups
- device change → breaks the group even inside the window

### Optimistic update + rollback

`undo()` increments `undoDepth` immediately and rolls back on backend failure. Tests must verify both:

```ts
mockedUndoPageGroup.mockRejectedValueOnce(new Error('backend'))
await store.getState().undo('PAGE_1')
expect(store.getState().pages.get('PAGE_1')?.undoDepth).toBe(0) // rolled back
```

### Integration with page-blocks store

Every mutation (`createBelow`, `edit`, `remove`) calls `onNewAction(pageId, opRefs?)` on success, clearing the redo stack. Tests verify this notification happens on success but NOT on backend error.

`undo.test.ts` mocks `@/lib/tauri` with the commands the store calls (`undoPageGroup`, `undoOp`, `undoOps`, `redoPageOp`, `undoPageOp`, `listPageHistory`) plus `@/lib/logger` and `@/lib/announcer` (the latter touches a singleton DOM node — mock it so store tests stay DOM-side-effect-free). `makeUndoResult()` is a local helper in that file; `makeHistoryEntry()` is shared in `src/__tests__/fixtures/index.ts`.
