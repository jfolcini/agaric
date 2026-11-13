# Session 4066 — real-backend checks: stale reads after a write, a released vault, the Enter and merge wait

One PR for three items that all test or measure the real backend: #6567's stale-cache experiment and its upgrade-path test, and #6559's measurement of what Enter and a merge wait for. No product change.

## The stale-cache experiment (#6567)

Run at the command layer, not through the app: a local write through its `*_inner` command, then the view's read command with no settle, then the same read polled until it is right.

- The Pages list and Linked References are right when the write returns: `pages_cache` rows and counts and `block_links` are maintained in the write's transaction.
- Search, the tags list and `agenda_cache` are not: they wait for the background queue. On a small vault that is milliseconds. `RebuildAgendaCache` is whole-cache, and its window passes the frontend's 150 ms refetch debounce at about 5K dated blocks.
- Nothing is fixed. The numbers and their caveats are in a comment on #6567; the fix belongs to the change-feed plan or to a per-block agenda refresh.

What landed is the guard for the green half, `read_after_write.rs`. Its value over the settled sibling tests was shown, not assumed: with the count maintenance removed both go red; with it moved behind the background queue the settled test stays green and only the new one reds.

## The released vault (#6567)

`src-tauri/tests/fixtures/release-vault/0.23.0/` is a vault written by the 0.23.0 tag, and `upgrade_vault_tests.rs` boots it with head.

- **Written by the tag's command layer, not its UI.** `scripts/gen-release-vault.sh` checks the tag out into a throwaway worktree, copies `generator.rs` in as an example and runs it. The generator is never compiled at head, so it may only use what the tag exports. Driving the tag's real binary needs the whole WebDriver lane at the tag; that is the days-sized version the issue estimated.
- **The test lives in the lib, not in `tests/`**, because the boot phases it must run (`recover_and_bootstrap`, `boot_cache_gating`) are private to `lib.rs`.
- **A new migration file does not rebuild the migrator.** `sqlx::migrate!` embeds the directory at compile time and cargo does not watch it, so the first falsification (a throwaway migration that wipes `todo_state`) passed against a stale binary. Touch `src/db/pool.rs` and check the log says the crate compiled.
- Shown red twice: that migration makes the oracle report `engine.blocks.todo_state`; boot without the engine rehydrate appends 17 ops to an empty engine and fails the op count.
- gzip, not zstd: the workspace has no zstd crate, and `flate2` was already in the lockfile. An unpacked migrated database is over the 500 KB added-file limit.
- The tag's Markdown export is committed as `.txt`, because markdownlint would reformat the bytes the test compares.
- Not done from the issue's list: an attachment, a compaction and a paired peer in the vault; the `release.sh` step that adds a vault per release; the stale figure in `check-migration-test-coverage.mjs`.

## The Enter and merge wait (#6559)

`bench_enter_split_and_merge` in `interactive_slo` times the two sequences on the write-path fixture and prints p50 and p95 beside the mean. The numbers, from two local runs in the `release-test` profile, are in a comment on #6559 with their spread.

- Each pair is followed by a `flush_background`, and a delete's background work is about 4 s at 100K blocks, so a run holds few calls. Both probes record both halves of every pair so the percentiles get twice the calls for the same time.
- The split costs far more than an appended create plus an edit; the create at a sibling slot in the middle of a 2K-child page is the difference. Not profiled.
- Desktop only. The phone, the sync-apply case and the 300-line paste are open on the issue.

## Traps

- prek stashes unstaged changes while its hooks run. A commit made while a build is reading an unstaged file can hand that build the old file; commit only between builds.
- The end-of-file hook rewrites a fixture that lacks a final newline, so the script writes `device-id` with one.

## What ran

Both halves of `cargo nextest run --workspace`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, `prek run --all-files` and the manual stage. The bench ran whole, twice, in the `release-test` profile: every probe's shape assertions passed. The `bench-slo` lane did not run on this branch.
