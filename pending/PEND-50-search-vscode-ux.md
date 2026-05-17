# PEND-50 — Search foundation: IPC struct migration + page-grouped result rendering + match highlighting

> **Foundation plan** for the search UX overhaul. Does three things:
>
> 1. Migrates `search_blocks` from positional Tauri args to an **`ExtraQueryFilters`-style request struct** (`SearchFilter`) and a typed response row (`SearchBlockRow`). Required before any follow-up plan can add filter fields — `search_blocks` currently has 6 user args + `State`, and the tauri-specta 10-arg ceiling is already hit by PEND-54.
> 2. Replaces the flat result list in `SearchPanel` with **page-grouped results** matching VSCode's *Find in Files* layout, **reusing the existing `CollapsibleGroupList` component** (115 LOC, already implements grouped-by-`page_id` with `aria-expanded` chevrons).
> 3. Adds **match highlighting** in snippets via FTS5 `snippet()`, rendered as React nodes (no `dangerouslySetInnerHTML` — no XSS surface, no DOMPurify dep).
>
> Three follow-up plans build on this one: **PEND-54** (inline filter syntax + glob/tag), **PEND-55** (toggle row + history), **PEND-53** (property filters). **PEND-51** (Cmd+K palette) consumes the same grouped-renderer. **PEND-52** (in-page find) coordinates the `Ctrl+F` ↔ `Ctrl+Shift+F` keyboard rebind.

## TL;DR

- **Backend:** ~M (~5-7 h). Introduce `SearchFilter` request struct + `SearchBlockRow` response struct (renaming the existing positional-arg surface). Add FTS5 `snippet()` column. Backward-compat via tauri-specta auto-regen + `#[serde(default)]` on every new filter field added by follow-ups.
- **Frontend:** ~M (~5-7 h). Refactor `SearchPanel`'s flat list to drive `CollapsibleGroupList` instances. Snippet → React nodes (parse `<mark>` boundaries server-side and emit alternating text/marked spans). Result count summary. Drop the rendering of nothing-but-`<ResultCard>` rows.
- **Docs:** ~S (~1.5 h). Skeleton `SearchHelpDialog` + skeleton `docs/architecture/search.md` + skeleton `docs/SEARCH.md` + i18n key additions enumerated.
- **No migrations.** Reuses existing `fts_blocks` trigram index and existing `blocks` / `pages_cache` indexes.
- **Existing chips preserved.** `+ Page` / `+ Tag` chip UI + `searchFilterReducer.ts` stay; PEND-54 deletes them when the inline-filter-syntax framework lands. No regression window.

## Current state — verified against codebase

- **Frontend.** `src/components/SearchPanel.tsx` (459 LOC) drives a single debounced input → `searchBlocks` IPC → renders flat `<ResultCard>` rows. Existing chips: `+ Page` (single-page filter) and `+ Tag` (multi-tag AND), driven by `src/components/SearchPanel/searchFilterReducer.ts` (98 LOC). No match highlighting; result content rendered verbatim. `src/components/CollapsibleGroupList.tsx` (115 LOC) already implements the page-grouped-with-expand pattern this plan needs — **reuse, don't fork.**
- **Backend.** `search_blocks_inner` at `src-tauri/src/commands/queries.rs:131` takes 6 positional args (`pool, query, cursor, limit, parent_id, tag_ids, space_id`), returns `Result<PageResponse<ActiveBlockRow>, AppError>` (line 139). The Tauri command wrapper is at line 461. **`AppError` is `{kind: string, message: string}` via manual `Serialize`** at `src-tauri/src/error.rs:152-165` — not a tagged union; follow-up plans needing typed validation errors must use `AppError::Validation(format!("InvalidGlob: ..."))` and parse the message prefix on the frontend.
- **IPC struct precedent.** `ExtraQueryFilters` at `src-tauri/src/commands/mod.rs:487` is the established escape hatch for the 10-arg ceiling; `query_by_property` (queries.rs:489-528) used it. Cited comment at `queries.rs:480`: "`tauri-specta` 10-arg limit". `search_blocks` is at 6 user args today; adding PEND-54's two glob fields hits 8, PEND-55's three toggles hit 11 → over the ceiling. **This plan's struct migration unblocks all follow-ups.**
- **FTS5.** `fts_blocks` virtual table with `tokenize = 'trigram case_sensitive 0'` (migration `0006_fts5_trigram.sql`). Columns: `block_id UNINDEXED, stripped`. `MAX_SEARCH_RESULTS = 100` (`fts/search.rs:17`).

## Design

### IPC struct migration

New `SearchFilter` request struct + `SearchBlockRow` response struct in `src-tauri/src/commands/queries.rs`:

```rust
#[derive(Debug, Clone, Default, Deserialize, Type)]
pub struct SearchFilter {
    pub parent_id: Option<ActiveBlockId>,
    pub tag_ids: Vec<ActiveBlockId>,
    pub space_id: Option<ActiveBlockId>,
    // PEND-54 will append: include_page_globs, exclude_page_globs (Vec<String>, #[serde(default)])
    // PEND-55 will append: case_sensitive, whole_word, is_regex (bool, #[serde(default)])
    // PEND-51 will append: block_type_filter (Option<String>)
    // PEND-53 will append: state_filter, priority_filter, due_filter, scheduled_filter, property_filters, excluded_property_filters
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct SearchBlockRow {
    // Inherit every column from ActiveBlockRow
    pub id: ActiveBlockId,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<ActiveBlockId>,
    pub position: Option<i32>,
    pub deleted_at: Option<chrono::DateTime<chrono::Utc>>,
    pub todo_state: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<chrono::NaiveDate>,
    pub scheduled_date: Option<chrono::NaiveDate>,
    pub page_id: Option<ActiveBlockId>,
    // New in this plan:
    pub snippet: Option<String>,  // FTS5 snippet() with literal <mark>...</mark> boundaries
    // PEND-55 will append: match_offsets: Vec<MatchOffset> (#[serde(default)])
}
```

The Tauri command becomes:

```rust
#[tauri::command]
#[specta::specta]
pub async fn search_blocks(
    pool: tauri::State<'_, SqlitePool>,
    query: String,
    cursor: Option<String>,
    limit: Option<u32>,
    filter: SearchFilter,
) -> Result<PageResponse<SearchBlockRow>, AppError> { ... }
```

Down from 7 to 4 args (well under the 10-arg ceiling). `#[serde(default)]` on every future `SearchFilter` field keeps backward compat for the frontend bindings auto-regenerated by `tauri-specta`.

Callsites to update inside the same PR:

- `src/lib/tauri.ts` — the existing `searchBlocks` wrapper at `src/lib/tauri.ts:570` learns the struct shape.
- `src/components/SearchPanel.tsx:223-252` — projects existing `searchFilterReducer.ts` state into `SearchFilter { parent_id, tag_ids, space_id }`. **No behaviour change.**
- Tests under `src-tauri/src/commands/tests/` (~10 callsites of `search_blocks_inner` to update; mechanical).
- MCP tools test `src-tauri/src/mcp/tools_ro/tests.rs:1295` (single callsite).

### UX

```text
┌────────────────────────────────────────────────────────────┐
│  [search…                                          ]       │  ← existing input (PEND-54 reshapes)
│  [+ Page] [#urgent ×] [#review ×]   …existing chips         │  ← preserved; PEND-54 deletes
├────────────────────────────────────────────────────────────┤
│  9 matches in 3 pages                                       │  ← new: count summary
│  ▼ 📄 Project Alpha                          3 matches     │  ← new: page-group
│        🧩  …kicked off the **alpha** review…                │  ← highlighted snippet
│        🧩  …**alpha** builds gate on this PR…               │
│        🧩  …**alpha** cohort is the test bed…               │
│  ▼ 📄 Daily 2026-05-12                       1 match       │
│        🧩  …reviewed the **alpha** plan with…               │
│  ▶ 📄 Roadmap                                5 matches     │  ← collapsed group
└────────────────────────────────────────────────────────────┘
```

- **Result count summary** above the first group: "N matches in M pages". Empty result → existing `search.noResultsFound` i18n key.
- **Page-grouped rendering** via `CollapsibleGroupList`:
  - Reuse the existing component (`src/components/CollapsibleGroupList.tsx:1-115`); parametrise `renderBlock` to render `<SearchResultBlockRow>`.
  - Page header row: title + breadcrumb (namespace path) + match count.
  - Indented child rows for each matching block.
  - Pages with name-only match render as a single header row (no children).
  - Existing `expandedGroups: Record<string, boolean>` state pattern.
- **Match highlighting** via **React-node rendering, not `dangerouslySetInnerHTML`**:
  - Backend FTS5 returns `snippet` strings containing literal `<mark>...</mark>` boundaries.
  - Frontend parses the snippet with a single-pass split on `<mark>` / `</mark>` markers, emitting alternating `<span>` and `<mark>` React elements.
  - **No HTML parsing, no `dangerouslySetInnerHTML`, no DOMPurify dep** — the parser only recognises the two literal marker tags; any other `<` in the snippet is rendered as a literal text node (React escapes it).
  - Renders the same DOM as the `<mark>` HTML path would, with zero XSS surface.

### a11y role model

Each `<SearchResultGroup>` is a **separate `role="listbox"`** containing block rows as `role="option"` (matches the existing `SearchResultList.tsx` roving-tabindex model: `role="listbox"` + `role="option"` + `aria-activedescendant`). The group chevron button has `aria-expanded`. The outer result-area container has `role="region" aria-label={t('search.resultsRegionLabel')}`.

- **Why per-group listbox, not `role="tree"`:** `role="tree"` requires per-row `aria-level`, `aria-posinset`, `aria-setsize` accounting, plus typeahead-search behaviour — heavier than the existing roving model and incompatible with `aria-activedescendant`. Per-group listboxes preserve the keyboard model that `useListKeyboardNavigation` already implements.
- **Keyboard nav across groups:** `useListKeyboardNavigation` (existing hook used at `SearchPanel.tsx:304`) needs a small extension to flatten across multiple listbox children for arrow-key traversal. Document in `AGENTS.md` as an additive primitive.

### Edge cases (locked in)

- **Block with no content** (`block_type='page'` hit on title only) → `snippet` is `None`; row renders the page title verbatim with no highlight; row still navigates correctly on click.
- **Snippet text contains `<` or `&`** in source content → no special handling needed; the React-node renderer never invokes `dangerouslySetInnerHTML`; React escapes both characters on render.
- **Snippet contains an unpaired `<mark>` boundary** (theoretically impossible from FTS5 but defended against) → the parser emits the trailing text as a regular `<span>`, no exception thrown.
- **Long content** → FTS5 `snippet(fts_blocks, 1, '<mark>', '</mark>', '…', 32)` with the **trigram tokenizer** yields a ~32-trigram (≈ 32-character) window, NOT a 32-word window. **The plan tunes this constant during Phase 1** based on a benchmark; expect to bump it to 64 or 96. The `…` ellipsis flags truncation.
- **Multiple matches in one block** → FTS5 picks the densest window; the snippet may contain one or several `<mark>` pairs depending on density.

## Phase split

### Phase 0 — IPC struct migration (M, ~3-4 h backend + ~1 h frontend wiring)

- Define `SearchFilter` and `SearchBlockRow` in `src-tauri/src/commands/queries.rs` (alongside the existing `search_blocks_inner`).
- Reshape `search_blocks` Tauri command signature.
- Update every callsite (Rust tests + MCP test + frontend wrapper).
- **No behaviour change.** Default `SearchFilter` = today's no-filter shape.
- Frontend bindings (`src/lib/bindings.ts`) auto-regenerate via `tauri-specta`.
- AGENTS.md update: document `SearchFilter` as the canonical extension point; "follow-up plans add fields with `#[serde(default)]`, never positional args."

### Phase 1 — Grouped renderer + highlighting (M, ~4-5 h frontend + ~1 h backend SQL)

- Extend the search SQL with `snippet(fts_blocks, 1, '<mark>', '</mark>', '…', 32)` → `SearchBlockRow.snippet`. (`fts_blocks` column index 1 is `stripped`; verified against migration `0006_fts5_trigram.sql:13`.)
- Frontend:
  - `src/components/search/SearchResultBlockRow.tsx` — accepts `row: SearchBlockRow`; parses `snippet` into alternating text/`<mark>` React nodes. (PEND-55 later adds an alternate `matchOffsets` rendering path consumed via `Vec<MatchOffset>`.)
  - Refactor `SearchPanel.tsx` result-list rendering: group rows by `page_id`, pass to `CollapsibleGroupList`, parametrise `renderBlock={(row) => <SearchResultBlockRow row={row} />}`.
  - New `src/components/search/ResultCountSummary.tsx` — renders "N matches in M pages" above the first group.
  - **Keep the existing `+ Page` / `+ Tag` chip UI and `searchFilterReducer.ts` untouched.** PEND-54 deletes them when the inline-filter-syntax framework replaces them. No regression in this plan.
- CSS: add `.search-result-mark` rules (bold + accent background, dark-mode-aware) into `src/index.css` (existing global stylesheet convention; no `src/styles/` dir).

### Phase 2 — Documentation scaffolding (S, ~1.5 h)

- New `src/components/help/SearchHelpDialog.tsx` skeleton with a `?` button in the search toolbar. Reserves five sections (populated by follow-ups):
  - **Filter syntax** (PEND-54)
  - **Toggles** (PEND-55)
  - **Regex syntax** (PEND-55)
  - **Boolean operators** (PEND-55)
  - **Tips** (PEND-55 + later)
- New `docs/architecture/search.md` — FTS5 trigram pipeline + IPC struct shape + grouped-render layer. Extended by follow-ups.
- New `docs/SEARCH.md` — user-facing skeleton + intro paragraph. Each follow-up plan appends its own section additively (no forward-looking TOC stubs; avoids broken anchors if a follow-up doesn't ship).
- `README.md` — one-line *Search* entry pointing to in-app help and `docs/SEARCH.md`.

## Testing surface

### Backend (`src-tauri/src/`)

**`commands/tests/search_blocks_struct_tests.rs` (new file):**

- `SearchFilter` deserialises from JSON with all fields absent (default values).
- `SearchFilter` deserialises with partial fields (only `tag_ids` present).
- Round-trip: `SearchFilter` → serialise → deserialise = identity.
- `SearchBlockRow` serialises `snippet: None` as JSON `null`, `Some("foo")` as `"foo"`.

**`fts/tests.rs` extensions:**

- `snippet()` returns text with paired `<mark>` boundaries on a content match.
- `snippet()` returns `None` (NULL on the SQL side) for blocks where the FTS match path doesn't produce a content snippet (verify FTS5 behaviour empirically — likely returns the full row content for page-title-only hits; either way, document the observed shape).
- `snippet()` handles content containing literal `<` and `&` — output preserves them verbatim (FTS5 does not HTML-escape; the frontend renderer never invokes `dangerouslySetInnerHTML`).
- Long-content windowing (block ≥ 1000 chars with one match) returns a snippet under 200 chars; record the actual length as a regression baseline.
- Multiple matches in one block — snippet contains at least one `<mark>` pair; no panic.
- **Snippet length tuning**: a new test asserts the windowing constant produces user-readable snippets on a representative sample. The constant (32 today) is bumped if the assertion shows uselessly-short windows on the trigram tokenizer.
- Existing FTS search tests pass with the new column (regression).
- `cargo nextest run --profile ci` baseline holds (3693+ tests, no `#[ignore]` additions).

### Frontend (`src/`)

**Unit (`src/components/search/__tests__/`):**

- `SearchResultBlockRow.test.tsx`:
  - Renders snippet without `<mark>` boundaries as plain text.
  - Renders snippet with one `<mark>` pair as `<span><mark><span>` React nodes.
  - Renders snippet with multiple `<mark>` pairs correctly.
  - Renders snippet containing literal `<` and `&` — output DOM has them as text content (React escapes), no script execution.
  - **XSS test**: snippet `<script>alert(1)</script>` (hypothetical, never emitted by FTS5 but defensively tested) renders as text, no script runs.
  - Renders gracefully on unpaired `<mark>` open or close (defensive).
- `ResultCountSummary.test.tsx`:
  - "0 matches" / "1 match in 1 page" / "N matches in M pages" string variants via i18n.

**Integration (`src/components/__tests__/SearchPanel.grouping.test.tsx` — new file, separate from the existing `SearchPanel.test.tsx`):**

- Search returns 9 matches across 3 pages → 3 `CollapsibleGroupList` groups render with correct match counts.
- Click on a page-group header navigates to that page.
- Click on a block row navigates to that block.
- Collapse state per-group preserved across re-renders; resets on query change.
- Highlight renders for a query that matches in the middle of a long block.
- a11y: each group has `role="listbox"`; rows have `role="option"`; group headers have `aria-expanded`; outer region has `role="region"` with i18n'd label. Run `vitest-axe` (already in devDeps at `package.json:125`) over the rendered tree.
- Existing keyboard navigation tests (arrow keys, Home/End, Enter) updated for the per-group-listbox model.

**Snapshot:**

- One full `CollapsibleGroupList`-rendered result tree (3 groups, varying expand state). Reviewed manually on update.

## Documentation deliverables

| Artifact | New or extended | Scope in this plan |
|---|---|---|
| `src/components/help/SearchHelpDialog.tsx` | New | Skeleton + "Search basics" intro paragraph |
| `docs/architecture/search.md` | New | FTS5 trigram pipeline, `SearchFilter` / `SearchBlockRow` IPC shapes, grouped-render layer (CollapsibleGroupList reuse), a11y role model rationale |
| `docs/SEARCH.md` | New | User-facing skeleton + intro (each follow-up appends its own section) |
| `README.md` | Extended | One-line *Search* entry → in-app help (`?` button) + `docs/SEARCH.md` |
| `AGENTS.md` | Extended | "Search & FTS" invariants: `SearchFilter` is the canonical extension struct (no new positional args); `SearchBlockRow.snippet` carries literal `<mark>` boundaries; **never** `dangerouslySetInnerHTML` for snippets (React-node rendering only) |
| In-app KeyboardShortcuts dialog | Untouched | PEND-52 owns the `Ctrl+F` ↔ `Ctrl+Shift+F` rebind |

## New i18n keys (Phase 1 + 2)

In `src/lib/i18n/references.ts`, append under the existing `search.*` block (which ends at line 218):

- `search.resultsRegionLabel` → "Search results"
- `search.matchCountSingular` → "1 match in 1 page"
- `search.matchCountPlural` → "{{matchCount}} matches in {{pageCount}} pages"
- `search.matchCountInGroupSingular` → "1 match"
- `search.matchCountInGroupPlural` → "{{count}} matches"
- `search.groupCollapsedLabel` → "Show matches in {{pageTitle}}"
- `search.groupExpandedLabel` → "Hide matches in {{pageTitle}}"
- `search.helpButtonLabel` → "Search help"

No existing key collisions. The plan ships these in the same PR as the components that consume them; biome's i18n-key-presence lint (verify it exists, otherwise enforce by code review) catches drift.

## Cost / Impact / Risk

- **Cost:** Phase 0 ~4-5 h. Phase 1 ~5-6 h. Phase 2 ~1.5 h. **Total M (~11-13 h, ~1.5 focused days).**
- **Impact:** **High.** Closes the "unscannable wall of text" papercut. Establishes the IPC struct contract that unblocks PEND-51 / 54 / 55 / 53. Reuses existing render component (`CollapsibleGroupList`) rather than forking — avoids two parallel grouped-list components that would drift over time.
- **Risk:** **Low-Medium.** Touching the result-rendering DOM is the riskiest seam; mitigated by reusing the verified `CollapsibleGroupList` component. IPC struct migration is mechanical (positional → struct, no semantics change). Snippet rendering avoids `dangerouslySetInnerHTML` entirely — no XSS attack surface added. Legacy chip UI preserved untouched — no regression to existing tag-AND filtering.

## Coherence with other plans

| Surface this plan owns | Detail |
|---|---|
| `SearchFilter` IPC struct | Foundation; all follow-ups append fields with `#[serde(default)]` |
| `SearchBlockRow` response struct | Adds `snippet`; PEND-55 appends `match_offsets` |
| Result list rendering | `CollapsibleGroupList`-based grouped renderer + `SearchResultBlockRow` snippet renderer + `ResultCountSummary` |
| a11y model | Per-group `role="listbox"`; outer `role="region"`; `aria-expanded` on chevrons |
| `SearchHelpDialog` skeleton | Reserves five sections for follow-ups; no forward-looking TOC stubs |
| Search SQL | Adds `snippet()` column; **no** filter changes |
| KeyboardShortcuts dialog | **Untouched** (PEND-52 owns the rebind) |
| Input toolbar | **Untouched** (PEND-54 owns the chip row; PEND-55 owns the toggle row) |

| Inherited by | What |
|---|---|
| PEND-51 (palette) | `<SearchResultBlockRow>` + grouped-list shape (via `CollapsibleGroupList`) |
| PEND-54 (filter syntax) | `SearchFilter` struct (appends `include_page_globs`, `exclude_page_globs`) |
| PEND-55 (toggles + history) | `SearchFilter` (appends three bools); `SearchBlockRow` (appends `match_offsets`); `<SearchResultBlockRow>` (extended with the offset rendering path) |
| PEND-53 (property filters) | `SearchFilter` (appends six structured-filter fields) |

## Open questions

1. **`<mark>` styling in dark mode.** Bold + accent background works in light mode; dark mode needs explicit foreground/background tokens. Use existing theme tokens at `src/index.css:856+`; pick a pair that meets WCAG AA contrast and document.
2. **Match-count semantics for page-name-only hits.** A page whose title matches but with zero content hits — counter shows "0 matches" or "1 match (in name)"? Recommendation: "1 match (in name)" so the user understands why the group is there.
3. **Snippet length tuning.** 32 is a trigram-window guess; the Phase 1 benchmark sets the real value. Document the result in `docs/architecture/search.md`.

## Related

- `pending/PEND-51-search-palette-dialog.md` — consumes `<SearchResultBlockRow>` + grouped-list shape.
- `pending/PEND-52-in-page-find.md` — coordinates the `Ctrl+F` ↔ `Ctrl+Shift+F` rebind.
- `pending/PEND-53-property-filters.md` — depends on PEND-54.
- `pending/PEND-54-inline-filter-syntax.md` — replaces the legacy `+ Page` / `+ Tag` chip UI with the unified syntax model.
- `pending/PEND-55-search-toggles-history.md` — adds toggle row and history dropdown.
- `src/components/CollapsibleGroupList.tsx` — **reused, not forked.**
- `src/components/SearchPanel.tsx` — main refactor site.
- `src-tauri/src/commands/queries.rs` — `search_blocks_inner` and `SearchFilter` / `SearchBlockRow` additions.
- `src-tauri/src/commands/mod.rs:487` — `ExtraQueryFilters` precedent for IPC structs.
- `src-tauri/src/error.rs:152-165` — `AppError` `Serialize` shape (`{kind, message}`) that all typed-validation errors flow through.
- `src-tauri/src/fts/search.rs:228` — `search_fts` body site for the `snippet()` SQL addition.
- `src-tauri/migrations/0006_fts5_trigram.sql:13` — trigram tokenizer config.
