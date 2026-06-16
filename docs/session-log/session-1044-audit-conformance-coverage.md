# Session 1044 — audit fix #1269: conformance coverage for tag/restore/purge/delete-property

2026-06-16. From the 2026-06 Opus quality audit (testing). `/loop /batch-issues` run.

## Gap
The conformance harness (the only mock⇄backend parity gate) never exercised `add_tag`,
`remove_tag`, `restore_block`, `purge_block`, `delete_property` — so a silent divergence
between the tauri-mock and the Rust backend for those ops would go undetected.

## What was added
4 fixtures (`tag_add_remove`, `restore_block`, `purge_block`, `delete_property`) covering
all 5 ops, plus the Rust runner arms. Every op routes through the production foreground +
engine pipeline (`append_local_op` → `dispatch_op` → `settle`, `install_for_test()`), the
#891 engine-path guard asserts op-created blocks live in the engine tree (not the sql_only
fallback), and the assertions compare the SETTLED reprojected snapshot. `expected`
snapshots are backend-authored (`CONFORMANCE_UPDATE=1`).

## Bug the new gate immediately caught (per #763 drift policy)
`purge_block` failed parity: production `purge_block_inner` appends a `PurgeBlock` op to the
op_log, but the mock's `purge_block` handler omitted `pushOp` — exactly the silent
divergence the harness exists to surface. Fixed with one line in
`src/lib/tauri-mock/handlers.ts` (`pushOp('purge_block', { block_id })`). No revert
regression: the revert switch handles purge only via `default` (irreversible).

## Verification
Reviewer confirmed the foreground+engine routing, backend-authored snapshots, the mock-fix
correctness (no revert regression), and per-fixture semantics (tag dedupe to one edge;
restore clears `deleted_at`; purge physically removes; delete_property drops the row vs
set-null). Rust conformance + 106 tag/purge/property/restore tests pass; TS conformance 13
pass; full tauri-mock suite green; tsc clean.
