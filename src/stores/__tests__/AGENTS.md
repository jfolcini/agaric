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

- **`invoke` from `@tauri-apps/api/core`** — mocked globally in `src/test-setup.ts`, below the `@/lib/tauri/*` wrappers and `@/lib/bindings`, so it catches every call. Prefer it.
- **`vi.mock('@/lib/tauri', …)`** — catches only imports through the barrel (`undo.test.ts`); a store importing `@/lib/bindings` directly bypasses it. Check the store's imports first.

## Conventions

- Deferred promises to observe intermediate states (loading, recovering).
- `useBootStore.subscribe()` to capture state-transition sequences.
- Both paths: on backend error, assert state did **not** change.

## Assert durable, re-queried effect — never call-shape (anti-drift)

For an action that mutates backend state, `expect(invoke).toHaveBeenCalledWith(…)` is not enough — the tauri mock drifts from the real backend. Re-`load()` or read the projection afterwards and assert the resulting row / column / cleared field (several page-blocks suites drive the tauri mock's `dispatch` directly for this). Rule and enforcement: [`src/__tests__/AGENTS.md` § anti-drift](../../__tests__/AGENTS.md#assert-durable-re-queried-effect--never-call-shape-anti-drift).

## Undo / redo store

Per-page state is a `Map<string, PageUndoState>` (`undoDepth`, `redoStack`, `redoGroupSizes`); reset with `useUndoStore.setState({ pages: new Map() })`.

- **Two revert paths.** Entries with op refs from `onNewAction` revert by ref (`undoOp`, or one atomic `undoOps` per group); ref-less and pre-tracking entries fall back to the positional `undoPageGroup` anchored on `undoDepth`. Test both.
- **Batch grouping.** Same-device ops within `UNDO_GROUP_WINDOW_MS` (import from `src/stores/undo.ts`) form one undo unit. Use `makeHistoryEntry()` with explicit timestamps; assert inside window → grouped, past it → separate, device change → separate.
- **Optimistic update + rollback.** `undo()` bumps `undoDepth` immediately; on a rejected `undoPageGroup` assert it rolled back.
- **Page-blocks integration.** Every mutation (`createBelow`, `edit`, `remove`) calls `onNewAction(pageId, opRefs?)` on success (clearing the redo stack), never on backend error.

`undo.test.ts` mocks `@/lib/tauri` (`undoPageGroup`, `undoOp`, `undoOps`, `redoPageOp`, `undoPageOp`, `listPageHistory`), `@/lib/logger`, and `@/lib/announcer` (a singleton DOM node — keep store tests DOM-free). `makeUndoResult()` is local there; `makeHistoryEntry()` is a shared fixture.
