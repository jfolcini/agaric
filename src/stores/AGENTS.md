# Zustand stores

> Store layout is in root [AGENTS.md § Frontend Architecture](../../AGENTS.md#frontend-architecture); store tests in [`__tests__/AGENTS.md`](__tests__/AGENTS.md). This file: rules for code that writes through a store.

## Optimistic and async writers

Check every new or changed writer against all four; tests rarely catch these races.

1. **Serialize per block.** Writers that read slot or content state before an `await` chain through `enqueueMove` (`page-blocks.ts`), or a two-press sequence computes both requests from one snapshot.
2. **Snapshot inside the queued run**, not before `enqueueMove`, or the queue serializes calls that still read stale state.
3. **Rollback is reference-guarded.** On failure, restore only if live state still equals what this call wrote; otherwise `load()`. `edit` and `rollbackProvisionalMove` (`page-blocks-move.ts`) are the reference.
4. **Never coalesce into an undo entry whose undo is in flight** (`undoInProgressEntry` in `undo.ts`); it jams Ctrl+Z.

A callee that catches and logs its own error defeats the caller's abort or rollback: let it throw, or return a result the caller checks.

## Writes outside the page store

A backend change that does not go through the optimistic page-store path (sync, MCP, quick capture, import, restore, drag reschedule) leaves mounted stores stale. Call `reloadChangedPageStores(changedPageIds)` (`src/hooks/useSyncEvents.ts`), which reloads, re-anchors undo, and bumps the graph-structure signal. For a narrower change call the specific helper: `invalidatePropertyCaches`, `invalidateNameCaches`, `recordBlockPropertyChange`, `recordGraphStructureChange`, `recordAttachmentInvalidation`, `invalidatePageBrowserData`, `invalidateCalendarPageDates`. Never hand-roll a subset of what `reloadChangedPageStores` does.
