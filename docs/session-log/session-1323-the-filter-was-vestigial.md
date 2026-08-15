# Session 1323

## The filter was vestigial

`rederive_page_and_space_ids` is the entirety of a move's `page_id` maintenance — #2200 dropped
`RebuildPageIds` from that arm on the grounds that the in-tx walk reaches the same state. Both
members of its descendant CTE filtered `deleted_at IS NULL`, so a soft-deleted descendant of a
moved root kept its pre-move page indefinitely (#3919).

The interesting part is not the bug. It is how much evidence had accumulated around it without
anyone removing it.

- The function's own rustdoc claimed it reaches the **same** state a full `RebuildPageIds` +
  `rebuild_space_ids` would. Both authorities — `DESIRED_PAGE_ID_SQL` and
  `rebuild_space_ids_impl` — have no `deleted_at` filter. The claim was simply false.
- `restore_all_deleted` carries a hand-rolled `page_id` backfill whose comment names this exact
  bug. Somebody already paid for a workaround on one path out of many.
- An existing test recorded the staleness as a **setup precondition**. The bug was load-bearing
  in a test, which is the most durable way to make one permanent.
- `reconciliation_oracle.rs` states outright that its ownership fold deliberately does not
  consult `deleted_at`, "because production derives `page_id` for tombstones too, and a rebuild
  that skipped them would report a divergence on every soft-deleted block". So the code was in
  violation of the repo's own written oracle spec, and the spec said so.
- The filter's stated justification was that a conflict copy inherits `parent_id` from the
  original. `blocks.is_conflict` and every piece of conflict-copy machinery were deleted some
  time ago. The justification referenced a concept that no longer exists.

Five independent signals, one of them the function's own documentation contradicting its own
body. What was missing was not evidence but the question — nobody asked whether the filter was
still for anything.

### Removing a filter widens an UPDATE, so the review swept the readers

The right check on "drop a `WHERE` clause" is not "do the tests pass" but "who can now observe a
different value". Every read of `page_id`/`space_id` that can see a tombstone was enumerated:

- **Cannot observe it**: the pages-cache roll-up, the page-link cache count and sweep, the
  block-links reindex, agenda, FTS, tags, `resolve_block_space` — all filter `deleted_at IS NULL`
  on the source row. The builder's claim that the stale row was wrong for `inbound_link_count`
  was **false**, and was corrected rather than left in as a plausible-sounding extra reason.
- **Can observe it, and the new value is the right one**: the space-scoped trash list, which
  reads `space_id` over `deleted_at IS NOT NULL` rows — after a cross-space move a tombstone now
  reaches the destination's trash immediately instead of at the next lifecycle event; the
  delete/restore cohorts handed to `distinct_pages_for_blocks`, which previously refreshed the
  *old* page's counts on restore.
- **The one that had to be chased**: purge routing resolves a soft-deleted block's space to pick
  a LoroDoc. A cross-space move now re-stamps the tombstone, so purge routes to the destination
  doc. But cross-space moves take the SQL-only fallback in the engine anyway, so the change makes
  tombstones behave *identically to their live siblings* rather than differently.

The conclusion is stronger than "safe": it converts a function documented as equivalent, and
silently not, into one that actually is.

### Two claims softened because they were bigger than the evidence

The builder said the fix made the `restore_all_deleted` backfill unnecessary. It made it
redundant *for the move*. That backfill is a whole-table fixpoint that also covers drift the
in-tx walk cannot reach — anything past its depth cap, replayed remote ops, crash residue. The
comment now says which of those it is.

Two comments in `crud.rs` still asserted the old behaviour after the diff falsified it, and one
of them carried the dead conflict-copy justification. A change that makes a comment false and
leaves it standing has moved the bug rather than fixed it.

### Trading a panic for a test that fires deterministically

`SetBlockPageId` carried a `debug_assert!` whose premise named the create arm as the only enqueue
site. The retry sweeper is a second one (#3909), so the premise was wrong.

The choice was to re-derive in the retry path or to downgrade the assert. Re-deriving would hand
the incremental arm the power to write NULL, contradicting #3908's authority argument, which had
just landed. So: the assert becomes a field on the `tracing::error!` that already fires
unconditionally on the same condition — the release signal strictly increases, and only the
debug-mode panic is traded away.

What justifies the trade is not the log line. It is #3920: a sweep over all thirteen `OpType`s ×
four hints × three move states, pinning that the create arm is the *only* dispatch-site enqueue,
with a catch-all-free `match` as a compile-time tripwire. That fires deterministically at test
time on the change that would invalidate the reasoning, instead of waiting for a runtime shape to
occur in a debug build. And the old `#[should_panic]` test aborted before the durable
`RebuildPageLinkCache` obligation — the mechanism that actually rescues the stranded rows — could
be observed. It is now asserted.

The honest cost, recorded because the review would not let it pass silently: `moved_between_pages`
is provably a constant `true` at its only use site, and no test pins it. Deleting the field
reddens nothing. It is the weakest line in the diff, and it is weak in exactly the way this log
keeps arguing against — a value that looks like information and distinguishes nothing.

### Two proptests that pass at 94% of their budget

`b4_two_peer_snapshot_exchange_converges_sql` and `compute_reverse_is_deterministic` timed out in
the full run and passed in isolation at 113s and 53s against 120s and 60s budgets — unloaded.
Unrelated to this diff, but worth writing down with the numbers attached: a test that needs 94% of
its timeout on an idle machine is not passing, it is arriving late.
