<!-- markdownlint-disable MD060 -->
# Pages view architecture

The shape of the Pages browser — the list view that fronts every page in the active space. This file documents the **data flow** behind density rows, the seven sort modes, and the per-page metadata IPC. Workflow + UI conventions live with the page-browser source under `src/components/PageBrowser/`; this file is the load-bearing contract a contributor reads before touching the surface.

## Overview

The Pages view is the canonical "show me every page in this space" surface. It feeds the in-app navigator (starred + namespace tree + flat tail) and is the host surface for three coordinated workplans:

| Plan | Scope | Status |
|------|-------|--------|
| **PEND-56** | Density rows + 7 sort modes + per-page metadata IPC (`list_pages_with_metadata`) | Phase 1 (backend) + Phase 2 (frontend hooks) shipped. Phase 3 (orchestrator wiring + `DensityRow`) shipping now. |
| **PEND-56b** | Materialise `inbound_link_count` + `child_block_count` into `pages_cache`; extract a `SortKeyset` descriptor | Shipped — closes the 20k-page scaling cliff (335 ms → 34 ms). See "Materialised counts" below. |
| **PEND-57** | Multi-select + bulk ops + saved views (filter+sort+density snapshots in localStorage) | Pending — consumes the density-row primitive and the metadata columns this plan adds. |
| **PEND-58** | Compound filters (`tag:` / `path:` / `has-property:` / `last-edited:` / Pages-only `orphan:` / `stub:` / `has-no-inbound-links:`) sharing the parser with Search | Phase 1 (`FilterPrimitive` extraction) shipped; builds on PEND-56's cursor + metadata columns. |

The three follow-up plans intentionally compose: PEND-57's saved view is a `{filterSet, sort, density}` triple, where PEND-58 owns `filterSet`, PEND-56 owns `sort` + `density`, and PEND-57 owns the storage shape. **The metadata IPC introduced here is the seam that lets all three plans avoid re-querying for shared columns.**

## Data flow

Every Pages-view list render walks the same five stages. The IPC is the only async hop; everything below it is pure transformation.

```text
┌──────────────────────────┐
│ list_pages_with_metadata │  Tauri IPC — paginated keyset over `blocks WHERE block_type='page'`,
│   (pages.rs:1626)        │  joined to 4 metadata aggregates. Cursor carries sort-key value
└────────────┬─────────────┘  + sort-mode discriminator. Returns PageResponse<PageWithMetadataRow>.
             │
             ▼
┌──────────────────────────┐
│  usePaginatedQuery       │  Generic hook (src/hooks/usePaginatedQuery.ts) — owns the
│   ↳ rows[], hasMore,     │  cursor/limit state machine + request-id stale-guard. The
│     loadMore, refetch    │  `RequiresRefresh:` recovery wrapper lives in the orchestrator
│                          │  (`PageBrowser.tsx:97-114` `withCursorRecovery`); see below.
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  usePageBrowserSort      │  Applies the active comparator. Three modes are frontend-only
│   .sortPages(rows)       │  (`alphabetical`, `recent`, `created`); four ride the IPC (`recently-
│                          │  modified`, `most-linked`, `most-content`, `default`). See
│                          │  "Sort modes" below.
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  usePageBrowserGrouping  │  Folds the flat row list into the Starred + Namespace-tree +
│   .buildMultiPageBranch  │  Pages layout. `sortTopLevelUnits` aggregates child metadata
│                          │  for namespace roots so a tree root sorts by its descendants'
│                          │  metric, not the root's own (always-zero) column.
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  <DensityRow>            │  Pages-specific leaf row (compact 32px / regular 44px /
│   src/components/        │  expanded 68px). Reads typed primitive props for memoisation;
│   PageBrowser/           │  badge set varies by density per the "Density" section below.
│   DensityRow.tsx         │  Tree-page rows still use the recursive `PageTreeItem`; only
│                          │  leaf rows are density-aware.
└──────────────────────────┘
```

Two side hooks orbit this pipeline without altering its shape:

- **`usePageBrowserDensity`** owns the row chrome and the virtualizer's `estimateSize`. Density never affects which rows render — only how each row paints.
- **Alias resolver** (`PageBrowser.tsx:262-284`) is a parallel single-row IPC for "user typed an alias in the filter box" (`resolvePageByAlias` → augments `aliasMatchId` so the matching page surfaces even when its visible title doesn't match the filter); it is independent of the list query and unchanged by this plan.

## Sort modes

Seven options. Three carried forward from the legacy three-mode list; four added by PEND-56:

| Sort option | Comparator type | Wire value | Cursor key | Notes |
|-------------|-----------------|------------|------------|-------|
| `alphabetical` | Frontend-only (`localeCompare`) | `default` (IPC orders by id ASC; JS re-sorts the page) | `id` (tiebreaker only) | SQLite `COLLATE NOCASE` disagrees with V8 `localeCompare` on every non-ASCII title, so JS owns the comparator over the bounded page-of-50. |
| `recent` | Frontend-only (`getRecentPages()` MRU lookup) | `default` | n/a — local visit history layered on top | Per-device localStorage history; never goes over the wire. |
| `created` | Frontend-only (ULID DESC) | `default` | `id` | Treats the ULID timestamp prefix as creation order. |
| `recently-modified` | Wire — backend `last_modified_at` DESC | `recently-modified` | `last_modified_at` (in `Cursor.deleted_at` slot) + `id` tiebreaker | NULL `last_modified_at` is COALESCE'd to `'0001-01-01'` so the keyset works uniformly across NULL + non-NULL rows. |
| `most-linked` | Wire — `pages_cache.inbound_link_count` DESC | `most-linked` | `inbound_link_count` (in `Cursor.seq` slot) + `id` tiebreaker | Served by the materialised column (PEND-56b). ~34 ms at 20k pages. |
| `most-content` | Wire — `pages_cache.child_block_count` DESC | `most-content` | `child_block_count` (in `Cursor.seq` slot) + `id` tiebreaker | Same materialised path as `most-linked`. |
| `default` | Wire — backend `id ASC` | `default` | `id` | Power-user / debug; also the wire shape the three frontend-only sorts reuse. |

Cursor implications:

- Each wire-sort encodes its primary key into an **existing** `Cursor` slot (`deleted_at` for ISO timestamps and strings; `seq` for i64 counts). No new typed slot. Any future paginator introducing a non-id sort key must reuse those existing slots rather than growing the struct.
- `Cursor.position` carries a sort-mode discriminator (i64 stamped by `sort_discriminator`). A cursor whose discriminator does not match the requested sort is rejected at decode — this is the recovery contract for "user changed sort mid-scroll" (see "Cursor recovery" below).
- The three frontend-only sorts (`alphabetical`, `recent`, `created`) all map to wire value `default` and re-sort the loaded page in JS. They scroll past the loaded window in **id-ASC** order, not in comparator order — a known property of the implementation, preserved across the PEND-56 rewrite.

Sort comparators must not allocate per-comparison. The `sortPages` callback in `usePageBrowserSort` materialises any expensive lookup (the `getRecentPages()` `Map`, the metadata `lookupMeta` closure) **once** before `Array.sort`. The comparator body reads scalars off rows and returns an integer; no `.map`, no `new Date()`, no closure-over-row inside the comparator. Adding a sort mode follows this pattern.

## Density

Three modes, persisted to localStorage. Default `regular` to match the existing row height and avoid a virtualizer re-measure storm on first upgrade.

| Density | Row height | Badge set | Re-measure on toggle? |
|---------|------------|-----------|------------------------|
| `compact` | 32 px | Title + relative time only. Inbound-link / child-count / property flags collapse into the title tooltip. | Yes |
| `regular` | 44 px | Title + `↗ inbound_link_count` + `⊟ child_block_count` + relative time + first matched `has-*` flag chip (if any). | Yes |
| `expanded` | 68 px | Title on line 1; full metadata row on line 2; all `has-*` flag chips render (not just the first). | Yes |

Contract — load-bearing for tests and for downstream consumers:

- **Storage key:** `page-browser-density`. Value is the bare mode string (`compact` / `regular` / `expanded`); not JSON-wrapped.
- **`data-density` attribute:** Every `<DensityRow>` renders with `data-density={mode}`. Integration tests assert against this attribute; the virtualizer's `estimateSize` callback identity is keyed off the same value so density transitions invalidate the saved scroll offset.
- **Row height source:** `DENSITY_ROW_HEIGHT` in `src/hooks/usePageBrowserDensity.ts` is the single source of truth. The virtualizer reads `rowHeight` off the hook; no other component should hardcode 32/44/68.
- **Independence from sort:** Toggling density never changes the IPC arguments or the sort comparator. Sort + density are orthogonal preferences with separate storage keys (`page-browser-sort` and `page-browser-density`).

`<DensityRow>` is **Pages-specific** and lives at `src/components/PageBrowser/DensityRow.tsx`. TrashView and HistoryView have different row shapes (`TrashRow.descendants_affected`, `HistoryEntry`'s op-log payload), so extracting prematurely couples three views to a single primitive that has to grow optional props for each one's metadata. If a second consumer needs this shape, propose an extraction PR first rather than importing across surfaces.

## Cursor v1 → v2 (the `RequiresRefresh:` recovery contract)

The legacy Pages view called `list_blocks(blockType='page')`, whose cursor encodes `(id ASC)` only. The new IPC needs keysets on a numeric / date column with `id` as the tiebreaker, plus a sort-mode discriminator so cursors don't survive a sort change.

The implementation **does not bump `CURRENT_CURSOR_VERSION`** (it stays at 1). Instead `list_pages_with_metadata` reuses existing `Cursor` slots:

- `Cursor.position` → sort-mode discriminator (i64, one per `PageSort` variant).
- `Cursor.deleted_at` → primary-sort key for string / ISO-timestamp sorts.
- `Cursor.seq` → primary-sort key for i64-count sorts.
- `Cursor.id` → tiebreaker (always).

A cursor whose `position` slot does not match the requested sort is rejected by `validate_pages_metadata_cursor` with `AppError::Validation("RequiresRefresh: cursor sort mismatch (expected …)")`. The frontend recognises the `RequiresRefresh:` prefix as a recovery signal: drop the cursor, refetch from page 1, and (if the user is mid-scroll) surface a "Sort changed — refresh to continue" toast.

**This is the only `RequiresRefresh:` consumer today.** Any future paginator that introduces cross-cursor incompatibility (sort change, schema change, filter change that invalidates keysets) should use the same `AppError::Validation("RequiresRefresh: …")` shape so the frontend's recovery path stays single.

## Metadata aggregation

`PageWithMetadataRow` extends `BlockRow` with four columns. Each is derived by a correlated subquery in `list_pages_with_metadata_inner`'s SELECT — there is no materialised view today.

| Column | Definition | Index |
|--------|------------|-------|
| `last_modified_at` | `MAX(op_log.created_at)` for the page itself (not subtree-aware in v1 — the recursive-CTE variant is deferred per PEND-56 open question #1). | `idx_op_log_block_id` (migration 0030) |
| `inbound_link_count` | `COUNT(DISTINCT block_links.source_id)` where the target is the page or any of its descendants (walked via `blocks.page_id`). | `idx_block_links_target` (migration 0001) |
| `child_block_count` | `COUNT(*)` non-deleted descendants where `page_id = page.id AND id != page.id`. | `idx_blocks_page_id` |
| `flags: PagePropertyFlags` | Typed struct with `has_tags` / `has_todo` / `has_scheduled` / `has_due` — each an `EXISTS` subquery that short-circuits on first match. Replaces the original bitmask shape (Round 1 review). | `idx_block_tags_block_id`, `idx_blocks_page_id` |

### Materialised counts (PEND-56b)

`inbound_link_count` and `child_block_count` are **materialised into `pages_cache`** (migration `0069`). The IPC's SELECT LEFT JOINs `pages_cache` and reads the cached columns directly; the previous per-page `COUNT(DISTINCT bl.source_id)` / `COUNT(*)` correlated subqueries are gone.

The materializer maintains both columns byte-identically to the canonical SELECT on every `CreateBlock` / `EditBlock` / `DeleteBlock` / `RestoreBlock` / `PurgeBlock` op (helpers live in `src-tauri/src/materializer/handlers.rs`). The implementation uses **recompute-on-touch** (re-run the canonical aggregate for affected pages on each op) rather than delta-math — per-op cost is bounded by the affected-page count (typically 1-5) and the parity test catches any drift.

The parity contract is non-negotiable: `src-tauri/src/materializer/tests.rs::pages_cache_count_parity` exercises a mixed 10-page fixture through every materializer op and asserts `pages_cache.{inbound,child}_block_count == SELECT COUNT(...) FROM block_links / blocks` after each step.

**Measured latencies** (warm steady-state, sqlite 3.50.6, 20k pages, 100k links):

| Sort | Before (correlated subqueries) | After (materialised columns) |
|---|---|---|
| `most-linked` first-page | 335 ms | **34 ms** (10× win) |
| `most-content` first-page | ~20 ms | sub-10 ms |

`EXPLAIN QUERY PLAN` for `most-linked` confirms the plan uses `SEARCH pc USING INDEX sqlite_autoindex_pages_cache_1` — no `block_links` scan, no `CORRELATED SCALAR SUBQUERY`. The plan terminates with `USE TEMP B-TREE FOR ORDER BY` (no secondary index on `inbound_link_count DESC` — at ≤20k pages the quick-sort-into-top-K is sub-50 ms and an index would add maintenance cost on every link change without paying for itself).

`last_modified_at` is not materialised — it is served cheaply by `idx_op_log_block_id` and does not hit the same cliff at the measured scales.

## Open extension points

- **PEND-57** (multi-select + bulk ops + saved views). Consumes `<DensityRow>` (extends it with a select checkbox), reads the metadata columns to drive bulk operations, and snapshots the `{filterSet, sort, density}` triple to `agaric:pages:savedViews:v1` in localStorage. Backend graduation of saved views is out of scope; the per-device storage shape is the long-term contract.
- **PEND-58** (compound filters). Extends `ListPagesWithMetadataFilter` with a `Vec<FilterPrimitive>` field, shared with `SearchFilter` via the `FilterPrimitive` enum + per-surface `Projection` trait. The Pages-only `orphan:` / `stub:` / `has-no-inbound-links:` primitives ride the same metadata columns this plan introduces; the materialised counts shipped in PEND-56b are the prerequisite for those facets at scale.
- **MCP exposure of `list_pages_with_metadata`** — deferred. Today's MCP `list_pages` serves the simpler shape; the richer surface lands only if a tool-side need emerges in PEND-57 / PEND-58.
- **Subtree-aware `last_modified_at`** — deferred per PEND-56 open question #1. The recursive-CTE variant is a single SELECT change once benchmark evidence justifies it.
