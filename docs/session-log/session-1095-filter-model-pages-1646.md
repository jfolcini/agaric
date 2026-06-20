# Session 1095 — /batch-issues loop: migrate PageBrowser surface to canonical filter model (#1646)

## What happened

Surface 3 of 4 for #1646 (after graph #1850 and search #1852). Per the maintainer
decision — unify the representation everywhere, keep each surface's UI — the PageBrowser
filter surface now projects through the canonical `FilterPredicate` model with zero UI
change and a byte-identical emitted filter. Built in `wt-fpages`, adversarially reviewed.

## Shipped

PR `refactor/filter-model-fpages-1646`:

- **#1646 (PageBrowser surface)** — added the inverse `canonicalToFilterPrimitive` to
  `src/lib/filters/model.ts` (exact inverse of the existing `filterPrimitiveToCanonical`)
  and a `src/lib/filters/pageBrowserAdapter.ts` seam: `projectPageFilterThroughCanonical`
  round-trips a `FilterPrimitive` through the canonical model, falling back to the input
  unchanged for any leaf with no flat canonical category. Wired at the single emit seam in
  `PageBrowser/AddFilterPopover.tsx` (`onAddFilter(projectPageFilterThroughCanonical(...))`)
  — the categorized Add-Filter popover UI, gestures, categories, and chip rendering are
  unchanged; only the value crossing the IPC boundary is routed through canonical.
  - **Sentinels preserved:** `HasProperty`'s `PropertyPredicate` (incl. `NotExists` =
    absent-property) is passed verbatim both ways, so `NotExists` never collapses into
    `Eq ""` (the #1647 lesson — asserted non-equal in the test). `State{is_null:true}`
    (none) round-trips exactly.
  - **Deferred** (pass-through, not mis-mapped): the recursive `HasParentMatching`
    `FilterExpr` sub-tree and the compound `And/Or/Not` layer return `null` from
    `filterPrimitiveToCanonical` and fall back to the input by reference.

## Review pass

Reviewer (APPROVE, zero behavior change): the only behavioral change in
`AddFilterPopover.tsx` is the single emit routing; the round-trip is the IDENTITY for
every popover-emittable leaf (enumerated Tag/PathGlob/HasProperty/LastEdited/Priority/
State/BlockType/Due/Scheduled/Created/LinksTo/LinkedFrom/Orphan/Stub/HasNoInboundLinks/
HasParentMatching). Mutation-confirmed the `NotExists` vs `Eq ""` parity assertion is
load-bearing; spot-checked the inverse for all 7 DatePredicate ops, all 4 property ops,
include/exclude polarity, tag by-name-vs-id, single-vs-multi priority. Allow-list covers
all emitted kinds; no backend/type-def/other-surface change. 321 tests, tsc + oxlint clean.

## Notes

- Migration order: graph (#1850) → search (#1852) → **Pages** (this) → Backlink. UI kept
  for every surface per the maintainer decision; compound `And/Or/Not` layer deferred.
- Branch rebased onto post-search `origin/main`.
