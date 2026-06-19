# Session 1073 — /batch-issues loop: split op_log/mod.rs god-file, batch 22 (2026-06-19)

## What happened

God-file split from the night `/loop /batch-issues` run (batch 22), built in worktree
`wt-oplog`, overlapped with the fts split (#1660) and the batch-23 fixes. Pure
reorganization — no production behavior or public API change.

## Shipped

PR `fix/split-op-log-mod-1659`:

- **#1659** (LOW, maintainability) — `op_log/mod.rs` was ~96 KB but contained only the
  thin production re-export surface plus ONE giant `#[cfg(test)] mod tests` block
  (~2,500 lines). Extracted that test module into a focused `op_log/tests/` directory:
  `tests/mod.rs` (shared fixtures/helpers — `test_pool`, `make_create_payload`,
  `all_op_payloads`, exposed `pub(super)`) plus 6 themed submodules — `append.rs` (8),
  `hash.rs` (2), `read.rs` (7), `payload.rs` (16), `immutability.rs` (8), `origin.rs`
  (16). `mod.rs` is now 19 lines (the byte-identical production re-exports +
  `#[cfg(test)] mod tests;`). Insta snapshots moved from `op_log/snapshots/` to
  `op_log/tests/snapshots/` (insta resolves relative to the test source file) and
  renamed to the new module path; snapshot data byte-identical.

## Review pass

Reviewer (PASS, no defects) verified the cardinal refactor invariants: production code
(the `mod`/`pub use` re-export surface and the 5 production submodules) is byte-for-byte
identical to `origin/main`; the test set is unchanged — **57 before, 57 after, identical
names, 0 `#[ignore]`** (independently enumerated via `cargo nextest list`); all 57 test
bodies are whitespace-normalized-identical to the originals (incl. the immutability /
hash-chain / tracing-writer tests); the moved insta snapshots resolve (0 `.snap.new`
produced); and no importer's visibility changed. `cargo clippy --all-targets -D warnings`
clean; `cargo nextest` 106/106 (57 op_log::tests + related) pass.

## Notes

- No dynamic-SQL-baseline impact: the moved code is all test code; the #646 baseline
  counts production only.
- Files: `op_log/mod.rs` (shrunk), new `op_log/tests/{mod,append,hash,read,payload,
  immutability,origin}.rs`, moved `op_log/tests/snapshots/*`.
- Branch base is current `origin/main` (rebased before push).
