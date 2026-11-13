# Session 4056 — Replacing one block's search row no longer scans the index

#6534, route A as decided on the issue. Picked up from the handover (#6667): the branch held one unreviewed `wip:` commit.

## What changed

- **Migration 0131** indexes the block-id column of FTS5's shadow content table: `CREATE INDEX idx_fts_blocks_content_block ON fts_blocks_content (c0)`. No new table, no rebuild of the search index.
- **`fts/index.rs`**: the single-block delete and the batch delete look the rowid up through that index and delete by rowid (`delete_fts_row_query`, `delete_fts_rows_query`). Every writer that removes or replaces rows goes through one of the two; the full rebuild still empties the table.
- **Benches**: `seed_write_path_fixture` builds the search index, so the write probes run against a 100K-row index, and `edit_block settled` has a budget. `bench_update_fts_for_block` asserts the index holds one row per block before and after its loop.

## Decisions and traps

- The wip's migration was `SELECT 1;`: a falsification left applied when its builder was cut off. No marker grep finds that; the migration test does.
- The batch delete changed too, though the issue names the three single-block deletes: it is the same scan, run by a restore, a tag or page rename and the sync fan-out.
- The three purge paths (`cache/purge.rs`, `apply/loro_apply.rs`, `loro/projection.rs`) still delete by `block_id IN (…)`. That is one scan per purge, not one per edit, and they were left alone.
- Deleting from `fts_blocks_content` directly, instead of through `fts_blocks`, removes the row and leaves its tokens. The rows-equality test stays green on that; only FTS5's `integrity-check` in the property test fails.
- The property test maintains `block_links` with `reindex_block_links`, because a page rename finds its referrers there; a tag rename finds them by scanning content.
- No new `e2e-tauri` spec: `search-edited-word.e2e.ts` already fails if an edit leaves the old row behind.
- `main` took migration 0130 (#6683) while this was being verified, so the migration, its test and the two places naming it moved to 0131 in the merge commit.
- `migrations-immutable` in its staged mode compares with `HEAD`, so it rejects a fix to, or a rename of, a migration that an earlier commit of the same unmerged branch added. Those two commits ran with `SKIP=migrations-immutable`; the range mode, which CI runs, passes.
- Each bench binary seeds every group's fixture whatever the name filter, so a local run of one probe is stopped once that probe has reported.
- `gh api` through the cloud proxy answers an occasional `HTTP 502` ("builtin injection failed"); a retry succeeds. `scripts/next-session-log.mjs` hits it too and then leaves open PRs out of its count.

## Measurements

Local, the session's cloud container, `cargo bench --profile release-test`; the "scan" column is the same binary rebuilt with the old statement. Criterion's interval in brackets.

| `update_fts_for_block`, rows in the index | Old delete (scan) | New delete (rowid) |
|---|---|---|
| 1K | 0.93 ms [0.90, 0.96] | 0.73 ms [0.70, 0.76] |
| 10K | 2.64 ms [2.55, 2.74] | 0.76 ms [0.74, 0.79] |
| 100K | 20.6 ms [19.9, 21.3] | 0.83 ms [0.80, 0.86] |

- The new delete still grows 14% from 1K to 100K rows, outside Criterion's interval, so "within noise of 1K" is not quite met. The same call also inserts into the larger index; the two were not split.
- `edit_block (2K-block page) settled @ 100K`: 26.4 ms [24.9, 27.4] with the old delete, 6.8 ms [6.5, 7.0] with the new one. The command alone went from 2.7 to 1.4 ms: the next save waited behind the scan.
- Two warm `bench-slo` runs on the branch (43424812177, 43424815243) measured the settled probe at 4.14 and 4.74 ms, which gives the 20 ms budget under `src-tauri/benches/AGENTS.md`. The container is about 1.4 times slower than the CI runner, so on CI the old delete would sit near the budget, not clearly over it (an estimate). The plan-pinning test is the guard; the budget is a backstop.

## Verified

- Each new test red once on its predicted assertion: the plan test with the statement reverted and with the migration emptied; the migration test with the migration emptied; the rows-equality test and the property test with a delete that takes other blocks' rows and with a batch delete that takes none; the property test's `integrity-check` with the delete run against the shadow table; the property test with its own rename step and its delete-referrer step removed.
- On the tree merged with `main`: `cargo nextest run --workspace` in two partitions (3990 and 3984 tests, all passed), `just gen-sqlx` with no diff, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, `node scripts/check-migration-test-coverage.mjs`. `prek run --hook-stage manual --all-files` ran before that merge.
- Not run locally: vitest and Playwright (no TypeScript changed), doc-tests, and the real-backend lane, which `just e2e-related` selects whole and CI runs.
