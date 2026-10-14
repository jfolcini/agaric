# Session 1996 — review notes from #5459, #5460, #5464, #5465 and #5471

One follow-up PR for the non-blocking review notes on those five merged PRs. Each premise was checked against the code before changing anything.

**The user-visible fix (#5459).** Opening Graph with no page open erased the local mode remembered for the space. The #1752 effect clears `localMode` when there is no seed. The per-space write effect then saved that `active: false`. With no seed, the toggle and the depth control are both disabled, so the user can't have chosen anything. The write now skips when there is no seed. Two tests, both shown red on a copy:
- opening with no page leaves the stored `{ active: true, hops: 1 }` alone (red when the guard is dropped);
- turning local mode off on a page is saved (red when the guard is inverted).

**Copy (#5465).** These messages are user-facing:
- The refusal to delete an in-use definition now reads "Can't delete '{key}': {n} block(s) still use it. Remove the property from them first." The message is updated in `delete_property_def_inner`, in the Rust test (now `assert_eq!` on the whole text), in the mock's copy, in the frontend test and in the e2e toast. `property_def_writes.json` pins only the error kind, so no re-authoring was needed. `block_properties` has primary key `(block_id, key)`, so a row count is a block count.
- `propertiesView.deleteDesc` claimed that blocks keep their values. In fact the backend refuses that delete. It now says a property still in use can't be deleted.
- `properties.newSelectOptions` moved into the `properties.*` block.
- The e2e comment about a `[[alpha...]]` chip was stale. The chip's value button is labelled `Project: alpha`, so the spec now matches that exact name and the comment is gone.
- `property-save-utils.ts` quoted the old message. The quote is dropped.

**Cleanups:**
- #5460: `useCalendarPageDates` re-exported `fetchPageMap` only for its own test. The test now imports it from `@/lib/calendar-page-dates-cache`.
- #5464: `TagList` had fallbacks for a virtual index past `tags.length`. That index can't occur: `useVirtualizer` sets `count: tags.length` during render, and virtual-core range-checks every `getItemKey` call. Both fallbacks are replaced by `tagAt`, which throws on an impossible index.
- #5471: the bench comment's "~6.7K rows at 100K" is dropped, because nothing regenerates it.

**Corrections to merged logs:**
- Session 1963 (#5461) says the properties and attachments fetches are both invalidated by the provider's `invalidationKey`. Only the properties provider takes `invalidationKey`. `BatchAttachmentsProvider` refetches when its own `invalidate()` or the attachment-invalidation bus bumps `invalidationToken`.
- Session 1960 (#5458) cites `src/lib/empty-block-cleanup.ts:218` for the `document.hasFocus()` early return. The stable reference is the symbol: `deleteBlockIfLeakedEmpty`.

Suites that ran:
- vitest over graph, `TagList`, `useCalendarPageDates`, the property components, the tauri mock, boot store and i18n: 72 files, 1713 tests;
- typecheck, plus oxlint and oxfmt on the changed files;
- Playwright on `properties-table-and-refusals` and `graph-view`: 16 passed, and one inline-property test this PR doesn't touch passed on retry;
- nextest on `property_def` and the conformance fixtures;
- clippy and fmt.
