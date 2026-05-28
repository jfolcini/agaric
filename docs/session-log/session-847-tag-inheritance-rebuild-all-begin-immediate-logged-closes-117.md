## Session 847 — tag_inheritance::rebuild_all begin_immediate_logged migration (closes #117) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | #117 (tag_inheritance::rebuild_all single-pool — same SQLITE_BUSY_SNAPSHOT bug class as #105) |
| **Items modified** | — |
| **Tests added** | 0 (PR #116's `reindex_block_links_waits_for_competing_writer` contention guard already covers the bug class; the fix here is uniform with that PR's 25 conversions) |
| **Files touched** | 1 |

**Summary:** Closes issue #117, the follow-up surfaced during PR #116's review. Two-line edit in `src-tauri/src/tag_inheritance/rebuild.rs`:

- **Line 21** (`rebuild_all`, single-pool) — `pool.begin().await?` → `crate::db::begin_immediate_logged(pool, "tag_inheritance_rebuild").await?`. This is the bug fix: same `SQLITE_BUSY_SNAPSHOT` race that PR #116 closed across 25 cache/ + fts/ sites — the DEFERRED form attempts a snapshot-upgrade mid-tx that `busy_timeout` does NOT cover. The split variant at line 67 already used `BEGIN IMMEDIATE` and its docstring already cited the L-94 race.
- **Line 67** (`rebuild_all_split`) — `write_pool.begin_with("BEGIN IMMEDIATE").await?` → `crate::db::begin_immediate_logged(write_pool, "tag_inheritance_rebuild_split").await?`. Pure observability consistency with PR #116's cache/ migrations — no behavioural change, just adds the MAINT-30 slow-acquire log so per-rebuild contention is filterable in production traces.

No new contention test — PR #116's `reindex_block_links_waits_for_competing_writer` already guards the bug class with a generic shape; adding a parallel test for tag_inheritance would be gold-plating.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (work was a `plan`-labelled GitHub issue, not REVIEW-LATER).
- **Previously resolved:** 1350+ → 1350+ across 846 → 847 sessions.

**Files touched (this session):**
- `src-tauri/src/tag_inheritance/rebuild.rs` (+~10, -2 — 2 conversions + 2 explanatory comment lines)

**Verification:**
- `cd src-tauri && cargo nextest run tag_inheritance` — 30 / 30 pass.
- `cd src-tauri && cargo nextest run` — 4011 / 4011 pass (1 flaky retry on `sync_files::tests::run_file_transfer_initiator_breaks_on_cancel_m47`, unrelated).

**Process notes:** Demonstrated the loop's find→file→fix discipline — issue #117 was filed during PR #116's review (1-line fix, no Open Qs, properly labeled `plan`), then picked up and shipped in the very next iteration. The two-line scope crept slightly past the issue's "one-line swap" because the split variant's observability story was an obvious add (free MAINT-30 logging via the wrapper) and the file is only 86 lines so cohesion wins.

**Commit plan:** single commit on topic branch `issue-117-tag-inheritance-rebuild-immediate`; PR against `main`. Closes #117 on merge.
