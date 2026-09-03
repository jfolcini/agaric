# Session 1500 — #4499 phase 1: `reverse/` and `link_metadata/` leave the app crate

Two modules the plan measured as already free of the app crate move down a
level: `reverse/` (the inverse-op kernels the undo engine computes from) into
`agaric-engine`, and `link_metadata/` (the link-preview fetcher and its cache
table) into `agaric-store`. Neither had a production dependency on the app
crate beyond `crate::db` names that were re-exports of `agaric_store::db` all
along, which is the finding the plan rests on.

## The move

`git mv` per directory, then only path re-qualification: `crate::db::{ReadPool,
MAX_SQL_PARAMS}` become `agaric_store::db::…`, and `link_metadata`'s
`crate::db::now_ms` stays `crate::db::now_ms` because that is where it always
resolved. `reverse`'s `pub(crate) use` re-exports become `pub` — the app's
history commands, the bulk-equivalence oracle and the attachment-GC tests
call them from outside now. The three in-file test modules that built their
own pool through the app's `init_pool` use the store's `test_support::test_pool`
instead, which is what the loro tests did when they moved (#2621).

`reverse/tests.rs` splits. The mutants lane runs each package's own tests
against its mutants (`-p`), so the suite that kills the 183 `reverse/**`
mutants has to live in the engine: 57 of its 68 tests need only a pool and
`append_local_op_at` and become `agaric-engine/tests/reverse_tests.rs`, with
the replicated-op seeder calling `dag::ingest_replicated_record` directly
(the sync crate's `insert_replicated_op` is a wrapper over it, and the engine
cannot name the sync crate). The eleven that reach the app's `Materializer`,
`revert_ops_inner` or `soft_delete` stay in the `app_tests` binary phase 0d
created; `commands::blocks::find_prev_edit_in_tx` is `pub` for the #3644
stamping test among them. `reverse/proptest_b1.rs` follows the code as
`agaric-engine/tests/reverse_proptest_b1.rs`, and `proptest_db_harness` moves
to the engine with it as a `test-util` module (the feature pulls `proptest` as
an optional normal dependency, the `tempfile` shape; the engine gains the
self dev-dependency the app and store already use). The app's B2-B4
proptests import it from the engine.

`reqwest` moves from the app crate's manifest to the store's with its
rustls-posture comment; the app has no other user. `url` stays in both
(`deeplink` uses it). The store's `tokio` gains `net` for the pinned resolver's
`lookup_host`.

## G1 — every path-keyed guard, ported

- `prek.toml` mutants-scope trigger, `.cargo/mutants.toml` `examine_globs`,
  `scripts/bulk-equivalence-baseline.json` (9 `fn` paths), the dynamic-SQL
  baseline (re-anchored: `link_metadata/mod.rs` keeps its 3), two
  `docs/architecture/` citations, `src-tauri/tests/AGENTS.md`.
- `check-bulk-equivalence.mjs` only walked `*/src` roots, so the `covered`
  entry pinned by `compute_reverse_batch_matches_per_op_loop` reported "no fn by
  that name" once that test lived under `src-tauri/tests/`. `src-tauri/tests`
  is a scan root now — the same repair `check-metric-provable.mjs` needed in
  #4631.
- The mutants shard matrix: `reverse/**` was the app package's entire
  examine surface (183 mutants, 6 per shard, 31 shards, each paying the app
  crate's build). Those mutants are `agaric-engine`'s now, sized at its
  per-mutant cost: 566 mutants at 32 per shard is 18 shards, up from 12; the
  31 `agaric` shards go. The first cron's PARTIAL notices settle the
  estimate, as the matrix comment already says for the engine.

## G2 / G3 / G4

Non-member trees: `fuzz/fuzz_targets/html_parse.rs` and
`benches/groups/undo_redo.rs` repointed; `fuzz/Cargo.lock` refreshed through
`cargo metadata`, and again after the `proptest` optional dependency.

Caches: `just gen-sqlx` added four files to `agaric-engine/.sqlx/` — the
`reverse` module's `query!` sites (the attachment row lookup, the prior
property and prior move scans over `op_log`, the `add_attachment` payload
fetch) — and the same four to `agaric-sync/.sqlx/`, which already carries
the engine's queries because the sync crate's prepare compiles the engine.
The workspace-root cache already had them (it is workspace-wide) and did not
change; nothing left `agaric-store/.sqlx/` because `link_metadata` has only
dynamic SQL. All four caches staged.

Census, per moved file, `#[test]` / `#[tokio::test]` / `proptest!` markers
old → new: identical for all eleven (0, 0, 4, 4, 0, 0, 68, 6, 0, 0, 89). `fn`
counts drop by exactly one in `block_ops.rs`, `property_ops.rs` and
`link_metadata/tests.rs`: the per-file `test_pool` helper each replaced with
the store's. The rename-aware diff of the moved files, with path
re-qualification filtered out, leaves: `pub(crate)` → `pub` on the two
re-export lines, the two `#[cfg(test)] mod` declarations that moved to
`tests/app_tests/main.rs`, and one comment that now names
`agaric_store::db`. `src/lib/bindings.ts` is byte-identical (no command
surface changed).

## Verified

- `cargo check --workspace --all-targets` clean.
- `cargo nextest run --workspace --retries 0`: 6289 run, 6288 passed, 1
  failed (below), 11 skipped; then `-E 'test(link_metadata)'` after the fix:
  107 passed. Doc-tests are unchanged by a move; CI runs them.
- The first full run died on a full disk (three worktrees' `target/` dirs).
  The second failed one test, and it is the one thing in this move that was
  not a path: `is_blocked_ip_enforced` permits loopback under `cfg(test)`, and
  the app crate's `link_metadata` command tests relied on that to reach
  `127.0.0.1:1` and fail at connect time. The guard now compiles in the store,
  which the app's test binary links without `cfg(test)`, so the same URL is
  refused before any socket opens and the error says "refusing", not
  "Network error". Those three tests target `*.invalid` hosts now, which fail
  in the resolver — the same "a fetch was attempted" proof without leaning on
  a test-only allowance in another crate.
