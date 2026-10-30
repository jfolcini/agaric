# Session 3192 — Page mode's batch reads probed at its cap

#5691's backend box, as the maintainer readjusted it: probe the batch reads page mode leans on at the size of the largest page it opens, `PAGE_MODE_BLOCK_CAP` (1000), and at twice that, since the cap may rise as far as measurements allow.

**What page mode reads.** On open and again after every save (`bringIn`), page mode calls four batch reads: `load_page_subtree` (the store's `load`), `get_batch_properties` and `list_attachments_batch` (`readPageFit`), and `batch_resolve` (`resolveLinks`). The save's writes are per-block commands with their own probes. Before this change these reads were probed only at a journal day's size (inside `journal week open`), `load_page_subtree` at 500 blocks and `batch_resolve` at 50 ids.

**What changed.** `interactive_slo.rs` seeds a page of 1000 and one of 2000 blocks in the 100K vault, each block linking a background block, with a property on every 5th, a task on every 10th and an attachment on every 20th. Each read is timed per size and reported through `report_measurement_only` until `bench-slo` has measured it; an untimed shape probe asserts the exact count each read answers for.

**Trap for raising the cap.** Every batch read rejects more than `MAX_BATCH_BLOCK_IDS` (1000) ids, and `readPageFit` and `fetchAndCacheLinks` send a page's ids in one call. So page mode cannot open a page past 1000 blocks until those callers chunk; the 2000-block probes time the reads as two calls of 1000, as a chunking caller would. `load_page_subtree` has its own cap of 10,000.

**Bug found under today's cap.** `fetchAndCacheLinks` sends every uncached link target on the page at once, so a page whose blocks link more than 1000 distinct targets gets a `Validation` refusal from `batch_resolve`, logs a warning and resolves none of those chips. Block mode shares the call. Fixed in a separate PR.

**Suites:** clippy `--all-targets -D warnings` and fmt locally. The seeders and timings run only in CI's `bench-smoke` and `bench-slo` lanes, dispatched on this branch; this PR merges on their result.
