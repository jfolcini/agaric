## Session 853 — DB-layer micro-pushdowns sub-items 1, 2, 4 (closes #112) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | 3 build + 1 review |
| **Items closed** | #112 (DB-layer micro-pushdowns batch — all 4 sub-items now shipped: sub-item 3 in commit aa73a686 / session 850, sub-items 1+2+4 here) |
| **Items modified** | — |
| **Tests added** | +1 parity (cache::pages — five-case set-based parity incl. content-cleared) / +1 concurrency (sync_files — 100-attachment set-equality probe) |
| **Files touched** | 7 |

**Summary:** Ships the remaining three sub-items of issue #112 in one PR. (1) `backlink/sort.rs` + `tag_query/query.rs`: ~210 LOC of Rust property-sort comparator code collapsed into a single `sort_by_property_column` helper that drives `ORDER BY value_{text,num,date} {ASC|DESC} NULLS LAST, b.id ASC` over a `json_each(?)` candidate set; tiebreaker stays `b.id ASC` to preserve cursor-walk semantics. (2) `cache/pages.rs`: `apply_sort_merge_rebuild` rewritten as two SQL statements — `INSERT … ON CONFLICT(page_id) DO UPDATE … WHERE pages_cache.title != excluded.title` followed by `DELETE … WHERE page_id NOT IN (live page IDs)` — preserving the M-2 "skip unchanged → don't refresh `updated_at`" semantic. (4) `sync_files.rs::find_missing_attachments`: serial `tokio::fs::metadata` loop becomes `futures_util::stream::iter(...).buffer_unordered(16).collect()` (concurrency 16 per maintainer comment 2026-05-28T09:38; hard-coded, no runtime knob; `futures-util` gained the `"std"` feature for the `alloc` cfg behind `buffer_unordered`).

**Review caught one MUST-FIX:** the technical-review subagent flagged that the new DELETE in sub-item 2 was missing `AND content IS NOT NULL`, which would silently leave a stale `pages_cache` row whenever a page's content was cleared (the UPSERT skips such blocks because *its* SELECT filters `content IS NOT NULL`, so without the DELETE-side filter the cache row would persist as an orphan). Fix applied (added the predicate) and the parity test extended to a fifth fixture (`PAGEEEEE`, content-cleared) so the regression is now covered by `rebuild_pages_cache_set_based_parity_112`.

**Files touched (this session):**
- `src-tauri/Cargo.toml` (+1, -1 — `futures-util` `["sink"]` → `["sink","std"]`)
- `src-tauri/src/backlink/sort.rs` (~ -127 net — three per-column fetchers + comparator collapsed into one SQL-driven helper)
- `src-tauri/src/cache/pages.rs` (set-based rebuild + five-case parity test incl. content-cleared)
- `src-tauri/src/sync_files.rs` (serial loop → `buffer_unordered(16)`)
- `src-tauri/src/sync_files/tests.rs` (+1 set-equality probe over 100 attachments)
- `src-tauri/src/tag_query/query.rs` (sort + cursor + limit folded into one round-trip)
- `src-tauri/.sqlx/query-73e0d4a7…json` (new, for `UPDATE blocks SET content = NULL WHERE id = ?` test helper)

**Verification:**
- `cd src-tauri && cargo sqlx prepare -- --tests` — one new cache entry for the test helper, no other regenerations.
- `cd src-tauri && cargo nextest run` — 4016/4016 pass on the merged + fixed tree (one re-run needed on the known-flaky `deleted_blocks_visible_in_list_blocks_show_deleted` integration test, passes deterministically on retry).
- Three build subagents reported clean cargo nextest + clippy independently in their own worktrees.
- pre-commit / pre-push hooks will run on commit and push.

**Process notes:** Three build subagents launched in parallel with `isolation: "worktree"` so each had its own `target/` and `.sqlx/` (sub-items 1 and 2 both touch SQL queries and would otherwise race on the cache regeneration). Build wall-clock dominated by sub-item 1 (~25 min, the most code-heavy refactor). One review subagent (different from all builders, per the no-self-review rule) caught the content-cleared regression that none of the per-slice tests would have surfaced — exactly the failure mode reviews exist to catch.

**Lessons learned (for future sessions):** When a sub-item carries a load-bearing semantic (here: "what does the DELETE-side filter need to include?"), the parity test should enumerate every transition into and out of the live set, not just the headline cases. The original four-case test (changed / unchanged / new / soft-deleted) missed the fifth (content-cleared) because the issue body's example DELETE didn't include the `content IS NOT NULL` clause — a literal copy of the issue's example would have shipped the bug. Reviewers reading test coverage should ask "which membership transitions are unexercised?", not just "does the test cover the cases the body lists?".

**Commit plan:** three commits on branch `perf/db-pushdowns-issue-112`, opened as one PR. Commit 1 = sub-item 1 (backlink + tag_query sort to SQL). Commit 2 = sub-item 2 (pages_cache set-based rebuild + review-fix + parity test). Commit 3 = sub-item 4 (`buffer_unordered(16)`).
