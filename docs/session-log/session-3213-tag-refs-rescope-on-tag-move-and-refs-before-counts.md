# Session 3213 — a tag's space move rescopes its refs; refs rebuild before tag counts

Two backend bugs the differential fuzzer found.

**#6216: `usage_count` stayed low after a restore.** The lifecycle rebuild set is enqueued one task at a time, so under load it splits across background drains, and `RebuildTagsCache` ran before `RebuildBlockTagRefsCache` re-admitted the restored ref.
- `FULL_CACHE_REBUILD_TASKS` and `CONTENT_LIFECYCLE_REBUILD_TASKS` now put the refs rebuild first.
- The `dedup_tasks` tail rule stays: many arms enqueue `RebuildTagsCache` alone, and only the tail keeps it after a refs rebuild that lands later in the same drain.
- `restore_set_drained_one_task_at_a_time_counts_the_restored_ref_6216` drains one task per batch; red with the old order (0, expected 1).

**#6209: a tag's old-space refs survived its move.** `block_tag_refs` applies the space filter at index time, and a `space` write on a tag re-indexed nothing until the next boot.
- The dispatch `space` arm enqueues a full `RebuildBlockTagRefsCache` before `RebuildTagsCache`. A per-referrer reindex cannot re-admit a ref on the move back, because the dropped row is no longer there to find.
- Inbound sync does the same when a changed block is a tag (`changed_page_and_tag_ids` now returns `block_type`). Without it, the 5712 peer tests kept the stale ref on the receiving device.
- The boot backstop `enqueue_tag_ref_rebuilds` is deleted: every case it covered is a dispatched `space` op now.
- `moving_a_tag_to_another_space_rescopes_its_inline_refs_6209` moves a tag away and back; the fixture `tag_ref_dropped_after_tag_moves` pins it on both runners. The mock already matched.
- The fuzzer's `no_tag_ref` exclusion is gone.

**Review.** A separate reviewer re-killed the #6216 test by swapping the order back, traced every path that writes a tag's `space` (local, undo, boot placement, sync), and approved. Its non-blocking note: a synced tag create or rename now costs a full refs rebuild instead of a per-block reindex, which is rare.

**Suites:** full `cargo nextest run --workspace`, the fuzz lane three times, clippy, `SQLX_OFFLINE` check, fmt, vitest over `src/lib/tauri-mock`, typecheck.
