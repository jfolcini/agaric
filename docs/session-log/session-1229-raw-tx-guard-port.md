# Session 1229 — Raw-tx guard widened to subcrates (#3110)

**Issue:** #3110 (filed from the #3109 review's confirmed gap)

## What

`check-raw-tx.py` (the #653/#110 BEGIN-IMMEDIATE/CommandTx guard) scanned only
`src-tauri/src`; the #2621 split moved ~44 protected sites in 19 subcrate files
out of its sight. Ported to the four crate roots mirroring
`check-table-ownership.py`'s CRATE_ROOTS approach (+ diagnostics defensively,
`**/src/bin/**` excluded).

- Allowlist hand-mapped old→new: store `cache/**`, `db/**`, `fts/index.rs`,
  `tag_inheritance/rebuild.rs`; sync `snapshot/{create,restore}.rs`,
  `sync_daemon/snapshot_transfer.rs`, `sync_protocol/{loro_sync,
  session_state_machine}.rs`. Stale entries dropped (gcal integration removed,
  `src/db.rs` now a dir, duplicate materializer glob). One NEW entry:
  `agaric-engine/src/apply/**` — the migrated materializer projection,
  structural successor of `src/materializer/handlers/**`.
- One production edit: a per-line `// allow-raw-tx:` marker on
  `agaric-engine/src/draft.rs` `flush_draft` (test-/bench-only wrapper; the
  command path is `commands::drafts::flush_draft_inner` on an app CommandTx —
  no op_log dispatch to couple).
- `prek.toml` trigger regex widened to the four crate roots.
- Self-test 6 → 37 cases (subcrate scanning, bin/test exclusion, allowlist-port
  positives and dropped-glob negatives).

All 44 newly-visible sites investigated individually — 43 covered by ported
globs, 1 marker; no blanket allows.

## Review

Tooling-only PR (zero-Rust except the comment marker): orchestrator-verified
path — every claim re-checked post-rebase (self-test 37/37, plain run exit 0
over 381 files, all sibling guards green); agaric-reviewer covers the PR.

## Verification

Post-rebase onto main (#2897 + #3108 in base): `--self-test` pass; full scan
exit 0; dynamic-sql/table-ownership guards green; `prek run --all-files
check-raw-tx check-raw-tx-self-test` passed; builder's `cargo check --lib`
clean with the marker.
