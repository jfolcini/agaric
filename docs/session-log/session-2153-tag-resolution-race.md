# Session 2153 — an open tag search re-resolves after a sync

The real-backend lane found this on its first run of `sync-refresh.e2e.ts` (#5609). An open search for `tag:#name` stayed at "No results" after a pull brought that tag in. The tag and the tagged block were both in the backend.

**Cause.** `invalidateNameCaches()` fires twice per pull: on `sync:complete`, which arrives before the cache rebuild, and on `blocks:changed`, after it.
- `useTagResolution` reacted only by dropping names it had cached as "not found".
- The first invalidation started a lookup that read `tags_cache` before the rebuild committed.
- The second invalidation arrived while that lookup was still in flight. With nothing yet cached to drop, it changed nothing.
- The stale lookup then cached "not found", and no later invalidation retried it, so the search was stuck.

**Fix.** Every name change now bumps a `reloadKey` that the lookup effect depends on. A lookup in flight is cancelled and re-issued. Resolved ids stay as they are, so a sync does not put the search back on hold. This is the `reloadKey` pattern that `useBlockTags` and `usePageAliases` already use.

**Test.** Two orders, in `useTagResolution.test.ts`:
- **Race order:** the name change lands while the re-lookup is in flight. It fails without the fix, with the stuck `{ tagIds: [], hasUnresolved: true }` state.
- **Control order:** the change lands after the re-lookup settled. It passes either way, so the test isolates the race.

Removing the `cancelled` guard in `settle` also fails the race order: the stale answer overwrites the fresh one.

Checked the other subscribers to the same signal (`useBlockTags`, `TagList`, `use-block-resolve`, `TagFilterPanel`). Each re-issues or sequences its requests already. `usePageAliases` re-issues, but has no `cancelled` guard on its fetch, so a late older answer could overwrite a newer one. That is a different shape and was left alone.

Ran:
- `npx vitest run src/components/SearchPanel/__tests__/ src/components/__tests__/SearchPanel` (195);
- `npm run typecheck`;
- `oxlint`;
- `oxfmt --check`.
