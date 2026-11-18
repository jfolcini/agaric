# Session 4355 — search and query WDIO specs onto the bridge

Slice 15 of #6926: the search and Advanced query WebdriverIO specs are ported onto the headless bridge (#6529) and deleted.

**Promoted to `REAL_BACKEND_SPECS`:** nothing new. Every `search-*`, `query-*` and `advanced-query-*` spec was already listed.

**Deleted as duplicates:** `search-nested-result` (twin: *a result for an indented block opens its page with the block focused*) and `advanced-query-saved-views` (twin: *a saved view is listed after leaving, loads, …*). Both twins run on the bridge. The backlinks case of `advanced-query-group-by` is *type:backlinks lists the blocks linking to the target, not its children* in `query-blocks.spec.ts`.

**Ported, then deleted from `e2e-tauri/`:**
- `search-short-term` → `search-results.spec.ts` and `advanced-query-happy-paths.spec.ts`: a two-character term is found alone and beside a longer word, in Search and in the Advanced query full-text box.
- `search-edited-word` → `search-results.spec.ts`: a block edited in the editor is found by its new word and not by its old one.
- `search-bm25-order` → `search-results.spec.ts`, `@real-only` (the mock does not rank): the block that holds the term once in fewer words comes first.
- `search-load-more` → `search-results.spec.ts`, `@real-only` (the mock's page is not the backend's 50): Load more reaches all 60 matches, each listed once. It waits for `search_blocks` to return all 60 before the first submit, because the Search view keeps its answer for a query it has already run.
- `search-shown-text-6277` → `search-shown-text-6277.spec.ts`, `@real-only` (the mock strips at query time): a block ref is found by its target's new first line and not by the old one.
- `search-purged-ref-target-6843` → the same file: a block ref is no longer found by a purged target's first line.
- `search-replace` → `search-replace.spec.ts`: Ctrl+Z on a page opened after a run undoes only that page's part.
- `advanced-query-group-by` → `advanced-query-group.spec.ts`, `@real-only` (the mock returns one bucket): grouped by state, the groups read their counts, and their Count chips after a summary is added, again after leaving and coming back. Grouped by a list key, a block sits in each item's group, and only once when its list repeats an item (#6741).

**Shown red on the bridge.** Each break was made in the Rust and the bridge rebuilt:
- Buckets in `gcount ASC` order: the groups came back in the wrong order.
- The list join without its repeat guard: Ann read 3 blocks.
- The short-term `LIKE` without `%`: `qz` found nothing, in both views.
- No `UpdateFtsBlock` on an edit: `violetite` found nothing.
- No `ReindexFtsReferences` for an edited content block: `cobaltine` found only the target.
- A purge's referrers not re-stripped: the referrer was still found.
- `fts.rank DESC`: the two rows swapped.
- The undo group enumerating every page's ops: Alpha read `[""]`. The widened group also took the seed's creates, so the test failed at Alpha's check, not Beta's.

The first Load more break, `b.id >= ?4`, did not redden: the 60 blocks' ranks differ, so the cursor's id tie-break is never reached. A rank cursor that restarts from the top did, at `60 matches` (it read 50). The view drops a repeated id, so a repeated page shows as matches that never arrive.

**Ran:**
- the five changed files on the bridge, three times: 84 passed, 3 skipped (the existing `<mark>` skip), then once more after rebuilding the restored bridge;
- the same five files on the mock, two repeats: 48 passed;
- `npm run typecheck`.
