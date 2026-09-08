# Session 1603 — an assertion that could not fail, and four that fired the wrong branch (#4668)

## What shipped

`src/components/__tests__` migrated onto the typed `mockInvokeCommands` seam —
all 16 counted files. Ratchet **72 → 56**. 42 files / 1276 tests before and
after, identical.

## The assertion that could not fail

`PageBrowser.namespaces.test.tsx` had a test asserting that `trash_page` and
`delete_page` were **never** invoked. Neither command exists — not in
`src/lib/bindings.ts`, not in `src-tauri/src/commands/`. A negative assertion
against a name nothing can emit passes unconditionally.

That is the unreachable-condition shape AGENTS names. Re-pointed at
`delete_block`, and proven live: flipping `ConfirmDialog`'s destructive
`autoFocus` from Cancel to Action now reddens it, where the old form could not.

## Four tests running the error branch, via mock leakage

`SearchPanel.test.tsx`'s four keyboard-navigation tests never stubbed
`batch_resolve`, and the strict fallback never fired — because
**`vi.clearAllMocks()` does not reset implementations**. Each inherited the
PREVIOUS test's catch-all, which answered `batch_resolve` with `emptyPage`, a
`PageResponse` where `ResolvedBlock[]` is expected. Breadcrumb resolution ran
its error branch in all four.

Same shape as session 1600's `useBlockTags` finding, arriving by a different
route: there it was a per-test catch-all, here it is leakage across tests.
`test-setup.ts:71` already documents the sibling caveat about the once-queue.

`TrashView.test.tsx` was worse in bulk: **42 of 101 tests** leaned on the
dispatchers' `return undefined` tail for `trash_descendant_counts`, which
`unwrap` reads as success. The `?? {}` at `useTrashDescendantCounts.ts:36` is
production code that only a shape the backend cannot send ever justified.

`JournalPage.test.tsx`'s "shows empty state when page listing fails" used a
positional `mockRejectedValueOnce` covering only the first invoke; three more
journal reads were served by the previous test's leaked catch-all.

## Drift the typing rejected

Five `PageBrowser.*` files fed `list_pages_with_metadata` snake_case `BlockRow`s
from `makePage()` across ~45 sites — `PageWithMetadataRow` is camelCase and
carries `lastModifiedAt` / `inboundLinkCount` / `childBlockCount` / `flags` that
no `BlockRow` has. `SearchPanel`'s `list_tags_by_prefix` stubs returned a
`color` field `TagCacheRow` does not have while omitting the non-optional
`usage_count` and `updated_at`. `makeSearchResult` omitted four non-optional
`SearchBlockRow` fields across ~30 tests. `TrashView`'s `list_trash` literals
omitted `total_count`. Nine `TagList` sites were missing their `WithOps`
envelope, and its `delete_block` stubs carried an ISO `deleted_at` where
`DeleteResponse.deleted_at` has been epoch ms since migration 0081.

## Recorded, not fixed

`TagList.test.tsx`'s "permanently deletes tag on confirmation" does not pin the
purge: deleting `await purgeBlock(tagId)` from `TagList.tsx:179` leaves all 49
tests green. Pre-existing — the old positional stub was equally unasserted — so
it is named here rather than folded in silently, and a different TagList break
was used for falsification.

`JournalPage.test.tsx` keeps 17 untyped `mockImplementation` dispatchers. The
ratchet does not count them and converting them is a restructure the typing did
not require; it is the obvious next slice for that file.

## Falsification

Five break-the-production-code checks, each against a copy, restored and
`cmp`-verified: the search dedupe (2 red), the alias request-id guard (1), the
tag rename update (1), `useTrashDescendantCounts`' `?? {}` (4), and
`ConfirmDialog`'s destructive autofocus (1 — the corrected assertion above).

No `as any`, `as never`, or `@ts-` was added. Every error injection in this
directory went through the typed seam as a rejecting handler, including the raw
`AppError` wire shapes.
