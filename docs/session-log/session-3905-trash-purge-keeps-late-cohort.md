# Session 3905 — Auto-purge keeps a trash cohort that holds a block created after the delete

#6543: device A deletes page P; device B, not yet synced, writes C under P. After the exchange C sits in P's trash cohort on both devices, dated at A's delete, and `tombstone_purge` hard-deleted it with the cohort 90 days after that date, possibly days after C arrived. The two-device test reproduced this before the fix: C took P's `deleted_at` on both sides and the purge took P, its old child and C.

`tombstone_purge`'s candidate query now leaves out:
- every row sharing `deleted_at` with a "late" block, meaning a deleted block whose ULID prefix (the creation ms) is newer than its own `deleted_at`. This keeps the whole cohort, the late block included.
- every ancestor of a late block, because purge cascades down the subtree whatever the descendants' `deleted_at`. This covers a late block in an older nested cohort under a page deleted later.

The change only removes candidates, so auto-purge never deletes more than before. The ULID floor for a `deleted_at` is computed in SQL (Crockford base32 of the ms). Ids that are not 26 characters long carry no creation time and are never late. The existing purge tests seed ids like `AGED0001`, and without that clause five of them go red.

`tombstone_purge_before(cutoff_ms)` is the seam the two-device test uses to put the clock past the window. Back-dating `deleted_at` would make every block look late, because real commands mint ULIDs at the current time.

The issue placed the test in `agaric-sync`'s `loro_sync_tests.rs`. `tombstone_purge` lives in the app crate, which that crate cannot reach, so both tests are in `src/maintenance.rs`.

Not covered: an edit to a block that existed before the delete, a purge that already ran before the sync, and a writer whose clock runs behind the deleter's, so the late block's ULID predates the delete.

The `.sqlx` cache is regenerated for the new `query!`.

`purge_candidates_are_a_subset_of_the_pre_6543_query_and_late_test_is_exact` keeps the old query as an oracle: new is a subset of old, equal when no block is late, and the late test flips exactly one ms after `deleted_at`.

Ran: targeted nextest on the purge tests, red first, then each new clause falsified; `cargo check`, clippy and fmt across the workspace.
