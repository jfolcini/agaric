## Session 929 — #235 query→macro conversion, batch 4 (2026-05-31)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-31 |
| **Subagents** | 4 build (grouped by disjoint files) + orchestrator central verify |
| **Items closed** | — (partial; #235 stays open) |
| **Items modified** | #235 |
| **Tests added** | +0 (behaviour-preserving refactor; covered by existing 4067 tests) |
| **Files touched** | 6 source + 17 new `.sqlx` cache entries + 1 session log |

**Summary:** Fourth batch of #235 — swept the remaining convertible static-literal sites in the cache / tag-query / maintenance modules: 24 conversions across 6 files. `cache/agenda.rs` and `cache/tags.rs` had no convertible sites (their SQL is a `const &str` reference, not an inline literal — the macros require a literal), and were left untouched.

**Files touched (this session):**
- `src-tauri/src/cache/page_links.rs` (8 sites; +/-66) — UPSERT/DELETE + tuple roll-ups (`AS "col!"` on COALESCE/COUNT/UNION columns); also refreshed the now-stale module doc comment.
- `src-tauri/src/cache/block_tag_refs.rs` (5 sites) — json_each DELETE/INSERT + streaming tuple `.fetch()`.
- `src-tauri/src/tag_query/resolve.rs` (5 sites) — tag-leaf resolution scalars.
- `src-tauri/src/cache/projected_agenda.rs` (3 sites) — cache DELETE + repeating-row query_as (`AS "id: BlockId"`).
- `src-tauri/src/cache/pages.rs` (2 sites) — sort-merge rebuild UPSERT/DELETE.
- `src-tauri/src/maintenance.rs` (1 site) — tombstone-purge scalar.
- `src-tauri/.sqlx/` (+17 cache entries, 0 deletions).

**Verification:**
- `cd src-tauri && cargo check --all-targets` — clean.
- `cd src-tauri && cargo nextest run` — 4067 passed.
- `cargo sqlx prepare -- --all-targets` — 17 new entries, no deletions.

**Process notes:** OUT-of-scope sites left untouched: `AssertSqlSafe`/`format!` chunked upserts (page_links, block_tag_refs, agenda), and `const &str` SQL in agenda/tags caches (macros need an inline literal, not a const reference — a distinct OUT category from concat/dynamic). With batches 1–4, the readily-convertible static-literal backlog in non-test production code is now largely exhausted; the remainder is `concat!()`/`AssertSqlSafe` dynamic SQL tracked under #139.

**Commit plan:** single commit / pushed.
