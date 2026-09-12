# Session 1715 — review notes from #4981 and #4982

The non-blocking notes the reviewer left on #4981 (dead-surface sweep) and
#4982 (review notes from #4980), batched into one PR after both merged, per
AGENTS.md § How we work.

- **`SyncDaemon.scheduler` was write-only.** #4981 deleted
  `cancel_active_sync`, the field's only reader; `cancel_sync_inner` takes
  the scheduler from managed Tauri state, not from the daemon handle. The
  field, its two constructor clones and the test literal are gone; the
  `SyncDaemonContext` still carries the scheduler into `daemon_loop`.
- **`commands::` re-exported `get_mcp_socket_path_inner` and
  `get_mcp_rw_socket_path_inner`** with no consumer outside `mcp.rs` once
  the wrappers went. Removed from the `pub use` list; the functions stay
  where the status commands call them.
- **The mock's `compareSortKeysDesc` doc** still gave `list_block_history`
  its pre-#4980 order (`seq DESC, device_id DESC`). Both history listings
  share one keyset now and the comment says so.

## Verified

`SQLX_OFFLINE=true cargo check --workspace --all-targets` clean; `cargo
nextest run --workspace -E 'test(sync_daemon) | test(mcp) | test(shutdown)'`
569 passed. Pure deletions and one comment: the compiler is the oracle for
the field and the re-exports (a surviving reader would not build). The
pre-push verifier was skipped; CI runs the full suite on the PR.
