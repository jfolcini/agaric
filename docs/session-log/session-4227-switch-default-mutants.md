# Session 4227 — the redundant switch defaults #6848 left (#6841 follow-up)

The diff-scoped mutation lane on #6848 reported survivors on the case labels its `switch-exhaustiveness-check` burn-down stacked above an unchanged `default`: a mutated label still lands in `default`, so nothing can catch it. #6848 merged before the fix, so it is this follow-up.

## What shipped

- **`default` dropped** where the stacked labels already cover the declared type and the value is produced or validated in-app (sync state through `mapBackendState`, sort preferences against `VALID_SORT_BY`, graph filters through `parseFilterPredicates`, query trees through `isFilterExpr`, `DiffTag` from a closed Rust enum). The lint rule now catches a new variant at those switches.
- **`default` kept**, with a one-line reason, where a value outside the type really arrives: user-typed `type:` and `operator:` text cast to a union, and saved-view or `v2:` leaves checked only to be objects. Switches over an open `string | null` keep theirs, since it is the only branch for other strings.
- **Tests** pin each formerly absorbed variant: every non-graph kind through `canonicalToGraphFilter` is `null`, `sortAgendaBlocksBy` with `'date'` and `undefined` sorts date-first, and `filterSummary` names And, Or, DueDate and SourcePage `filter` instead of an impossible `'Unknown'` cast.

## What ran

- `node scripts/run-mutation.mjs` before and after: filters-model 15 survivors and 2 no-coverage to 0 and 0; agenda-sort's `case 'date'` survivor killed (its other survivors predate #6848); inline-property-parse unchanged.
- `npm run typecheck`, type-aware oxlint (0 errors), vitest over every touched module and its neighbours.
- The FilterPillRow case was shown red by renaming one label.
