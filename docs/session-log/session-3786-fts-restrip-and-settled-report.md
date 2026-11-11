# Session 3786 — Re-strip stale FTS rows once, and let the integrity check settle

The maintainer's integrity check reported 27 `fts_blocks.stripped` divergences after the 0.23.0 upgrade (#6488). The strip changed in #6330, #6348 and #6421, the oracle folds with the new strip, and boot rebuilt the index only when it was empty, so every row indexed before the upgrade kept the old text.

## What shipped

- A completed full FTS rebuild (`rebuild_fts_index`, `rebuild_fts_index_split`) writes `FTS_STRIP_MARKER` (`repair.fts_strip.v1`) to `app_settings` after its last chunk commits. Boot's `schedule_fts_rebuild_if_due` enqueues `RebuildFtsIndex` while the marker is absent, as well as on the old empty-index condition. The rebuild runs through the serial background queue, so it cannot interleave with an `UpdateFtsBlock`.
- `settled_reconciliation_report` flushes the foreground queue and fires the pending inbound-sync rebuild, then drains the background queue before the oracle reads, so work in flight is not reported as a divergence.

## Decisions and traps

- The marker is written by the rebuild, not by the boot code that enqueues it: `RebuildFtsIndex` is not persisted to `materializer_retry_queue` on failure, so a marker written at enqueue time would retire a rebuild that never ran.
- The bug-bundle log allowlist (`STABLE_MESSAGES`) carries the boot line, so its wording moved with it.

## Tests

Red first, on the predicted assertion each:

- `boot_cache_gating_tests::a_row_stripped_by_an_older_rule_is_restripped_once_6488`: a seeded old-strip row is re-stripped at boot, and the second boot runs only the flush barrier.
- `commands::reconciliation::tests::a_pending_inbound_rebuild_lands_before_the_report_6488`: a corrupted `pages_cache` count with an armed inbound rebuild reports clean.
