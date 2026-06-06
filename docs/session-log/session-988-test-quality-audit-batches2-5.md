# Session 988 — Test Quality Audit Batches 2–5

**Date:** 2026-06-05/06
**Branch pattern:** `fix/test-quality-batch2` through `fix/test-quality-batch5`
**Issues closed:** #496–#499, #501–#516

## Work done

Continued the test-quality audit loop (`/loop /batch-issues`) shipping the remaining 4 of 5 batches from the 26-issue audit (#491–#516). All batches parallel-built via domain-split subagents.

### Batch 2 (PR #518 — merged) — issues #496, #497, #498, #499, #501
- `sync_daemon/tests.rs`: renamed mislabeled test; added `daemon_loop` tests using new `run_sequential_sync_round` helper
- `sync_daemon/orchestrator.rs`: extracted `run_sequential_sync_round` for testability
- `attachments.rs`: `ORDER BY created_at` → `ORDER BY created_at, id` (stable sort)
- `block_cmd_tests.rs`: renamed tests + fixed assertion messages
- `recurrence/tests.rs`: December year-rollover edge cases
- `agenda_cmd_tests.rs`: exact computed date assertions
- `backlink/tests.rs`: exact `ulid_to_ms` assertion
- `backlink_integration.rs`: use materializer path instead of raw INSERT
- **sqlx fix**: swapped the one changed `.sqlx` file (ORDER BY change) rather than regenerating 218 test-query entries

### Batch 3 (PR #519 — merged) — issues #500, #502, #503, #504, #506, #507
- Bench quality: `black_box` on all bench return values; `sample_size(10)` for heavy bench; `assert_eq!` over `>=` in property_def_bench
- `cache/tests.rs`: true differential for `projected_agenda_cache_split`; idempotency; template-page fixture
- `edge_case_tests.rs`: rename SQL-injection → allowlist-reject framing
- `glob_filter_tests.rs`, `toggle_filter_tests.rs`: exact count/offset assertions
- `dag/proptest_b2.rs`, `dag/tests.rs`: structural LCA invariant; rename+strengthen compaction test
- `fts/tests.rs`: fix vacuous `<` survival check
- `loro/engine_proptest.rs`: per-op read-back assertions
- `mcp/tools_ro/tests.rs`: new `search_truncates_multibyte_content_safely` test
- `soft_delete/proptest_b3.rs`: pick non-pre-deleted root; assert `count1>0`
- `tag_inheritance/tests.rs`: exact `(block,tag,inherited_from)` triples
- `tag_query/resolve/tests.rs`: `len()` guards on `resolve_not_*`

### Batch 4 (PR #520 — CI running) — issues #505, #508, #509, #510, #511
- `materializer/tests.rs`: concurrent_fg_bg content+metrics assertions; exact `==1` for drop counters; remove vacuous op_log assertion; rename seven→eight; delete smoke test
- `page_integration.rs`: fix restore_page_to_op path; midnight-rollover guard for today_journal/quick_capture; alias ownership assertion
- `list_pages_with_metadata_tests.rs`: full page-2 MostLinked assertions; sort-order assertion
- `property_cmd_tests.rs`: exact date auto-timestamps; value_ref read-back; dedup len==1; custom-date round-trip test
- `query_cmd_tests.rs`: boundary block in `gt` test; exact Delete/Insert diff assertions
- `lifecycle_integration.rs`: rename sequential-create test
- **sqlx fix**: added missing `.sqlx/query-c07d5bc9....json` for new `STRESS_01` query in materializer tests

### Batch 5 (PR #521 — CI pending) — issues #512, #513, #514, #515, #516
- `snapshot/tests.rs`: extended proptest strategies (todo_state, due_date, priority, deleted_at, value_num, value_date, value_ref, value_bool→i64); exact timestamp in compact_preserves_recent_ops
- `commands/tests/snapshot_tests.rs`: `flush_background()` instead of `sleep(10ms)`; updated insta snapshot
- `commands/tests/undo_redo_tests.rs`: renamed restore_page_to_op test to reflect CTE-scope behaviour
- `recovery/tests.rs`: exact surviving content; removed wall-clock `duration_ms` assertions; asserts `replay_errors.len()==1` on dropped table
- `integration_tests.rs`: capture edit_block seq; exact `prev_edit` assertion
- `reverse/proptest_b1.rs`: discriminated match on NotFound for Edit/Move/SetProperty
- `sync_daemon/tests.rs`: FEAT6 last_hash assertion; rename S-1 test
- `sync_files/tests.rs`: remove vacuous zero-assertions; rename M-51 test; fix unverifiable doc claims
- `sync_net/tests.rs`: tighten cert-pinning assertion; delete vacuous empty mdns test; module-level doc comment

## Key lessons
- `cargo sqlx prepare --check -- --tests` verifies ALL test-code queries; even a new `sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'STRESS_01'")` with a literal-string id needs its SHA-256 `.json` cache entry
- Sqlx query hash = `sha256(query_string)` — verified by comparing filename hash with `echo -n "..." | sha256sum`
- For test-only `.sqlx` changes: only swap the one changed file; `cargo sqlx prepare -- --tests` in dev mode nuke test-query entries (218 files deleted on the batch-2 incident)
- `flush_background()` is the reliable materializer barrier; `sleep(10ms)` is flaky and adds noise to counters

## PRs
- #518 merged ✓ (closes #496–#499, #501)
- #519 merged ✓ (closes #500, #502–#504, #506–#507)
- #520 open, CI running (closes #505, #508–#511)
- #521 open, CI pending (closes #512–#516)
