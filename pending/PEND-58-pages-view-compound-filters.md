# PEND-58 — Pages view: compound filters (shared primitives with Search)

> **Plan 3 of 3** in the Pages-view redesign. PEND-56 lands density rows + the sort
> foundation. PEND-57 lands bulk ops + saved views. PEND-58 completes the trio by giving
> the Pages view a **compound filter set** — `tag:` / `path:` / `has-property:` /
> `last-edited:` / `space:` shared with Search, plus the grooming-specific `orphan:` /
> `stub:` / `has-no-inbound-links:` / `last-edited:bucket` that only make sense for a
> page-level overview.
>
> **Architectural framing locked in up front.** Search and Pages share **filter
> primitives** at the backend — one `FilterPrimitive` enum, one SQL-fragment compiler,
> one parser (PEND-54's). The two surfaces **diverge on vocabulary** and on
> **projection**: Search projects to block rows and accepts `regex:` / `case-sensitive:` /
> `whole-word:` / `snippet:` (which only make sense when paired with a query); Pages
> projects to page rows and accepts `orphan:` / `stub:` / `has-no-inbound-links:` (which
> only make sense at page granularity). The **shared** set — `tag:` / `path:` /
> `has-property:` / `last-edited:` / `space:` / `priority:` — has identical syntax and
> identical semantics on both surfaces; a `tag:urgent` chip applied in Pages and the same
> `tag:urgent` token typed into the Search input return *intersecting* result sets.
>
> **Depends on** PEND-54 (extends its parser; this plan does not duplicate it).
> **Builds on** PEND-56 (consumes its `(sort_key, id)` cursor; the recency-sort cursor
> bump is PEND-56's, not this plan's). **Feeds** PEND-57 (a saved view's payload is
> `{name, sortKey, filterSet, density}` — this plan defines `filterSet`'s shape).
> **Cross-link** PEND-50 (Search foundation IPC contract).

## TL;DR

- **Backend:** ~M-L (~6-9 h). Extract a single `FilterPrimitive` enum from PEND-54's
  `SearchFilter` field set; reshape `SearchFilter` and (PEND-56's) `PageListFilter` as
  thin wrappers around `Vec<FilterPrimitive>` plus per-surface allowed-keys gates. Append
  four Pages-only primitives: `Orphan`, `Stub`, `HasNoInboundLinks`, `LastEditedBucket`.
  Compile each primitive to a `WhereClause` whose SQL differs per surface via a
  `Projection` trait (`PagesProjection` joins through `pages_cache.id`;
  `SearchProjection` joins through `blocks.id`). No new migrations — all joins ride
  existing indexes (`idx_block_links_target`, `idx_block_links_source`,
  `idx_block_props_key`, `idx_op_log_created`).
- **Frontend:** ~M (~7-10 h). Reuse `FilterPill` + `FilterPillRow` (precedent:
  `BacklinkFilterBuilder`, `GraphFilterBar`). New `PageBrowserFilterRow` composes those
  primitives with an `Add Filter ▾` popover modelled on `GraphFilterBar`'s. No inline
  parser in the Pages input — the input remains a name-substring filter; structured
  filters live exclusively in chips (rationale below). The Pages chip set serialises to
  the same `FilterToken[]` AST that PEND-54's parser emits, so PEND-57's saved-view JSON
  payload is identical across surfaces.
- **Docs:** ~S (~2 h). `docs/PAGES.md` (new — user-facing),
  `docs/architecture/filters.md` (new — the shared-primitives contract). `AGENTS.md`
  gains the *one* new invariant: filter primitives are the single source of truth;
  surface-specific behaviour lives only in the allowed-keys set and the `Projection`
  impl.
- **No migrations.** Verified against the existing indexes — every Pages-only
  primitive's SQL is index-backed (see *Performance*).
- **Migration story:** today's name-substring filter (`filterText` state in
  `PageBrowser`) is preserved verbatim as a non-chip free-text input. Today's
  `PageBrowser` users see no regression; the Add-Filter affordance is purely additive.

## Current state

- `list_blocks` (`src-tauri/src/commands/blocks/queries.rs:326`) accepts *mutually
  exclusive* filters today (`parent_id` XOR `block_type` XOR `tag_id` XOR `agenda`). The
  signature is at the `tauri-specta` 10-arg ceiling and uses `AgendaQuery`
  (`src-tauri/src/commands/mod.rs:439`) as the established workaround. Adding compound
  filters requires the same `ExtraQueryFilters`-style struct treatment PEND-50 introduced
  for `search_blocks`.
- `PageBrowser.tsx` exposes a single filter: free-text substring against `block.content`
  via `matchesSearchFolded`, applied **client-side** after pagination. There is no
  server-side filter beyond `block_type='page' AND space_id=?`. Sort/grouping is owned by
  `usePageBrowserSort` + `usePageBrowserGrouping`; the latter is keyset-paginated by
  `(content, id)` today and will gain `(last_modified_at, id)` under PEND-56 with a
  cursor-version bump.
- The reusable filter primitives at the **UI** layer already exist and are
  battle-tested: `src/components/ui/filter-pill.tsx` (the chip primitive),
  `src/components/FilterPillRow.tsx` (the row + `filterSummary` formatter),
  `src/components/BacklinkFilterBuilder.tsx` (the canonical Add-Filter popover
  precedent; `addFilterButtonRef` focus-restore pattern at line 117 is the model to
  copy), `src/components/GraphFilterBar.tsx` (multi-dimension popover precedent with the
  `Add Filter ▾` UX this plan reuses, line 466). Do not greenfield any of these.
- The backend tables this plan joins are indexed for the queries it needs:
  `block_links(source_id)` (migration 0020), `block_links(target_id)` (migration 0001,
  line 118), `block_properties(key, block_id)` (migration 0004),
  `block_properties(key, value_num)` (migration 0022), `op_log(created_at)` (migration
  0001, line 120). The `pages_cache` table (migration 0001, lines 101-105) carries `id`,
  `title`, `space_id` and is the canonical page-row source.
- PEND-54's parser (`src/lib/search-query/`) lands a token-recogniser registry. Pages
  does not re-implement parsing — it consumes the same registry, with an allowed-keys
  gate that filters out Search-only tokens at the surface boundary.

## Design

### Architecture: same primitives, different vocabularies

The contract is one sentence: **a `FilterPrimitive` is a value; a `Projection` is how
that value compiles to SQL for a given surface.**

```rust
// Sketch — see "Filter primitive contract" below for the full shape
enum FilterPrimitive {
    Tag(BlockId),                          // shared
    PathGlob { pattern: String, exclude: bool }, // shared
    HasProperty { key: String, op: PropOp, value: Option<PropValue> }, // shared
    LastEdited(LastEditedSpec),            // shared (spec covers both buckets and absolute dates)
    Space(SpaceId),                        // shared
    Priority(String),                      // shared

    // Pages-only
    Orphan,
    Stub,
    HasNoInboundLinks,

    // Search-only
    Regex(String),
    CaseSensitive(bool),
    WholeWord(bool),
    Snippet(SnippetSpec),
}
```

PEND-54's parser emits `FilterToken[]`. The Pages surface and the Search surface each
carry a static `ALLOWED_KEYS: &[&str]`; the parser's `register/classify` step rejects any
token whose key isn't in that surface's allowed set, producing an `invalid` token with a
typed error rather than a confusing "no results". Pages rejects `regex:` early; Search
rejects `orphan:` early. The error message is symmetric (`"orphan:" is not supported in
Search — try the Pages view`) and i18n-keyed.

The SQL diff is owned by the `Projection` trait. For `Tag("urgent")`:

- `PagesProjection::compile_tag(...)` emits
  `pages_cache.id IN (SELECT block_id FROM block_properties WHERE key = 'tag' AND value_ref = ?)`.
- `SearchProjection::compile_tag(...)` emits a JOIN against `block_properties` on
  `blocks.id`, plus the existing FTS5 path.

The *primitive value* is identical; the *projection* differs. This means a `tag:urgent`
chip applied in Pages and a `tag:urgent` token typed in Search return result sets that
**intersect at the page level**: every page surfaced by Pages has at least one
tag-`urgent` block; every block surfaced by Search whose page is in Pages's result set is
correctly included.

### Pages filter vocabulary

| Facet | Syntax | Semantics | SQL fragment | Backing index |
|---|---|---|---|---|
| `orphan:` | `orphan:` (no value) | Page has zero inbound and zero outbound block-link edges. Grooming target: candidate for archival or merging. | `pages_cache.id NOT IN (SELECT target_id FROM block_links UNION SELECT source_id FROM block_links WHERE source_id IN (SELECT id FROM blocks WHERE page_id = pages_cache.id))` | `idx_block_links_target`, `idx_block_links_source` |
| `stub:` | `stub:` (no value) | Page whose only block is its own title row (zero non-title descendants). Empty-but-named pages. | `pages_cache.id NOT IN (SELECT page_id FROM blocks WHERE page_id IS NOT NULL AND id != page_id AND deleted_at IS NULL)` | `idx_blocks_page_id` (verify in 0027) |
| `has-no-inbound-links:` | `has-no-inbound-links:` (no value) | Zero backlinks. Discovery target: pages nobody has linked to yet. | `pages_cache.id NOT IN (SELECT target_id FROM block_links WHERE target_id = pages_cache.id)` | `idx_block_links_target` |
| `last-edited:bucket` | `last-edited:today`, `last-edited:this-week`, `last-edited:this-month`, `last-edited:older` | Recency grooming buckets driven by the latest `op_log.created_at` per page. | Subquery against `op_log` joined on the page's blocks; bucket boundaries computed in Rust against `chrono::Utc::now()`. | `idx_op_log_created` plus `idx_op_log_block_id` (migration 0003) |

Each Pages-only primitive is **boolean-valued** — it takes no argument beyond the colon.
The `last-edited:` facet is shared (see next table) but accepts both bucket tokens
(Pages-friendly) and absolute-date tokens (Search-friendly); the parser admits both forms
on both surfaces.

### Shared filter vocabulary

| Facet | Syntax | Semantics | SQL fragment via `Projection` | PEND-54 ref |
|---|---|---|---|---|
| `tag:` | `tag:#name` (PEND-54 alias `#name`) | Block (Search) or page (Pages) has tag. Repeats AND. | `block_properties WHERE key='tag' AND value_ref=?`, joined per surface. | line 79 |
| `path:` | `path:GLOB`, `not-path:GLOB` | Page-name glob; brace expansion + bare-token substring per PEND-54. | `pages_cache.title GLOB LOWER(?)`, projected. | line 80-81 |
| `has-property:` | `has-property:key`, `has-property:key=value`, `not-has-property:key` | Property existence or equality on the block (Search) or the page (Pages). | `block_properties` joined per surface; uses `idx_block_props_key` for existence, `idx_block_props_key_text` or `idx_block_properties_key_value_num` for equality. | PEND-53 vocabulary |
| `last-edited:` | `last-edited:today` / `last-edited:this-week` / `last-edited:this-month` / `last-edited:older` / `last-edited:>=2026-01-01` | Bucket or absolute-date comparator against `op_log.created_at`. Same primitive for both surfaces; bucket tokens render natively in Pages chips, absolute-date tokens in Search. | Subquery against `op_log`; bucket math in Rust. | This plan |
| `space:` | `space:Personal`, `space:Work` (implicit on each surface) | Currently-active space; mostly implicit but selectable when a multi-space view lands. | `space_id = ?`. | PEND-50 line 39 |
| `priority:` | `priority:A`, `priority:B`, `priority:C`, `not-priority:` | Block (Search) or page (Pages) priority. | `blocks.priority = ?`, projected. | PEND-53 |

All shared facets emit **the same `FilterPrimitive` enum variant** regardless of surface.
The two `Projection` impls render the same primitive against different join graphs.

### Search-only facets (informational)

The Pages surface's allowed-keys gate rejects these with a typed error. They are listed
here so the boundary is unambiguous, not to design them — PEND-50 / PEND-54 / PEND-55
own them.

- `regex:` — only meaningful with a query string. Pages has no query, only a
  name-substring input; offering regex on a substring is incoherent.
- `case-sensitive:` — same reason. Pages's name-substring uses `matchesSearchFolded`
  (Unicode case- and diacritic-insensitive); flipping that on a per-row basis would
  surprise users.
- `whole-word:` — same reason.
- `snippet:` — snippets are an FTS5 windowing concept; a page row has no snippet, only
  a title and a chip-set summary.

### UI: chip-row vs inline syntax

**Locked-in choice: Pages uses chips only. No inline parser surface inside the Pages
text input.**

Rationale:

- The Pages input is a **name-substring filter**, not a "query". The user types
  `Project` and expects pages whose title contains "Project". Mixing `tag:urgent
  Project` into the same input would conflate two filter axes (substring + structured)
  and force users to memorise prefixes for a view that should be obvious at first paint.
- Search has a query, which composes naturally with structured filters: `alpha
  tag:urgent` is "find blocks containing 'alpha' that are tagged urgent". The inline
  parser shines there.
- The chip-only model is **strictly more learnable** for the Pages surface. Add
  Filter ▾ is the discoverable affordance; the substring input behaves as it does today.

Concretely:

- Search input continues to support inline filters (PEND-54).
- Pages input is **name-substring only**; typing `tag:urgent` into it would match a
  page literally titled "tag:urgent" (almost always zero pages, which is the correct
  user-visible signal that they're using the wrong input).
- Both surfaces serialise the structured filter portion to the same `FilterToken[]`
  AST. PEND-57's saved views can be shared across surfaces — the filter-set portion of a
  saved view is the same JSON regardless of which surface created it. (The surface
  decides which tokens to *render* based on its allowed-keys set; tokens disallowed on a
  given surface render as disabled chips with the typed error, so a Search-saved view
  applied to Pages doesn't silently drop `regex:` — it surfaces the incompatibility.)

The Add Filter popover for Pages copies `GraphFilterBar`'s anatomy (line 466): a button
with `aria-haspopup="dialog"` opens a categorised menu (Shared facets / Pages facets),
each row opens a value-selection sub-popover keyed off the facet type. The
single-popover-at-a-time pattern from PEND-54 (line 152: helper closes when sub-popover
opens, anchored to the same trigger) carries over verbatim.

### Filter primitive contract

The load-bearing shape, sketched. Full implementation is Phase 2.

```rust
pub trait Projection {
    fn compile_tag(&self, tag: &BlockId) -> WhereClause;
    fn compile_path_glob(&self, p: &str, exclude: bool) -> WhereClause;
    fn compile_has_property(&self, k: &str, op: PropOp, v: Option<&PropValue>) -> WhereClause;
    fn compile_last_edited(&self, spec: &LastEditedSpec) -> WhereClause;
    fn compile_space(&self, s: &SpaceId) -> WhereClause;
    fn compile_priority(&self, p: &str) -> WhereClause;
    // Pages-only — Search's impl returns `WhereClause::unsupported()` (compile error
    // surfaced via the allowed-keys gate before we ever reach this dispatch).
    fn compile_orphan(&self) -> WhereClause { WhereClause::unsupported() }
    fn compile_stub(&self) -> WhereClause { WhereClause::unsupported() }
    fn compile_has_no_inbound_links(&self) -> WhereClause { WhereClause::unsupported() }
}

pub struct WhereClause { pub sql: String, pub binds: Vec<Bind> }
pub struct PagesProjection;
pub struct SearchProjection;
```

The `unsupported()` default makes the static surface gate the authoritative check; if a
Pages-only primitive ever reaches `SearchProjection`'s `compile_*`, it returns an empty
clause and a debug-build assertion fires — defence in depth against the allowed-keys
gate developing a hole.

### Cursor compatibility

The Pages view's cursor under PEND-56 is `(sort_key, id)`. A filter set narrows the
WHERE clause; it does not change the sort key. **No cursor schema change is needed beyond
PEND-56's recency-sort bump.** A page's position in the sorted, filtered result set is
well-defined by `(sort_key, id)` regardless of how many filter primitives were applied.

One subtlety: under the `last-edited:` filter, the sort and the filter touch the same
column (`op_log.created_at`). The cursor is still well-defined — the filter restricts
the keyset's *range*; the sort orders within it. Tests assert this composition
explicitly (see *Tests*).

### Edge cases (locked in)

- **Empty filter set** — today's behaviour: all pages in the current space, sorted by
  the current sort, paginated by the cursor.
- **Invalid filter** (e.g. `tag:` referencing a deleted tag id) — returns zero results.
  **Not** an error; the chip renders normally with the value it was given. Surfacing it
  as an error would require backend round-trips for chip validation that don't pay for
  themselves.
- **Filter + name-substring** — composed with AND. The substring still applies
  client-side after pagination today; under this plan it stays client-side. Filters
  apply server-side. (Moving substring server-side is PEND-56's call, not this plan's.)
- **Filter + sort** — orthogonal axes; compose freely.
- **Max chip count** — **8**. Justified: most realistic grooming flows use 2-4 chips;
  8 leaves slack for the rare "every filter I have" experiment; beyond 8, the UI becomes
  visually crowded *and* the SQL plan starts to lose SARGable ordering benefits (each new
  clause adds a subquery cost). The cap is a soft warning (toast: "many filters can slow
  the view"), not a hard reject, and is documented in `docs/PAGES.md`.

## Phase split

Each phase ≤ 1 day. Phases are listed in dependency order; concurrent work is called out
where possible.

### Phase 1 — Backend `FilterPrimitive` extraction (M, ~5-7 h)

**Blocks every other phase. Also unblocks PEND-54's `SearchFilter` cleanup** — PEND-54
currently appends flat `Vec<String>` fields to `SearchFilter`; this phase replaces them
with `Vec<FilterPrimitive>` plus a thin `Into<FilterPrimitive>` adapter for the existing
fields so PEND-54's frontend wire format does not break.

- Define `FilterPrimitive`, `Projection` trait, `WhereClause`, `Bind` in
  `src-tauri/src/filters/primitive.rs` (new module — sibling to `commands/`, owned by
  neither).
- Implement `PagesProjection` and `SearchProjection`. Each surface declares its
  allowed-keys set as `pub const ALLOWED_KEYS: &[&str] = &[...]`.
- Reshape `SearchFilter` to carry `Vec<FilterPrimitive>` plus the existing flat fields
  (kept for one cycle for wire compat; deprecation comment + AGENTS.md note).
- Snapshot tests: each primitive × each surface = a SQL fragment snapshot. ~24
  snapshots total.

**This phase is the highest-leverage one in the plan.** Done right, every filter feature
for the next year extends one trait, one enum, and the per-surface allowed-keys set —
no parallel-codepath drift.

### Phase 2 — Pages-only primitives (S-M, ~3-5 h)

Depends on Phase 1.

- Add `Orphan`, `Stub`, `HasNoInboundLinks`, `LastEditedBucket` variants.
- Implement their `compile_*` in `PagesProjection`. Verify each query plan via `EXPLAIN
  QUERY PLAN` in tests — every one must hit an existing index.
- Bucket math: `chrono::Utc::now()` → `today`, `this_week` (rolling 7 days),
  `this_month` (rolling 30 days), `older` (everything else). The week/month buckets are
  **rolling**, not calendar-aligned — the calendar version is filed in *Open questions*.

### Phase 3 — Pages frontend chip-row (M, ~4-6 h)

Depends on Phase 1 (backend `Vec<FilterPrimitive>` shape).

- `src/components/PageBrowser/PageBrowserFilterRow.tsx` — composes `FilterPillRow` with
  the Add-Filter button. Lives next to `PageBrowserHeader`.
- Wire the chip set into `listBlocks` via a new `pageFilters: FilterPrimitive[]` field
  on the request struct (per PEND-50's IPC-struct convention).
- Local-state plumbing: chips live in `PageBrowser.tsx`'s `useState`, sit alongside
  `filterText` (the name-substring input).
- Empty state: an empty chip row renders an inline `Add Filter ▾` button only (no
  surrounding chrome). Identical to today's "no filter" appearance from the user's POV.

### Phase 4 — Add-Filter popover for Pages (M, ~4-5 h)

Depends on Phase 3.

- `src/components/PageBrowser/AddFilterPopover.tsx` — modelled on
  `GraphFilterBar.tsx:466`. Two categories: **Shared filters** (Tag, Page path, Has
  property, Last edited, Priority) and **Pages filters** (Orphan, Stub, No inbound
  links).
- Each category row opens a sub-popover keyed off facet type. The Tag sub-popover
  reuses `SearchablePopover` (precedent: PEND-54 line 26).
- Keyboard nav via `useListKeyboardNavigation` (existing hook, used by
  `BacklinkFilterBuilder`).
- Focus restore: `addFilterButtonRef` pattern from `BacklinkFilterBuilder.tsx:117`.

### Phase 5 — Tests (M, ~4-6 h)

Concurrent with phases 3-4 where possible. See *Tests* section.

### Phase 6 — Docs (S, ~2 h)

Concurrent with everything else.

- `docs/PAGES.md` — user-facing facet reference, worked examples (orphan grooming flow,
  "what changed this week" flow).
- `docs/architecture/filters.md` — the shared-primitive contract; `Projection` trait
  diagram; the surface allowed-keys gate as a static-data invariant; how saved views
  (PEND-57) reference primitives.
- `AGENTS.md` — one new invariant under a new *Filters* section: "Filter primitives are
  the single source of truth across Search and Pages. Per-surface behaviour lives in
  `ALLOWED_KEYS` (static `&[&str]`) and in the `Projection` trait impl. Adding a
  primitive to one surface and not the other is a deliberate diff in both files."
- `README.md` — one line under Pages.

**Sequencing summary:**

| Phase | Unblocks | Blocked by |
|---|---|---|
| 1 (FilterPrimitive extraction) | PEND-54's `SearchFilter` cleanup; Phases 2-5 of this plan; PEND-57's saved-view JSON shape | — |
| 2 (Pages-only primitives) | Phase 3-5 of this plan | Phase 1 |
| 3 (chip-row) | Phase 4 | Phase 1 |
| 4 (Add-Filter popover) | — | Phase 3 |
| 5 (tests) | — | Phases 1-2 for backend tests, 3-4 for frontend |
| 6 (docs) | — | — (can land concurrently) |

PEND-54 must finish *Phase 1's parser registry* before this plan's Phase 3. PEND-54's
Phase 2 (backend glob) is independent of this plan.

## Robustness

- **Filter validation**: parser-level errors render red chips with the typed error
  (precedent: PEND-54 line 211 — chip renders red with `InvalidGlob:` message).
  Backend-side validation errors flow through `AppError::Validation` with a per-primitive
  prefix (`InvalidFilter:`, mirroring `InvalidGlob:`).
- **Invalid combinations**: `orphan:` AND `has-no-inbound-links:` is redundant but not
  invalid (orphan is a strict superset). The UI does not collapse the redundancy — both
  chips render; the SQL evaluator deduplicates trivially. Document the redundancy in
  `docs/PAGES.md`.
- **Filter targets a deleted tag**: returns zero results, no error (per *Edge cases*).
  The chip still renders with the tag ULID's short form; users can remove it. Backlink
  resolution to a human-readable name is best-effort via the existing tag resolver
  (precedent: `FilterPillRow.tsx:90-93`).
- **Schema evolution**: a primitive lives in one enum variant; adding a field to it is
  non-breaking via `#[serde(default)]`. Removing a primitive requires a deprecation cycle
  — chips serialised in saved views (PEND-57) keep working as `unknown` tokens (render
  disabled, with a typed migration hint).
- **Malformed filter sets** from disk (corrupt saved view, hand-edited JSON): the
  deserialiser produces an `unknown` token per malformed entry; the view loads with as
  many chips as it could parse, plus a one-time toast surfacing the parse failure count.
- **Error states**: every chip can render in one of three states — **valid** (default
  chip styling), **disabled** (surface rejected via allowed-keys, e.g. a Search-saved
  view loaded into Pages with `regex:`), **invalid** (typed parse error). Each state has
  distinct styling tokens and an `aria-invalid` / `aria-disabled` accessor.

## Performance

Each primitive's SQL plan, measured against the existing indexes:

| Primitive | SARGable? | Index hit | Notes |
|---|---|---|---|
| `tag:` | Yes | `idx_block_props_key` (and `idx_block_props_key_text` via the `value_ref` join) | O(log N + matches). |
| `path:GLOB` | Substring-anchored only | None for the GLOB itself; full scan of `pages_cache.title` | Sub-millisecond for vault sizes the codebase targets (PEND-54 line 180). |
| `has-property:key` (existence) | Yes | `idx_block_props_key` | O(log N + matches). |
| `has-property:key=value` (equality, text) | Yes | `idx_block_props_key_text` | Per PEND-54. |
| `has-property:key=value` (equality, num) | Yes | `idx_block_properties_key_value_num` | Migration 0022 added this for exactly this query shape. |
| `last-edited:bucket` | Yes | `idx_op_log_created` | Bucket boundary is a constant computed at request time. |
| `space:` | Yes | `pages_cache.space_id` PK component | O(1) plan. |
| `priority:` | No dedicated index | Full scan filtered by `blocks.priority` | Acceptable at vault scale; document. |
| `orphan:` | Yes via the two `block_links` indexes | `idx_block_links_target` + `idx_block_links_source` | Two-subquery NOT-IN; SQLite plan is two indexed lookups. |
| `stub:` | Yes | `idx_blocks_page_id` (verify against migration 0027) | Single anti-join. |
| `has-no-inbound-links:` | Yes | `idx_block_links_target` | Single anti-join. |

**Compound-filter ordering for SARGable WHERE**: the compiler emits primitives in cost
order — index-backed primitives first, full-scan primitives last. This lets SQLite use
the first clause's index to narrow the row set before applying the scan. The order is
encoded as a `fn cost_hint(&self) -> u8` on `FilterPrimitive`; tested with a
deterministic snapshot.

**Slow-filter warning**: the only primitive without an index is `path:GLOB` (and only
when the GLOB has no anchor character). The chip renders a small clock icon when it
knows it will trigger a scan; tooltip explains. No hard reject — the scan is fast enough
at vault scale. Documented in `docs/PAGES.md`.

**Cache invalidation for derived facets**: `orphan:`, `stub:`, `has-no-inbound-links:`
are derived from `block_links` and `blocks`. They are not separately cached; each query
computes them on the fly. **Budget for a 1000-page space**: target sub-100ms for any
single-primitive query; sub-200ms for a 4-chip compound query. Phase 5's tests assert
against these as targets, not measurements (the harness will record real numbers during
implementation; if they exceed budget, the plan reconsiders pre-aggregation).

**Cache invalidation for `last-edited:bucket`**: the bucket is a *function of now*; the
SQL bakes in the boundary timestamp. A page that crosses a bucket boundary between two
queries surfaces correctly on the second query without any invalidation step. No cache to
invalidate.

## Maintainability

The `FilterPrimitive` extraction is the single biggest leverage point in this plan. If
Search and Pages ever need to diverge on a filter's semantics, that divergence must be a
**deliberate diff in `Projection` trait impls or in `ALLOWED_KEYS`**, never a silent
two-codepath drift.

Enforced by:

- `ALLOWED_KEYS` is a `pub const &[&str]` on each surface module. Adding a primitive to
  one surface and not the other shows up as a diff in two files; review catches it.
- Snapshot tests on every `(primitive, surface)` pair. Adding a primitive without
  registering its snapshot fails CI.
- The `Projection` trait's defaulted `compile_*` methods return
  `WhereClause::unsupported()`. A primitive that compiles to `unsupported` on a surface
  that admits it via `ALLOWED_KEYS` panics in debug builds — a deliberate "loud failure"
  for the unreachable branch.
- PEND-54's parser stays the **single source of truth** for tokenisation. This plan
  registers Pages-only token prefixes via PEND-54's `registerTokenPrefix` registry;
  there is no second parser.

If a future plan adds a primitive that's expensive on one surface and cheap on the other
(hypothetically: a "block-content regex against page rollup"), the diff lives in
`Projection` and nowhere else.

## Tests

### Unit (backend, `src-tauri/src/filters/tests/`)

- Per primitive × per surface: snapshot the emitted `WhereClause.sql` + bind set. ~24
  snapshots in Phase 1, plus 4 Pages-only-on-`PagesProjection` snapshots in Phase 2 =
  ~28 total.
- Per surface: `ALLOWED_KEYS` round-trip — every primitive's token form parses to a
  primitive that the surface admits; every disallowed primitive's token form parses to
  an `invalid` token with the expected typed message.
- Grooming-facet SQL snapshots: `Orphan`, `Stub`, `HasNoInboundLinks` each have a
  hand-verified-against-fixture test that the SQL returns the expected page IDs from a
  seeded space.
- Composition: filter × sort × cursor on a 50-page fixture — every reachable (filter,
  sort) combination paginates correctly across the keyset boundary.
- `EXPLAIN QUERY PLAN` assertion per primitive — fail CI if the plan does not name the
  expected index.

### Integration (frontend, `src/components/__tests__/`)

- `PageBrowser.filters.test.tsx` (new file):
  - Apply Tag chip via Add Filter ▾ — result set narrows to tagged pages.
  - Apply Orphan chip — fixture-known orphan pages surface; others don't.
  - Apply `last-edited:today` — fixture's today-edited pages surface; older don't.
  - Apply two chips — AND composition.
  - Remove chip via `×` — result set widens; cursor resets to the first page.
  - 8-chip soft warning fires.
- a11y over `PageBrowserFilterRow` + `AddFilterPopover` via `vitest-axe`. Chips have
  `aria-label="Remove filter {{token}}"` (precedent: PEND-54 line 213).
- Keyboard nav: Add Filter ▾ opens via Enter; arrow nav inside; Esc closes and restores
  focus to the trigger button (precedent: `BacklinkFilterBuilder.tsx:117` focus-restore).

### Cross-surface (parser-shared vs surface-rejected matrix)

A single test table (`src/lib/search-query/__tests__/cross-surface.test.ts` — new file)
enumerates every primitive's token form and asserts:

| Token | Pages outcome | Search outcome |
|---|---|---|
| `tag:#urgent` | valid chip | valid token |
| `orphan:` | valid chip | typed-error token |
| `regex:foo` | typed-error chip | valid token |
| ... | ... | ... |

This is the matrix the maintainability section relies on. Drift between the surfaces
fails this test.

### End-to-end (Playwright or equivalent, one new test)

- `e2e/pages-orphan-filter.spec.ts` — seed a space with 3 connected pages and 2
  orphans; open the Pages view; apply Orphan; assert exactly the 2 orphans surface;
  remove the chip; assert all 5 surface.

### Performance

- SARGable filter snapshot tests: `EXPLAIN QUERY PLAN` output for each primitive is
  committed to a snapshot file; CI fails on regression (plan loses index usage).
- Target-based timing tests (not measurement-based — labelled as targets per the plan's
  hard constraint): a 4-chip compound query against a 1000-page fixture completes under a
  target of 200ms locally; warns on regression rather than failing CI (CI hardware
  varies).

## Open questions

1. **Orphan-with-dangling-outbound**: should `orphan:` exclude pages that have outbound
   `[[page]]` links to non-existent pages? Two readings: (a) a page that links
   *anywhere*, even into the void, isn't an orphan because the author asserted a
   connection — keep it; (b) a link to a non-existent page is a broken connection and
   shouldn't rescue the page from orphan status. Recommendation: **(a)** — broken links
   are a separate grooming category (filed as a candidate for a future `broken-links:`
   facet). Confirm before locking Phase 2's `Orphan` SQL.
2. **Absolute dates in `last-edited:`**: the parser admits `last-edited:>=2026-01-01`
   on both surfaces, but Pages chips render bucket tokens natively. Does an
   absolute-date `last-edited:` chip in Pages render as a bucket label ("Custom") or as
   the raw date string? Recommendation: raw date string; reserve "Custom" for ranges
   (`last-edited:>=A,<B`).
3. **Max filter chip count**: 8 is justified above as a heuristic, not a measurement.
   If pre-Phase-3 user testing surfaces flows that legitimately want 12+, raise it; the
   SQL planner does not strictly bound it.
4. **Calendar vs rolling buckets for `last-edited:this-week`**: rolling 7-days is the
   default per Phase 2; calendar-week (Monday-start) is the alternative. The two diverge
   by up to 6 days at week's end. Locale-dependent week-start adds further complexity.
   Recommendation: ship rolling; revisit if grooming feedback says calendar.
5. **`has-no-inbound-links:` vs `orphan:` redundancy**: today the UI lets you apply
   both. Worth collapsing to one chip in the Add-Filter menu (an "is orphan" group with
   two checkboxes for inbound/outbound)? Holds for a UX pass; not a Phase-3 blocker.

## Acceptance criteria

- A user applies `orphan:` AND `last-edited:older` in Pages and sees every stale,
  unconnected page in the current space. Removing either chip widens the set as expected.
- A user applies `tag:#urgent` as a chip in Pages, then opens Search and types
  `tag:#urgent` in the input. The page set surfaced by Pages is exactly the set of pages
  whose blocks Search surfaces (intersect at the page level — no drift).
- A saved view created in Pages (PEND-57) with `tag:#urgent` chips loads on the Search
  surface as a query of `tag:#urgent` with zero loss. The reverse direction
  (Search-saved query with a `regex:` token loaded into Pages) renders the `regex:` chip
  in the disabled state with a typed hint, never silently drops it.
- Every Pages-only primitive's SQL plan hits an index (verified by `EXPLAIN QUERY PLAN`
  snapshot tests).
- The free-text name-substring filter in `PageBrowser` continues to work exactly as
  today when no chips are applied.
- Adding a new shared primitive in the future is a single-PR change: one enum variant,
  two `Projection` impls, two `ALLOWED_KEYS` updates, three sets of snapshot tests — and
  nothing else changes.

## Related

- `pending/PEND-56-pages-view-density-sort.md` — sort + density foundation.
- `pending/PEND-57-pages-view-bulk-ops-saved-views.md` — saved views snapshot this
  plan's filter set.
- `pending/PEND-50-search-vscode-ux.md` — Search-side foundation IPC contract.
- `pending/PEND-54-inline-filter-syntax.md` — parser this plan extends; **read before
  implementing**.
- `src-tauri/src/commands/blocks/queries.rs` — `list_blocks` site; filter struct lives
  here today.
- `src-tauri/src/commands/queries.rs` — Search command surface; `SearchFilter` reshape
  lands here.
- `src/components/PageBrowser.tsx` — host for `PageBrowserFilterRow`.
- `src/components/FilterPillRow.tsx` — chip primitive **reused verbatim**.
- `src/components/GraphFilterBar.tsx` — Add-Filter popover precedent **reused verbatim**.
- `src/components/BacklinkFilterBuilder.tsx` — focus-restore pattern reused for the
  Add-Filter trigger.
- `AGENTS.md` — extension target for the "Filter primitives are the single source of
  truth" invariant.
