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

Components that consume per-page hooks (`usePageBlockStore`, `usePageBlockStoreApi`) need the provider:

```tsx
function renderWithStore(ui: React.ReactElement) {
  return render(
    <PageBlockContext.Provider value={store}>{ui}</PageBlockContext.Provider>
  )
}
```

## Conventions

- **Global stores: reset in `beforeEach`** — singletons leak between tests.
- **Per-page stores: create fresh in `beforeEach`** — no leak risk, but document the per-test instance explicitly.
- **Deferred promises** to observe intermediate states (loading, recovering).
- **`useBootStore.subscribe()`** to capture state transition sequences.
- **Both paths** — verify state doesn't change on backend error.

Pure state-machine stores like `navigation.test.ts` need no mocks — `setState` + `getState` only.

## Undo / redo store

Per-page state in `Map<string, PageUndoState>` keyed by page ID. Each page tracks `undoDepth`, `redoStack`, `redoGroupSizes` independently.

```ts
// Reset per-page state, not global:
useUndoStore.setState({ pages: new Map() })
```

### Batch grouping (200ms window)

Consecutive ops within 200ms by the same device group into one undo unit. Tests use `makeHistoryEntry()` with explicit timestamps:

- 50ms apart → grouped (one Ctrl+Z undoes both)
- 201ms apart → separate groups
- Device change → breaks group even within window

### Optimistic update + rollback

`undo()` increments `undoDepth` immediately. On backend failure, rolls back. Tests must verify both:

```ts
mockedInvoke.mockRejectedValueOnce(new Error('backend'))
await store.getState().undo('PAGE_1')
expect(store.getState().pages.get('PAGE_1')?.undoDepth).toBe(0) // rolled back
```

### Integration with page-blocks store

Every mutation (`createBelow`, `edit`, `remove`) calls `onNewAction(pageId)` on success, clearing the redo stack. Tests verify this notification happens on success but NOT on backend error.

Helpers: `makeUndoResult()` (mock `UndoResult`), `makeHistoryEntry()` (mock for batch tests). Mocked commands: `undoPageOp`, `redoPageOp`, `listPageHistory`.
