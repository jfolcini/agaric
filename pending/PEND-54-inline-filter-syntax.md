# PEND-54 — Inline filter syntax framework + glob / tag filters

> Replaces the legacy `+ Page` / `+ Tag` chip UI in `SearchPanel` with a unified **inline filter syntax**: every filter is expressible **both** as a typeable token in the search input (`tag:#urgent path:Journal/2026-*`) **and** through UI affordances (chip row above the input, `+ Filter ▾` helper popover, caret-anchored autocomplete inside the input). The query string is the canonical source of truth; chips are projections of the parsed AST.
>
> Lands the **parser / serialiser / chip-row / helper-popover / autocomplete framework** that PEND-53 inherits without further core work. Ships **tag-AND** and **page-name glob include/exclude** as the first two filter types riding the framework.
>
> **Depends on PEND-50** (foundation: `SearchFilter` IPC struct + grouped result rendering). **Independent of PEND-55** (toggle row), **PEND-51** (palette), **PEND-52** (in-page find). **Inherited by PEND-53** (property filters).

## TL;DR

- **Backend:** ~M (~4-6 h). Append two `#[serde(default)] Vec<String>` fields to PEND-50's `SearchFilter` struct (`include_page_globs`, `exclude_page_globs`). Brace-expand in Rust. GLOB sub-select against `pages_cache.title` (not `blocks.content`) with `LOWER(...) GLOB LOWER(?)` for case-insensitive matching. Validation errors returned as `AppError::Validation(format!("InvalidGlob: ..."))` matching the existing `{kind, message}` wire shape (no new error enum).
- **Frontend:** ~M-L (~10-14 h). Parser + serialiser + chip row + helper popover + caret autocomplete. Deletes legacy `searchFilterReducer.ts` + `SearchFilters.tsx` + the `+ Page` / `+ Tag` `SearchablePopover` triggers (their function is taken by the unified model).
- **Docs:** ~S (~1.5 h). Help dialog's *Filter syntax* section + `docs/SEARCH.md` extension + `AGENTS.md` invariants + architecture doc extension.
- **No migrations.** Reuses existing `pages_cache` indexes + the `blocks` / `tags` infrastructure.
- **Default UX:** typing plain text behaves like today (FTS path). Typing `tag:#urgent` or `path:Journal/*` activates structured filtering with visible chips. Chip row + `+ Filter ▾` button render from first paint — affordance is passively discoverable.

## Current state — verified against codebase

After PEND-50 lands:

- `SearchFilter` request struct exists in `src-tauri/src/commands/queries.rs`. This plan appends `include_page_globs` + `exclude_page_globs`.
- Grouped result rendering via `CollapsibleGroupList` is live.
- The `+ Page` / `+ Tag` legacy chips (`src/components/SearchPanel/SearchFilters.tsx`, 122 LOC) + `searchFilterReducer.ts` (98 LOC) are still present — **this plan deletes both.**

Verified codebase details this plan relies on:

- `pages_cache.title` column exists (migration `0001_initial.sql:101-105`) — the canonical page-title source. PEND-54 uses this, not `blocks.content`, because (a) `pages_cache` is purpose-built for title lookups, (b) the scan target is ~10× smaller than `blocks WHERE block_type='page'`, (c) `blocks.content` for pages is the same data but unindexed for GLOB.
- `SearchablePopover<T>` generic at `src/components/SearchablePopover.tsx:27` — reusable for tag selection inside the helper popover.
- `match-sorter` ^8.3.0 at `package.json:83` — used by `useBlockResolve`, `slash-commands`, `CodeLanguageSelector`. **This plan reuses it** for tag-name autocomplete typo-tolerance.
- `useDebouncedCallback` at `src/hooks/useDebouncedCallback.ts` (57 LOC, `{schedule, cancel}` shape) — used at `SearchPanel.tsx:223` with 300 ms (AGENTS.md:195 canonical).
- `useListKeyboardNavigation` at `src/hooks/useListKeyboardNavigation.ts` — drives the existing `SearchablePopover` keyboard nav. **Reused** for the new autocomplete popover.
- The query string lives in `useState` inside `SearchPanel.tsx:84` (`const [query, setQuery] = useState('')`). **Agaric does not use a router** (`src/lib/url-state.ts:4`: "Agaric does not use a router (Tauri WebView, no react-router)"). This plan keeps the query string in `SearchPanel`'s local state; the AST is derived state computed from it.

## Design

### UX

```text
┌────────────────────────────────────────────────────────────┐
│  [TODO path:Journal/2026-* tag:#urgent              ] ?    │  ← input + help
│  [#urgent ×] [path:Journal/2026-* ×]      + Filter ▾       │  ← chips parsed from input
├────────────────────────────────────────────────────────────┤
│  (PEND-50 grouped results render below)                     │
└────────────────────────────────────────────────────────────┘
```

The `+ Filter ▾` popover (opens on click):

```text
┌─────────────────────────────────┐
│  Add a filter                    │
│   #  Tag                         │
│   📁  Page path (include)         │
│   🚫  Page path (exclude)         │
│   ─── (PEND-53 adds below) ───   │
│   ✓  Task state                  │
│   ⓘ  Priority                    │
│   📅  Due date                    │
│   📌  Scheduled date              │
│   🔑  Property…                   │
│                                  │
│  Tip: type `tag:` or `path:`     │
│  directly to skip this menu.     │
└─────────────────────────────────┘
```

Autocomplete inside the input — caret-anchored popover triggered by the recognised prefixes:

- Caret after `tag:#` → popover lists existing tags filtered by what follows `#`, ranked by `match-sorter` for typo tolerance.
- Caret after `path:` → popover lists namespace prefixes (resolved from the existing page-list cache, also ranked by `match-sorter`).
- Caret after `not-path:` → same shape as `path:`.
- Tab or Enter inserts the focused candidate; Esc dismisses.
- Arrow ↑ / ↓ navigates popover candidates. **Priority order when input is empty** (collision with PEND-55 history recall): autocomplete-open > history recall > result-list-nav. Document the precedence in `AGENTS.md`.
- Popover positions beneath the caret on desktop; on mobile, anchors to the input row top (avoids virtual-keyboard occlusion).

### Supported filter tokens (this plan's scope)

| Token | Meaning | `SearchFilter` field |
|---|---|---|
| `tag:#name` | Block has tag `name`. Repeats AND. | `tag_ids[]` (existing) |
| `#name` (bare alias) | Same as `tag:#name`. | `tag_ids[]` |
| `path:GLOB` | Page-name glob include (comma-separated allowed). | `include_page_globs[]` (new) |
| `not-path:GLOB` | Page-name glob exclude. | `exclude_page_globs[]` (new) |
| `"phrase"` | Quoted phrase — passes to FTS5 verbatim (existing). | (query string) |
| `AND`, `OR`, `NOT` | Boolean operators — passes to FTS5 verbatim (existing, uppercase). | (query string) |
| (bare text) | Plain query terms. | (query string) |

PEND-53 adds: `state:`, `priority:`, `due:`, `scheduled:`, `prop:key=value`, `not-prop:key=value`. Parser is extensible via a token-recogniser registry (see implementation skeleton).

### Behavioural changes from the legacy chip UI

The existing `+ Page` chip is a **single-page exact filter** (matches one page by ULID). The new `path:` glob is a **substring/glob match against page titles**. These are different semantics. A user who relied on `+ Page` for exact filtering will see:

- `path:Project Alpha` (bare token, no glob chars) → wrapped to `*Project Alpha*` per the VSCode-style substring default → matches `Project Alpha`, `Project Alpha 2`, `Old Project Alpha`. **Wider match than the old `+ Page` chip.**
- `path:Project Alpha$` won't work (no anchor syntax; SQLite GLOB doesn't have `$`).
- To preserve exact-page-filter semantics, document the workaround: use `path:Project Alpha` plus a unique substring, OR use the inline-link `[[Project Alpha]]` in the query (which FTS5 matches verbatim).

**This is a documented behavioural change**, not a regression — the new model is a strict superset of every other use case, and exact-page filtering was always implementable via the page title. Surface the change in `docs/SEARCH.md`'s "Migrating from the old chip UI" section.

### Parser implementation skeleton

Two pure functions, split for testability:

- `src/lib/search-query/tokenize.ts` — `tokenize(input: string) → Token[]` walks the input, emitting `{kind: 'literal'|'tagPrefix'|'pathPrefix'|'notPathPrefix'|'colon'|'whitespace', value: string, span: [start, end]}`.
- `src/lib/search-query/classify.ts` — `classify(tokens: Token[]) → AST` produces the `FilterToken[]` + free-text + boolean-op layout.

```typescript
type FilterToken =
  | { kind: 'tag'; value: string; span: [number, number] }
  | { kind: 'pathInclude'; value: string; span: [number, number] }
  | { kind: 'pathExclude'; value: string; span: [number, number] }
  | { kind: 'invalid'; source: string; error: string; span: [number, number] }
  // PEND-53 will append: state, priority, due, scheduled, prop, notProp

type AST = {
  filters: FilterToken[]
  freeText: string
}
```

**Token-recogniser registry** (`src/lib/search-query/registry.ts`):

```typescript
export type TokenRecogniser = (rest: string) => { token: FilterToken | null; consumed: number }

const recognisers: TokenRecogniser[] = []
export function registerTokenPrefix(prefix: string, parse: (value: string) => FilterToken) { ... }
```

PEND-53 adds recognisers without touching the core parser.

- `src/lib/search-query/serialize.ts` — `serialize(ast: AST, patch?: Patch) → string` produces the canonical query string. Round-trip invariant: **`serialize(parse(s)) === s` for canonical inputs `s`**, AND `parse(serialize(parse(s))) === parse(s)` for any `s`. Both directions are stated as AGENTS.md invariants and tested via `fast-check` (already in devDeps at `package.json:114`).

### Chip ↔ query sync

`SearchPanel.tsx` holds `query: string` in `useState`. The AST is computed via `useMemo` on every `query` change:

```typescript
const ast = useMemo(() => parse(query), [query])
const filters = ast.filters
const freeText = ast.freeText
```

Chips render from `filters`. Click `×` on a chip → `setQuery(serialize({...ast, filters: filters.filter(t => t !== removed)}))`.

The parser must be **deterministic and side-effect-free**; the same input string always parses to the same AST. To avoid unnecessary chip re-mounts on edits in the middle of the query, use a **stable token key** computed from `${kind}:${value}` rather than array index. Document in `AGENTS.md`.

### UI components

- `src/components/search/SearchInputWithFilters.tsx` — composes the existing `SearchInput` + chip row + autocomplete popover via two hooks:
  - `useSearchQueryAST(query, setQuery)` — owns parse / serialize / patch operations.
  - `useAutocompleteAnchor(inputRef, caretPos, ast)` — owns caret position + active token detection.
- `src/components/search/FilterChip.tsx` — single chip with `×` button.
- `src/components/search/FilterHelperPopover.tsx` — `+ Filter ▾` menu. Single-popover-at-a-time pattern: clicking a row closes the helper and opens the structured sub-popover anchored to the `+ Filter` trigger (avoids nested-Radix-popover focus-trap issues).
- `src/components/search/AutocompletePopover.tsx` — caret-anchored popover. Reuses `useListKeyboardNavigation`.

### Backend pipeline — page-name glob filtering

1. **Parse glob inputs in Rust.** For each entry in `include_page_globs` / `exclude_page_globs`:
   - Trim.
   - **Brace expansion** (hand-rolled, no nesting, no escape — bounded grammar): `{a,b}/c` → `["a/c", "b/c"]`. Multiple braces compose cartesian: `{a,b}/{c,d}` → 4 patterns. **Reject** nested braces or `\{` / `\}` escapes with `AppError::Validation("InvalidGlob: brace nesting not supported")`. The hand-rolled implementation is ~40 LOC; a borrowed bash-spec test corpus drives the unit tests.
   - **Bare-token substring**: if no `*` or `?` or `[`, wrap with `*…*`.
   - Reject unbalanced `[` with `AppError::Validation("InvalidGlob: unbalanced bracket")`.
2. **SQL sub-select against `pages_cache.title`** with case-insensitive comparison:

   ```sql
   SELECT b.id, b.block_type, b.content, ..., snippet(...) AS snippet
   FROM fts_blocks fts
   JOIN blocks b ON b.id = fts.block_id
   WHERE fts_blocks MATCH ?1
     AND b.deleted_at IS NULL
     AND (?include_count = 0 OR b.page_id IN (
       SELECT pc.page_id FROM pages_cache pc
       WHERE LOWER(pc.title) GLOB LOWER(?inc1) OR LOWER(pc.title) GLOB LOWER(?inc2) OR …
     ))
     AND (?exclude_count = 0 OR b.page_id NOT IN (
       SELECT pc.page_id FROM pages_cache pc
       WHERE LOWER(pc.title) GLOB LOWER(?exc1) OR LOWER(pc.title) GLOB LOWER(?exc2) OR …
     ))
   ```

   The pattern is lowercased in Rust before binding (one `LOWER` on each side, but the bound side is constant per query). `pages_cache.title` doesn't have a covering index for `GLOB`, but the scan target is the page count (~hundreds to low thousands on a realistic vault) — sub-millisecond. Document the scale boundary in `docs/architecture/search.md`.

   `sqlx::query_as!` doesn't support variable-cardinality `IN ?`, so the SQL is built using the **existing dynamic-string-builder pattern** in `src-tauri/src/fts/search.rs:228+` (`search_fts`) — track `next_param` and append clauses. **Not `QueryBuilder`** (which the codebase reserves for batched INSERTs in `fts/index.rs:46`).

### Error handling — aligning with `AppError`

`AppError` is a `{kind: string, message: string}` shape via manual `Serialize` (`src-tauri/src/error.rs:152-165`). It is **not a tagged union**; new variants don't auto-surface as typed errors on the frontend. PEND-54 returns validation failures as:

```rust
return Err(AppError::Validation(format!("InvalidGlob: {}", reason)));
```

The frontend parses the `message` prefix:

```typescript
function isInvalidGlobError(e: AppError): boolean {
  return e.kind === 'validation' && e.message.startsWith('InvalidGlob:')
}
```

A small helper `src/lib/errors/validation.ts` keeps prefix-string-matching out of components. The chip-level error rendering keys on the helper's typed predicates.

**Why not extend `AppError`:** adding a tagged-union variant would (a) require reshaping `error.rs:152-165` to emit a third JSON field, (b) ripple into every IPC callsite's specta-emitted TS type, (c) break the existing `sanitize_internal_error` flow at `commands/mod.rs:888`. The prefix-string protocol is consistent with how the codebase already handles validation errors today; documented in `AGENTS.md`.

### Edge cases (locked in)

- **Empty include / exclude lists** → no clause emitted (gated by `?include_count = 0` / `?exclude_count = 0`).
- **Whitespace-only entry** between commas → silently dropped.
- **Glob with one trailing `*`** (e.g. `path:foo*`) → prefix-anchored match against title.
- **Glob with no metacharacters** (e.g. `path:Journal`) → substring-wrapped to `*Journal*`. Document in tooltip.
- **Unclosed `[`** → `AppError::Validation("InvalidGlob: unbalanced bracket")`; chip renders red with the typed message.
- **Brace nesting** (`path:{a,{b,c}}`) → `AppError::Validation("InvalidGlob: brace nesting not supported")`; chip renders red.
- **`tag:` with no value** → invalid token; renders red chip with "tag: value required".
- **Tag name with Unicode** (`tag:#日本語`, `tag:#📌`) → preserved verbatim; backend `tag_ids[]` resolution treats unknown tags as 0-match (correct).
- **Multiple `path:` tokens** → equivalent to comma-separating them; `path:A path:B` resolves to `include_page_globs = ["A", "B"]`.
- **Mixing `path:` and `not-path:` on overlapping namespaces** → both apply; include + exclude are AND-joined in the SQL (a page matching include AND matching exclude is excluded).

## Phase split

### Phase 1 — Parser / serialiser / autocomplete framework (S-M, ~4-6 h)

Pure-frontend foundation, no IPC change. Builds on PEND-50's `SearchFilter` struct.

- Implement `tokenize.ts` + `classify.ts` + `serialize.ts` + `registry.ts` + `autocomplete.ts`.
- Register the three filter types: `tag:`, `path:`, `not-path:` (plus bare-`#tag` alias).
- Unit tests per pure module (no React).
- AGENTS.md additions: parser-as-source-of-truth invariant; round-trip invariant; precedence rule for `↑`/`↓` (autocomplete > history > result-list-nav).

### Phase 2 — UI integration + backend glob (M, ~6-8 h)

- New `SearchInputWithFilters.tsx`, `FilterChip.tsx`, `FilterHelperPopover.tsx`, `AutocompletePopover.tsx`.
- Wire into `SearchPanel.tsx`; **delete** `searchFilterReducer.ts`, `SearchFilters.tsx`, the `searchFilterReducer.test.ts` test file (verified: `src/components/SearchPanel/__tests__/searchFilterReducer.test.ts` exists and must be removed alongside).
- Confirm `usePopoverEntity.ts` is only used by the deleted chips (run `grep -rn usePopoverEntity src` before deletion; if used elsewhere, keep it).
- Backend: append `include_page_globs` + `exclude_page_globs` to PEND-50's `SearchFilter` struct + brace-expansion + GLOB sub-select against `pages_cache.title` with `LOWER(...)` + `AppError::Validation` typed messages.
- AST → IPC projection adapter (FilterToken[] → SearchFilter fields).
- Integration tests for the full input → IPC → results flow.

### Phase 3 — Documentation (S, ~1.5 h)

- Help dialog's **Filter syntax** section: token table + one paragraph per token type.
- `docs/SEARCH.md` extension: full filter-syntax reference + "Migrating from the old chip UI" section.
- `docs/architecture/search.md` extension: parser pipeline diagram + AST → SQL projection.
- `AGENTS.md` invariants: parser as source of truth; round-trip identity direction; `path:` filters use SQLite native GLOB via sub-select against `pages_cache.title` with `LOWER(...)` for case-insensitivity; validation errors flow through `AppError::Validation` with `InvalidGlob:` prefix.

## Testing surface

### Backend (`src-tauri/src/`)

**`commands/tests/glob_filter_tests.rs` (new file — avoid co-edit churn with existing tests):**

- Empty include/exclude → no clause emitted.
- Prefix-anchored glob (`Journal/*`) matches pages under `Journal/`; doesn't match `JournalNotes`.
- Unanchored glob (`*meeting*`) matches `Meeting Notes` and `2026 meeting roundup`.
- **Case-insensitive**: `path:journal/*` matches `Journal/2026-05-17` (regression check on the `LOWER(...)` clause).
- Brace expansion (`{Journal,Archive}/*`) → 2 GLOB clauses, OR-combined.
- Comma-separated globs (`Journal/*,Notes/*`) → 2 clauses, OR-combined.
- Bare-token substring-match (`Journal` → `*Journal*`).
- Include + exclude composition.
- Brace nesting → `InvalidGlob: brace nesting not supported`.
- Unclosed bracket → `InvalidGlob: unbalanced bracket`.
- Existing tag-AND backend filter still works (regression).
- `cargo nextest run --profile ci` baseline holds.

### Frontend (`src/`)

**Unit (`src/lib/search-query/__tests__/`):**

- `tokenize.test.ts` + `classify.test.ts` together cover all token kinds, edge cases (Unicode tag names, quoted phrases, booleans, invalid prefixes).
- `serialize.test.ts`:
  - `serialize(parse(s)) === s` round-trip identity on canonical inputs (10+ explicit cases).
  - `fast-check` property test: for random valid query strings, `serialize(parse(s)) === s`.
  - `parse(serialize(parse(s))) === parse(s)` for any input (idempotency).
  - `removeToken(ast, tokenIndex)` produces clean serialised output.
- `autocomplete.test.ts`:
  - Caret after `tag:#` → `{active: 'tag', query: ''}`.
  - Caret after `tag:#urg` → `{active: 'tag', query: 'urg'}`.
  - Caret in free text → `null`.
  - Caret after `tag:#name` (closed token) → `null`.
  - Caret after `path:` → `{active: 'path', query: ''}`.
  - Caret inside quoted string → `null`.
  - Caret after typed-and-deleted-back-to-prefix → re-opens autocomplete.

**Component (`src/components/search/__tests__/`):**

- `SearchInputWithFilters.test.tsx`: typing `tag:#urg` → ↓ → Enter inserts `tag:#urgent`; chip appears; query string updates.
- `FilterChip.test.tsx`: click `×` strips token; remaining whitespace cleaned.
- `FilterHelperPopover.test.tsx`: each entry's click closes helper and opens correct sub-popover anchored to `+ Filter` trigger (single-popover-at-a-time).
- `AutocompletePopover.test.tsx`: opens / closes on caret position; arrow nav via `useListKeyboardNavigation`; Tab inserts; Esc dismisses.
- a11y: input has accessible name; popovers have `role="listbox"`; chips have `aria-label="Remove filter {{token}}"`. Run `vitest-axe` over the rendered tree.

**Integration (`src/components/__tests__/SearchPanel.filters.test.tsx` — new file, separate from `SearchPanel.grouping.test.tsx`):**

- Typing `tag:#urgent` filters to tag-urgent blocks (full IPC round-trip).
- Typing `path:Journal/*` filters to Journal pages.
- Typing `not-path:Archive/**` excludes Archive pages.
- Click `+ Filter ▾` → Tag → select → chip appears, results update.
- Invalid glob → red chip with `InvalidGlob:` message from backend.
- Existing tag-AND behaviour preserved (regression).
- Chip click during in-flight IPC: stale response is discarded (verify via existing `requestIdRef` pattern at `hooks/usePaginatedQuery.ts:75`).

**`fast-check` property tests** for the parser round-trip (already a devDep at `package.json:114`).

## Documentation deliverables

| Artifact | Content added |
|---|---|
| `src/components/help/SearchHelpDialog.tsx` | New **Filter syntax** section (token table, one paragraph per token type, worked examples, "case-insensitive by default" note) |
| `docs/SEARCH.md` | New "Filter syntax" section mirroring help dialog + "Migrating from the old chip UI" section explaining the behavioural change from `+ Page` to `path:` |
| `docs/architecture/search.md` | New section: parser pipeline (string → tokens → AST → SearchFilter → SQL) + chip-from-AST sync model + AppError prefix protocol |
| `AGENTS.md` | Three new invariants under "Search & FTS": parser as source of truth + `serialize(parse(s)) === s` direction + path filters against `pages_cache.title` + AppError prefix protocol + `↑`/`↓` precedence (autocomplete > history > result-list) |
| `README.md` | Updated *Search* line: highlight inline filter syntax |
| Inline tooltips | `+ Filter ▾` entries each carry a one-line example |

## New i18n keys (Phase 2 + 3)

Append in `src/lib/i18n/references.ts` under `search.*` block:

- `search.addFilter` → "+ Filter"
- `search.filterCategory.tag` → "Tag"
- `search.filterCategory.pathInclude` → "Page path (include)"
- `search.filterCategory.pathExclude` → "Page path (exclude)"
- `search.filterCategoryTip` → "Type `tag:` or `path:` directly to skip this menu"
- `search.removeFilter` → "Remove filter {{token}}"
- `search.autocompleteListLabel` → "Filter suggestions"
- `search.invalidGlob` → "{{message}}" (parsed from `AppError::Validation`)
- `search.invalidFilter` → "Invalid filter token"

**Delete** the legacy keys (no longer used after this plan):

- `search.addPage`, `search.addTag`, `search.removePageFilter`, `search.removeTagFilter`

## Cost / Impact / Risk

- **Cost:** Phase 1 ~4-6 h. Phase 2 ~6-8 h. Phase 3 ~1.5 h. **Total M-L (~11.5-15.5 h, ~1.5-2 focused days).**
- **Impact:** **Very High.** Unifies scattered filter UI into one composable model. Filters are discoverable through both writing and clicking; copy-paste a query and it works. Establishes the framework that PEND-53 inherits without further core work.
- **Risk:** **Medium.** The riskiest seams are (a) the parser round-trip invariant (mitigated by `fast-check` property tests + AGENTS.md invariant), (b) the behavioural change in `path:` matching vs the old `+ Page` chip (mitigated by explicit docs + migration section), (c) deleting `searchFilterReducer.ts` (mitigated by grep-before-delete verification of importers).

## Open questions

1. **Tag name casing.** `tags` table: are tag names stored as-typed or normalised? Verify before locking in autocomplete: if normalised, autocomplete shows normalised names; if as-typed, it shows verbatim.
2. **Bare-token substring tooltip wording.** "type `foo*` for prefix match, `foo` for substring" — confirm phrasing with the maintainer before scheduling.
3. **Saved searches.** Out of scope. Filed in `pending/IDEAS.md`. The canonical-query-string-as-source-of-truth design means a saved search is just `(name, queryString)` for the filter+free-text portion; **toggle state is separate** (per PEND-55's explicit non-writable decision).

## Related

- `pending/PEND-50-search-vscode-ux.md` — foundation (must land first).
- `pending/PEND-53-property-filters.md` — extends this plan's framework with state/priority/due/scheduled/property tokens.
- `pending/PEND-55-search-toggles-history.md` — independent; chip row above the input vs toggle row to the right. Shared `↑`/`↓` precedence rule documented in AGENTS.md.
- `pending/PEND-51-search-palette-dialog.md` — independent (palette has no filter syntax by design).
- `pending/IDEAS.md` — saved searches.
- `src/components/SearchPanel.tsx`, `src/components/SearchPanel/searchFilterReducer.ts`, `src/components/SearchPanel/SearchFilters.tsx` — main refactor / deletion site.
- `src-tauri/src/commands/queries.rs` — `SearchFilter` struct extension (PEND-50 introduced).
- `src-tauri/src/fts/search.rs:228` — `search_fts` body; existing dynamic-string-builder pattern this plan extends.
- `src-tauri/migrations/0001_initial.sql:101-105` — `pages_cache.title` column.
- `src-tauri/src/error.rs:152-165` — `AppError` `{kind, message}` Serialize shape.
- `package.json:83` — `match-sorter ^8.3.0` (reused for tag autocomplete).
