# Session 2226 — An open tag search misses a peer's new tag (#5255)

The real-backend `sync-refresh.e2e.ts` failed once on PR #5645, which touches
no search or sync code: an open `tag:#marigold` search never listed the
block a paired peer had tagged, through twelve more Syncs. The previous run
of the same code passed.

**Cause.** An app race in `useTagResolution`. A pull publishes two name
changes about 5 ms apart: `sync:complete`, before the `tags_cache` rebuild
commits, and `blocks:changed`, after it. The first starts a re-lookup that
reads the old tag list. That lookup's answer is discarded only by the
resolve effect's `cancelled` flag, which is set when React commits the
second change. When the answer lands in between, it settles the name as
unknown after the subscriber has dropped the unknowns. The effect then has
nothing left to look up. Every later Sync pulls nothing, so nothing refreshes
again, and the search stays empty until it is remounted. The CI log shows
the one pull carrying all the peer's writes and the `tags_cache` rebuild
taking the tag.

**Fix.** The subscriber bumps `nameChangesRef` synchronously. A lookup
started before the bump discards its own answer. `reloadKey` stays, since it
is what re-runs the effect.

**Test.** A vitest case in `useTagResolution.test.ts` publishes the change
and lands the stale answer inside one `act`, before the commit. It was red on
the old code (`hasUnresolved: true`). Removing the new guard reddens it
alone. Removing the `reloadKey` bump reddens it and the existing in-flight
case. The real-backend spec catches this only sometimes, and the mock twin
publishes one event, so neither could be the red test.

**Checked, not changed:**
- `useBlockTags` and `usePageAliases` re-fetch on every bump and cache no
  settled state, so the next fetch overwrites a stale answer.
- `use-block-resolve` already guards with a generation counter.

**Suites:** the Search panel's vitest files, typecheck and oxlint.
