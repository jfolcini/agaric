# Canonical filter model — migration record (Issue #1646)

> **Status: closed — this is a record, not a live plan.**
>
> #1646 landed the canonical model and then migrated all four filter surfaces
> onto it. Follow-up deep review **#2258** found that three of those four seams
> (search, Pages browser, backlink) round-tripped their wire shape through the
> canonical model and straight back out again — provably the identity for every
> value they produce — so the seams and their converter families were removed
> and those surfaces went back to emitting their wire shape directly.
>
> Today only the **Graph** surface consumes the canonical model at runtime. The
> source of truth for the current scope is the header comment of
> [`src/lib/filters/model.ts`](../../src/lib/filters/model.ts); this file is kept
> for the vocabulary map below and the reasoning behind the scope-down.

## The problem (still true)

The same user concept — *filter by tag / status / priority / property / date /
block-type* — is implemented across **four independent type vocabularies** and
**two unrelated builder interaction models**:

| # | Surface | File(s) | Vocabulary (TS type) | Interaction model | Emits / consumes |
|---|---------|---------|----------------------|-------------------|------------------|
| 1 | **Backlink builder** | `src/components/backlink-filter/AddFilterRow.tsx` (+ `categories/*`) | `BacklinkFilter` (`src/lib/bindings.ts`) | `<Select>` picks a category → inline form swaps in → Apply | `BacklinkFilter[]` → backlink query IPC |
| 2 | **Pages browser / advanced query / search-compound** | `src/components/PageBrowser/AddFilterPopover.tsx` | `FilterPrimitive` / `FilterExpr` (`src/lib/bindings.ts`) | Categorised **Add-Filter popover**: boolean facets add on click, value facets open an inline editor inside the popover | `FilterPrimitive` chips → advanced-query / pages IPC |
| 3 | **Graph view** | `src/components/graph/GraphFilterBar.tsx` | `GraphFilter` (`src/lib/graph-filters.ts`) | Popover + `<Select>` dimension picker → multi-checkbox value list → Apply | `GraphFilter[]` → **client-side** `applyGraphFilters`, persisted to localStorage |
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

**Key observation:** `FilterPrimitive` (surface 2) is the de-facto *unified
backend vocabulary* — its own doc comments note that backlink leaves "route to"
its shapes, and it is the most complete of the four. The canonical model is
therefore largely a **frontend mirror** of `FilterPrimitive`, widened to also
absorb the backlink-only (`tagPrefix`, `sourcePage`, `contains`) and graph-only
(`hasBacklinks`, `excludeTemplates`) categories.

### Shared pieces (build on these, don't re-invent)

- `src/components/filters/forms/` (#1647) — `FilterValueSelect` (parametrised
  single-select) + `stateVocabulary.ts`, the *single* canonical task-state value
  set shared by search State and backlink Status.
- `src/components/filters/TagComposer.tsx` (#1426) — the rich tag-expression
  builder.
- Nested **TagExpr** IPC (#1472) — the backend accepts a recursive tag
  expression; canonical tag predicates are its leaves.
- The pages popover's `add-filter/{editors,menu,vocab}` modules are the reusable
  categorised-popover building blocks.

## What survives today

`src/lib/filters/model.ts`:

- **`FilterPredicate`** — a discriminated union keyed on **`kind`**
  (deliberately *not* `type`, to stay distinct from the four legacy wire shapes
  that all use `type`). One variant per conceptual category, kept intact as the
  target vocabulary for any future consumer.
- **Graph converters** — `graphFilterToCanonical` / `canonicalToGraphFilter`
  (and their list forms), lossless in both directions and load-bearing: the
  graph canonicalises its `GraphFilter[]` and persists the canonical form.
  Round-trip tests live in `src/lib/filters/__tests__/model.test.ts`.

Everything else the original plan introduced — the per-surface converters for
search, Pages browser, and backlink, plus the `FILTER_SURFACE_ALLOWLIST` /
`surfaceSupports` allow-list scaffolding — was removed by #2258 as
zero-production-use.

## Why the other three seams were reverted (#2258)

Each of the three surfaces converted its wire shape *to* a `FilterPredicate` at
the builder and *back* to the identical wire shape at the IPC boundary. Because
neither the builder nor the IPC call ever held the canonical form as working
state, the round-trip was the identity for every value those surfaces can
produce: no behaviour depended on it, and it cost a converter family plus its
tests per surface. Both `searchFilterParams.ts` and `AddFilterPopover.tsx` carry
an inline comment recording this.

The lesson generalises: **a canonical model pays off only when a second
consumer works in the canonical vocabulary.** Round-tripping through it at a
boundary that immediately reverses the conversion is pure overhead.

## What was never attempted

- **Backlink interaction convergence.** Routing the backlink builder's
  `<Select>`-swaps-inline-form interaction onto the shared categorised popover
  is a user-visible UX change and was always gated on the maintainer seeing it
  in the real app. The builder still uses the `<Select>` swap.
- **Compound layer.** A canonical `FilterGroup` wrapper
  (`{ op: 'and'|'or'|'not'; children: … }`) absorbing `FilterExpr`,
  backlink `And`/`Or`/`Not`, `HasParentMatching` and `Snippet` was deferred so
  the foundational slice stayed leaf-only, and never landed. (The unrelated
  `src/components/AdvancedQuery/FilterGroup.tsx` component predates this work
  and builds `FilterExpr` trees directly.)
- **The fifth vocabulary.** `src/lib/filter-dimension-metadata.ts` +
  `src/lib/agenda-filters.ts` (the agenda filter UI) is a fifth representation
  never in scope for #1646.

## If this is picked up again

Reintroduce a surface's converters **together with the consumer that benefits**
— i.e. only when something genuinely reads or manipulates `FilterPredicate` as
working state. Adding a converter pair ahead of that consumer reproduces exactly
what #2258 removed.
