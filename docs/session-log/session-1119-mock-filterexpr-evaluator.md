# Session 1119 — tauri-mock `FilterExpr` evaluator (P2 prerequisite)

Resumed the inline-query unification plan (P2: route `{{query}}` blocks onto the
rich `FilterExpr` engine). The prior session deferred P2 as "blocked on two
prerequisites", the first being that the tauri-mock's `run_advanced_query`
handler returned an always-empty page because it "cannot compile a `FilterExpr`
to SQL". This session removes that blocker by INTERPRETING the tree instead.

## What shipped

The mock already had a faithful, conformance-guarded per-primitive matcher
(`metaRowMatchesFilter`, pinned by `filter-primitive-conformance.test.ts` against
Rust-authored golden vectors). The only missing piece was the boolean
composition over it:

- **`metaRowMatchesExpr(row, expr)`** — a recursive `FilterExpr` tree-walk:
  `Leaf` → `metaRowMatchesFilter`; `And` → every child (empty ⇒ TRUE / `1=1`);
  `Or` → some child (empty ⇒ FALSE / `1=0`); `Not` → complement. The combinators
  are the engine's exact identities, so this adds no drift surface beyond the
  already-pinned per-primitive matrix.

- **`run_advanced_query` FLAT path** now evaluates the request's `FilterExpr`
  against every active, in-space block (`fbqInSpace` scoping, an omitted filter
  defaulting to `And{[]}` = whole space), returns the matched blocks in the
  engine's `b.id ASC` keyset-tiebreaker order, and keyset-paginates
  (`limit`/`cursor`, first-page-only `total_count`). The GROUPED + AGGREGATE
  response paths stay synthesised (unchanged); full `SortKey` ordering beyond the
  id tiebreaker is a follow-up.

## Why it's safe / valuable on its own

- **Zero production risk:** tauri-mock is dev-preview + e2e only.
- **Standalone value:** `AdvancedQueryView` (a shipped surface) rendered nothing
  in dev-preview/e2e because the handler returned `rows: []`; it now runs against
  real seed data.
- The `useAdvancedQuery` hook and `AdvancedQueryView` unit tests stub the IPC
  directly, so they are unaffected; no e2e drives the handler today.

New test `advanced-query-filter-expr.test.ts` covers the combinator identities
(empty-And/Or, And/Or/Not) and the handler end-to-end (space scoping, matched
rows, pagination). `tsgo` + the full tauri-mock/advanced-query vitest suites
green.

## Remaining P2 work (still tracked in #1951)

This unblocks — but does not perform — the execution cutover. Stage A (route
faithfully-translatable legacy `{{query}}` blocks through the rich path, gated by
the `legacyQueryToFilterExpr` bridge's refusal `reasons`, with async `tag:`
prefix resolution via `list_tags_by_prefix`) and Stage B (upgrade
`QueryBuilderModal` to the nested `FilterGroup` builder + store a `SavedQuerySpec`
payload in the block) remain follow-ups.
