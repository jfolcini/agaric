# Session 1655 — twenty-one wrappers off the legacy surface

`@/lib/tauri` is frozen by the `tauri-import-baseline` ratchet and only
shrinks. This slice takes it from **38 importers to 13**.

## What went

- `src/lib/tauri/properties.ts` — deleted, seven PURE wrappers.
- `src/lib/tauri/queries.ts` — deleted: `runAdvancedQuery` plus the three
  SCOPE ones. Its hand-written `ProjectedAgendaEntry` went with it; call sites
  use the generated `ActiveProjectedAgendaEntry`, which is structurally
  identical.
- `src/lib/tauri/blocks.ts` — reduced to `createBlock` alone; nine PURE and one
  SCOPE gone.

Every SCOPE wrapper's `toSpaceScope(...)` now happens at the call site, and
every `?? null` default was carried over positionally, checked against
`git show HEAD:` of each deleted wrapper. No numeric `limit:` literals appear:
call sites take `paginationLimit` / `listBlocksLimit` /
`listProjectedAgendaLimit` or a named cap (invariant 10).

## What stayed, and why

`createBlock` carries the H-3a page/space invariant and the #2849 client-ULID
contract in its doc comment — the issue's own exclusion, and it wants a
dedicated review rather than a mechanical sweep.

`searchBlocks` / `searchBlocksPartitioned` are the one place deleting a wrapper
would be a security change: `SearchFilter.scope` is `#[serde(default)]` over a
`SpaceScope` whose `Default` is `Global`, the opposite of the wrapper's
`requireActiveScope`. Removing them turns a cross-space leak into a missing
object key. #4412 kept them deliberately; so does this.

`logFrontend` is not a pure pass-through: `logging.ts` runs
`setLogBackendSink(logFrontend)` as an import-time side effect, live only
because something still imports the barrel. Retiring it means rehoming that
registration, which is a behaviour change.

Of the 13 remaining baseline entries, nine are held by those four wrappers.
**Four are held by nothing but the barrel's type and `safe-limit` re-exports**
— `useTagResolution.ts` and `FilterHelperPopover.tsx` (`paginationLimit`),
`GraphView.helpers.ts` (`PageHeading`), `vault-import.ts`
(`BibliographyFormat`, `VaultFile`). Not wrappers, so out of this slice, but
free wins for whoever drives the baseline to zero.

## A test that could not fail

Choosing a falsification target turned one up: `UnfinishedTasks.test.tsx`
switches spaces in two tests to drive effect re-runs, but never asserted the
scope reaching the IPC. Dropping the scope argument would have leaked another
space's overdue tasks into the panel and reddened nothing.

Pre-existing — the wrapper used to supply the scope, so no test had to watch
it — and exactly what this migration moves to the call site. Closed here with
an assertion on both arms (active space, and global when there is none), shown
red by dropping the scope: 1 failed, 49 passed.

## Falsification

`TrashView.tsx`'s migrated SCOPE call, `toSpaceScope(currentSpaceId)` →
`toSpaceScope(null)`: 7 red of 101, including the two that exist to catch a
cross-space leak ("never includes another space's trashed block id when
emptying / restoring"). Restored from the copy, `cmp` identical, 101 passed.

## Verification

`npm run typecheck` clean, `npx knip` clean,
`node scripts/check-tauri-import-baseline.mjs` reports 13 with no new
importers and no stale entries, full vitest 825 files / 18967 passed. The test
count falls because `tauri.test.ts` lost 17 wrapper describes (1053 → 438
lines), each replaced by a note saying where the coverage now lives.
