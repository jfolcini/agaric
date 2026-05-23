<!-- markdownlint-disable MD060 -->
# Search architecture

The architectural contract behind the search panel. Workflow + UI conventions live in [`docs/SEARCH.md`](../SEARCH.md) (user-facing) and [`docs/UX.md`](../UX.md) (panel placement); this file documents the **shape of the pipeline**.

The search stack has three layers — FTS5 trigram index in SQLite, a typed Tauri IPC surface (`SearchFilter` request, `SearchBlockRow` response), and a grouped-by-page React renderer reusing the existing `CollapsibleGroupList` primitive.

## FTS5 trigram pipeline

The index is a single virtual table, `fts_blocks`, created in migration `0006_fts5_trigram.sql`:

```sql
CREATE VIRTUAL TABLE fts_blocks USING fts5(
  block_id UNINDEXED,
  stripped,
  tokenize = 'trigram case_sensitive 0'
);
```

The `stripped` column carries the block content with markup boundaries removed (ULIDs, `[[…]]` link wrappers, `#[…]` tag wrappers, `(( … ))` block-ref wrappers) so a search for human-readable text matches what the user sees, not what's in the raw markdown. The `case_sensitive 0` flag is required for the trigram tokenizer to fold case; without it FTS5 falls back to exact-case matching on the trigram alphabet.

Trigrams give substring matching for free — a query of `alp` matches `alpha`, `alphabet`, `cephalopod` — but they pay for it in index size (every overlapping three-character window of every block) and in worst-case match selectivity (short queries have many candidate trigrams). The pagination cap (the `MAX_SEARCH_RESULTS` `const` in `src-tauri/src/fts/search.rs` — read the value from the code) and a 3-character floor keep that cost bounded. The floor is **two distinct measures**, not one shared rule:

- **Frontend** (`src/components/SearchPanel.tsx`) — a soft hint. When the trimmed query is non-empty but its JavaScript-string length (UTF-16 code units, counted across the *whole* query) is below 3, the panel shows a "type more characters" notice. It does not block the request.
- **Backend** (`sanitize_fts_query` in `src-tauri/src/fts/search.rs`) — the authoritative drop. Each word token shorter than `TRIGRAM_MIN_LEN` *Unicode scalars* (`word.chars().count()`, so a 2-character CJK word is measured as 2, not by byte length) is dropped from the FTS query; quoted phrases and the boolean operators bypass the floor.

The synchronous primary-state writer does **not** maintain `fts_blocks`. The materializer rebuilds the FTS row asynchronously on every block insert / update / soft-delete, batched through the materializer's retry queue (`materializer_retry_queue`). The search query therefore sees results that lag the write log by one materializer flush — measured in milliseconds at the desk, but never zero. This is the same lag every materialized view in the app pays.

### `snippet()` rendering

The search SQL projects `snippet(fts_blocks, 1, '<mark>', '</mark>', '…', N)` alongside the row, where:

- `1` is the index of the `stripped` column (the only indexed column).
- `<mark>` / `</mark>` are the literal text boundaries SQLite emits around each hit. These are **not** HTML tags at the SQL layer — they are opaque marker strings the frontend parses. Choosing real HTML-looking tags trades a tiny amount of confusion (someone might assume FTS5 returns HTML) for a renderer that can ignore any other angle-bracket in the source content as ordinary text.
- `'…'` is the ellipsis that flags a truncated window on either end.
- `N` is the window width measured in **trigrams**, not words — a tight context window (a few words of surrounding text), much tighter than the per-word windows most FTS5 deployments use. The exact value is a tunable inlined in the `snippet(...)` projection in `src-tauri/src/fts/search.rs`; consult the code rather than a number here, which would drift.

For page-title-only hits (block with no content body), `snippet()` may return `NULL` on the SQL side; the frontend treats `snippet: None` as "render the page title verbatim, no highlight" and the row still navigates correctly on click.

## IPC shapes

The Tauri command `search_blocks` takes a typed request struct and returns a typed response page. Both shapes live in `src-tauri/src/commands/queries.rs` and round-trip through `tauri-specta` into `src/lib/bindings.ts`:

```rust
// Request — appended to, never re-shaped. Every field carries
// #[serde(default)] so the tauri-specta-regenerated frontend wrappers stay
// compatible when a follow-up field lands ahead of its consumer. Only the
// base fields are shown; later plans (PEND-53/54/55/63) append more.
pub struct SearchFilter {
    pub parent_id: Option<String>,
    pub tag_ids: Vec<String>,
    pub space_id: Option<String>,
    // Follow-up plans append fields here, each with #[serde(default)].
}

// Response — one row per matching block, paginated via PageResponse<T>.
// Standalone struct (NOT a sub-type of ActiveBlockRow); it mirrors the
// ActiveBlockRow columns by value so the wire format is a strict superset.
pub struct SearchBlockRow {
    pub id: ActiveBlockId,
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
    // Added in PEND-50:
    pub snippet: Option<String>,  // literal <mark>...</mark> boundaries, never HTML-parsed
    // Added in PEND-55 — UTF-16 match offsets from the toggle/regex
    // post-filter pass; empty unless a toggle is on. Preferred over
    // `snippet` by the renderer when populated.
    pub match_offsets: Vec<MatchOffset>,
    // Follow-ups append optional fields here with #[serde(default)].
}
```

Two invariants ride on this contract:

1. **`SearchFilter` is the canonical extension struct.** New filter dimensions land as additional fields on this struct — never as new positional arguments on the Tauri command. The `tauri-specta` 10-argument ceiling is already close on the search surface; the struct keeps the command signature at five arguments (`pool`, `query`, `cursor`, `limit`, `filter`) regardless of how many filter dimensions exist. The `ExtraQueryFilters` struct in `src-tauri/src/commands/mod.rs` is the same pattern applied to `query_by_property`.
2. **`SearchBlockRow.snippet` carries literal `<mark>` boundaries.** The frontend never feeds this string to `dangerouslySetInnerHTML`. Instead the renderer at `src/components/search/SearchResultBlockRow.tsx` splits the string on the literal marker pairs and emits alternating React text nodes and `<mark>` elements. React escapes any stray `<`, `&`, `script`, etc. as text content — so the snippet path has no XSS surface, even though the FTS5 sanitiser is the only thing between user content and the rendered DOM.

Errors propagate through the existing `AppError` shape — `{ kind: string, message: string }` per `src-tauri/src/error.rs`. Typed validation errors (e.g., invalid glob patterns added by PEND-54) use `AppError::Validation("InvalidGlob: …")` and rely on a stable message prefix the frontend parses. The shape is not a tagged union because the manual `Serialize` impl predates that pattern; do not retrofit it without a coordinated migration.

## Grouped-render layer

The result list reuses `src/components/CollapsibleGroupList.tsx` — the same primitive backing the agenda's by-date and by-tag groupings. **Do not fork a search-only grouped list.** The component owns:

- per-group `expandedGroups: Record<string, boolean>` state with `aria-expanded` chevrons,
- a `renderHeader` slot for the page-title + breadcrumb + match-count row,
- a `renderBlock` slot the search panel parametrises with `<SearchResultBlockRow row={…} />`.

The orchestration above `CollapsibleGroupList` is two FE-3 components (PEND-58f):

- `src/components/search/SearchResultGroups.tsx` — wraps `CollapsibleGroupList` with the search a11y model (the `role="region"` container, per-group `aria-activedescendant` resolution from the parent's flat `focusedIndex`, and the page-name-only "1 match (in name)" counter rule). It also exports the pure `groupResultsByPage(rows, pageTitles)` helper that buckets the flat `SearchBlockRow[]` into `SearchResultGroup[]`, preserving relevance order at both group and row level. It supplies `CollapsibleGroupList`'s `renderGroupList` slot with the virtualizer below rather than letting the primitive mount every row eagerly.
- `src/components/search/VirtualizedResultListbox.tsx` — one expanded page-group's `role="listbox"`, windowed with `@tanstack/react-virtual`. It is a drop-in for the single `<ul>` `CollapsibleGroupList` used to render, preserving the per-group listbox count, roles, `data-testid`s, and the roving `aria-activedescendant` contract. The load-bearing a11y detail: `scrollToIndex` mounts the focused row before `aria-activedescendant` points at it, so the active descendant id always resolves to a live DOM node even though only the visible window plus overscan is mounted; `measureElement` corrects the height estimate after first paint.

The search panel groups its flat `SearchBlockRow[]` by `page_id` before handing it to `CollapsibleGroupList`. Pages whose only match is on the page title itself (no content hits) render as a single header row with no children — the `renderBlock` slot is called zero times for that group. The match-count summary above the first group (`N matches in M pages`, via `ResultCountSummary`) is i18n-driven; see `search.matchCountSingular` / `.matchCountPlural` in `src/lib/i18n/references.ts`.

The page-header click navigates to the page; a block-row click navigates to the block. Expand-state is preserved across re-renders within the same query and reset on query change — the query string is the dependency that drives the reset.

## Accessibility role model

The search result tree uses a per-group listbox arrangement, not a single tree, to keep compatibility with the existing roving-tabindex keyboard model (`useListKeyboardNavigation`):

- The outermost container around all groups carries `role="region"` with `aria-label={t('search.resultsRegionLabel')}` — so screen readers announce entering the search-results area.
- Each `<SearchResultGroup>` is its own `role="listbox"`. Its block rows are `role="option"`. The group's chevron button carries `aria-expanded` reflecting the expand state.
- The chevron button's accessible name is i18n-driven: `search.groupCollapsedLabel` ("Show matches in {{pageTitle}}") flips to `search.groupExpandedLabel` ("Hide matches in {{pageTitle}}") on toggle.

`role="tree"` was considered and rejected. It demands per-row `aria-level`, `aria-posinset`, and `aria-setsize` accounting on every node, plus a typeahead-search behaviour that conflicts with the search input itself. The per-group listbox arrangement preserves the existing `aria-activedescendant`-based keyboard model without a parallel ARIA layer.

Cross-group keyboard traversal (arrow keys flowing from the last row of group N to the first row of group N+1) is an extension `useListKeyboardNavigation` carries; it flattens the visible-row set across listbox children. The flattening recomputes on every expand/collapse so a collapsed group's rows are not reachable by arrow-key.

## Inline filter syntax (PEND-54)

The query string is the canonical model of search state. Chips and IPC fields are projections of a parsed AST. The pipeline is:

```text
input string ──tokenize──▶ raw tokens ──classify──▶ SearchQueryAST {filters, freeText}
                                                          │
                                                          ├──▶ chip projection (FilterChipRow)
                                                          ├──▶ autocomplete (caret offset)
                                                          └──▶ astToFilterProjection ──▶ SearchFilter IPC
```

Three pure modules under `src/lib/search-query/`:

- `tokenize.ts` — lexes whitespace-delimited words and `"…"` quoted phrases, attaching `[startCol, endCol)` spans. Mirrors the FTS5 sanitiser's quoting rules so the parser doesn't pre-process operator syntax.
- `registry.ts` — token-prefix recogniser table. Each recogniser owns one prefix (`tag:`, `path:`, `not-path:`) and returns either a concrete `FilterToken` or an `invalid` token with a typed error string. The longest prefix wins; PEND-53 registered `state:`, `priority:`, `due:`, etc. on top of this table without touching the core parser.
- `classify.ts` — walks the raw token stream, asks the registry, and stitches the surviving free-text spans into `freeText`.

The round-trip invariant — `parse(serialize(parse(s))) === parse(s)` for any `s` — is enforced by `fast-check` property tests in `__tests__/serialize.test.ts`. Direct equality `serialize(parse(s)) === s` only holds for canonical inputs (the `#tag` bare alias normalises to `tag:#tag` on the way out, by design).

Validation errors come in two flavours:

- **Frontend-cheap**: glob shape checks (unbalanced brackets, nested braces, escape sequences) live in `glob-validate.ts` (`validateGlob`), which `register.ts`'s `path:` / `not-path:` parsers call; failures surface as `invalid` chips with `InvalidGlob:`-prefixed error strings. The chip renders red with the typed message as the tooltip.
- **Backend authoritative**: `src-tauri/src/fts/glob_filter.rs` re-validates and brace-expands. Failures return `AppError::Validation("InvalidGlob: …")` so the frontend keys on the same prefix regardless of which side caught the error.

### AST → SQL projection

Page-name globs resolve against `pages_cache.title` (the dedicated title-lookup table — much smaller scan target than `blocks WHERE block_type='page'`). The dynamic SQL emits one `LOWER(pages_cache.title) GLOB ?` clause per pattern, OR-joined inside an `IN (...)` sub-select. `LOWER(...)` is applied on both sides for case-insensitive matching; the bound pattern is lowercased in Rust before binding (one `LOWER` per row, one constant `LOWER(?)` at parse time). The scale boundary is "low thousands of pages" — no covering index for `GLOB` is needed at that size.

Brace expansion is hand-rolled (no `glob` crate dependency) and capped at 64 patterns per token. Comma-separated values are split at top level (commas inside `{...}` belong to brace alternatives, not the separator).

## PEND-55 — Toggle row pipeline

The three search toggles (`case_sensitive`, `whole_word`, `is_regex`) all land as `#[serde(default)] bool` fields on `SearchFilter`. They drive a single new module — `src-tauri/src/fts/toggle_filter.rs` — that sits between `search_blocks_inner` and the candidate-set sources. The dispatch is binary:

- **`is_regex == false`** → `search_fts` (today's FTS5 path) is called first; if `case_sensitive` or `whole_word` is on, the result rows are passed through `apply_post_filter` with a literal-escaped regex. The filter narrows matches and attaches `match_offsets`; rows without a match are dropped.
- **`is_regex == true`** → `search_fts` is **bypassed entirely** (FTS5 MATCH cannot accept a regex). A separate recency-ordered scan over `blocks` (filtered by tags / space / path globs and any structural metadata predicates) returns up to `REGEX_PRE_FILTER_CAP` candidates; each is matched against the user's regex. The numeric value of that cap lives only in the code constant — see `src-tauri/src/fts/toggle_filter.rs`.

### Caps (all locked-in via module constants)

The regex pipeline is bounded by a set of locked-in caps — pattern length, the
`RegexBuilder` size / DFA-size limits, the per-row offset count, and the
regex-mode pre-filter scan limit. The authoritative values and their rationale
live as documented `pub const`s at the top of `src-tauri/src/fts/toggle_filter.rs`
(`MAX_PATTERN_LEN`, `REGEX_SIZE_LIMIT_BYTES`, `REGEX_DFA_SIZE_LIMIT_BYTES`,
`MAX_OFFSETS_PER_BLOCK`, `REGEX_PRE_FILTER_CAP`). Read them from the code — a copy
of the numbers here would silently drift.

### UTF-16 offset emission

`regex::Match::{start,end}` returns byte offsets into a UTF-8 buffer. JavaScript strings are UTF-16 code units (`.length`, `.charCodeAt`, `.substring` all use UTF-16 indices). The conversion happens in Rust before serialising, via `byte_to_utf16_offsets` (one walk of the string, builds a `byte → utf16` table on the fly). Frontend renderers MUST treat `MatchOffset.start` / `end` as JS string indices — no further conversion.

ASCII passthrough is free (`len_utf16 == 1`, `byte == utf16_index`). CJK (3 bytes UTF-8, 1 UTF-16 unit per char) and emoji (4 bytes UTF-8, 2 UTF-16 units = surrogate pair) diverge; the test suite exercises both.

### Regex composition

`compose_literal_pattern` (non-regex path) escapes user input via `regex::escape` so a user typing `a.b*c` searches for the literal `a.b*c`, not the regex `a<any>b<repeat>c`. The regex-mode path takes the user's input verbatim. Whole-word toggles wrap the pattern in `(?-u:\b)` — the **ASCII** word boundary; documented v1 behaviour that CJK runs don't match (no ASCII word chars inside CJK).

### Regex-mode SQL path

The recency-ordered scan reuses the same parent / tag / space / path-glob filters (and the structural metadata predicates) as `search_fts`. Ordering is `b.id DESC` — ULID prefixes are time-sortable, and `blocks` doesn't carry a `created_at` column. The cursor field on the response is always `None` because there's no rank to encode; "Load more" is disabled in regex mode (the candidate set is already capped at `REGEX_PRE_FILTER_CAP`).

### Regex matches raw content, FTS matches the stripped index

Regex mode and FTS mode see **different text for the same block**. FTS5 matches the `fts_blocks.stripped` column — markup-stripped, reference-resolved, NFC-normalised (written by `strip_for_fts_with_maps`). Regex mode runs the user's pattern against the **raw `blocks.content`** column instead. The authoritative contract is the comment block at the top of `regex_mode_query` in `src-tauri/src/fts/toggle_filter.rs`. Three concrete consequences:

1. **Reference tokens are visible to regex, invisible to FTS.** A `#[ULID]` tag/page reference stays verbatim in `blocks.content` but is resolved to its target name in the stripped index. A regex on a tag or page *name* therefore MISSES a block that only references that name via `#[ULID]` — FTS would match it. (Use the `tag:` structural filter instead of a regex when you want reference-aware tag matching.)
2. **Raw markdown/markup is matchable by regex only.** Link wrappers, formatting markers, and other syntax the strip pass removes are still present in `blocks.content`, so only a regex can match them.
3. **NFC vs NFD.** `blocks.content` is stored as the user typed it (may be NFD, e.g. a macOS paste); the stripped index is NFC. The regex *pattern* is NFC-normalised before compilation (cheap, safe), but the stored content on this path is **not** re-normalised — a regex against NFD-stored content can still diverge from the FTS index.

Changing the scanned column (stripped vs raw) is a deliberate out-of-scope behaviour change; the code comment is the documented contract.

### Frontend rendering

`SearchResultBlockRow` prefers `row.match_offsets` over `row.snippet` when both are present (the toggle pipeline clears the snippet to avoid double-rendering). `renderOffsetHighlights` splits the content into alternating `<span>` and `<mark>` React nodes — never `dangerouslySetInnerHTML`. Defensive clamping handles malformed offsets (out-of-range / inverted / overlapping) without throwing.

### History store

Per-space MRU list at `agaric:search-history` (Zustand persist). Dedupes on insert; cap 20. Submission triggers `push`; the dropdown surfaces entries when the input is focused AND empty. The cycling hook (`useSearchHistoryCycling`) owns the `↑`/`↓` browse-mode state machine; precedence with PEND-54's autocomplete and the result-list nav is documented in AGENTS.md.

## PEND-53 — Property / metadata filters

The `state:`, `priority:`, `due:`, `scheduled:`, `prop:` token family adds six fields to `SearchFilter`: `state_filter`, `priority_filter`, `due_filter`, `scheduled_filter`, `property_filters`, `excluded_property_filters`. PEND-63 appends two more for the `not-state:` / `not-priority:` inversion: `excluded_state_filter`, `excluded_priority_filter`. All carry `#[serde(default)]`. They compile to `EXISTS` sub-selects against `block_properties` and to direct comparisons on `blocks.todo_state` / `blocks.priority` / `blocks.due_date` / `blocks.scheduled_date`.

### Date filter resolution

`due:today` / `due:this-week` etc. are resolved against `chrono::Local::now().date_naive()` inside `fts::metadata_filter::prepare_metadata`. The SQL only ever sees concrete date bounds. Week starts on **Monday** (matches the agenda view's convention). Test-injected `today` is threaded through `prepare_metadata_with_today` so date-clock churn doesn't flake snapshot tests.

Bucket vocabulary is locked at: `today`, `yesterday`, `overdue`, `this-week`, `this-month`, `next-week`, `older`, `none`. Unknown buckets or unparseable dates surface as `AppError::Validation("InvalidDateFilter: …")`; the frontend keys on the message prefix.

### `state:none` / `priority:none` semantics

A literal `none` value (case-insensitive) in `state_filter` / `priority_filter` is split out in `prepare_metadata` and emitted as a `column IS NULL` branch in the SQL disjunction. **A custom state literally named `"none"` would match the `IS NULL` shadow** — documented limitation; a real custom state must be named differently to avoid that overlap.

### Property column mapping (PEND-64)

`prop:KEY=VALUE` matches across the four user-facing typed columns (`value_text`, `value_num`, `value_date`, `value_ref`) with type coercion at SQL bind time. The composer in `fts::metadata_filter::append_property_match` emits a four-way `OR` with `NULL`-bound branches for variants that don't parse — so `prop:priority=1` binds `value_num = 1.0` and `NULL` for the other three, while `prop:status=draft` binds `value_text = 'draft'` and `NULL` for the rest. The `exactly_one_value` CHECK on `block_properties` (migration `0062`) ensures at most one branch can ever fire per row. `value_bool` is internal (not user-typed) and remains out of scope.

Property keys are case-sensitive (`block_properties` PK is `(block_id, key)` with no `COLLATE NOCASE`). ULID values matched against `value_ref` are normalised to uppercase at bind time per Agaric's storage convention.

### Excluded states / priorities (PEND-63)

`not-state:VALUE` / `not-priority:VALUE` chips project to `excluded_state_filter` / `excluded_priority_filter`. The SQL composer emits `(column IS NULL OR column NOT IN (…))` — **NULL-inclusive inversion by design**: a "blocks not in DONE" query returns blocks with no state set at all, not excludes them. The `not-state:none` sentinel flips to `column IS NOT NULL`.

## PEND-54 — Path globs

`path:` filters resolve against `pages_cache.title` with `LOWER(...)` for case-insensitive matching. SQLite native `GLOB` (no regex extension), with brace expansion + substring-wrap applied in Rust before binding. Validation failures surface through `AppError::Validation` with an `InvalidGlob:` message prefix — the frontend keys on the prefix string rather than a new error variant (avoids reshaping the `{kind, message}` wire shape at `error.rs`).

### `↑` / `↓` precedence in the search input

When ambiguity exists, autocomplete-open wins, then history recall (PEND-55), then result-list navigation. Document any new precedence-claiming surface here.

## Related files

- `src/components/SearchPanel.tsx` — orchestrator: input, debounce, IPC call, group + render.
- `src/components/search/SearchResultGroups.tsx` — group orchestration over `CollapsibleGroupList` + `groupResultsByPage` (PEND-58f FE-3).
- `src/components/search/VirtualizedResultListbox.tsx` — per-group virtualized `role="listbox"` (PEND-58f FE-3).
- `src/components/search/SearchResultBlockRow.tsx` — snippet / offset → React-node renderer.
- `src/components/search/ResultCountSummary.tsx` — "N matches in M pages" header.
- `src/components/search/SearchToggleRow.tsx` — three toggle buttons (PEND-55).
- `src/components/search/SearchHistoryDropdown.tsx` — recent-queries listbox (PEND-55).
- `src/components/CollapsibleGroupList.tsx` — the grouped-list primitive (reused, never forked).
- `src/components/help/SearchHelpDialog.tsx` — in-app `?` help.
- `src/stores/search-history.ts` — Zustand-persisted per-space history (PEND-55).
- `src/hooks/useSearchHistoryCycling.ts` — `↑`/`↓` browse state machine (PEND-55).
- `src-tauri/src/commands/queries.rs` — `SearchFilter`, `SearchBlockRow`, `MatchOffset`, `search_blocks_inner`.
- `src-tauri/src/fts/search.rs` — FTS5 query construction + `snippet()` projection.
- `src-tauri/src/fts/toggle_filter.rs` — `SearchToggles`, `search_with_toggles`, regex pipeline (PEND-55).
- `src-tauri/src/fts/glob_filter.rs` — page-name glob parser + brace-expansion (PEND-54).
- `src-tauri/migrations/0006_fts5_trigram.sql` — index definition + tokenizer config.
- `src/lib/search-query/` — inline filter syntax parser, AST, serialiser, autocomplete (PEND-54).
- `src/components/search/FilterChipRow.tsx` — AST → chip projection (PEND-54).
- `src/components/search/FilterHelperPopover.tsx` — `+ Filter ▾` picker (PEND-54).
