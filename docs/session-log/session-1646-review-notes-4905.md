# Session 1646 — review notes from #4905, and a fix that was wrong twice

Two non-blocking notes on the link-graph backfill. Both were right, and the
second one took two attempts because the first fix repeated the mistake it was
correcting.

## The rollups belonged to the caller

`backfill_block_links` rebuilt `page_link_cache` and
`pages_cache.inbound_link_count` itself, after its own transaction had
committed — marker included. So a rebuild that failed for any ordinary reason
(lock contention at boot, IO) left the pass recorded as done and the two
rollups wrong, with nothing to retry it: the marker is what retires the scan,
and it was already set.

They are now the caller's, handed to the materializer's background queue at
the `lib.rs` boot site the way `repair_misfiled_tag_spaces` hands off its
follow-ups. A shed or failed task persists to `materializer_retry_queue`; an
`await` in the backfill did not. It also takes two rebuilds off the boot path.

## "Did the graph move" is not a question `COUNT(*)` can answer

The rebuild was gated on `added > 0`, where `added` is a NET count. A vault
that drops one stale edge and adds one missing edge nets zero, so the rollups
were skipped while `page_link_cache` kept an edge that no longer existed. A net
deletion did the same through `saturating_sub`.

The first fix changed the gate to `after != before`. That is the same mistake
in a different arrangement — one edge out and one edge in leaves the row count
identical, so it reports "unchanged" for a vault whose graph just changed. The
new test caught it: written to pin the net-zero case, it went red against the
fix meant to handle it.

No arithmetic over `COUNT(*)` can distinguish a swap from a no-op, so the
signal is not a count at all. `LinkBackfill::ran` says whether the pass
actually scanned — false only when the marker had already retired it. The scan
happens once per vault, so rebuilding the rollups unconditionally on that one
occasion is both always right and cheaper to reason about than any delta.

## Verification

Four tests green unfiltered, whole workspace compiled. The net-zero test was
falsified against a `cp` backup by reverting `ran` to `after != before`: it
reddens that test and only that test, then restored `cmp`-identical.
