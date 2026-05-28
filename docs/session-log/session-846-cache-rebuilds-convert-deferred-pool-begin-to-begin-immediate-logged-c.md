## Session 846 — cache rebuilds: convert deferred `pool.begin()` to `begin_immediate_logged` (closes #105) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only + 1 review subagent (technical) |
| **Items closed** | #105 (cache rebuilds + FTS: 25 sites converted) |
| **Items modified** | — |
| **Tests added** | +1 backend (`reindex_block_links_waits_for_competing_writer` — contention regression guard) |
| **Files touched** | 10 |

**Summary:** Closes issue #105. Mechanical s/`pool.begin()`/`crate::db::begin_immediate_logged(pool, "<scope>")`/ swap across 25 sites in `src-tauri/src/cache/` and `src-tauri/src/fts/index.rs`. The DEFERRED form acquired a SHARED lock first and attempted a RESERVED-lock upgrade on the first write; under concurrent writer contention SQLite returns `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` does NOT cover (it's a serialization error, not a lock-wait). `begin_immediate_logged` wraps `pool.begin_with("BEGIN IMMEDIATE")` and takes the writer lock upfront, so contention waits with `busy_timeout` instead of failing mid-tx.

Each of the 25 sites got a unique snake-case scope label (e.g. `cache_block_links_reindex`, `cache_block_links_reindex_write`, `fts_rebuild_index_chunk`) for the MAINT-30 slow-acquire log so per-site contention can be filtered. Two `read_pool.begin()` sites (`cache/page_id.rs:88`, `cache/projected_agenda.rs:368`) intentionally stay DEFERRED — `read_pool` is built with `PRAGMA query_only = ON` so they cannot ever write, and converting them would be wrong (no writer, no point taking IMMEDIATE).

Added one contention regression test (`cache::tests::reindex_block_links_waits_for_competing_writer`) at the bottom of `src-tauri/src/cache/tests.rs`. Holder acquires `BEGIN IMMEDIATE` + `SELECT 1` (forces lock now, not lazily) + sleeps 100ms. Contender invokes `reindex_block_links` and must wait ≥50ms then succeed. On the OLD `pool.begin()` form the contender would hit `SQLITE_BUSY_SNAPSHOT` and fail the `result.expect(...)`. Multi-thread tokio runtime required.

**Out-of-scope sibling site (filed as follow-up):** `src-tauri/src/tag_inheritance/rebuild.rs:21` — `rebuild_all` (single-pool variant) is on bare `pool.begin()` doing DELETE + recursive-CTE INSERT…SELECT. The split variant `rebuild_all_split` at line 67 already uses `begin_with("BEGIN IMMEDIATE")` and the docstring there cites the same L-94 race this PR closes. Surface as a follow-up so #105 stays clean.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (work was a `plan`-labelled GitHub issue, not REVIEW-LATER).
- **Previously resolved:** 1350+ → 1350+ across 845 → 846 sessions.

**Files touched (this session):**
- `src-tauri/src/cache/block_links.rs` — 2 conversions (reindex + split write)
- `src-tauri/src/cache/agenda.rs` — 2 conversions
- `src-tauri/src/cache/block_tag_refs.rs` — 4 conversions (2 reindex + 2 rebuild)
- `src-tauri/src/cache/page_links.rs` — 3 conversions
- `src-tauri/src/cache/page_id.rs` — 1 conversion (write side; line 88 read_tx stays DEFERRED)
- `src-tauri/src/cache/pages.rs` — 2 conversions
- `src-tauri/src/cache/projected_agenda.rs` — 2 conversions (line 368 read_tx stays DEFERRED)
- `src-tauri/src/cache/tags.rs` — 2 conversions
- `src-tauri/src/fts/index.rs` — 7 conversions (update + reindex + 2× rebuild × {clear, chunk})
- `src-tauri/src/cache/tests.rs` (+~45 — new contention regression test)

**Verification:**
- `cd src-tauri && cargo check` — clean.
- `cd src-tauri && cargo nextest run` — 4012 / 4012 pass (2 flaky, unrelated to this change — pagination + integration tests, succeeded on retry).
- Technical review subagent — LGTM across correctness / test coverage / conventions / architectural stability; surfaced the `tag_inheritance/rebuild.rs:21` follow-up.

**Commit plan:** single commit on topic branch `issue-105-cache-rebuilds-begin-immediate`; PR against `main`. Closes #105 on merge.
