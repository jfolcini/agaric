# Session 1093 — /batch-issues loop: migrate search surface to canonical filter model (#1646)

## What happened

Second surface migration for #1646 (after the graph proof in #1850). Per the maintainer
decision — unify the representation everywhere, keep each surface's UI — the search
surface now projects through the canonical `FilterPredicate` model with **zero UI change
and byte-identical IPC output**. Built in `wt-fsearch`, adversarially reviewed.

## Shipped

PR `refactor/filter-model-search-1646`:

- **#1646 (search surface, "adapter-only")** — added two lossless adapters to
  `src/lib/filters/model.ts`: `searchProjectionToCanonical(AstFilterProjection)` and its
  exact inverse `canonicalToSearchProjection`. `SearchPanel/searchFilterParams.ts`'s
  `astFilterParams` now round-trips the AST projection through
  `canonicalToSearchProjection(searchProjectionToCanonical(projection))` before the
  UNCHANGED empty→undefined emit, so the emitted `SearchFilterParams` is byte-identical.
  - **`state:none` preserved** (the #1647 trap): encoded as the literal value `'none'` in
    `stateFilter`/`excludedStateFilter`, NOT collapsed to the canonical `isNull` flag —
    the backend `todo_state IS NULL` path is untouched.
  - **Dates:** comparison ops map `<`↔Before … `>`↔After; named buckets ride a non-ISO
    `__search-named-date__:` sentinel on an `On` predicate (no `YYYY-MM-DD` collision),
    mirroring the graph has-date sentinel.
  - The `#717` async tag-resolution / unresolved-tag sentinel stays at the IPC boundary
    (after the round-trip), unaffected. Compound `And/Or/Not` deferred per the plan.

## Review pass

Reviewer (APPROVE, zero behavior change): diffed the `return {...}` emit block against
`origin/main` — byte-for-byte identical (only the round-trip line inserted, proven to be
the identity on every projection the UI can produce, field order preserved). Confirmed the
parity test's oracle is verbatim `origin/main`'s pre-migration `astFilterParams`.
Mutation-tested `state:none` (collapsing to `isNull` fails the parity test); verified the
date sentinel never collides with an ISO date; #717 resolved/unresolved both covered;
exclude polarity intact across all categories; allow-list covers exactly the 6 produced
kinds. 104 tests, tsc + oxlint clean. Only `model.ts` + `searchFilterParams.ts` + 2 test
files changed; no UI/shape/backend/other-surface change.

## Notes

- Migration order so far: graph (#1850) → **search** (this) → Pages → Backlink (UI
  unchanged for all per the maintainer decision); compound layer later.
- Branch base is current `origin/main` (has #1850).
