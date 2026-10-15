<!-- markdownlint-disable MD060 -->
# Pages view architecture

The shape of the Pages browser — the list view that fronts every page in the active space. This file documents the **data flow** behind the page rows, the six sort modes, and the per-page metadata IPC. Workflow + UI conventions live with the page-browser source under `src/components/PageBrowser/`; this file is the load-bearing contract a contributor reads before touching the surface.

## Overview

The Pages view is the canonical "show me every page in this space" surface. It feeds the in-app navigator (starred + namespace tree + flat tail).

Four strands of work compose here, and all of them hang off one seam — the `list_pages_with_metadata` IPC, which returns the shared metadata columns once so no consumer has to re-query for them:

- **Page rows + sort modes + the metadata IPC** — the base surface (below).
- **Materialised counts** — `inbound_link_count` / `child_block_count` moved into `pages_cache`, which removed the 20k-page scaling cliff on `most-linked` / `most-content`.
- **Compound filters** — `FilterPrimitive` shared with Search and the other filter surfaces. See [`filters.md`](filters.md).
- **Multi-select + bulk ops + saved views** (#81) — a saved view is a `{filterSet, sort}` pair persisted under `agaric:pages:savedViews:v1` (`src/hooks/useSavedPagesViews.ts`); the compound-filter work owns `filterSet`, the sort work owns `sort`. Views saved before #5372 also carry a `density` field that nothing reads.

## Data flow

Every Pages-view list render walks the same four stages. The IPC is the only async hop; everything below it is pure transformation.

```text
┌──────────────────────────┐
│ list_pages_with_metadata │  Tauri IPC — paginated keyset over the space's `pages_cache` rows,
│  (pages/metadata.rs)     │  joined to their live page blocks. Cursor carries sort-key value
└────────────┬─────────────┘  + sort-mode discriminator. Returns PageResponse<PageWithMetadataRow>.
             │
             ▼
┌──────────────────────────┐
│  useInfiniteQuery        │  TanStack Query, owned by usePageBrowserData
│   ↳ rows[], hasMore,     │  (src/hooks/usePageBrowserData.ts) — the query key IS the
│     loadMore, reload     │  cursor/basis stale-guard (#2634). The `RequiresRefresh`
│                          │  recovery wrapper (`withCursorRecovery`) lives in that hook.
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  usePageBrowserGrouping  │  Folds the flat row list into the Starred + Namespace-tree +
│   .buildMultiPageBranch  │  Pages layout, keeping the server's order: a namespace root
│                          │  sits where its first page arrived.
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  <PageRow>               │  Pages-specific leaf row (see "Page rows" below). Reads
│   src/components/        │  typed primitive props for memoisation. Tree-page rows still
│   PageBrowser/           │  use the recursive `PageTreeItem`.
│   PageRow.tsx            │
└──────────────────────────┘
```

Returning to the view refetches only a stale list (#5446). Any local command that can write notes marks it stale (`watchLocalWrites` in `src/lib/local-write-watch.ts`, installed in `main.tsx`), and so does an out-of-band change (`invalidatePageBrowserData` from `useSyncEvents`). A stale list refetches every loaded page in order from page 1; a sort, filter or space change refetches as before.

One side hook orbits this pipeline without altering its shape:

- **Alias resolver** (`src/components/PageBrowser/usePageBrowserFilters.ts`) is a parallel single-row IPC for "user typed an alias in the filter box" (`resolvePageByAlias` → sets `aliasMatchId` so the matching page surfaces even when its visible title doesn't match the filter). Independent of the list query.

## Sort modes

Six options, every one ordered by the server over all pages in the space behind a keyset cursor (#5371). The rows render in the order received; nothing re-sorts them in JS.

Each sort reads its rows in order from an index and stops at the page size instead of sorting the space (migration 0124). The query drives from `pages_cache`, which carries its page's `space_id`, through the index named below; a cursor page seeks into it at the cursor's key. A page also reads the rows it skips: those a filter rejects, and, for the count and last-edited sorts, the pages that share the cursor's key and sort before it, since the seek lands at the start of that run (many pages share a count of zero). A tag filter or an include path glob is the exception: the query seeks the pages it lists by id and sorts only those (`SPACE_TERM_UNDER_PAGE_LIST` in `src-tauri/src/commands/pages/metadata.rs`).

| Sort option | Wire value | Order | Cursor key | Index |
|-------------|------------|-------|------------|-------|
| `alphabetical` | `alphabetical` | `pages_cache.title_sort_key` ASC, `id` ASC | `title_sort_key` in `Cursor.deleted_at` | `idx_pages_cache_space_title` |
| `recent` ("Last opened") | `last-opened` | `page_opens.opened_ms` DESC, `id` DESC; pages never opened on this device follow, newest first | `opened_ms` (`-1` for never) in `Cursor.seq` | `idx_page_opens_opened`, then `idx_pages_cache_space_created` |
| `created` | `created` | `id` DESC | `id` only | `idx_pages_cache_space_created` |
| `recently-modified` ("Last edited") | `recently-modified` | `pages_cache.last_edited_ms` DESC, `id` ASC | `last_edited_ms` in `Cursor.seq` | `idx_pages_cache_space_edited` |
| `most-linked` | `most-linked` | `pages_cache.inbound_link_count` DESC, `id` ASC | the count in `Cursor.seq` | `idx_pages_cache_space_linked` |
| `most-content` | `most-content` | `pages_cache.child_block_count` DESC, `id` ASC | the count in `Cursor.seq` | `idx_pages_cache_space_content` |

- Last opened reads two arms: the opened pages from `page_opens` in open order, then the never-opened pages of the space in id order; a cursor in the never-opened tail reads that arm alone. `page_opens` has no space, so the opened arm skips the opens of other spaces.
- A page lists in the space its cache row names. The page-create INSERT copies the page's space, a `space` op's projection moves the row in the same transaction (`cache::sync_pages_cache_space_ids`), and the page-row rebuild repairs any other path (inbound sync, snapshot restore, purging a space). The rebuild drops a trashed page's row, so every restore path gives a restored page its row back in the restore's transaction (`cache::insert_missing_pages_cache_rows`). A page without a cache row, between a reset wiping the cache and its rebuild, is absent until the rebuild lands; boot schedules the rebuild when a live page has no row or a row in another space.

- `title_sort_key` is the title NFKD-decomposed, combining marks stripped, lowercased (`agaric_core::title_sort::title_sort_key`), compared as UTF-8 bytes: `Émile` sorts with `E`, `ángel` before `Zebra`.
- `last_edited_ms` is the newest op on the page or any block on it, else the page's ULID creation time. Every path that lands an op raises it in the same transaction (`agaric_store::cache::raise_pages_last_edited_ms`), so editing a page's body moves the page up, and op-log compaction (#5286) cannot lower it.
- `page_opens` is device-local: `record_page_open` stamps it when a page opens (`navigateToPage`, beside the `recent-pages` visit), it appends no op, and nothing syncs or exports it. The Pages list refetches this sort on every return, since an open marks nothing stale.
- A stored `default` sort, preference or saved view, reads as `created`.

Each sort encodes its primary key into an **existing** `Cursor` slot (`deleted_at` for the string key, `seq` for an i64). `Cursor.position` carries a sort-mode discriminator (`sort_discriminator`); a cursor whose discriminator does not match the requested sort is rejected (see "Cursor recovery" below).

## Page rows

A page row shows the title + `↗ inbound_link_count` + `⊟ child_block_count` + relative time + the first matched `has-*` flag chip (if any). The virtualizer estimates every row at 44 px (`PAGE_ROW_HEIGHT`, next to `HEADER_ROW_HEIGHT` in `src/components/PageBrowser.tsx`); `measureElement` corrects it to the rendered height.

`<PageRow>` is **Pages-specific** and lives at `src/components/PageBrowser/PageRow.tsx`. TrashView and HistoryView have different row shapes (`TrashRow.descendants_affected`, `HistoryEntry`'s op-log payload), so extracting prematurely couples three views to a single primitive that has to grow optional props for each one's metadata. If a second consumer needs this shape, propose an extraction PR first rather than importing across surfaces.

## Cursor v1 → v2 (the `RequiresRefresh` recovery contract)

The legacy Pages view called `list_blocks(blockType='page')`, whose cursor encodes `(id ASC)` only. The new IPC needs keysets on a numeric / date column with `id` as the tiebreaker, plus a sort-mode discriminator so cursors don't survive a sort change.

The implementation **does not bump `CURRENT_CURSOR_VERSION`** (it stays at 1). Instead `list_pages_with_metadata` reuses existing `Cursor` slots:

- `Cursor.position` → sort-mode discriminator (i64, one per `PageSort` variant).
- `Cursor.deleted_at` → primary-sort key for the string sort (the title key).
- `Cursor.seq` → primary-sort key for i64 sorts (epoch-ms and counts).
- `Cursor.id` → tiebreaker (always).

A cursor whose `position` slot does not match the requested sort is rejected by `validate_pages_metadata_cursor` with `AppError::validation_coded(ValidationCode::RequiresRefresh, "cursor sort mismatch (expected …)")`. The frontend recognises the structured `RequiresRefresh` code (#2251 promoted the former message prefix to a `code` field; `validationCode(err) === ValidationCode.RequiresRefresh` in `withCursorRecovery`) as a recovery signal: drop the cursor, refetch from page 1, and (if the user is mid-scroll) surface a "Sort changed — refresh to continue" toast.

**The source-mode save is the other `RequiresRefresh` consumer.** `apply_page_source` refuses a buffer whose base is no longer the page's source with the same code, and `PageSourceEditor` answers it by showing what changed instead of saving. Any future paginator that introduces cross-cursor incompatibility (sort change, schema change, filter change that invalidates keysets) should use the same `AppError::validation_coded(ValidationCode::RequiresRefresh, …)` shape so the frontend's recovery path stays single.

## Metadata aggregation

`PageWithMetadataRow` extends `BlockRow` with four columns, projected by `list_pages_with_metadata_inner`'s SELECT. `last_modified_at` and the two count columns are read from `pages_cache` (see "Materialised counts"); the flags are computed inline.

| Column | Definition | Index |
|--------|------------|-------|
| `last_modified_at` | `pages_cache.last_edited_ms`: the newest op on the page or any block on it, else the page's ULID creation time; kept when compaction prunes the ops (#5286). | `idx_pages_cache_space_edited` (migration 0124) |
| `inbound_link_count` | Canonical definition: `COUNT(DISTINCT block_links.source_id)` where the target is the page or any of its descendants (walked via `blocks.page_id`) and the source is a live block on another page in the page's space (`src.space_id IS page.space_id` — a `block_links` row survives a move to another space, #5275). Served from `pages_cache`. | `idx_block_links_target` (migration 0001) |
| `child_block_count` | Canonical definition: `COUNT(*)` non-deleted descendants where `page_id = page.id AND id != page.id`. Served from `pages_cache`. | `idx_blocks_page_id` |
| `flags: PagePropertyFlags` | Typed struct with `has_tags` / `has_todo` / `has_scheduled` / `has_due` — each an `EXISTS` subquery that short-circuits on first match. Replaces the original bitmask shape (Round 1 review). | `idx_block_tags_block_id`, `idx_blocks_page_id` |

### Materialised counts

`inbound_link_count` and `child_block_count` are **materialised into `pages_cache`** (migration `0069`). The IPC's SELECT drives from `pages_cache` and reads the cached columns directly; the previous per-page `COUNT(DISTINCT bl.source_id)` / `COUNT(*)` correlated subqueries are gone.

The materializer maintains both columns byte-identically to the canonical SELECT on every `CreateBlock` / `EditBlock` / `DeleteBlock` / `RestoreBlock` / `PurgeBlock` op (helpers live in `src-tauri/agaric-engine/src/materializer/handlers/pages_cache.rs`). The implementation uses **recompute-on-touch** (re-run the canonical aggregate for affected pages on each op) rather than delta-math — per-op cost is bounded by the affected-page count (typically 1-5) and the parity test catches any drift.

The parity contract is non-negotiable: `src-tauri/agaric-engine/src/materializer/tests/pages_cache_parity.rs` (`mixed_fixture_full_lifecycle` via `assert_parity`) exercises a mixed 10-page fixture through every materializer op and asserts `pages_cache.{inbound,child}_block_count == SELECT COUNT(...) FROM block_links / blocks` after each step.

Materialised columns turn the `most-linked` first-page query from a per-page correlated subquery over `block_links` into a direct read on `pages_cache` — the regression bench is `src-tauri/benches/interactive_slo.rs` (run with `cd src-tauri && cargo bench --bench interactive_slo`). `EXPLAIN QUERY PLAN` shows `SEARCH pc USING INDEX idx_pages_cache_space_linked (space_id=?)` — no `block_links` scan, no count subquery, and no temp B-tree: the index rewrite a count change costs is paid on the write so the read never sorts the space (`every_sort_reads_an_index_instead_of_sorting_the_space_5371` pins every sort's plan).

Migration `0123` adds the two sort keys beside them, `title_sort_key` and `last_edited_ms`; migration `0124` adds `space_id` and the per-sort indexes above. The page-row rebuild (`cache::pages::rebuild_pages_cache`) writes the title key wherever it writes the title and births `last_edited_ms` from the op log; boot schedules it while a row is still at the migration's unfilled default, or a live page has no row or a row in another space (an engine reproject in recovery writes `blocks.space_id` without the cache). `pages_cache_parity.rs` pins both keys after single ops, a batch and a cross-page move, and `space_id` through a page's `space` ops; the reconciliation oracle checks all three (`reconcile_pages_cache_sort_keys`).

## Open extension points

- **Backend graduation of saved views** — deferred. Saved views ship today as a per-device `localStorage` shape (`agaric:pages:savedViews:v1`); that shape is the long-term contract, and syncing them is a separate decision.
- **MCP exposure of `list_pages_with_metadata`** — deferred. Today's MCP `list_pages` serves the simpler shape; the richer surface lands only if a tool-side need emerges in the saved-views or compound-filter work.
