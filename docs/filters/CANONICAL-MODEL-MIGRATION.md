# Canonical filter model — migration plan (Issue #1646)

> **Status:** foundational slice landed (canonical model + allow-lists +
> conversion helpers + graph surface migrated as proof). The remaining three
> surfaces still emit their legacy wire shapes unchanged. This doc is the plan
> for converging them. **Several decisions below need maintainer sign-off — see
> "Decisions for maintainer review".**

## Problem

The same user concept — *filter by tag / status / priority / property / date /
block-type* — is implemented across **four independent type vocabularies** and
**two unrelated builder interaction models**:

| # | Surface | File(s) | Vocabulary (TS type) | Interaction model | Emits / consumes |
|---|---------|---------|----------------------|-------------------|------------------|
| 1 | **Backlink builder** | `src/components/backlink-filter/AddFilterRow.tsx` (+ `categories/*`) | `BacklinkFilter` (`bindings.ts`) | `<Select>` picks a category → inline form swaps in → Apply | `BacklinkFilter[]` → backlink query IPC |
| 2 | **Pages browser / advanced query / search-compound** | `src/components/PageBrowser/AddFilterPopover.tsx` | `FilterPrimitive` / `FilterExpr` (`bindings.ts`) | Categorised **Add-Filter popover**: boolean facets add on click, value facets open an inline editor inside the popover | `FilterPrimitive` chips → advanced-query / pages IPC |
| 3 | **Graph view** | `src/components/graph/GraphFilterBar.tsx` | `GraphFilter` (`graph-filters.ts`) | Popover + `<Select>` dimension picker → multi-checkbox value list → Apply | `GraphFilter[]` → **client-side** `applyGraphFilters`, persisted to localStorage |
| 4 | **Search query-string** | `src/components/SearchPanel/searchFilterParams.ts` (+ `src/lib/search-query/`) | `AstFilterProjection` → `SearchFilterParams` | Query-string **AST** (typed in a text box, parsed to chips) | `SearchFilterParams` (loose IPC fields) → FTS search IPC |

### Per-category support matrix (which surface offers which category)

| Category | Backlink (1) | Pages (2) | Graph (3) | Search (4) |
|----------|:---:|:---:|:---:|:---:|
| Tag (by id) | ✅ `HasTag` | — | ✅ `tag` | — |
| Tag (by name) | — | ✅ `Tag` | — | ✅ `tag:` |
| Tag prefix | ✅ `HasTagPrefix` | — | — | — |
| Status / state | ✅ `TodoState` | ✅ `State` (multi) | ✅ `status` (multi) | ✅ `state:` / `not-state:` |
| Priority | ✅ `Priority` | ✅ `Priority` | ✅ `priority` (multi) | ✅ `priority:` / `not-priority:` |
| Property | ✅ `PropertyText/Num/Date/IsSet/IsEmpty` | ✅ `HasProperty` | — | ✅ `prop:` / `not-prop:` |
| Due date | ✅ `DueDate` | ✅ `DueDate` | ✅ `hasDueDate` (bool) | ✅ `due:` |
| Scheduled | — | ✅ `Scheduled` | ✅ `hasScheduledDate` (bool) | ✅ `scheduled:` |
| Created range | ✅ `CreatedInRange` | ✅ `Created` | — | — |
| Last edited | — | ✅ `LastEdited` | — | — |
| Block type | ✅ `BlockType` | ✅ `BlockType` (multi) | — | — |
| Path glob | — | ✅ `PathGlob` | — | ✅ `path:` / `not-path:` |
| Source page | ✅ `SourcePage` | — | — | — |
| Space | — | ✅ `Space` | — | — |
| Contains / text | ✅ `Contains` | — | — | (FTS query itself) |
| Regex / case / whole-word | — | ✅ (`Regex`/`CaseSensitive`/`WholeWord`) | — | — |
| Links-to / linked-from | — | ✅ | — | — |
| Has-backlinks (bool) | — | — | ✅ `hasBacklinks` | — |
| Orphan / Stub / No-inbound | — | ✅ | — | — |
| Exclude templates | — | — | ✅ `excludeTemplates` | — |
| Compound And/Or/Not | ✅ (wire) | ✅ `FilterExpr` | — (list AND) | — (field AND) |

**Key observation:** `FilterPrimitive` (surface 2) is already the de-facto
*unified backend vocabulary* — its own doc comments note that backlink leaves
"route to" its shapes. It is the most complete of the four. The canonical FE
model is therefore largely a **frontend mirror** of `FilterPrimitive`, widened
to also absorb the backlink-only (`tagPrefix`, `sourcePage`, `contains`) and
graph-only (`hasBacklinks`, `excludeTemplates`) categories.

### Shared pieces already in place (build on these, don't re-invent)

- **#1647** landed `src/components/filters/forms/` — `FilterValueSelect`
  (parametrised single-select) + `stateVocabulary.ts` (the *single* canonical
  task-state value set, shared by search State and backlink Status). The
  canonical model's `status` predicate values draw from this same vocabulary.
- **#1426** — the deep **TagComposer** (`src/components/filters/TagComposer.tsx`)
  is the rich tag-expression builder; the canonical `tag` / `tagPrefix`
  predicates are the leaf vocabulary it should ultimately emit.
- **#1472** — nested **TagExpr** IPC: the backend already accepts a recursive
  tag expression. The canonical model's tag predicates are the leaves of that.
- The pages popover's `add-filter/{editors,menu,vocab}` modules are the reusable
  **categorised-popover** building blocks the convergence target reuses.

## The canonical model (landed)

`src/lib/filters/model.ts`:

- **`FilterPredicate`** — a discriminated union keyed on **`kind`** (deliberately
  *not* `type`, to stay distinct from the four legacy wire shapes that all use
  `type`). One variant per conceptual category; every variant of all four
  vocabularies is **losslessly representable** (proven by the round-trip /
  one-way tests in `src/lib/filters/__tests__/model.test.ts`).
- **`FILTER_SURFACE_ALLOWLIST`** — `Record<FilterSurface, FilterPredicateKind[]>`
  declaring exactly which kinds each surface may build/emit, derived from each
  surface's *current* capability set so migration is behaviour-preserving.
  `surfaceSupports(surface, kind)` is the membership check.
- **Conversion helpers** (additive; legacy wire types unchanged):
  - Graph: `graphFiltersToCanonical` / `canonicalToGraphFilters` — **lossless
    both directions** (the migrated proof).
  - Backlink: `backlinkFilterToCanonical` — lossless for every non-compound leaf.
  - Pages/search: `filterPrimitiveToCanonical` — lossless for every non-recursive
    leaf.

### Documented gaps (intentional, tracked here)

- `backlinkFilterToCanonical`'s `PropertyText` op mapping only round-trips
  `Eq`/`Ne` faithfully; `Lt/Gt/Contains/StartsWith` fall back to `Eq` because
  the builder never emits them today. When a surface starts emitting them, add
  the corresponding canonical text-comparison predicate variants.
- `HasParentMatching` (recursive `FilterExpr`) and `Snippet` return `null` from
  `filterPrimitiveToCanonical` — they have no flat canonical category yet. The
  compound layer (below) is the place to add them.
- **Compound `And`/`Or`/`Not`** are not yet in the canonical model. Surfaces 1
  and 2 manage composition as a flat list (implicit AND) or a `FilterExpr` tree.
  A canonical `FilterGroup` wrapper (`{ op: 'and'|'or'|'not'; children: … }`) is
  **deferred to a later PR** so the foundational slice stays a pure leaf model.

## Migration order (remaining surfaces)

Proof done: **Graph** — chosen because it is fully **client-side** (no backend /
IPC), so projecting through the canonical model at the localStorage persistence
boundary changes no wire contract and is exhaustively round-trip-testable. Its
`GraphFilter[]` prop, `applyGraphFilters`, and `GraphView` are untouched.

Recommended order for the rest (least → most blast radius):

1. **Search (surface 4)** — *adapter only, no UX change.* Insert the canonical
   model between the AST projection and `SearchFilterParams`: have
   `astFilterParams` build `FilterPredicate[]` and a new
   `canonicalToSearchParams` helper emit the existing `SearchFilterParams`. No
   visible change; pure internal convergence. Lowest UX risk after graph.
2. **Pages browser (surface 2)** — *smallest interaction change.* It already IS
   the categorised popover. Migrate its editors to read the canonical
   allow-list (`FILTER_SURFACE_ALLOWLIST.pageBrowser`) and emit canonical
   predicates, with a `canonicalToFilterPrimitive` helper at the IPC boundary.
   The popover UX is the convergence target, so this is mostly a vocabulary
   swap, not a redesign.
3. **Backlink builder (surface 1)** — *the real UX change.* Two steps:
   - **3a (vocabulary):** route its `categories/*` forms' output through
     `backlinkFilterToCanonical` + a new `canonicalToBacklinkFilter`, keeping the
     current `<Select>`-swaps-inline-form interaction. Pure refactor.
   - **3b (interaction, UX):** replace the `<Select>`-swap interaction with the
     shared categorised popover. **This is a user-visible UX change and needs
     the maintainer's visual review before shipping** (it alters the builder's
     look and keyboard flow).
4. **Compound layer** — add the canonical `FilterGroup` wrapper and migrate
   `FilterExpr` (pages advanced) + backlink `And/Or/Not` onto it. Folds in
   `HasParentMatching` and the #1472 nested TagExpr.

After all surfaces project from the canonical model, the per-surface emit
helpers (`canonicalTo{Graph,Search,FilterPrimitive,Backlink}`) are the *only*
places that know a legacy wire shape — a single, testable seam per backend.

## UX-convergence recommendation

The issue recommends converging on the **categorised Add-Filter popover**
(surface 2's interaction) as the one shared builder. **Confirmed** — it is the
better model: it scales to many categories via grouping, supports
click-to-add booleans and inline value editors uniformly, already has
accessible focus management, and is the most-used surface. The graph
`<Select>`-dimension picker and the backlink `<Select>`-swap should both
converge onto it.

**Caveat flagged for maintainer:** migrating the **backlink** builder's
interaction (step 3b) and the **graph** bar's interaction (a later cosmetic
follow-up) from `<Select>` to the popover is a **visible UX change**. The
vocabulary unification (this PR + steps 1, 2, 3a) is safe to land without visual
review; the *interaction* changes (3b and graph-bar cosmetic) should be gated on
the maintainer seeing the new builder in the real app.

## Decisions for maintainer review

1. **Canonical discriminant `kind` (not `type`).** Chosen to avoid colliding
   with the four wire shapes. Confirm this is acceptable naming.
2. **`FilterPrimitive` as the model's backbone.** The canonical model mirrors
   `FilterPrimitive` and widens it. Confirm we standardise on it rather than
   inventing a from-scratch vocabulary.
3. **Compound layer deferred.** The foundational slice is leaf-only; `And/Or/Not`
   - `HasParentMatching` come in a later PR. Confirm this phasing.
4. **Backlink interaction → popover is a UX change (step 3b).** Needs visual
   review. Confirm you want the backlink builder converged onto the popover at
   all (vs. keeping its inline-form interaction but on the unified vocabulary).
5. **Graph persistence format changed to canonical predicates.** Existing
   localStorage values (legacy `GraphFilter[]`) are read through a
   back-compat passthrough and re-persisted in canonical form on next write.
   Confirm this silent one-time migration of stored filters is acceptable.
6. **Adjacent 5th representation.** `src/lib/filter-dimension-metadata.ts` +
   `agenda-filters.ts` (the **agenda** filter UI) is a *fifth* vocabulary not
   named in #1646. Recommend folding it into this convergence in a later phase —
   confirm whether to expand scope to include it.
