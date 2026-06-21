# Session 1115 — tauri-mock filter-primitive conformance (#1908 slice 2, increments a/b/c)

## Problem

`src/lib/tauri-mock/handlers.ts` re-implements the backend's Pages
filter/sort/cursor logic in TypeScript so the e2e suite and many unit tests run
without the Rust backend. `scripts/check-tauri-mock-parity.mjs` checks only that
handler **names** match the generated bindings — never **behaviour** — so a
backend semantics change can leave the mock stale while every suite stays green
(#1886). Slice 1 (#1909) locked sort + cursor; #1910 locked the `PathGlob`
filter. #1908 extends the same shared-fixture pattern to the remaining
drift-prone reimplementation: `metaRowMatchesFilter`'s per-primitive predicate
matrix.

The maintainer's scoping note split the filter primitives by how hard they are
to conformance-test: the mock evaluates some **purely over a `PageMetaRow`**,
while others (`Tag` / `HasProperty`) read global mock state (`blockTags` /
`properties` maps) and `Orphan` needs link seeding. Each is a separable
increment.

## Approach — increment (a): the pure-over-row primitives

Added `conformance/pages-metadata/filters.vectors.json` (the third fixture under
the slice-1 / #1910 contract) covering the primitives evaluable without global
mock state: `Stub`, `HasNoInboundLinks`, `Priority`, and `LastEdited`'s `Range`
variant, plus **AND-composition** across a primitive list. Each scenario is
`{ name, filters: FilterPrimitive[], expectedMatchingIds }`; only the matching-id
**set** is compared cross-impl (representation-stable).

- **Rust** — `pages_filter_primitive_conformance_tests.rs` seeds `pages_cache`
  counts, `blocks.priority`, and `op_log.created_at` per fixture row, then drives
  the REAL `list_pages_with_metadata_inner` with the fixture's `FilterPrimitive`
  list (deserialized straight from the wire JSON; each primitive compiled to SQL
  in `src-tauri/src/filters/primitive.rs`).
- **TS** — `filter-primitive-conformance.test.ts` drives `metaRowMatchesFilter`
  (now `export`ed from `handlers.ts`, as slice 1 exported the sort/cursor fns),
  AND-composing the same list over a `PageMetaRow` built from each fixture row.

## Representation-stability decisions

- `LastEdited` bounds and row timestamps are identically-formatted RFC 3339 UTC
  (`…Z`), so the mock's **lexical-ISO** compare (`lm >= start && lm <= end`)
  equals the backend's **epoch-ms** compare (`MAX(op_log.created_at) BETWEEN …`).
  Row timestamps are kept clear of the bounds (no boundary-exact values) so both
  methods agree unambiguously.
- A null `lastModifiedAt` seeds **no** `op_log` row on the Rust side, so the
  subquery yields NULL and the `Range` bound excludes it — matching the mock's
  `lm == null → false`.
- `Rolling` / `OlderThan` are **excluded**: they resolve against the wall clock
  (`strftime('now', …)` / `new Date()`), which a golden fixture cannot pin.
- NULL `priority` is excluded by `Priority` on both sides (`NULL = ?` → NULL;
  `null === ?` → false), verified by a fixture row.

## Behaviour change

None. This is a test-only / fixture-only slice; the sole production-code change
is adding `export` to `metaRowMatchesFilter`. No logic moved.

## Verification

- TS: `filter-primitive-conformance.test.ts` — 9 scenarios pass.
- Rust: `pages_filter_primitive_conformance_matching` passes (real query path).
- Both sides assert the SAME fixture, so a future drift on either side breaks the
  gate.

## Slice (b) — `Orphan`

`orphan.vectors.json` + `pages_orphan_conformance_tests.rs` +
`orphan-conformance.test.ts`. `Orphan` = `inbound_link_count = 0` AND no outbound
link (`NOT EXISTS` over `block_links` to a *different* page); the mock evaluates
`inboundLinkCount === 0 && !hasOutboundLink`. The Rust seed writes
`inbound_link_count` directly and, for outbound rows, a real `block_links` row to
a **sentinel target page** left off the test space (so it never appears in
results yet still satisfies `tgt.page_id != b.id`). Rows cover the 2×2 of
{inbound 0/>0} × {outbound y/n}; a scenario contrasts `Orphan` with
`HasNoInboundLinks` (`Orphan ⊂ HasNoInboundLinks`).

## Slice (c) — `Tag` / `HasProperty`

`tag-property.vectors.json` + `pages_tag_property_conformance_tests.rs` +
`tag-property-conformance.test.ts`. These are the state-backed primitives: the
mock reads its global `blockTags` / `properties` maps (exported from `seed.ts`),
the backend reads `block_tags` / `block_properties`. Scope = the predicates the
mock implements and #1908 names: `Tag`, and `HasProperty` `Exists` / `NotExists`
/ `Eq` / `Ne` for both `Text` and `Ref` values. The Rust seed is FK-safe (a
`block_type='tag'` block per tag id; the ref-value target block seeded before the
property row); the TS test seeds the maps and clears them per scenario.

The `HasProperty` comparison / `LIKE` predicates
(`Lt`/`Gt`/`Lte`/`Gte`/`Contains`/`StartsWith`) are a known mock gap (it returns
`true` for them) — out of #1908 scope, filed as **#1913**.

## Closing

This PR ships all three pure / state-backed increments (a + b + c), completing
the filter-primitive evaluation parity #1908 asked for, so it **Closes #1908**.
The two remaining bullets from #1908's scoping (the `HasProperty` compare/LIKE
predicates and recently-modified cursor key-slot byte-equality) are tracked
separately (#1913 and slice-1's documented exclusion). #1886 can close once this
lands.
