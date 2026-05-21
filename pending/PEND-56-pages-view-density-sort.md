# PEND-56 — Pages view foundation: density rows + extended sort modes + per-page metadata IPC

**Status (2026-05-21):** Phase 1 (backend) + Phase 2 (frontend hooks) shipped. Phase 3 (orchestrator wiring + DensityRow) shipping in this session.

> **Foundation plan (1 of 3)** for the Pages-view redesign. Adds density-row rendering with
> per-page metadata badges (last-modified, inbound-link count, child-block count, has-property
> flags) and four new sort modes on top of today's three. Sibling plans **PEND-57** (bulk
> ops + saved views) and **PEND-58** (compound filters) build on the metadata columns + sort
> infrastructure this plan introduces. Today's `PageBrowser` is functionally a flat name list;
> the three plans together turn it into a browsing surface a senior IC can groom 500 pages
> in without leaving the keyboard.

## TL;DR

- **Backend:** ~M. One new sibling IPC `list_pages_with_metadata` next to existing
  `list_blocks`. Adds four metadata columns via joins against `op_log`, `block_links`,
  `blocks(page_id)`, `block_properties`. Cursor schema bump from v1 → v2 (recency / link-count
  / size sort modes need keysets that the v1 `(id ASC)` cursor cannot encode). Reuses every
  existing index — no migration.
- **Frontend:** ~M-L. New `<DensityRow>` primitive co-located in `PageBrowser/` (kept
  Pages-specific in this plan; extraction to `components/` deferred). `density` preference
  (compact / regular / expanded) persisted in localStorage. Sort dropdown extends from
  three to seven options. Metadata badges render from typed primitive props so memoisation
  hits — same memo pattern that `BlockListItem` uses.
- **Docs:** ~S. `docs/architecture/pages-view.md` (new). Help dialog entry covering density
  - sort. `AGENTS.md` invariants for the cursor-version bump and density-preference key.
- **No migration.** Indexes `idx_op_log_block_id` (migration 0030),
  `idx_block_links_target` (migration 0001), `idx_blocks_parent` (migration 0001),
  and `idx_block_props_date` already cover the four metadata joins.
- **Behind a flag.** New IPC + density UI gated by a `pageBrowser.densityV1` preference
  for the first release so the existing 3-mode flat-row layout stays the rollback target.
  Flag removed in a follow-up after one stable release.

## Current state

Verified against the codebase:

- **Component LOC.** `src/components/PageBrowser.tsx` is 644 LOC, `usePageBrowserSort.ts`
  91 LOC, `usePageBrowserGrouping.ts` 287 LOC, `PageBrowserHeader.tsx` 165 LOC,
  `PageBrowserRowRenderer.tsx` 273 LOC. Test surface: `PageBrowser.test.tsx` (3001 LOC,
  106 `it`/`test` blocks, 6 axe audits), `usePageBrowserSort.test.ts` (106 LOC, 8 tests),
  `usePageBrowserGrouping.test.ts` (177 LOC, 11 tests).
- **Sort modes today (`usePageBrowserSort.ts:16`).** Three options: `'alphabetical'`,
  `'recent'`, `'created'`. Preference persisted via `useLocalStoragePreference` under
  `'page-browser-sort'`. `'recent'` comparator reads `getRecentPages()` (frontend-only
  localStorage history of visited pages); `'created'` sorts by ULID descending.
- **Data shape.** `BlockRow` (`src-tauri/src/pagination/mod.rs:124-137`) carries
  `{id, block_type, content, parent_id, position, deleted_at, todo_state, priority,
  due_date, scheduled_date, page_id}`. No metadata columns — every "last modified" or
  "backlink count" UI today either fakes it from `id` (ULID order) or doesn't render it.
- **IPC.** `list_blocks` (`src-tauri/src/commands/blocks/queries.rs:326`) takes 7 args
  via `AgendaQuery` bundle, returns `PageResponse<BlockRow>`. The Pages view at
  `PageBrowser.tsx:69-83` calls `listBlocks({blockType: 'page', cursor, limit, spaceId})`.
- **Cursor.** `CURRENT_CURSOR_VERSION = 1` at `src-tauri/src/pagination/mod.rs:66`. The
  `Cursor` struct (lines 292-303) carries `{id, position, deleted_at, seq, rank}`;
  `list_by_type` (pagination/hierarchy.rs:96) keys on `id ASC` only.
- **Virtualization + scroll restoration + namespace tree merging are stable** —
  `useVirtualizer` from `@tanstack/react-virtual`, `sessionStorage` scroll restoration
  per space (`PageBrowser.tsx:321-403`), namespace tree merging via
  `usePageBrowserGrouping.buildMultiPageBranch`. **Do not regress these.**
- **Reusable primitives present.** `useListKeyboardNavigation` (189 LOC),
  `FilterPillRow` (130 LOC), `BlockListItem` (455 LOC, memoised inner component with
  typed primitive props for the metadata row). `FeaturePageHeader` exists but is not used
  by `PageBrowser` today.

## Design

### UX

```text
┌──────────────────────────────────────────────────────────────────┐
│  [+ new page                          ] [New]   312 pages        │  ← create form (unchanged)
│  [search…                             ] [Sort: Alphabetical ▾] [≡ Density ▾]
├──────────────────────────────────────────────────────────────────┤
│  ★  STARRED  (3)                                                  │  ← header (unchanged)
│  ⭐ ☐ Project Alpha           5 ↗  · 12 ⊟  · 3d                  │  ← regular density
│  ⭐ ☐ Journal/2026-05-17      2 ↗  · 8  ⊟  · today               │
│  ⭐ ☐ Roadmap                 9 ↗  · 41 ⊟  · 1w     [#focus]     │  ← has-property badge
├──────────────────────────────────────────────────────────────────┤
│  📄  PAGES  (309)                                                 │
│  ▸ Archive                                            42 pages    │  ← namespace root
│  ☐ Daily 2026-05-12          0 ↗  · 3  ⊟  · 5d                   │
│  ☐ Meeting Notes             1 ↗  · 7  ⊟  · 2h     [#review]    │
└──────────────────────────────────────────────────────────────────┘

Metadata legend:  ↗ = inbound links · ⊟ = child blocks · relative time = last modified ·
[#tag] = has-property hint (renders the first matched flag from a fixed allowlist)
```

Three densities; only the row chrome changes. Backlink count / child count / last-modified
relative time / has-property badges are present at all densities — what varies is wrapping,
padding, and which fields collapse into an overflow tooltip on compact.

- **Compact.** 32 px row. Title + the *single* most informative metadata field (last-modified
  relative time). Remaining metadata accessible via title-tooltip with the full breakdown.
- **Regular (default).** 44 px row. Title + ↗ + ⊟ + relative time + first has-property
  badge (if any). Matches today's row height — no virtualizer re-measure storm on first
  flag flip.
- **Expanded.** ~68 px row. Title on line 1; metadata row underneath; all has-property badges
  rendered (not just first); two-line content if there's a description property. Always
  forces virtualizer re-measure on toggle.

Density is a separate localStorage preference (`'page-browser-density'`), independent of
sort, persisted per device. Default is **regular** to minimise visual disruption on first
upgrade; an upgrade-time toast invites the user to try compact.

### Sort modes

Seven options. Three carried forward, four new:

| Option (key) | Comparator | Carry / new |
|---|---|---|
| `alphabetical` | `content.localeCompare` | Carry |
| `recent` (recently-visited) | `getRecentPages()` map lookup; existing behaviour preserved | Carry |
| `created` (ULID DESC) | `b.id.localeCompare(a.id)` | Carry |
| `recently-modified` | `last_modified_at DESC` (from backend; max `op_log.created_at` for the page or its descendants) | New |
| `most-linked` | `inbound_link_count DESC`, then `alphabetical` | New |
| `biggest` (size) | `child_block_count DESC`, then `alphabetical` | New |
| `ulid` | `id ASC` — surfaces the raw backend default for power users / debugging | New |

The four new modes are split between **comparator-only changes** (`ulid` is just the SQL
default, no extra IPC field) and **modes that need backend-computed columns** (the other
three). The frontend comparator dispatches on `sortOption` and reads the appropriate
metadata column from the row.

`recent` stays frontend-only — its `getRecentPages()` source is per-device visit history
and never makes sense to move server-side. `recently-modified` is the server-derived twin
that any device can compute identically.

### IPC + data shape

**Decision: add a new sibling IPC `list_pages_with_metadata`, do not extend `list_blocks`.**

Reasons:

1. `list_blocks` is a polymorphic dispatcher (`list_blocks_inner`, 7 callsites in the
   frontend, MCP `list_pages` tool, agenda paths). Adding four metadata columns to its
   return type pulls join cost into every non-pages caller.
2. The sibling-IPC pattern matches `ExtraQueryFilters` precedent at
   `src-tauri/src/commands/mod.rs:487` — when a query gains structure that other callers
   don't need, fork the surface rather than overload the shared one.
3. `list_blocks` returns `PageResponse<BlockRow>`. A new typed return
   `PageResponse<PageWithMetadataRow>` keeps the tauri-specta binding for `BlockRow`
   stable; the four metadata-aware UIs (this view today, PEND-57 / PEND-58 later)
   consume the richer row.

Shape sketch (load-bearing only — implementation details elided):

```rust
// src-tauri/src/commands/pages.rs  (sibling to list_pages_inner)
#[derive(Debug, Clone, Serialize, sqlx::FromRow, specta::Type)]
pub struct PageWithMetadataRow {
    // Carry every BlockRow column verbatim so the frontend can downcast for free.
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
    pub todo_state: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    pub scheduled_date: Option<String>,
    pub page_id: Option<String>,
    // New columns:
    pub last_modified_at: Option<String>,   // max(op_log.created_at) over page subtree
    pub inbound_link_count: i64,            // COUNT(block_links WHERE target_id = page_id_or_descendant)
    pub child_block_count: i64,             // COUNT(blocks WHERE page_id = id AND deleted_at IS NULL AND id != page_id)
    pub has_property_flags: i64,            // bitmask: 0=has tags, 1=has todo descendants, 2=has scheduled, 3=has due
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListPagesWithMetadataFilter {
    pub sort: PageSort,                     // enum: Alphabetical | RecentlyModified | MostLinked | Biggest | Ulid
                                            //  (frontend-only sorts — `recent`, `created` — never come over the wire;
                                            //   they reuse the `Ulid` SQL ordering and re-sort in JS.)
    pub space_id: String,
}
```

**Cursor implications.**

- `alphabetical` is a frontend-only sort layered on top of the cursor stream — backend
  serves `Ulid` order, frontend re-sorts the loaded page. Risk: the stream comes in
  `id ASC`, so alphabetical scroll past the loaded window misses any page whose title
  starts with an earlier letter than the most-recent-loaded ULID. This is a known property
  of the current implementation (see `usePageBrowserSort.ts:69-70`) and we preserve it.
- `recently-modified`, `most-linked`, `biggest` need keyset cursors on a numeric / date
  column, not on `id`. **Bump `CURRENT_CURSOR_VERSION` 1 → 2.** Add a second optional
  slot to the existing `Cursor` struct (`pagination/mod.rs:292`): `pub last_sort_key:
  Option<String>` — a serialised primary-sort value. Reuse `id` as tiebreaker. Existing
  cursors decode as v1; the new IPC rejects v1 cursors with `AppError::Validation`,
  forcing a fresh first page on upgrade.
- AGENTS.md addition: any future paginator that introduces a new sort key reuses
  `last_sort_key` rather than adding a third typed slot.

### Edge cases (locked in)

- **Empty metadata.** A brand-new page has 0 inbound links, 0 child blocks, no op_log
  entries beyond its own creation, and no has-property flags. Row renders the title
  - `last_modified_at = created_at` (the page's own creation row in `op_log`); badges
  render with a `0` or are suppressed by the renderer (config: suppress `↗ 0` and
  `⊟ 0`, always render relative time).
- **Deleted mid-scroll.** The existing pattern (cursor + virtualizer + `usePaginatedQuery`)
  already handles this — if a page is deleted by another tab between two loads, the next
  cursor page just skips it. New code path: metadata IPC must NOT error if the requested
  page was deleted between cursor encode and decode; the join's
  `WHERE b.deleted_at IS NULL` filter handles it implicitly.
- **Namespace tree interaction.** `usePageBrowserGrouping.buildMultiPageBranch` builds
  a flat-or-tree row model from sorted leaves. The new sort modes feed in via the same
  `sortPages` callback. `sortTopLevelUnits` (lines 216-257) aggregates child metadata for
  namespace roots — extend its switch to handle the three new keys (`recently-modified`
  → max child `last_modified_at`; `most-linked` → sum of child `inbound_link_count`;
  `biggest` → sum of child `child_block_count`). The aggregator is comparator-internal,
  so namespace tree merging itself does not change.
- **Filter + sort.** `filterText`-based filtering already happens client-side
  (`PageBrowser.tsx:228-238`). The new sort modes apply *after* filtering for consistency
  with today's behaviour — sort over the visible result set, not the loaded buffer. Open
  question (below): whether to push glob filters into the IPC; PEND-58 owns that decision.

## Phase split

Each phase ≤ 1 day of focused work.

### Phase 1 — backend `list_pages_with_metadata` IPC + cursor v2 (M, ≈ 6 h)

- New `PageWithMetadataRow` + `ListPagesWithMetadataFilter` in `src-tauri/src/commands/pages.rs`
  (sibling to the existing `list_pages_inner`).
- Single SQL `SELECT … FROM blocks b LEFT JOIN (per-page aggregates) … WHERE b.block_type
  = 'page' AND b.deleted_at IS NULL` — three correlated sub-selects, one per aggregate, all
  hitting indexed columns (`idx_block_links_target`, `idx_op_log_block_id`,
  `idx_blocks_parent`). `has_property_flags` is a single CASE-bitmask in the SELECT list.
- Cursor schema bump 1 → 2 with the new `last_sort_key` slot. v1 cursors rejected at the
  decode boundary.
- Frontend `src/lib/tauri.ts` wrapper.
- Backend unit tests live in `src-tauri/src/commands/tests/list_pages_with_metadata_tests.rs`
  (new file to avoid churn against existing `pages.rs` tests).

### Phase 2 — frontend density primitive + preference (M, ≈ 5 h)

- New `src/components/PageBrowser/DensityRow.tsx` (Pages-specific in this plan; see
  *Maintainability*). Accepts the same typed primitive props pattern `BlockListItem` uses
  so `React.memo` shallow-compares hit.
- New `src/hooks/usePageBrowserDensity.ts` mirroring `usePageBrowserSort.ts` (parse / serialise /
  `useLocalStoragePreference`). Default `'regular'`.
- `PageBrowserHeader` extends with a density selector next to the sort selector.
- `PageBrowserRowRenderer` swaps the flat `PageRow` body for `<DensityRow>`. Tree-page rows
  reuse the existing recursive `PageTreeItem` (do not introduce density into the tree
  recursion in this plan — the tree primitives are stable; only the leaf row is
  density-aware).
- Virtualizer `estimateSize` returns 32 / 44 / 68 depending on the density.
- Feature flag: `pageBrowser.densityV1` localStorage flag gates the new code path. Without
  it, the existing flat-row layout renders.

### Phase 3 — frontend sort extension (S, ≈ 4 h)

- `usePageBrowserSort` extends its `SortOption` union to seven members. The parser /
  serialiser guards against unknown values (existing `parseSort` pattern, allowlist
  fallback to `alphabetical`).
- `sortPages` comparators added for `recently-modified`, `most-linked`, `biggest`, `ulid`
  — each reading the appropriate metadata column from the row.
- `sortTopLevelUnits` in `usePageBrowserGrouping` gains parallel aggregator branches.
- `PageBrowser` switches its `queryFn` from `listBlocks` to `listPagesWithMetadata` when
  the density flag is on. When the flag is off, behaviour is unchanged.

### Phase 4 — tests (M, ≈ 6 h)

See *Tests* section.

### Phase 5 — docs (S, ≈ 1.5 h)

- New `docs/architecture/pages-view.md`: data flow from IPC → grouping → row.
- Help dialog row covering density + sort.
- `AGENTS.md`: cursor v1 → v2 migration note; density preference key; metadata bitmask
  semantics; "sort comparator must not allocate per-comparison" invariant; do-not-couple
  density to tree-page row layout.

## Robustness

Surfaces that already work and must not regress:

- **Scroll restoration** (`PageBrowser.tsx:321-403`, sessionStorage keyed per space).
  Density toggle invalidates the saved offset (height changed); sort change already does.
  Filter change already does.
- **Virtualization** with `@tanstack/react-virtual`. New `estimateSize` callback identity
  is stable across same-density re-renders (memoised on density value, not on rows array).
- **Alias resolution** (`PageBrowser.tsx:152-171`, request-id stale-fetch guard). The new
  IPC does not change alias semantics; the alias resolver is independent of the list query.
- **Namespace tree merging** (`usePageBrowserGrouping.buildMultiPageBranch`,
  `buildPageTree`). The grouping memo's input is still `BlockRow[]`-compatible — the
  metadata-rich row is a structural superset. The tree builder only reads
  `content` and `id`, not the new columns.
- **Existing test surface** (3001-LOC `PageBrowser.test.tsx`, 106 cases including 6 axe
  audits). New cases extend the surface; existing cases continue to pass against the
  flag-off code path.

## Performance

Per-row metadata aggregation cost — quantified upper bound, to be measured during
Phase 1 build:

- `inbound_link_count` is `COUNT(*) FROM block_links WHERE target_id = ?` per page,
  served by `idx_block_links_target` (index lookup, no scan). Cost: O(matching rows)
  per page. **To be measured** against a 500-page vault during Phase 1; budget is
  "below the existing `list_blocks` latency baseline measured the same way" — record
  both numbers in the migration doc.
- `child_block_count` is `COUNT(*) FROM blocks WHERE page_id = ? AND deleted_at IS NULL`,
  served by `idx_blocks_parent`. Same shape, same upper bound.
- `last_modified_at` is `MAX(created_at) FROM op_log WHERE block_id = ?` (or `IN
  (descendants)` if we want subtree-aware modification time). Served by
  `idx_op_log_block_id` (migration 0030). The subtree-aware variant requires a recursive
  CTE — start with **page-itself only** in Phase 1; subtree variant deferred to a
  follow-up if benchmarks show users want it.
- `has_property_flags` is four `EXISTS` sub-selects bitwise-ORed in the SELECT list. Each
  EXISTS short-circuits on first match; expected sub-millisecond per page on a covered
  index.

**Caching.** Do not materialise. The four aggregates are derived from append-only sources
(`block_links`, `op_log`) and indexed inputs (`blocks.page_id`); the join cost is bounded
by the page count, not the descendant count. A materialised view would have to be
invalidated on every block insert / delete / link change — high coupling for unclear win.
Re-evaluate after the Phase 1 benchmark.

**LCP budget.** The Pages view's LCP is dominated by the first paginated batch (50 pages)
rendering. The new metadata join adds N≈50 row aggregations on the first batch. **No
specific ms budget is asserted in this plan** — instead, Phase 1 includes a perf test
that records the IPC latency on a seeded 500-page vault and asserts a ≤ 2× factor against
the same vault's existing `list_blocks(blockType='page')` latency, with the actual
numbers recorded as the regression baseline.

**Flag.** New code path gated by `pageBrowser.densityV1` localStorage flag for the first
release. Flag removed in a follow-up after one stable release shows no perf regression
in production telemetry.

## Maintainability

`<DensityRow>` stays Pages-specific in `src/components/PageBrowser/` for this plan.
Reasons:

1. TrashView and HistoryView have different row data shapes (`TrashRow`'s
   `descendants_affected`, `HistoryEntry`'s op-log payload) — extracting prematurely
   couples three views to a single primitive that has to grow optional props for each
   one's metadata.
2. `BlockListItem` already plays the "shared presentational block row" role and is
   structurally different from what Pages needs (PageLink breadcrumb, due-date chip).
   Adding a second shared primitive without first observing the second consumer's needs
   is a YAGNI bet.
3. Extraction is mechanical and reversible — the row's prop interface mirrors
   `BlockListItemProps`'s primitive-props shape, so a future move to
   `components/DensityRow.tsx` is a rename + import update.

`AGENTS.md` adds an explicit note: "Pages-specific row in `PageBrowser/DensityRow.tsx`.
Do not import from outside `PageBrowser/`. If a second consumer needs this shape, propose
an extraction PR first."

## Tests

### Unit

- `usePageBrowserSort.test.ts` extends from 8 to ≥ 19 tests:
  - Each new comparator (`recently-modified`, `most-linked`, `biggest`, `ulid`) with
    explicit equal-key tiebreaker assertions (e.g. two pages tied on
    `inbound_link_count` fall back to alphabetical).
  - Allowlist parse rejects unknown values, falls back to `alphabetical`.
  - Round-trip: every option serialises and parses back to itself.
- `usePageBrowserDensity.test.ts` (new file, ~6 tests):
  - Parse / serialise / default fallback.
  - Density toggle state machine: compact → regular → expanded → compact (cycle).
  - Persistence: setDensity writes to localStorage with the documented key.
- `usePageBrowserGrouping.test.ts` extends from 11 to ≥ 17:
  - `sortTopLevelUnits` with each new sort option; tree-root aggregates match
    descendant-aggregate semantics.
  - Hybrid root (`pageId` set + has children) sorts by aggregate, not by own column.
- New `pageMetadataFetch.test.ts` (frontend wrapper test, ~5 tests):
  - `listPagesWithMetadata` wrapper passes `sort` and `spaceId` through.
  - Cursor v1 rejection bubbles as `AppError::Validation` to the caller.

### Integration

- `PageBrowser.test.tsx` extends from 106 to ≥ 120 cases:
  - Filter + each new sort = cross-product asserts the filtered set is the source for
    sort (no leaked unfiltered rows).
  - Density toggle changes row height (asserted via `data-density` attribute and the
    virtualizer's `estimateSize` callback identity).
  - Density preference persists across remount.
  - Metadata badges render for inbound-link count, child-block count, last-modified
    relative time, has-property flag — at regular density. At compact density, only
    the relative time renders; the rest are in the tooltip.
  - **Keyboard nav completeness** (Round-1 gap): Arrow + Home/End/PgUp/PgDn cover all
    visible rows under each density; focus ring stays on the focused row across density
    changes.
  - **Alias race condition** (Round-1 gap): explicit test for the `aliasReqIdRef`
    monotonic guard under interleaved fast-typing.
  - **Namespace creation flow** (Round-1 gap): create `foo/bar` while sorted by
    `most-linked` → the new page lands under the correct namespace root.

### e2e

- One new Playwright case: load Pages view → toggle to compact → verify metadata badges
  visible → toggle sort to `most-linked` → verify result order matches the metadata column.

### Perf

- New `pageBrowserPerf.test.ts`: render-count assertion. Seed a 500-page synthetic vault;
  measure number of `<DensityRow>` renders during a scroll from top to bottom and back;
  assert ≤ 1.2 × the baseline (recorded from the same test on the flag-off path).
  Frame-budget assertion is left as a follow-up — Playwright's frame timing is noisy
  enough on CI that we'd be asserting against environment variance, not user-visible
  perf. Record the wall-clock IPC latency as a regression baseline instead.

### a11y

- `axe` audit at each density mode (compact, regular, expanded), in addition to the
  existing 6 axe audits. Each density's badge set must satisfy contrast on the live theme
  tokens (dark + light).

## Open questions

1. **`last_modified_at`: page-only or subtree-aware?** The subtree-aware variant lets
   users find pages where any child changed recently — useful for grooming. The page-only
   variant is cheaper. **Defer the recursive-CTE variant**; ship page-only in this plan and
   revisit after the Phase 1 benchmark.
2. **Density default.** `regular` minimises visual disruption on first upgrade and matches
   today's row height (no virtualizer re-measure storm). Alternative: ship `compact` as the
   default to advertise the new chrome aggressively. **Recommendation: regular**; collect
   density-toggle telemetry before reconsidering.
3. **Cursor v2 backward-compat window.** Reject v1 cursors hard, or quietly decode them as
   v1 and re-emit v2? **Recommendation: reject**, with an `AppError::Validation` carrying
   a `RequiresRefresh:` prefix that the frontend translates to a "Sort changed — refresh
   to continue" toast. Cleaner than silently mis-paginating.
4. **`has_property_flags` bitmask field set.** Initial allowlist: `has_tags`, `has_todos`,
   `has_scheduled`, `has_due`. Any more (e.g. `has_attachments`)? Defer to PEND-58 which
   owns property filtering — let it propose its own flag additions when it lands.
5. **MCP exposure.** Should `list_pages_with_metadata` be exposed to the agent? The existing
   `list_pages_inner` already serves MCP; the metadata-rich version is a richer surface
   that could help agents prioritise. **Defer** — wire to MCP only if a tool-side need
   emerges in PEND-57 / PEND-58.

## Acceptance criteria

Sharp and testable:

1. **Density preference round-trips.** Setting density to `expanded`, reloading, and
   asserting that the rendered row's `data-density="expanded"` attribute is set — green
   in the integration test.
2. **All seven sort modes are reachable from the dropdown** and each produces the
   comparator-asserted order over the same fixture set.
3. **Cursor v1 rejection.** Replaying a v1 cursor against `list_pages_with_metadata`
   returns `AppError::Validation` carrying the `RequiresRefresh:` prefix; the frontend
   recovers by issuing a fresh cursorless request.
4. **Metadata join cost.** Phase 1's benchmark records `list_pages_with_metadata`
   latency over a seeded 500-page vault. The recorded number is captured as the
   regression baseline; the perf test asserts subsequent runs stay within 20 % of
   baseline. The first measurement defines the budget; the budget is not pre-asserted.
5. **No regression in the 106 existing `PageBrowser.test.tsx` cases** under the flag-on
   path, including the 6 axe audits.
6. **Density preference is independent of sort.** Toggling density does not change the
   sort comparator or the IPC arguments.
7. **Namespace tree merging is unchanged** structurally: `buildPageTree`'s output graph
   for a fixed input is byte-identical before and after this plan.

## Related

- `pending/PEND-57-pages-view-bulk-ops-saved-views.md` (planned sibling) — bulk select +
  saved views; consumes the density-row primitive and the IPC's `has_property_flags` field.
- `pending/PEND-58-pages-view-compound-filters.md` (planned sibling) — compound filters
  (`has-property:`, `linked-to:`, etc.); reads the same metadata columns this plan adds
  and extends the IPC's filter struct.
- `src/components/PageBrowser.tsx` — main refactor site (644 LOC).
- `src/hooks/usePageBrowserSort.ts` — extends from 3 to 7 sort modes.
- `src/hooks/usePageBrowserGrouping.ts` — extends `sortTopLevelUnits` aggregator.
- `src/components/PageBrowser/PageBrowserRowRenderer.tsx` — swap leaf `PageRow` for
  `<DensityRow>`.
- `src-tauri/src/commands/pages.rs` — new `list_pages_with_metadata_inner` sibling of
  `list_pages_inner`.
- `src-tauri/src/pagination/mod.rs:66` — cursor version bump 1 → 2.
- `src-tauri/migrations/0001_initial.sql:101-105` — `pages_cache` columns this plan
  uses for title resolution if needed (titles come from `blocks.content` today; cache
  not strictly required for the metadata IPC).
