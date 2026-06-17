# Filter primitives — the shared cross-surface filter compiler

Every structural filter in Agaric — Pages, Search, Backlinks, and the
advanced-query surface — compiles through **one** vocabulary. The contract is
one sentence:

> A `FilterPrimitive` is a **value**; a `Projection` is **how that value
> compiles to SQL** for a given surface.

As of #1320 (filter-compiler unification) and #1280 (advanced-query mode), this
is no longer aspirational. The `FilterPrimitive` / `Projection` engine is the
**single filter compiler shared across four surfaces**, each with its own
`Projection` impl and its own `ALLOWED_KEYS` gate:

| Surface | Projection | Lives in |
|---------|------------|----------|
| Pages   | `PagesProjection` | [`src-tauri/src/filters/primitive.rs`](../../src-tauri/src/filters/primitive.rs) |
| Search (FTS) | `SearchProjection` | [`src-tauri/src/filters/primitive.rs`](../../src-tauri/src/filters/primitive.rs) |
| Backlinks | `BacklinkProjection` | [`src-tauri/src/backlink/projection.rs`](../../src-tauri/src/backlink/projection.rs) |
| Advanced query | `QueryProjection` | [`src-tauri/src/query/projection.rs`](../../src-tauri/src/query/projection.rs) |

The primitive types live in
[`src-tauri/src/filters/primitive.rs`](../../src-tauri/src/filters/primitive.rs)
and are re-exported from
[`src-tauri/src/filters/mod.rs`](../../src-tauri/src/filters/mod.rs); the
boolean-tree composition lives in
[`src-tauri/src/filters/expr.rs`](../../src-tauri/src/filters/expr.rs).

This document is the architecture reference. For the user-facing facet guide,
see [`docs/PAGES.md`](../PAGES.md). For the Pages view data flow, see
[`docs/architecture/pages-view.md`](pages-view.md).

## The primitive enum

`FilterPrimitive` is a tagged enum grouped by which surface(s) admit it. The
**shared** group — plus the #1280 metadata group — is what makes the engine
cross-surface; the Pages-only and Search-only groups are surface specialties.

| Group | Variants |
|-------|----------|
| **Shared** | `Tag`, `PathGlob { pattern, exclude }`, `HasProperty { key, predicate: PropertyPredicate }`, `LastEdited { spec: LastEditedSpec }`, `Space { space_id }`, `Priority { priority }` |
| **Metadata (#1280)** | `State { values, is_null, exclude }`, `BlockType { values, exclude }`, `DueDate { predicate: DatePredicate }`, `Scheduled { predicate: DatePredicate }`, `Created { after, before }` |
| **Pages-only** | `Orphan`, `Stub`, `HasNoInboundLinks` |
| **Search-only** | `Regex`, `CaseSensitive`, `WholeWord`, `Snippet { spec: SnippetSpec }` |

### Value sub-types

- **`PropertyPredicate`** — an internally-tagged enum that fuses the operator
  with its operand, so an `Eq`-without-value or `Exists`-with-value state is
  unrepresentable (D8). The vocabulary is `Exists` / `NotExists` /
  `Eq { value }` / `Ne { value }` and, since #1280, the ordered + substring
  comparators `Lt` / `Gt` / `Lte` / `Gte` / `Contains` / `StartsWith` (each
  carrying a `PropertyValue`).
- **`PropertyValue`** — `Text { value }` / `Ref { value }` and, since #1280,
  `Num { value: f64 }` (compared against `block_properties.value_num`, bound as
  a SQLite REAL) and `Date { value }` (lexical ISO compare against
  `value_date`). `Contains` / `StartsWith` over a `Num` are meaningless and
  compile to `1=0`.
- **`DatePredicate`** (#1280) — a predicate over a TEXT-ISO date column
  (`b.due_date`, `b.scheduled_date`): `IsNull` / `Before` / `After` /
  `OnOrBefore` / `OnOrAfter` / `On` / `Between`. Comparisons are **lexical** —
  ISO-8601 dates sort byte-wise the same as chronologically. `On` over a
  time-bearing column expands to the half-open calendar-day range
  (`>= d AND < d+1day`) via `to_lexical_sql`; the Pages/Backlink `due-date` /
  `scheduled` compilers keep the DATE-exact `= ?` form to stay byte-identical
  with the backlink resolver oracle.
- **`LastEditedSpec`** — `Rolling { days }` / `Range { start, end }` /
  `OlderThan { days }`.
- **`SnippetSpec`** — FTS5 `snippet()` window parameters.

### Wire format

The enum and its serde-exposed sub-types derive `Serialize` / `Deserialize` /
`specta::Type` with **internal tagging** (`#[serde(tag = "type")]`), so the
TypeScript binding in [`src/lib/tauri.ts`](../../src/lib/tauri.ts) is a discriminated
union of the shape `{ type: "Orphan" } | { type: "Tag"; tag: string } | …`.
Newtype variants are declared as single-field struct variants
(`Tag { tag: String }`, not `Tag(String)`) because serde's internal tagging
cannot represent a newtype-of-primitive — this matches the `BacklinkFilter`
convention. Note that `FilterPrimitive` is `PartialEq` but **not** `Eq`: the
`Num { value: f64 }` operand added in #1280 makes `Eq` underivable.

## The Projection trait

`Projection` is the per-surface compiler. Each surface decides which primitives
it supports and how each one compiles to SQL on its schema:

- The shared leaves — `compile_tag`, `compile_path_glob`,
  `compile_has_property`, `compile_last_edited`, `compile_space`,
  `compile_priority` — are required methods.
- The #1280 metadata leaves — `compile_state`, `compile_block_type`,
  `compile_due_date`, `compile_scheduled`, `compile_created` — and the
  Pages-only / Search-only leaves **default to `WhereClause::unsupported()`** on
  the trait, so a surface opts in only by overriding them.

Each `compile_*` returns a `WhereClause { sql, binds, unsupported }` — a
boolean-valued SQL fragment, its positional bind values, and an explicit
"unsupported" flag. `WhereClause::unsupported()` is a sentinel
(`1=0 /* UNSUPPORTED */` with `unsupported: true`); it must never reach SQL.
The allow-list gate (below) is the production guard; the sentinel is
defence-in-depth.

`Bind` is the three-affinity bind shape: `Text(String)` / `Int(i64)` /
`Real(f64)` (the last carrying #1280 numeric property values).

### The four projections

- **`PagesProjection`** implements the shared leaves, all three Pages-only
  physical leaves (`orphan` / `stub` / `has-no-inbound-links`, which read the
  materialised `pages_cache` counts), **and** the #1280 metadata leaves (so the
  advanced-query surface can delegate to it). It compiles on the `b` block
  alias and `LEFT JOIN pages_cache pc`.
- **`SearchProjection`** implements the shared leaves plus the Search-only
  specialties. Since #1320 it is **wired into the FTS query path**
  ([`src-tauri/src/fts/filter_builder.rs`](../../src-tauri/src/fts/filter_builder.rs)):
  the structural side of a search — `space`, `tag`, page-name glob,
  `last-edited`, `state`, `block-type`, `due-date`, `scheduled` — is now routed
  through `SearchProjection` rather than a parallel hand-built SQL path. After
  #1320-A both surfaces share the `LOWER(title) GLOB ?` page-name dialect (only
  the alias differs: Pages keys on `b.id`, Search on `b.page_id`).
- **`BacklinkProjection`** ([`backlink/projection.rs`](../../src-tauri/src/backlink/projection.rs))
  compiles the correlated backlink leaf fragments: `has-property`, `priority`,
  and the #1280 metadata set (`state` / `block-type` / `due-date` / `scheduled`
  / `created`). Its `compile_expr` complement logic is the canonical source the
  shared boolean tree borrows (see below).
- **`QueryProjection`** ([`query/projection.rs`](../../src-tauri/src/query/projection.rs))
  is the advanced-query surface. It supports the shared leaves and the #1280
  metadata leaves, and **delegates every one to `PagesProjection`** (both run on
  `FROM blocks b`), so the advanced query's SQL is byte-shape-identical to the
  Pages surface. Pages-only physical leaves and Search-only leaves fall through
  to `unsupported()`.

## Per-surface allow-list gate

Each surface declares a static key set; a primitive's `allowed_key()` maps it to
its token, and the surface rejects any primitive whose key is not in its set
with `AppError::Validation`:

- `PAGES_ALLOWED_KEYS` — the shared keys plus `orphan` / `stub` /
  `has-no-inbound-links`.
- `SEARCH_ALLOWED_KEYS` — the shared keys plus `regex` / `case-sensitive` /
  `whole-word` / `snippet`.
- `BACKLINK_ALLOWED_KEYS` — `has-property` / `priority` plus the #1280 metadata
  keys (`state` / `block-type` / `due-date` / `scheduled` / `created`).
- `QUERY_ALLOWED_KEYS` — the shared keys plus the #1280 metadata keys.
  Deliberately **excludes** the Pages-only physical leaves and the Search-only
  leaves (both compile to `unsupported()` on this surface).

The gate is the trust boundary: on Pages, the Add-Filter popover
([`src/components/PageBrowser/AddFilterPopover.tsx`](../../src/components/PageBrowser/AddFilterPopover.tsx))
only offers allowed facets, but the backend allow-list — not the UI — is what
rejects an out-of-vocabulary primitive on the wire.

**Invariant:** admitting a primitive on one surface and not another is a
*deliberate diff* in both `ALLOWED_KEYS` **and** the `Projection` impl. A
cross-surface consistency test asserts that every routed key is present in its
surface's allow-list, so adding a primitive without registering its key (or its
`compile_*`) is caught.

## Boolean composition — `FilterExpr`

[`FilterExpr`](../../src-tauri/src/filters/expr.rs) is the boolean tree over
`FilterPrimitive` leaves: `Leaf` / `And { children }` / `Or { children }` /
`Not { child }`. A flat chip-row `Vec<FilterPrimitive>` is exactly
`FilterExpr::And { children: [Leaf, …] }` (built by `FilterExpr::all`), so the
existing flat-conjunction surfaces lift losslessly; the tree only **adds** the
ability to nest `Or` / `Not`.

`compile_expr` is a blanket extension on every `Projection`: it recurses the
tree, compiling each leaf and joining the fragments with SQL booleans:

- **`And`** joins children with ` AND `, parenthesising each; empty `And` is the
  identity `1=1` (TRUE).
- **`Or`** joins with ` OR `, parenthesising each; empty `Or` is the identity
  `1=0` (FALSE).
- **`Not`** wraps its child in the **3-valued complement**
  `NOT COALESCE((…), 0)` — `COALESCE` folds a NULL (a LEFT-JOIN miss / unknown)
  to 0 *before* negating, so `Not` is the set complement over non-deleted rows
  rather than SQL's `NOT NULL = NULL` (which would silently drop the row). This
  is lifted verbatim from the backlink resolver's `compile_backlink_filter`, so
  the two boolean compilers agree.
- **Unsupported propagation** — if any leaf is unsupported on the projection,
  the *whole* expression compiles to `unsupported()`; the allow-list gate then
  rejects it as a unit rather than silently emitting a `1=0` conjunct.

### Depth guard

`compile_expr` recurses **unbounded** and is an infallible pure SQL builder, so
depth validation is a separate, caller-invoked gate. `FilterExpr::validate_depth`
(#1396) rejects a tree whose nesting exceeds `FilterExpr::MAX_DEPTH` (50,
mirroring the backlink resolver's bound) with `AppError::Validation`. Callers
building a tree from **untrusted** input (the advanced-query IPC) MUST call it
before `compile_expr`. Depth counts **nesting**, not breadth — a 1000-leaf-wide
single `And` is fine; only nesting can overflow the recursion.

## The advanced-query engine (#1280)

The advanced-query surface is the first end-to-end consumer of the full stack:
a composable boolean tree over every shared + metadata dimension, optionally
intersected with full-text, returned as a keyset-paginated page of blocks.

- **Command:** `run_advanced_query`
  ([`src-tauri/src/commands/advanced_query.rs`](../../src-tauri/src/commands/advanced_query.rs))
  is a thin IPC wrapper over `query::compile_and_run`
  ([`src-tauri/src/query/engine.rs`](../../src-tauri/src/query/engine.rs)).
- **Request:** `AdvancedQueryRequest { space_id, filter, sort, cursor, limit, fulltext }`.
  `filter` is a `FilterExpr` defaulting to `And { children: [] }` (the TRUE
  expression → every block in the space). `fulltext` is optional.
- **Response:** `AdvancedQueryResponse { rows, next_cursor, has_more, total_count }`,
  where each `QueryResultRow` is an `ActiveBlockRow` flattened with a `score`.

### Pipeline

1. **Depth gate** — `validate_depth` rejects pathological nesting before the
   unbounded compile.
2. **Allow-list gate** — every leaf key must be in `QUERY_ALLOWED_KEYS`; an
   unsupported key (e.g. `orphan`) is rejected with `AppError::Validation`.
3. **Compile** — `QueryProjection::compile_expr` folds the tree into one
   `WhereClause` (an `unsupported()` result is rejected defensively).
4. **Assemble** — `FROM blocks b WHERE b.space_id = ? AND b.deleted_at IS NULL
   AND (<compiled>)`, with the anonymous `?` placeholders renumbered to explicit
   `?N` so the space, filter, keyset (and MATCH) binds never collide (mirroring
   `compile_pages_filters`).
5. **Full-text composition** — when `fulltext` is `Some`, the FROM becomes
   `fts_blocks fts JOIN blocks b ON b.id = fts.block_id` and `fts_blocks MATCH ?1`
   (the **sanitised** query) is AND-composed in front of the structural
   predicate — the MATCH **∩** the structural WHERE. The per-row `bm25` rank
   (`fts.rank`, lower = better) fills the `score` channel and becomes the
   relevance sort source. An FTS5 parse error surfaces as `AppError::Validation`,
   not `Database`.
6. **Sort + keyset** — `SortSource::Column { name: SortColumn }` maps each key
   to a *literal* column (the `SortColumn` enum is closed —
   `Created` / `LastEdited` / `Position` / `Priority` / `Title` — so a sort key
   can never be a user string spliced into SQL); `SortSource::Relevance` sorts
   on `fts.rank` and is **rejected unless** a `fulltext` term is present. Every
   sort terminates in the `b.id` tiebreaker so the keyset is total; the default
   is `b.id DESC` (newest-first), or relevance-first when full-text is present.
   The opaque cursor encodes the full sort tuple of the last row (with a `1e-9`
   epsilon band on the float rank so precision drift never skips or re-emits a
   boundary row).
7. **Count** — `total_count` is a `COUNT(*)` over the same predicate computed on
   the **first** page only; cursor pages skip it.

## The vector / hybrid seam (designed, not built)

The wire shapes reserve forward-compat slots so a future semantic-search /
hybrid stage lands non-breaking — **none of this is implemented today**:

- `QueryResultRow::score` is a generic ranking channel. Today it carries the
  full-text `bm25` rank (or `None` for purely structural queries); a future
  vector pass could fill the same channel.
- `SortSource` is a tagged enum with only `Column` and `Relevance` built. Its
  doc reserves `Aggregate` (group-by) and `VectorScore` (vector similarity)
  variants, intentionally **not** added because there is no aggregate or vector
  channel to sort on yet.
- A future hybrid retrieval stage — a `vec0` (sqlite-vec) nearest-neighbour pass
  fused with the existing `bm25` channel via Reciprocal-Rank Fusion (RRF) — would
  slot in alongside the FTS5 `MATCH`, feeding a `VectorScore` sort source and the
  same `score` channel. This is a **documented design seam**, not a commitment.

## In progress / planned

Honest status of the advanced-query surface as merged:

- **Merged:** the cross-surface compiler (#1320), the boolean `FilterExpr` tree
  with its depth guard, the `run_advanced_query` engine with structural filtering,
  full-text ∩ structural with `bm25` relevance, keyset pagination, and a flat
  conjunction builder UI
  ([`src/components/AdvancedQuery/AdvancedQueryView.tsx`](../../src/components/AdvancedQuery/AdvancedQueryView.tsx),
  restricted to the shared engine-supported keys).
- **In progress / planned:** `GROUP BY` grouping and aggregation (the
  `Aggregate` sort source + `group_by` request fields are reserved, not built);
  saved views; the nested And/Or/Not builder UI; and dedicated chip editors for
  the `state` / `block-type` / date metadata leaves on the advanced-query pane
  (the engine supports those leaves; only the *flat shared-key* builder is
  exposed in v1). Search-surface composition of the Search-only specialties
  (`regex` / `case-sensitive` / `whole-word` / `snippet`) remains on its own FTS
  path; only the structural subset routes through `SearchProjection` today.
