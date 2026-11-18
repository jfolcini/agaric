# Session 4343 — page header's property select reads definitions through the shared query

Fix #6946: `PagePropertyTable` read the space's property definitions in a plain `useEffect`, outside `propertyDefsQueryKey`, so `invalidatePropertyCaches()` and the change feed (#6545) never refreshed the header's select.

`useSpacePropertyDefs.ts` now also exports `useSpacePropertyDefList`, the same query (`propertyDefsQueryKey`, every page of `listAllPropertyDefs`) as a list. `PagePropertyTable` reads it, and its two local definition writes (a definition created in the header, options edited there) go through `queryClient.setQueryData` on that key, so the block views see them at once too. Loading and error reporting come from the query; the per-page `definitionsLoading` state is gone.

Tests: a vitest case in the #5287 block (definition options edited behind the table, then `invalidatePropertyCaches()`), and `e2e/page-header-select-options.spec.ts` (options edited over IPC while the page is open; the mock's change feed invalidates). Both shown red against origin/main's component. Ran: typecheck, oxlint, vitest over `src/components/pages`, `src/hooks`, `src/components/query`, `BlockInlineControls`.

Other readers outside the query key, left as they are: `BlockPropertyDrawer` (reads on open; a sheet), `PropertyDefinitionsList` (Settings, the writer; reloads on mount), `QueryBuilderModal` and `AddFilterPopover` (read on open), `FilterSortControls` (own key `backlinkSortPropertyDefs`, `staleTime: 0`, refetches on mount).
