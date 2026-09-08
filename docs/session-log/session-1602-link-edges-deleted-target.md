# Session 1602 — the target half of #4848, and the guard that did two jobs (#4853)

## The divergence

#4848 fixed the SOURCE side: `block_links` keeps a tombstoned source's row, and
the mock dropped it. This is the mirror. `reindex_block_links_conn` applies
`tgt.deleted_at IS NULL` only inside the INSERT
(`agaric-store/src/cache/block_links.rs:537-547`, and the two-pool twin at
`:701-710`); the only DELETE is keyed by `source_id` and the content diff, never
by target liveness.

Verified past the oracle's own comments, in the production dispatch:
`OpType::DeleteBlock` (`agaric-engine/src/materializer/dispatch.rs:1604-1627`)
emits `lifecycle_rebuild_tasks(...)` + `RemoveFtsBlock`, and neither
`FULL_CACHE_REBUILD_TASKS` nor `CONTENT_LIFECYCLE_REBUILD_TASKS` contains
`ReindexBlockLinks`. The one link-shaped member, `RebuildPageLinkCache`, only
ever `DELETE FROM page_link_cache` — it never touches `block_links`. Every other
`block_links` DELETE is a purge path, not a soft delete.

The backend then settled it empirically: it authored
`{"source_id": "B10", "target_id": "B9"}` into `expected.page_links` with B9
tombstoned.

## The guard was doing two jobs, and only one of them overclaimed

#4853's acceptance said to drop the `liveIds` filter. That would have been
wrong. `deriveLinkEdges` does no existence check at all, so `liveIds` was also
keeping DANGLING tokens out — and that half is a real mirror:
`block_links.target_id` is `REFERENCES blocks(id) ON DELETE CASCADE`
(migration 0061), so the table cannot hold a row whose target does not exist.
Deleting the guard outright would have made the mock emit rows the table
cannot contain — trading one divergence for another.

Narrowed instead: `liveIds` → `knownIds`, existence without liveness. No fixture
has a dangling token today, so this is behaviour-identical now and correct
later. The comment says which of dangling / purge / soft-delete each case is.

## Pinning it

New seeds `S9` (page) and `S10` (content under S2), ops
`edit_block S10 → [[S9]]` then `delete_block S9`. Fresh seeds on both ends, per
session 1601's rule: reusing an existing block as target or source would have
moved the `get_backlinks` steps and made the new assertion true for two reasons.

## Falsification

Each against a copy, restored and `cmp`-verified.

- Restore the liveness filter — which is also the pre-change mock, so this
  doubles as "new fixture vs old mock" — RED on exactly the new edge,
  `- "source_id": "B10" / - "target_id": "B9"`.
- Remove the premise (drop `delete_block S9`) — the step moves:
  `- "deleted_at": "DELETED"` → `null`, `- "count": 9` → `8`.
- **The crossed check**, which is what proves the pin is not true for two
  reasons: regenerate `expected` with S9 left LIVE, then run the PRE-change
  mock → 70/70 green with `B10 -> B9` present. So the first mutant's redness
  comes from the tombstone alone, not from the two new blocks existing.

## Read paths

No compensating filter needed, re-verified rather than assumed.
`deriveLinkEdges`' two production consumers both funnel through
`buildPageMetaRow` → `pageLinkStats`, and `buildPageMetaRow` builds
`pageScopeIds` from the page plus its NON-deleted descendants at both call
sites, so a tombstoned target can never be counted. `hasOutbound` gates on
`sourceId` and is untouched. The two test oracles reading `deriveLinkEdges` are
source-side only.

Unlike #4848, which did need one.

## Fixture churn

`CONFORMANCE_UPDATE=1` rewrote 31 unrelated fixtures on each of two runs — the
same trap as sessions 1598 and 1601. Verified semantically identical by parsed
JSON and restored byte-for-byte. This recurs every time that flow runs.
