# Zustand store test patterns

> Root [`src/__tests__/AGENTS.md`](../../__tests__/AGENTS.md) covers cross-cutting conventions. This file covers `src/stores/__tests__/`.

## Global stores

Singletons (`useBlockStore`, `useNavigationStore`, …): `getState()` / `setState()` directly, no rendering. Reset in `beforeEach` — they leak between tests.

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

Pure state-machine stores (`navigation.test.ts`) need no mocks.

## Per-page block store

`createPageBlockStore(pageId)` — create a fresh instance in `beforeEach`:

```ts
import { createPageBlockStore, PageBlockContext } from '@/stores/page-blocks'

let store: ReturnType<typeof createPageBlockStore>
beforeEach(() => { store = createPageBlockStore('PAGE_1'); vi.clearAllMocks() })
```

Components using `usePageBlockStore` / `usePageBlockStoreApi` render inside `<PageBlockContext.Provider value={store}>`.

## Choosing the mock layer

Prefer the global `invoke` mock, which catches every call. `vi.mock('@/lib/ipc-helpers', …)` catches only the hand-written floor: a store calling `commands.*` from `@/lib/bindings` bypasses it, so check the store's imports first.

## Conventions

- Deferred promises to observe intermediate states (loading, recovering).
- `useBootStore.subscribe()` to capture state-transition sequences.
- On backend error, assert state did **not** change.
- For a backend mutation, re-`load()` or read the projection and assert the resulting row; several page-blocks suites drive the tauri mock's `dispatch` directly for this.
- Optimistic writers: test the race, not only the failure. Fire two calls on one block, reject the first, and assert the second's state survives the rollback (rules: [`src/stores/AGENTS.md`](../AGENTS.md)).

## Undo / redo store

Per-page state is a `Map<string, PageUndoState>` (`undoDepth`, `redoStack`, `redoGroupSizes`); reset with `useUndoStore.setState({ pages: new Map() })`.

- **Two revert paths.** Entries with op refs from `onNewAction` revert by ref (`undoOp`, or one atomic `undoOps` per group); ref-less and pre-tracking entries fall back to the positional `undoPageGroup` anchored on `undoDepth`. Test both.
- **Batch grouping.** Same-device ops within `UNDO_GROUP_WINDOW_MS` (import from `src/stores/undo.ts`) form one undo unit. Use `makeHistoryEntry()` with explicit timestamps; assert inside window → grouped, past it → separate, device change → separate.
- **Optimistic update + rollback.** `undo()` bumps `undoDepth` immediately; on a rejected `undoPageGroup` assert it rolled back.
- **Page-blocks integration.** Every mutation (`createBelow`, `edit`, `remove`) calls `onNewAction(pageId, opRefs?)` on success (clearing the redo stack), never on backend error.

`undo.test.ts` mocks `commands.*` from `@/lib/bindings` (`undoPageGroup`, `undoOp`, `undoOps`, `redoPageOp`, `undoPageOp`, `listPageHistory`, each resolving the `{ status: 'ok', data }` envelope), `@/lib/logger`, and `@/lib/announcer` (a singleton DOM node — keep store tests DOM-free). `makeUndoResult()` is local there; `makeHistoryEntry()` is a shared fixture.
