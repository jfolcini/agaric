# Session 1096 — /batch-issues loop: migrate backlink surface to canonical filter model (#1646)

## What happened

Surface 4 of 4 — the FINAL #1646 surface migration (after graph #1850, search #1852,
PageBrowser #1854). Per the maintainer decision — unify the representation everywhere,
keep each surface's UI (the backlink builder explicitly KEEPS its simpler inline
`<Select>`-swap form) — the backlink filter surface now projects through the canonical
`FilterPredicate` model with zero UI change and a byte-identical emitted `BacklinkFilter[]`.
Built in `wt-fbacklink`, adversarially reviewed.

## Shipped

PR `refactor/filter-model-fbacklink-1646`:

- **#1646 (backlink surface)** — `AddFilterRow.handleApply` now emits
  `onApply(projectThroughCanonical(filter))` where `projectThroughCanonical =
  canonicalToBacklinkFilter(backlinkFilterToCanonical(filter))`, falling back to the input
  if canonical returns null. The inline-form UI is untouched.
  - **Made `backlinkFilterToCanonical` lossless** (`src/lib/filters/model.ts`): the
    foundation version (#1850) collapsed `PropertyText` non-Eq ops to Eq, dropped
    `PropertyNum`'s op, and coerced `PropertyDate` to Text — a documented non-live gap the
    round-trip can't tolerate. Replaced with an op-faithful `comparePredicate` (CompareOp
    ↔ PropertyPredicate 1:1) + variant-faithful `PropertyValue` (Text/Num/Date), so the
    leaf type is fully recoverable.
  - Added the inverse `canonicalToBacklinkFilter` (total over the backlink allow-list).
  - **`none`→`PropertyIsEmpty{key:'todo'}` preserved exactly** (the #1647 fix): emits
    `PropertyIsEmpty` → canonical `NotExists` → back to `PropertyIsEmpty`, never a literal
    `value='none'` match (guarded by a `not.toEqual` assertion).
  - **No inverse ambiguity:** status/priority route through `PropertyText` leaves (the
    builder's actual output) → canonical `property`; the wire-type's `TodoState`/`Priority`/
    `DueDate` leaves round-trip independently through their own kinds.
  - **Deferred** (pass-through): compound `And/Or/Not` + `Ref` property values (never
    builder-emitted) return null and fall back to the input.

## Review pass

Reviewer (APPROVE, zero behavior change): the only behavioral change in `AddFilterRow.tsx`
is the emit routing; `projectThroughCanonical` is the identity for every builder-emittable
category (the pre-existing UI-driven `BacklinkFilterBuilder.test.tsx` shapes stay green —
the real parity proof). `none`→PropertyIsEmpty preserved (mutation-guarded). The
`backlinkFilterToCanonical` losslessness change is correct (exhaustive CompareOp switch,
faithful PropertyValue variants; the old null→`Text:''` and Date→Text coercions are gone)
and no other surface relied on the old lossy behavior (grep: one non-test caller). Inverse
non-ambiguity confirmed. 173 tests, tsc + oxlint clean; only 4 files changed.

## Notes

- This completes the #1646 representation unification across all four surfaces (graph,
  search, PageBrowser, backlink), each keeping its own UI per the maintainer decision. The
  compound `And/Or/Not` layer remains the one documented follow-up. #1646 can close once
  all four surface PRs merge.
- Branch rebased onto post-search `origin/main` (model.ts merge keeps search + backlink
  helpers).
