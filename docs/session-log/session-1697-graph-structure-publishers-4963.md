# Session 1697 — the graph-structure counter's missing publishers (#4963)

`recordGraphStructureChange()` had exactly two publishers: the page-block
store (`notifyUndoNewAction`, `appendBlock`) and `sync:complete`. Every
mutation that goes straight to a command — the whole delete/restore half of
the app — changed the page-link graph without telling anyone, so `GraphView`,
Linked and Unlinked References and the journal badge counts served the
deleted page until the 5-minute TTL elapsed. This session gives each of those
mutators its one line.

## Where the calls went

`notifyPagesRemoved` (`src/lib/name-change-bus.ts`) is the shared fan-out
every page removal already converges on — `usePageDeleteAction`,
`PageBrowserBatchToolbar`'s trash and move-to-space, `useBlockMultiSelect` —
so one bump there covers the delete half. It sits *below* the "publishes
nothing for an empty cohort" guard: a block-tree selection holding no pages
must not invalidate a graph it did not change. The module docblock's closing
claim ("this bus is only about the two picker list caches") was amended
rather than left quietly false.

The restores have no shared publisher, so each bumps for itself:
`usePageDeleteAction.handleUndo`, `PageBrowserBatchToolbar.handleUndoTrash`,
and `TrashView`'s `handleRestore` / `handleBatchRestore` / `handleRestoreAll`.
In `TrashView` the bump is deliberately outside the page/tag branch the name
caches key on — a restored content block's `[[links]]` are edges just the
same. `HistoryView.reloadAfterMutation` covers revert and restore-to-here,
next to the attachment-invalidation bump it already carried.

Two block-tree surfaces write through the command and patch the store by
hand, missing the store reducer entirely: `useBlockMultiSelect`'s batch
delete (bumped right after the `deleteBlocksByIds` unwrap) and
`applyContentEdit` in `use-block-slash-commands/helpers.ts` (after the
`editBlock` unwrap).

`GraphView` needed nothing: it already stamps the counter on each cache entry
and compares it on the next mount.

## Deviations from the issue's list

**Item 3 — direct calls, not the store's `notifyUndoNewAction`.** The issue
proposed routing `useBlockMultiSelect` and the slash helpers through the
reducer helper that already bumps. It is not exported
(`function notifyUndoNewAction` in `page-blocks-reducers.ts`), so routing
means widening a store internal and rewriting two working undo call sites;
a `recordGraphStructureChange()` call is one line that touches no undo
semantics. Took the smaller diff. In the slash helpers the call went into
`applyContentEdit`, not the shared `notifyUndo` — `notifyUndo` is also the
undo hook for the property slash commands (`useSlashCommandProperty`), which
are property mutations the property counter already invalidates on.

**Purge is not a graph mutation, so `handlePurge` / `handleBatchPurge` got no
bump**, against the issue's list. `TrashView` only ever purges rows that are
already soft-deleted, and every query behind the four consumers filters
`deleted_at IS NULL` — `list_all_pages_in_space` supplies the graph's nodes,
and its edges are then filtered to those nodes. A purge removes rows they
already exclude. The reason is written at the restore site so the asymmetry
does not read as an oversight.

**Two sites the issue did not list were added**, both the missing half of a
pair it did list: `usePageDeleteAction.handleUndo` (the single-page delete's
Undo — the delete bumps, so without it a page stays missing from the graph
after being brought back) and `TrashView.handleRestoreAll`.

Not touched: `use-block-date-picker.ts`, which carries its own copy of
`notifyUndo` and inserts dates into content. Out of the issue's scope and
unexamined here.

## Verified

- vitest on the seven touched test files: 317 passed. Re-ran the five
  counter *consumers* (`GraphView`, `useBatchCounts`, `useUnlinkedReferences`,
  `LinkedReferences`, `useInvalidateOnGraphStructure`) — 140 passed — plus
  `JournalPage.integration`, `PageBrowser.crud` and `PageBrowser.multiselect`
  (30 passed), since a new bump can add a refetch under an existing count
  assertion. None did.
- `npm run typecheck`: exit 0.
- Falsified against a copy of each mutator, each restored `cmp`-clean. Every
  red was `AssertionError: expected +0 to be 1`, on:
  - `name-change-bus.test.ts` "bumps the graph-structure counter for a
    non-empty cohort only" (fake timers; the empty-cohort half of the same
    test pins the bump below the guard).
  - `usePageDeleteAction.test.tsx` "bumps the graph-structure counter when
    Undo restores the page".
  - `PageBrowserBatchToolbar.test.tsx` "the Undo bumps the graph-structure
    counter".
  - `TrashView.test.tsx` — three separate removals, one per call site:
    "bumps the graph-structure counter on a restore, content blocks
    included", "batch restore fires ONE restore_blocks_by_ids IPC for all
    selected", and "calls restore_blocks_by_ids (never restore_all_deleted)
    … on Restore All confirmation".
  - `HistoryView.test.tsx` "bumps the graph-structure counter after a
    successful revert".
  - `use-block-multi-select.test.ts` "bumps the graph-structure counter even
    when no page was removed" — the page-less selection, which is what
    distinguishes this call from the `notifyPagesRemoved` one.
  - `useSlashCommandStructural.test.ts` "a content-rewriting slash command
    bumps the graph-structure counter".

The three TrashView tests each reset the module counter first, so the one
assertion at the end belongs to that path alone; the restore-half tests that
follow a delete reset *after* the delete, which also drops its pending
debounce.

## Not done

No GraphView-level "delete a page, watch the node vanish" test. The consumer
half is already pinned end-to-end from the counter in `GraphView.test.tsx`
(#1530's mounted-bump and bumped-while-unmounted cases), and the publisher
half is now pinned per mutator; wiring a real delete surface into the
GraphView harness would be far past the ~40 lines that would make it worth
the duplication.

A negative case for the multi-select delete — "a failed delete bumps
nothing" — was written and then deleted: with a 150 ms debounce, a
synchronous `expect(key).toBe(0)` right after the rejected call passes
whether or not the code bumped. A vacuous assertion is worse than none.
