## Session 895 — #110 batch 4: raw-tx lint guard — #110 COMPLETE (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 1 build (orchestrator-reviewed) |
| **Items closed** | `#110` (conversions + guard; op_log/dag API refactor split to `#224`) |
| **Items modified** | — |
| **Tests added** | +0 (hook self-verified) |
| **Files touched** | 8 |

**Summary:** Final #110 (finish MAINT-112) batch — the Q3 lint guard. Added
`scripts/check-raw-tx.py` (stdlib-only) + a prek `local` hook (`check-raw-tx`, pre-commit +
pre-push, `files = ^src-tauri/src/.*\.rs$`) that flags any NEW raw `pool.begin_with("BEGIN IMMEDIATE")`
/ `begin_immediate_logged(` in production Rust outside the allowlist, so the `CommandTx` convention
can't regress. With the group-1/group-2 conversions already merged (drafts, bootstrap, soft_delete),
this completes #110's planned scope.

**Hook design:** skips `#[cfg(test)]` modules (brace-depth tracking) + whole test files; allowlists the
modules where raw tx is legitimate (the `begin_immediate_logged`/`CommandTx` primitive in `db.rs`;
cache/** & fts/tag_inheritance rebuilds = derived data; materializer/handlers = self-recursion;
snapshot/recovery/sync transport = system-level; gcal_push externals); and honors a per-site
`// allow-raw-tx: <reason>` escape hatch. Per-site markers added to the 4 kept-raw command functions
(`set_page_aliases_inner`, `gcal_disconnect_inner`, `delete_property_def_inner`, `cmd_compact_op_log`).

**op_log/dag:** `op_log::append_local_op` + `dag::insert_merge_op` are still raw — the maintainer
flagged these as an API-refactor (take `&mut CommandTx`), distinct from the allowlist. Temp-marked
`// allow-raw-tx: pending op_log/dag CommandTx API refactor (#224)` + filed **#224** to track the
refactor. The lint guard lands now; #224 removes the markers later.

**Files touched:** `scripts/check-raw-tx.py` (new), `prek.toml`, + 6 comment-only marker edits
(`commands/{pages,gcal,properties,compaction}.rs`, `op_log.rs`, `dag.rs`).

**Verification:**
- Hook over the whole tree (`git ls-files 'src-tauri/src/*.rs'`) → **0 violations, exit 0**.
- Injected an unmarked raw `begin_with` in `commands/blocks/crud.rs` (prod scope) → hook **flagged + exit 1**; injection removed.
- `#[cfg(test)]` fixtures (e.g. `cross_space_validation.rs`'s 12 test-mod raw sites, `draft/tests.rs`) correctly skipped, while a prod-scope line in the same file is still caught.
- taplo lint + fmt --check pass on `prek.toml`. Commit exercised the new pre-commit hook live.

**Commit plan:** single commit, pushed, PR opened with `Closes #110` (op_log/dag tracked as #224).
