# Session 1091 — /batch-issues loop: canonical filter-model foundation, batch 38 (2026-06-20)

## What happened

Foundational first slice of the HIGH-severity architectural issue #1646 (four
independent filter representations + two interaction models), built in worktree
`wt-1646` and adversarially reviewed. Deliberately NOT a big-bang rewrite: this lands
the canonical model + a one-surface proof + a migration plan, and surfaces the design /
UX-convergence decisions for maintainer sign-off.

## Shipped

PR `refactor/unify-filter-model-1646`:

- **#1646 (foundation)** — investigated all four filter representations (backlink
  `AddFilterRow`, PageBrowser `AddFilterPopover`, graph `GraphFilterBar`, search
  `searchFilterParams`) and found a fifth (agenda). Key finding: `FilterPrimitive` is
  already the de-facto unified backend vocabulary.
  - **Canonical model** (`src/lib/filters/model.ts`): a `FilterPredicate` discriminated
    union keyed on `kind` (deliberately distinct from the legacy `type`-keyed wire
    shapes so they coexist), one variant per category, subsuming all four vocabularies;
    a `FILTER_SURFACE_ALLOWLIST` + `surfaceSupports()`; and lossless conversion helpers
    (graph both-ways; `backlinkFilterToCanonical`; `filterPrimitiveToCanonical`).
  - **One-surface proof = graph** (lowest blast radius — fully client-side, no backend/
    IPC): `GraphFilterBar` now persists/reads filters as canonical `FilterPredicate[]`
    and projects back to `GraphFilter[]` at the localStorage boundary;
    `GraphView`/`applyGraphFilters`/the `GraphFilter[]` prop are untouched. Legacy
    localStorage values are read via a back-compat passthrough and re-saved canonically
    (storage key unchanged — no user loses saved graph filters). The other three
    surfaces are untouched and working.
  - **Migration plan** (`docs/filters/CANONICAL-MODEL-MIGRATION.md`): the four-rep
    comparison, per-surface allow-lists, documented deferrals (compound `And/Or/Not`,
    `HasParentMatching`, `Snippet`), and the migration order
    (Search adapter → Pages vocab → Backlink vocab → **Backlink interaction (UX)** →
    compound layer).

## Decisions flagged for the maintainer

1. Canonical discriminant `kind` (not `type`). 2. `FilterPrimitive` as the model
backbone. 3. Compound `And/Or/Not` layer deferred to a later PR (leaf-only foundation).
4. **Backlink builder → categorized popover is a visible UX change** (migration step 3b)
that needs your visual review — confirm you want the backlink *interaction* converged
vs keeping its inline form on the unified vocabulary. 5. Graph localStorage silently
migrated to canonical predicates (back-compat read; no data loss). 6. The 5th (agenda)
representation — fold into scope later?

## Review pass

Reviewer (APPROVE, ship-ready): the canonical⇄`GraphFilter` round-trip is lossless for
every dimension the UI can build (14 cases); the existing `GraphFilterBar` persistence
tests write OLD-shape localStorage and still hydrate correctly under the new read path
(the `'kind' in e` detector routes legacy→passthrough, canonical→project; key unchanged)
— no user data loss; backlink (13) + FilterPrimitive (19) leaves map losslessly and the
deferred compound/recursive categories return `null` and are test-pinned; the other 3
surfaces + all of `src-tauri/` are byte-for-byte untouched (purely additive). 158 tests,
tsc + oxlint clean. Two non-blocking cosmetic notes (one-time tag-pill reorder on first
read; backlink non-Eq text-op fallback, non-live) left as future-work.

## Notes

- Files: `src/lib/filters/{model.ts,__tests__/model.test.ts}` (new),
  `src/components/graph/GraphFilterBar.tsx` (+test),
  `docs/filters/CANONICAL-MODEL-MIGRATION.md` (new). No backend / other-surface change.
- Branch base is current `origin/main`.
