# Session 2262 — Three slow Rust tests, cut without weakening them

Three tests ran for most of a nextest partition's tail. Each was slow for a
different reason, and each keeps every assertion it had.

- **`issue611_oversized_loro_snapshot_syncs_via_chunked_wire_path`** synced a
  fixed 4 MB of content. It needs a snapshot just over
  `LORO_INLINE_MAX_BYTES`, so the content is now that constant plus a tenth,
  and its time falls with the size. The diagnosis assumed the snapshot is
  about the size of the content. It is twice that (history and current
  state). So the premise assertion, that the snapshot exceeds the threshold,
  is what goes red when the content shrinks too far, and that red was shown.
- **`conformance_fixtures_match_backend`** and
  **`b4_two_peer_snapshot_exchange_converges_sql`** opened a freshly migrated
  pool per fixture and per proptest case, and the migration was most of their
  time. `init_pool_from_template` in `commands/tests/common.rs` migrates once
  per process and writes a copy to each caller's own path. `init_pool` still
  opens that copy, so a later migration still applies. `test_pool` (every
  command_integration test) and the reproject proptests' `fresh_pool` use it.
  A new test proves two callers never share a database: it went red when the
  helper handed out the same pool twice.
- B4's proptest regression seeds sat in a directory proptest never reads,
  because proptest resolves the path from the nearest `lib.rs` (`src-tauri/src`).
  The file moved to `proptest-regressions/materializer_app_tests/`, so its
  seeds replay again. `strace` showed the run opening it.

`nextest.toml` loses a comment claiming B4 takes about 30 s alone, now false.
Its timeout overrides stay.

Gates: clippy (`--workspace --all-targets`), `SQLX_OFFLINE=true cargo check
--workspace --all-targets`, `cargo fmt --check`, and the full workspace suite
in two partitions, all green.
