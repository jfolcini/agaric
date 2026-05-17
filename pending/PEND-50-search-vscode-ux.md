# PEND-50 — VSCode-style search UX: page-name glob filters + regex / case-sensitive / whole-word toggles

> Reshapes the existing `SearchPanel` into a **find-in-files surface**: the three toggles (`Aa`, `Ab|`, `.*`) and the two glob filter fields (*pages to include* / *pages to exclude*) from VSCode's *Find in Files*. Glob filtering is pushed into SQL via SQLite's built-in `GLOB` operator; the toggles share a single post-FTS filter pipeline. Results render as **page-grouped trees** (page header + indented block hits), matching VSCode's grouped-by-file layout. The default-state behaviour is unchanged — the existing FTS-fast path stays intact for every user who never touches the new controls.
>
> **Paired with `pending/PEND-51-search-palette-dialog.md`** (the Cmd+K palette / navigation surface). The two plans split the search UI by job: this one is *systematic find-in-files*, PEND-51 is *quick navigation jump*. They **share** the `<SearchResultGroup>` render component (Phase 0 below) — whichever ships first owns it.

## TL;DR

- **Backend:** ~M (6-10 h). Two new fields on the search filter struct + one SQL sub-select + one post-FTS filter stage in Rust.
- **Frontend:** ~M (4-7 h). A toggle row beneath the input + a collapsible "filter" section with two glob inputs.
- **Docs:** ~S (1-2 h). User-facing help (inline tooltips + an in-app help dialog section) + internal `AGENTS.md` note + one extension to `docs/architecture/`.
- **No migrations.** Reuses the existing `fts_blocks` trigram index and the `blocks` table.
- **Default UX unchanged.** Toggles are off; glob fields are empty; current users see the same search they have today.

## Current state

- **Frontend.** `src/components/SearchPanel.tsx` (~460 LOC) drives a single debounced input → `searchBlocks` IPC → renders `BlockRow`s. Input chain: `SearchHeader` → `SearchInput` → `useDebouncedCallback(300ms)`. No filter fields; no toggles.
- **Backend.** `src-tauri/src/commands/queries.rs::search_blocks_inner` → `fts::search_fts` (`src-tauri/src/fts/search.rs`). Query goes through `sanitize_fts_query` (line ~132) which today **strips** glob/regex metacharacters (`*`, `(`, `)`, `col:`, `NEAR(`) to prevent injection, then runs `fts_blocks MATCH ?1` against the trigram-tokenised virtual table (`migrations/0006_fts5_trigram.sql`: `tokenize='trigram case_sensitive 0'`).
- **Cap.** `MAX_SEARCH_RESULTS = 100`; cursor pagination by `(rank, block_id)`.
- **Existing filter shape.** `SearchFilter` already supports `parent_id`, `tag_ids`, `space_id` — adding `include_page_globs` / `exclude_page_globs` follows the same pattern.

## Design

### UX (matches VSCode *Find in Files* one-to-one)

```text
┌───────────────────────────────────────────────────┐
│  [search…                              ] [Aa Ab| .*]  │  ← input + toggles
├───────────────────────────────────────────────────┤
│  ▼ Filter (1)                                     │  ← collapsible; "(1)" if any filter set
│      pages to include  [Journal/2026-*            ]│
│      pages to exclude  [Archive/**, *-draft       ]│
├───────────────────────────────────────────────────┤
│  ▼ 📄 Project Alpha                    3 matches  │  ← page-group header
│        🧩  …kicked off the alpha review…           │
│        🧩  …alpha builds gate on this PR…          │
│        🧩  …alpha cohort is the test bed…          │
│  ▼ 📄 Daily 2026-05-12                 1 match    │
│        🧩  …reviewed the alpha plan with…          │
│  ▶ 📄 Roadmap                          5 matches  │  ← collapsed group
└───────────────────────────────────────────────────┘
```

- Toggles render to the right of the input, matching VSCode's order: `Aa` (case-sensitive), `Ab|` (whole word), `.*` (regex).
- The filter section is **collapsible and collapsed by default**. The header shows the count of active filters ("Filter (2)") so a user can see at a glance that filters are narrowing their results.
- Glob inputs accept **comma-separated** patterns, same as VSCode (`Journal/**, src/*.ts`).
- Tooltip on each input shows one example.
- Toggle state persists in component state across re-renders but is **not** persisted to disk for v1 (decision: a "saved search" feature is out of scope).
- Existing keyboard shortcut path (Enter to submit, debounce on type) is unchanged.

### Result rendering — grouped by page

The flat block list in today's `SearchPanel` is replaced with **page-grouped results**, matching VSCode's *Find in Files* and the palette-side rendering in `pending/PEND-51-search-palette-dialog.md` (shared component, see Phase 0).

- One row per page that has at least one match — page title, breadcrumb (namespace path), and match count ("3 matches").
- Indented child rows beneath each header, one per matching block, 2-3 line content snippet, truncated.
- A page that matches by **name only** (no content hits) renders as a single header row, no expand affordance.
- A page that matches by **content only** still renders the same group shape — the header is always the navigation target for "open this page".
- Expand/collapse state per group, **expanded by default**. State lives in component state for the current search session and resets on query change (so users don't accidentally hide matches when reformulating).
- **"Load more" grows existing groups in place** rather than appending new rows at the end of the list. This is the non-obvious pagination consequence: the cursor is still flat at the backend, but new rows from the next page are *routed into their page-groups by `page_id`* on arrival. Mental model: "VSCode keeps loading more matches into the file groups I'm already looking at", not "the list grows arbitrarily and I have to re-find my place".
- Backend stays flat — cursor by `(rank, block_id)` unchanged. Grouping is a render-layer reshape after `batchResolve` resolves page titles for the breadcrumb. **No new IPC, no migration.**
- Shared render component with the palette dialog: factor out `<SearchResultGroup>` (and `<SearchResultGroupHeader>` + `<SearchResultBlockRow>`) so the dialog can render `topN.slice(0, K)` of the same tree with the same `ResultCard` styling.

### Backend pipeline

1. **Parse glob inputs (Rust).** For each comma-separated entry: trim, then **expand `{a,b}` brace alternations** in Rust before binding (SQLite `GLOB` does not support brace expansion). One bound parameter per resulting pattern. Reject unbalanced brackets/braces with a typed error (`SearchFilterError::InvalidGlob`).
2. **SQL sub-select for the page-ID filter.** Inline into the existing search SQL:

   ```sql
   SELECT b.id, b.block_type, b.content, ...
   FROM fts_blocks fts
   JOIN blocks b ON b.id = fts.block_id
   WHERE fts_blocks MATCH ?1
     AND b.deleted_at IS NULL
     AND (
       -- include filter (omit clause entirely when empty)
       ?include_count = 0 OR b.page_id IN (
         SELECT p.id FROM blocks p
         WHERE p.block_type = 'page'
           AND p.deleted_at IS NULL
           AND (p.content GLOB ?inc1 OR p.content GLOB ?inc2 OR …)
       )
     )
     AND (
       -- exclude filter (omit clause entirely when empty)
       ?exclude_count = 0 OR b.page_id NOT IN (
         SELECT p.id FROM blocks p
         WHERE p.block_type = 'page'
           AND p.deleted_at IS NULL
           AND (p.content GLOB ?exc1 OR p.content GLOB ?exc2 OR …)
       )
     )
   ```

   `sqlx::query_as!` doesn't support `IN ?` with variable list, so the SQL is built with `QueryBuilder` (already in use elsewhere) and the macro path stays for the no-filter fast case. Mention this in `AGENTS.md` as the canonical pattern for variable-cardinality binds.
3. **Toggle post-filter (Rust).** When any of `case_sensitive` / `whole_word` / `is_regex` is set, after FTS returns its candidate set:
   - Compile a `regex::Regex` pattern (see "Toggle composition" below for how toggles combine).
   - Use `Regex::is_match` against `stripped` for each candidate row.
   - Run with a compile-time `size_limit` (e.g. 1 MB pattern AST cap) — the `regex` crate is linear-time, no catastrophic backtracking, but the `size_limit` closes the "compile a huge alternation" cost vector.
   - Keep the surviving candidates; re-emit pagination metadata (cursor recomputation against the *filtered* result set).

### IPC surface

No new Tauri commands; the existing `search_blocks` command grows new optional fields on its `SearchFilter` input struct (in `src-tauri/src/commands/queries.rs`):

```rust
pub struct SearchFilter {
    // existing fields — unchanged
    pub parent_id: Option<ActiveBlockId>,
    pub tag_ids: Vec<ActiveBlockId>,
    pub space_id: Option<ActiveBlockId>,

    // Phase 1 additions (#[serde(default)] — backward compatible)
    pub include_page_globs: Vec<String>,
    pub exclude_page_globs: Vec<String>,

    // Phase 2 additions (#[serde(default)] — backward compatible)
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub is_regex: bool,
}
```

The error enum gains two typed variants that surface as typed errors to the frontend:

```rust
pub enum SearchFilterError {
    // existing variants…
    InvalidGlob(String),    // returned from the glob parser
    InvalidRegex(String),   // returned from regex::RegexBuilder::build()
}
```

`tauri-specta` re-emits `src/lib/bindings.ts` automatically when these change — no hand-written binding edits. Frontend can match on the typed error variants to render an inline error under the correct input (glob field vs query field), same shape as the existing UX-217 toast path.

PEND-51's Cmd+K palette adds one further optional field (`block_type_filter: Option<String>`) to the same `SearchFilter` — independent of PEND-50, lands with PEND-51's Phase 1.

### Toggle composition

The three toggles combine into a single regex pattern that's applied to the FTS candidate set:

| Toggle state | Pattern built from query `q` |
|---|---|
| (all off — default) | post-filter skipped entirely; FTS result is the final result |
| `Aa` only | `(?-i){escaped q}` |
| `Ab\|` only | `(?i)\b{escaped q}\b` |
| `.*` only | `(?i){q}` (q is the user's regex, not escaped; sanitiser skipped) |
| `Aa` + `Ab\|` | `(?-i)\b{escaped q}\b` |
| `Aa` + `.*` | `(?-i){q}` |
| `Ab\|` + `.*` | `(?i)\b(?:{q})\b` |
| All three | `(?-i)\b(?:{q})\b` |

**Case-sensitive note.** The trigram FTS index is `case_sensitive 0`, so an `Aa`-toggled search still gets a *case-insensitive* candidate set from FTS; the post-filter then narrows it to exact-case matches. This is correct (no false negatives) but means `Aa` is **not** a free toggle — it forces the post-filter path even when no other toggle is set.

**Whole-word note.** Rust `regex` crate's `\b` is **ASCII word-boundary by default**. For CJK content (Agaric supports it via the trigram tokenizer), `\b` semantics are ambiguous — Unicode word boundaries need `(?-u:\b)` vs `(?u:\b)` and the right answer depends on script. **Defer CJK whole-word behaviour to v2.** v1 ships ASCII-correct whole-word with a tooltip noting "ASCII boundaries only". File a follow-up REVIEW-LATER item if CJK whole-word becomes a real ask.

### Regex mode

- Sanitiser **skipped entirely** when `is_regex` is set — the user's input is the pattern, verbatim.
- Compile with `regex::RegexBuilder` + `size_limit(1_000_000)` + `dfa_size_limit(10_000_000)`. Returns a typed `SearchFilterError::InvalidRegex(err.to_string())` to the frontend on compile failure (rendered as inline error under the input, same shape as the existing UX-217 toast path).
- **Performance gating** — recommend (but do not enforce) a literal seed term of ≥ 3 chars somewhere in the regex; without it, the regex runs over the full active-block corpus filtered only by the page-name glob (still bounded by `MAX_SEARCH_RESULTS`, but the wall-time scales with the unfiltered block count, not the FTS candidate count). The user docs call this out. No hard enforcement in v1 — let the result-cap protect us.

### Edge cases (locked in)

- **Empty include field** → match all (no filter applied; clause emitted as `?include_count = 0 OR …`).
- **Empty exclude field** → exclude nothing (same).
- **Whitespace-only entry** between commas → silently dropped.
- **Glob with no metacharacters** (e.g. `Journal`) → treated as a literal full-content match; `content GLOB 'Journal'` only matches a page literally named `Journal`. **VSCode behaviour:** their globs match substring by default (so `Journal` matches `Journal-Old`); we should match that — pre-process bare tokens by wrapping them in `*…*` before binding. Document this in the tooltip.
- **Glob with an unclosed `[` or `{`** → typed error to frontend, inline under the input.
- **`is_regex` set + empty query** → no-op, returns empty result without firing FTS.

## Documentation expansion (~S, 1-2 h)

This plan is the first time Agaric ships query syntax beyond plain text, so the docs surface needs explicit additions — leaving it implicit will cost a year of support questions.

### User-facing

1. **`src/components/help/SearchHelpDialog.tsx`** (new) — modal anchored on a `?` button next to the toggle row. Three short sections:
   - **Glob syntax** — `*`, `?`, `[abc]`, `[^abc]`, `{a,b}`, comma-separated. Two worked examples (`Journal/2026-*`, `Archive/**, *-draft`).
   - **Regex syntax** — Rust `regex` crate flavour. Link to the crate's syntax page. Note: linear-time, no lookaround, no back-references. Two worked examples (`TODO.*\bhigh\b`, `^[A-Z]{3,}$`).
   - **Toggles** — one-line each. Call out the ASCII-only `\b` caveat for whole-word.
2. **Inline tooltips** on each toggle and each glob input — one example apiece, no prose.
3. **`README.md`** — add a one-line entry under the *Search* section linking to the in-app help (`?` button in `SearchPanel`).

### Internal

1. **`AGENTS.md`** — add an entry under the existing "Search & FTS" invariants section:
   - Sanitiser is skipped in regex mode; trust the `regex` crate's `size_limit` instead.
   - `case_sensitive` toggle forces the post-filter path because the FTS index is `case_sensitive 0`.
   - Page-name glob filters use SQLite native `GLOB` via a sub-select; do not materialise the matching page-ID list in Rust.
2. **`docs/architecture/search.md`** (new, ~50 lines) or a new section in an existing arch doc — the data-flow diagram for the new pipeline: input → sanitise-or-skip → FTS → page-glob sub-select → toggle post-filter → cursor → response. Pair this with a small ASCII diagram of how toggles compose into the post-filter regex.

## Phase split

### Phase 0 — Shared `<SearchResultGroup>` render component (S, ~2-3 h)

**Pre-requisite for both this plan AND PEND-51.** Whichever plan ships first owns Phase 0; the other plan inherits it.

- New `src/components/search/SearchResultGroup.tsx` — props: `pageId`, `pageTitle`, `breadcrumb`, `matchCount`, `matches: BlockRow[]`, `expanded: boolean`, `onToggleExpanded`, `onPageClick`, `onBlockClick`, optional `cap?: { matchesPerGroup: number }` for the palette case.
- Renders a header row (page glyph + title + breadcrumb + match count) and indented child rows; when `cap` is set and `matches.length > cap.matchesPerGroup`, render a footer "+N more" pill that links to the find-in-files view with the current query pre-filled.
- Refactor `SearchPanel`'s current flat-list rendering to drive `<SearchResultGroup>` instances (one per page); this is the act that switches the view to grouped rendering. Reuse the existing `batchResolve` for breadcrumb resolution.
- Tests: header-only rendering for name-only matches; expand/collapse; cap behaviour; click handlers fire with the correct ids.

**Stop here** is also viable but uncommon — just-grouped rendering without the rest of PEND-50 is a small UX win on its own.

### Phase 1 — Glob filters (S, ~3-5 h backend + ~2-3 h frontend + ~0.5 h docs)

Builds on Phase 0's grouped rendering. Ships independently of the toggles; the lower-risk half of the plan.

- Backend: `SearchFilter::{include_page_globs, exclude_page_globs}` + brace-expansion + GLOB sub-select + invalid-glob error.
- Frontend: collapsible "Filter" section with two inputs + a filter-count badge on the section header.
- Tests: empty include/exclude (smoke); prefix-anchored glob (`Journal/*`); unanchored glob (`*meeting*`); brace expansion (`{Journal,Archive}/*`); include+exclude composition; bare-token substring-match; invalid glob → typed error.
- Docs: tooltip examples + the in-app help dialog's "Glob syntax" section.

**Stop here** is a viable shippable state — power-user filtering without the regex/case/whole-word toggles.

### Phase 2 — Toggle row (M, ~3-5 h backend + ~2-4 h frontend + ~1-1.5 h docs)

- Backend: `SearchFilter::{case_sensitive, whole_word, is_regex}` + post-filter pipeline + sanitiser carve-out for `is_regex` + `RegexBuilder` size_limits + typed `InvalidRegex` error.
- Frontend: three toggle buttons in the input toolbar (existing icon library has all three glyphs already; verify before scheduling).
- Tests: regex happy path (anchor + alternation); invalid-regex returns typed error; case-sensitive narrows correctly; whole-word ASCII positive + ASCII negative; CJK whole-word **explicitly tested as undefined-but-non-crashing**; size_limit guard (compile a 2 MB regex string, expect typed error not panic).
- Docs: in-app help dialog's "Regex syntax" and "Toggles" sections; AGENTS.md additions; `docs/architecture/search.md` if pursuing the new file route.

## Open questions

1. **Bare-token glob behaviour.** VSCode wraps non-glob tokens with implicit `*…*` (substring). Should Agaric match that, or take literal-by-default (more SQL-honest but less VSCode-familiar)? Recommendation: match VSCode, document in tooltip.
2. **Result highlighting in regex mode.** Today no highlighting; the snippet just shows the block's `content`. Adding match-offset highlighting (à la VSCode's bold-on-hit) is a meaningfully bigger frontend change. Recommendation: **out of scope for v1**; file as a follow-up if user feedback asks for it.
3. **`?` next-to-toggles vs. standalone Help menu entry.** VSCode shows inline `?`. Recommendation: match VSCode.
4. **Persisted toggle state across navigation?** VSCode persists per-workspace. For v1, recommend in-component-state-only (the search panel is itself ephemeral on most navigations). Revisit if users complain.
5. **Saved searches?** Out of scope. If we ever do them, they become a separate plan (compose with this one — a saved search is `{ query, toggles, globs }`).

## Cost / Impact / Risk

- **Cost:** Phase 0 ~2-3 h (shared render component; counted once across this plan + PEND-51). Phase 1 ~5-8 h end-to-end (backend + frontend + tests + docs slice). Phase 2 ~6-10 h. Total M.
- **Impact:** **High.** Closes the most-frequent power-user search ask (matches the IDE search workflow every developer already has muscle memory for). Doesn't move the cold-cache search latency; the cost lives only on opted-in toggle/glob paths.
- **Risk:** **Low.** Default-off semantics mean the existing FTS path is untouched. The riskiest new surface is regex injection / runaway compile — bounded by the `regex` crate's linear-time guarantee + `size_limit`. SQL injection on glob inputs is impossible because patterns are bound as parameters, never concatenated.

## Related

- `src/components/SearchPanel.tsx`, `SearchHeader.tsx`, `SearchInput.tsx` — frontend chain.
- `src-tauri/src/fts/search.rs` — `sanitize_fts_query`, `search_fts`. Carve-out and post-filter land here.
- `src-tauri/src/commands/queries.rs` — `search_blocks_inner`. Signature grows to carry the new filter fields.
- `src-tauri/migrations/0006_fts5_trigram.sql` — trigram tokenizer config; no migration needed.
- `pending/PEND-51-search-palette-dialog.md` — the Cmd+K palette this plan pairs with. Shared Phase 0.
- `regex` crate (already in `Cargo.toml`? **verify before scheduling** — if not, this is a new dep).
