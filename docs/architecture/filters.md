# Filter primitives — shared cross-surface contract

The Pages view filters through one shared vocabulary, designed so Search can
adopt it later. The contract is one sentence:

> A `FilterPrimitive` is a **value**; a `Projection` is **how that value
> compiles to SQL** for a given surface.
>
> **Current reality (PEND-58d D27):** this engine is wired into the **Pages**
> surface only. Search still runs on its own subsystem — the inline-query
> parser at `src/lib/search-query/` plus `src-tauri/src/fts/` — and
> `SearchProjection` below is a compiled-but-unwired stub (see *Extension points*). The
> "single source of truth shared with Search" framing is therefore the design
> intent, **not** a guarantee that holds today: a primitive added here does not
> change Search behaviour, and the legacy Search filter path is still load-bearing.

Everything below follows from that split. The types live in
[`src-tauri/src/filters/primitive.rs`](../../src-tauri/src/filters/primitive.rs)
and are re-exported from
[`src-tauri/src/filters/mod.rs`](../../src-tauri/src/filters/mod.rs).

This document is the architecture reference. For the user-facing facet guide,
see [`docs/PAGES.md`](../PAGES.md). For the Pages view data flow, see
[`docs/architecture/pages-view.md`](pages-view.md).

## The primitive enum

`FilterPrimitive` is a tagged enum grouped by which surface admits it:

| Group | Variants |
|-------|----------|
| **Shared** | `Tag`, `PathGlob { pattern, exclude }`, `HasProperty { key, op, value }`, `LastEdited(LastEditedSpec)`, `Space`, `Priority` |
| **Pages-only** | `Orphan`, `Stub`, `HasNoInboundLinks` |
| **Search-only** | `Regex`, `CaseSensitive`, `WholeWord`, `Snippet(SnippetSpec)` |

Value sub-types: `PropertyOp` (`eq` / `ne` / `exists` / `notExists`),
`PropertyValue` (`Text` / `Ref`), `LastEditedSpec` (`Rolling { days }` /
`Range { start, end }` / `OlderThan { days }`), `SnippetSpec`.

### Wire format

The enum and its value sub-types derive `Serialize` / `Deserialize` /
`specta::Type`. Serde uses **internal tagging** (`#[serde(tag = "type")]`),
so the TypeScript binding in
[`src/lib/bindings.ts`](../../src/lib/bindings.ts) is a discriminated union
of the shape `{ type: "Orphan" } | { type: "Tag"; tag: string } | …`. Newtype
variants are declared as single-field struct variants (`Tag { tag: String }`,
not `Tag(String)`) because serde's internal tagging cannot represent a
newtype-of-primitive — this matches the `BacklinkFilter` convention already
used elsewhere in the bindings.

## The Projection trait

`Projection` is the per-surface compiler. Each surface decides which
primitives it supports and how each one compiles to SQL on its schema:

- `compile_tag`, `compile_path_glob`, `compile_has_property`,
  `compile_last_edited`, `compile_space`, `compile_priority` — the shared set.
- `compile_orphan`, `compile_stub`, `compile_has_no_inbound_links` — Pages-only;
  they **default to `WhereClause::unsupported()`** on the trait, so a surface
  that does not implement them simply rejects them.

Each `compile_*` returns a `WhereClause { sql, binds }` — a boolean-valued SQL
fragment plus its positional bind values. The two implementations are
`PagesProjection` and `SearchProjection`.

`WhereClause::unsupported()` is a sentinel (`1=0 /* UNSUPPORTED */`). It must
never reach SQL: the allow-list gate (below) is the production-side guard, and
the sentinel is defence-in-depth for an unreachable branch.

## Per-surface allow-list gate

Each surface declares a static key set:

- `PAGES_ALLOWED_KEYS` — the shared keys plus `orphan` / `stub` /
  `has-no-inbound-links`.
- `SEARCH_ALLOWED_KEYS` — the shared keys plus `regex` / `case-sensitive` /
  `whole-word` / `snippet`.

A primitive's `allowed_key()` maps it to its token; the IPC rejects any
primitive whose key is not in the active surface's set with
`AppError::Validation`. On Pages, the Add-Filter popover
([`src/components/PageBrowser/AddFilterPopover.tsx`](../../src/components/PageBrowser/AddFilterPopover.tsx))
only offers allowed facets, so a Search-only primitive never reaches the wire
in normal use — the backend gate is the trust boundary.

**Invariant:** adding a primitive to one surface and not the other is a
*deliberate diff* in `ALLOWED_KEYS` **and** in the `Projection` impl. Adding a
primitive without registering its allow-list key and its `compile_*` is caught
by the unit tests in `primitive.rs`.

## SQL composition

The Pages IPC composes filters in
[`list_pages_with_metadata_inner`](../../src-tauri/src/commands/pages.rs) via
the `compile_pages_filters` helper:

1. **Cost ordering.** Each primitive carries a `cost_hint(&self) -> u8`
   (index-backed primitives `0`, per-row cheap `1` (`Priority`, `LastEdited`),
   `PathGlob` `2`, post-filter / non-SQL `3`). Clauses are emitted cheapest-first
   so SQLite can narrow the row set with an index before applying a scan.
   `PathGlob` is always `2` (full scan): it compiles to `title COLLATE NOCASE
   LIKE ? ESCAPE '\'` (PEND-58d D1), and SQLite does not apply its LIKE-index
   optimization to a case-insensitive `LIKE` — neither a `COLLATE NOCASE` index
   nor a `LOWER(title)` expression index is used; only an explicit `COLLATE
   NOCASE >= p AND < p++` range would hit `idx_pages_cache_title_nocase`. The
   scan is cheap because `pages_cache` is one row per page.
2. **Bind renumbering.** Each `compile_*` fragment emits anonymous `?`
   placeholders. Because the fragments are spliced into a statement that also
   carries the keyset binds, `compile_pages_filters` renumbers every `?` to an
   explicit `?N` position so SQLite's positional binding stays unambiguous
   regardless of compose order. (A filter-plus-cursor pagination test pins this.)
3. **Join context.** The Pages-only primitives reference
   `pc.inbound_link_count` / `pc.child_block_count`, so the SELECT must
   `LEFT JOIN pages_cache pc ON pc.page_id = b.id`. The IPC already does this;
   any future consumer of `PagesProjection` must provide the same alias.

## Performance

The Pages-only grooming facets read **materialised** columns:

- `Orphan` and `HasNoInboundLinks` test `COALESCE(pc.inbound_link_count, 0) = 0`.
- `Stub` tests `COALESCE(pc.child_block_count, 0) = 0`.

Those columns are maintained by the materializer and were added in
[`migration 0069`](../../src-tauri/migrations/0069_pages_cache_link_and_content_counts.sql).
This is why the grooming facets do not pay the per-page `COUNT(DISTINCT …)`
cost that the originally-computed approach hit at ~20k pages — they ride the
same materialised counts the `most-linked` sort uses, so the filter result and
the inbound-link badge agree by construction.

`inbound_link_count` excludes **same-page / self / deleted-source** edges
(PEND-58d D2,
[`migration 0070`](../../src-tauri/migrations/0070_pages_cache_inbound_link_count_exclude_same_page.sql)),
mirroring the canonical backlink query in `backlink/grouped.rs` — so a page whose
only inbound edge comes from one of its own descendants correctly reads as an
orphan / has-no-inbound.

`Orphan`'s outbound half is a page-wide `NOT EXISTS` over `block_links` joined to
the source's blocks; it joins the link **target** and excludes deleted and
same-page targets (PEND-58d D19) to stay symmetric with the inbound side. It has
no materialised counterpart yet and is a candidate for a future
`outbound_link_count` column if measurement shows it dominating.

## Extension points

- **Search-surface composition** is stubbed: `SearchProjection` exists with the
  shared `compile_*`, but wiring it into the FTS query path
  (`src-tauri/src/fts/`) is future work — today Search keeps its existing SQL.
- **Saved views** (planned, PEND-57) snapshot a `FilterPrimitive[]` alongside
  the sort + density, so a saved Pages view round-trips through the same
  vocabulary.
