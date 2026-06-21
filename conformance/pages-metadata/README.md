# Cross-impl conformance: `list_pages_with_metadata`

`src/lib/tauri-mock/handlers.ts` re-implements the backend's page-listing
filter/sort/cursor logic in TypeScript so the e2e suite and many unit tests can
run without the Rust backend. `scripts/check-tauri-mock-parity.mjs` only checks
that handler **names** match the generated bindings — it never checks
**behaviour**, so a backend semantics change (sort order, cursor encoding) can
leave the mock stale while every suite stays green (#1886).

`sort-cursor.vectors.json` closes that gap for sort + cursor. It is the single
source of truth, asserted from both sides:

- **Rust** — `src-tauri/src/commands/tests/pages_metadata_conformance_tests.rs`
  seeds a temp DB from `rows` and drives the real
  `list_pages_with_metadata_inner` query path.
- **TypeScript** — `src/lib/tauri-mock/__tests__/sort-cursor-conformance.test.ts`
  drives the mock's `compareMetaRows` / `encodeNextCursor` re-implementation.

If they diverge, one side's test fails. When backend semantics intentionally
change, update this file to the new expected values; the mock test then fails
until `handlers.ts` is realigned — which is the whole point.

## Schema

```jsonc
{
  "rows": [ { "id", "content", "lastModifiedAt", "inboundLinkCount", "childBlockCount" } ],
  "scenarios": [
    {
      "sort": "default" | "recently-modified" | "most-linked" | "most-content",
      "expectedOrder": ["<id>", ...],            // full order, ties broken by id ASC
      "expectedCursorAfterFirst": {              // next_cursor minted after the 1st sorted row
        "id": "<id>",
        "position": <sort discriminator>,        // 2=recently-modified 3=most-linked 4=most-content 5=default
        "seq": <int>                             // present only for count sorts (most-linked/most-content)
      }
    }
  ]
}
```

Only `id` and `position` (the sort discriminator) are asserted on the cursor:
they are the representation-stable parts that the cross-mode-refresh contract
depends on. The key-slot value legitimately differs between impls (Rust stores
`recently-modified` as epoch-ms-as-string, the mock as an ISO string), so it is
**not** compared across languages; `seq` (an integer on both sides) is the
exception and is asserted for the count sorts.

## Scope (staged, per #1886)

- **In:** the four wire sorts — ordering + cursor discriminator (`position`/`seq`).
- **Out:** recently-modified key-slot byte-equality, and the `HasProperty`
  comparison / `LIKE` predicates (`Lt`/`Gt`/`Lte`/`Gte`/`Contains`/`StartsWith`),
  which the mock does not yet implement (tracked in #1913). `alphabetical` is
  intentionally excluded — it never crosses the wire
  (`pageSortWireFor('alphabetical')` returns `'default'`). The filter-primitive
  evaluation parity (#1908) is otherwise covered — see "Filter primitives",
  "`Orphan` filter", and "`Tag` / `HasProperty` filters" below.

## `PathGlob` filter (#1910)

`path-glob.vectors.json` is the second fixture under the same contract, locking
the Pages **page-path glob** filter. The backend moved this surface to the
SQLite `GLOB` dialect in #1320-A; the mock had drifted to a stale LIKE
translation (`globMatchesTitle`), so brace expansion, `[class]` ranges,
validation and ASCII-only folding all diverged silently (#1910).

- **Rust** — `src-tauri/src/commands/tests/pages_path_glob_conformance_tests.rs`
  seeds `pages_cache` titles and drives the real `list_pages_with_metadata_inner`
  with a `PathGlob` filter (`prepare_globs` → `LOWER(title) GLOB ?`).
- **TypeScript** — `src/lib/search-query/__tests__/glob-conformance.test.ts`
  drives `pageGlobFilterMatches` (in `src/lib/search-query/glob-validate.ts`, the
  JS port of `prepare_globs` + a `GLOB`→`RegExp` compiler).

Only the **set of matching page ids** is compared cross-impl (representation
stable). Each `scenarios[]` entry has `{ pattern, exclude, expectedMatchingIds }`;
`invalid[]` lists patterns both sides must reject with the shared `InvalidGlob:`
prefix (the backend as `AppError::Validation`, the mock by dropping every row).
Scenarios exercise the seven divergence classes catalogued in #1910.

## Filter primitives (#1908, slice 2 / increment a)

`filters.vectors.json` is the third fixture under the same contract, locking the
Pages **filter-primitive evaluation** — the `metaRowMatchesFilter` re-implementation
in `handlers.ts` that `scripts/check-tauri-mock-parity.mjs` never checks for
behaviour. This increment covers the primitives evaluable **purely over a
`PageMetaRow`** without global mock state: `Stub`, `HasNoInboundLinks`, `Priority`,
and `LastEdited`'s `Range` variant, plus **AND-composition** across a primitive
list.

- **Rust** — `src-tauri/src/commands/tests/pages_filter_primitive_conformance_tests.rs`
  seeds `pages_cache` counts, `blocks.priority`, and `op_log.created_at`, then
  drives the real `list_pages_with_metadata_inner` with the fixture's
  `FilterPrimitive` list (each primitive compiled to SQL in
  `src-tauri/src/filters/primitive.rs`).
- **TypeScript** — `src/lib/tauri-mock/__tests__/filter-primitive-conformance.test.ts`
  drives `metaRowMatchesFilter` (now exported from `handlers.ts`), AND-composing
  the same list.

Each `scenarios[]` entry is `{ name, filters: FilterPrimitive[], expectedMatchingIds }`;
only the matching-id **set** is compared cross-impl. `LastEdited` bounds and row
timestamps are identically-formatted RFC 3339 UTC, so the mock's lexical-ISO
compare equals the backend's epoch-ms compare; values are kept clear of the
bounds so both methods agree. `Rolling` / `OlderThan` are **excluded** — they
resolve against the wall clock (`now` / `new Date()`), which a golden fixture
cannot pin.

## `Orphan` filter (#1908, slice b)

`orphan.vectors.json` locks the `Orphan` primitive — a page with **no inbound
links AND no outbound link**. The backend (`compile_orphan` in
`src-tauri/src/filters/primitive.rs`) reads `pages_cache.inbound_link_count = 0`
AND a `NOT EXISTS` over `block_links` (an outbound link is any edge from a block
on the page to a block on a *different* page); the mock evaluates
`r.inboundLinkCount === 0 && !r.hasOutboundLink`.

- **Rust** — `pages_orphan_conformance_tests.rs` seeds `inbound_link_count`
  directly into `pages_cache` and, for outbound rows, a real `block_links` row
  from the page to a **sentinel target page** that is *not* assigned to the test
  space (so it never appears in results yet still satisfies `tgt.page_id != b.id`).
- **TypeScript** — `orphan-conformance.test.ts` sets `inboundLinkCount` /
  `hasOutboundLink` on the `PageMetaRow` and drives `metaRowMatchesFilter`.

Rows cover the full 2×2 of {inbound 0 / >0} × {outbound yes / no}; a scenario
pairs `Orphan` against `HasNoInboundLinks` to show `Orphan ⊂ HasNoInboundLinks`
(a 0-inbound page *with* an outbound link is not an orphan). Only inbound **count**
and outbound **presence** cross the comparison, so both are representation-stable.

## `Tag` / `HasProperty` filters (#1908, slice c)

`tag-property.vectors.json` locks the two state-backed primitives. `Tag`
(`b.id IN (SELECT block_id FROM block_tags WHERE tag_id = ?)`) and `HasProperty`
(`block_properties` predicates) are evaluated by the mock over its global
`blockTags` / `properties` maps (exported from `seed.ts`).

- **Rust** — `pages_tag_property_conformance_tests.rs` seeds `block_tags` (with a
  `block_type='tag'` block per tag id, FK-safe) and `block_properties`
  (`value_text` / `value_ref`, with the ref target block seeded first).
- **TypeScript** — `tag-property-conformance.test.ts` seeds the `blockTags` /
  `properties` maps (cleared per scenario) and drives `metaRowMatchesFilter`.

Scope is the predicates the mock implements and #1908 names: `Exists`,
`NotExists`, `Eq`, `Ne` — for both `Text` and `Ref` values. The comparison /
`LIKE` predicates (`Lt`/`Gt`/`Lte`/`Gte`/`Contains`/`StartsWith`) are a known
mock gap, deliberately out of scope and tracked in **#1913**.
