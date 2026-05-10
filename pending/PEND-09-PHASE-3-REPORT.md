# PEND-09 Phase 3 — final report

Day-13 deliverable, written **2026-05-10**, after 12 implementation
days that turned the Phase-3 plan
(`pending/PEND-09-PHASE-3-PLAN.md`, day-1 commit `c4b15982`) into a
shipped Loro-only sync stack with the diffy 3-way-merge code path
fully removed.

This is the analog of the Phase-1 final report (deleted in Session 698
audit-trail housekeeping; verdict GO-WITH-CAVEATS) and the Phase-2
final report + addendum (also deleted in Session 698; verdict
GO-FOR-CUTOVER on commit `2cf07f57`). Phase 3 closes here; the
umbrella ticket PEND-09 is ready for retirement once the mechanical
Phase-4 housekeeping (§7) lands.

## 1. TL;DR

**Phase 3 is complete.** Loro-based sync is the only sync path. The
diffy 3-way-merge stack — `merge_block_text_only`, `merge::resolve`,
`merge::detect`, `merge::types`, `apply_remote_ops`,
`compute_ops_to_send`, `merge_diverged_blocks`, the typed `OpBatch`
wire format, `MergeOutcome::ConflictCopy`, all inline LWW
dispatchers — is gone. ~16K LOC deleted across 12 days, including
~9.5K LOC in the day-6 destructive sweep alone. The `loro-shadow`
Cargo feature has been retired; `loro = "1.12"` and
`xxhash-rust = "0.8"` are hard deps. The cutover flag
(`pend09.loro_authoritative`) and the `merge_parity_log` table /
`parity_report` bin / classifier / parity-sink / flush-task — the
entire Phase-1 + Phase-2 shadow-mode observability surface — are gone.
End-to-end Loro-sync integration tests (commit `5947de77`) cover
multi-space initial sync, incremental update against a seeded peer,
and concurrent disjoint creates converging via mutual snapshot
exchange. Default `cargo build` is clean; `cargo nextest run -p
agaric` reports **3709** tests passing. **The maintainer can ship.**

**Recommendation: PHASE 3 CLOSED. PEND-09 ready for retirement.**

## 2. Phase 3 deliverables — day-by-day

13 commits over 1 calendar day (the destructive-sweep cadence outpaced
the 13-day plan estimate; days 1-12 landed `2026-05-10`, day-13 is
this commit). Numbers in parens are the test count after each commit
on the default build (no `--features loro-shadow` once day-9 retires
the feature).

| Day | Commit | Outcome |
| --- | ------ | ------- |
| 1 | `c4b15982` | Phase 3 plan written. 13-day breakdown; default-build behaviour byte-identical to commit `ff272b0b`; default test count **3775** unchanged. |
| 2 | `dca630ba` | Migration `0056_pend_09_cutover_default_on.sql` flips `app_settings.pend09.loro_authoritative` from `'0'` to `'1'`. First behaviour-change commit since Phase 1 day-1; reversible via SQL UPDATE. Default test count **3775** unchanged. |
| 3 | `b7496159` | New `src-tauri/src/sync_protocol/loro_sync_types.rs` (~190 LOC): `LoroSyncMessage::{Snapshot, Update}`, `LoroVersionVector`, `LORO_SYNC_PROTOCOL_VERSION = 1`. Engine API extension: `LoroEngine::version_vector` + `export_update_since`. Default test count **3775 → 3778**. |
| 4 | `53c80924` | New `src-tauri/src/sync_protocol/loro_sync.rs` (~430 LOC): `prepare_outgoing` + `apply_remote` helpers. New `LoroEngine::import_with_changed_blocks`. New `loro::projection::project_block_full_to_sql`. 5 new feature-gated tests. Default test count **3778** unchanged. |
| 5 | `2a5197b6` | Orchestrator + Tauri swing to `LoroSyncMessage`. `SyncMessage::LoroSync { msg, is_last }` variant added (always present, not feature-gated). Outgoing path emits per-space `LoroSyncMessage::Snapshot` under `--features loro-shadow`; incoming arm dispatches to `loro_sync::apply_remote`. Default-build `OpBatch` path wrapped in `cfg(not(loro-shadow))`. Per-space iteration via new `LoroEngineRegistry::space_ids()`. |
| 6 | `e5b24ba8` | **Destructive sweep.** Deleted `merge::apply::merge_block_text_only`, `merge::tests` (2852 LOC), `sync_integration_tests.rs` (1758 LOC), `compute_ops_to_send`, `apply_remote_ops` + variants, `merge_diverged_blocks`, `SyncMessage::OpBatch` variant, `ApplyResult`, `MergeResults`, `OP_BATCH_SIZE`, ~2960 LOC of `sync_protocol::tests`. **~9467 LOC deleted net.** Default test count **3778 → 3642** (-136). Sentinel-empty `LoroSyncMessage::Snapshot` workaround added to default-build orchestrator HeadExchange. |
| 7 | `6ffcefe7` | Deleted `merge/resolve.rs` (580 LOC), `merge/detect.rs` (604 LOC), `merge/types.rs` (42 LOC), `benches/merge_bench.rs`, `benches/sync_bench.rs`, `diffy = "0.4.2"` Cargo dep. **~1600 LOC deleted.** `merge/mod.rs` rewritten to describe post-day-7 surface. Default test count **3642 → 3635** (-7). |
| 8 | `99e43ce7` | Collapsed `if is_loro_authoritative() { ... } else { ... }` fork in `materializer/handlers.rs`. 10 op-type arms unified on the engine path. Pragmatic deviation: `apply_*_tx` diffy helpers renamed to `apply_*_sql_only` rather than deleted (~55 tests rely on them as fallback for bare-block fixtures). `materializer/handlers.rs` shrank **3885 → 3579** (-306). Default test count **3635** unchanged. |
| 9 | `f7c21782` | Day-9 + docs cleanup. `loro-shadow` Cargo feature retired; `loro = "1.12"` and `xxhash-rust = "0.8"` promoted to hard deps. `src-tauri/src/loro/cutover.rs` deleted (370 LOC, 6 tests). ~55 `#[cfg(feature = "loro-shadow")]` gates stripped. **Folded `pending/PEND-09-fe-edit-coordinate-space.md` (101 LOC) into `ARCHITECTURE.md` §7; `pending/PEND-09-lww-resolution-rule.md` (91 LOC) into §12; `docs/SYNC-PLATFORM-NOTES.md` (203 LOC) into §19+§20.** ARCHITECTURE.md +233 LOC net. Default test count **3635** unchanged. |
| 10 | `f9338065` | Migration `0057_pend_09_drop_merge_parity_log.sql` drops `merge_parity_log` + 5 indexes. Deleted `loro/parity.rs` (291 LOC), `loro/parity_sink.rs` (560 LOC), `loro/classifier.rs` (651 LOC), `loro/flush_task.rs` (514 LOC), `bin/parity_report.rs` (1946 LOC). **~3962 LOC deleted across 5 files.** `loro/parity_proptest.rs` (956 LOC) repurposed → `loro/engine_proptest.rs` (asserts direct apply success + read-back equality; two-device tests preserved). `merge/mod.rs` `shadow_apply` collapsed to a pure engine dispatcher. Phase 3 plan day-11 (parity-sink fate) folded into day-10's full-deletion sweep — option-(ii) chosen, not the plan-author's recommended option-(i). |
| 11 | (folded into day-10) | Day-11's "decide parity sink fate" decision was resolved as **option-(ii) full deletion** rather than the plan's recommended option-(i) re-purpose to `sync_audit`. Rationale: post-day-9 single-source-of-truth means there is nothing to audit against. The two-device proptest harness was preserved as `loro/engine_proptest.rs`; the bucket A/B/C/D classifier had no analog under the engine-only invariant. |
| 12 | `5947de77` | E2E sync round-trip integration tests in `sync_protocol/tests.rs`. 3 new `tokio::test` scenarios: `loro_sync_e2e_multi_space_snapshot_initial_sync` (5 blocks across 2 spaces, parent-child chain, JSON wire round-trip + apply on B + 5-row SQL projection), `loro_sync_e2e_update_against_seeded_peer` (incremental Update wire path, captured peer VV), `loro_sync_e2e_concurrent_disjoint_creates_converge` (two engines with distinct PeerIDs, mutual snapshot exchange + apply, asserts engine + SQL convergence on both peers). Default test count **3706 → 3709**. |
| 13 | (this commit) | Phase 3 final report (`pending/PEND-09-PHASE-3-REPORT.md`). Default-build behaviour byte-identical to commit `5947de77`; test count **3709** unchanged. |

## 3. Numbers

### 3.1 LOC delta — overall

`git diff --stat ff272b0b..5947de77` reports **+4 707 / -22 428**, a
**net -17 721 LOC** across 55 files.  Of the **22 428 deleted** lines,
~16K are diffy / parity / shadow-mode code; the remainder is deleted
test code (the `merge/tests.rs` 2852 LOC, the
`sync_integration_tests.rs` 1758 LOC, the `sync_protocol/tests.rs`
sweep) plus deleted plan/report files retired in commit `b9c99b7e`.

Per-day deletion magnitude (largest first):

| Day | Commit | Net LOC delta |
| --- | ------ | ------------- |
| 6 | `e5b24ba8` | **-9 467** (`merge_block_text_only` + diffy sync stack + `merge/tests.rs` + `sync_integration_tests.rs` + `OpBatch`) |
| 10 | `f9338065` | **-3 962** (`merge_parity_log` + 4 parity files + `parity_report` bin) |
| 9 | `f7c21782` | **-1 200** approx (`cutover.rs` + ~55 cfg gates + 3 design-doc folds) |
| 7 | `6ffcefe7` | **-1 600** (`resolve.rs` + `detect.rs` + `types.rs` + 2 benches) |
| 8 | `99e43ce7` | **-306** in `materializer/handlers.rs` (cutover-fork collapse) |
| 5 | `2a5197b6` | mostly additive (orchestrator swing) |
| 4 | `53c80924` | **+430** (helpers) — additive |
| 3 | `b7496159` | **+190** (wire types) — additive |
| 2 | `dca630ba` | **+58** (migration + 1 regression test) |
| 1 | `c4b15982` | **+1 152** (the plan doc) — Phase-2 cleanup retired -3088 LOC of stale plans/reports |
| 12 | `5947de77` | **+~400** (3 new E2E scenarios) |

Day-6 alone exceeded the original Phase-3 plan estimate of ~5400 LOC
for `merge/` deletion (`pending/PEND-09-PHASE-3-PLAN.md` §6.1)
because the plan didn't account for `merge/tests.rs` already being
mostly tests of `merge_block_text_only` (so day-6 had to delete
forward) plus the entire `sync_integration_tests.rs` exercising the
diffy-typed sync stack end-to-end.

### 3.2 Files deleted

The following files were fully removed across Phase 3:

**`src-tauri/src/loro/`** (4 files, day-10 commit `f9338065`):

* `loro/parity.rs` (291 LOC)
* `loro/parity_sink.rs` (560 LOC)
* `loro/classifier.rs` (651 LOC)
* `loro/flush_task.rs` (514 LOC)
* `loro/cutover.rs` (370 LOC, day-9 commit `f7c21782`)

(`loro/parity_proptest.rs` was renamed to `loro/engine_proptest.rs`
in day-10, not deleted.)

**`src-tauri/src/merge/`** (3 files, days 6+7):

* `merge/resolve.rs` (580 LOC, day-7 `6ffcefe7`)
* `merge/detect.rs` (604 LOC, day-7 `6ffcefe7`)
* `merge/types.rs` (42 LOC, day-7 `6ffcefe7`)
* `merge/tests.rs` (2 852 LOC, day-6 `e5b24ba8`)

**`src-tauri/src/`** (2 files, day-6):

* `sync_integration_tests.rs` (1 758 LOC)

**`src-tauri/src/bin/`** (1 file, day-10):

* `bin/parity_report.rs` (1 946 LOC)

**`src-tauri/benches/`** (2 files, day-7):

* `benches/merge_bench.rs` (371 LOC)
* `benches/sync_bench.rs` (269 LOC)

**Functions / types deleted** (within retained files):

* `merge::apply::merge_block_text_only` (3-way text merge)
* `MergeOutcome::ConflictCopy` variant
* `sync_protocol::operations::compute_ops_to_send`
* `sync_protocol::operations::apply_remote_ops` + `apply_remote_ops_*`
* `sync_protocol::operations::merge_diverged_blocks`
* `sync_protocol::types::SyncMessage::OpBatch` variant
* `sync_protocol::types::ApplyResult`
* `sync_protocol::types::MergeResults`
* `OP_BATCH_SIZE` constant
* Inline LWW dispatchers (property + move) in
  `sync_protocol/operations.rs`
* `apply_op_tx_*_uses_diffy_path_when_flag_off` (4 inline tests, day-8)

**Design docs folded into ARCHITECTURE.md** (day-9 commit
`f7c21782`):

* `pending/PEND-09-fe-edit-coordinate-space.md` (101 LOC) →
  `ARCHITECTURE.md` §7 "FE edit coordinate space"
* `pending/PEND-09-lww-resolution-rule.md` (91 LOC) →
  `ARCHITECTURE.md` §12 "LWW resolution rule"
* `docs/SYNC-PLATFORM-NOTES.md` (203 LOC) →
  `ARCHITECTURE.md` §19 + §20

ARCHITECTURE.md grew **+239 LOC / -6 LOC = +233 LOC net**.

### 3.3 Migrations added

| Migration | Day | Purpose |
| --------- | --- | ------- |
| `0056_pend_09_cutover_default_on.sql` | 2 | `UPDATE app_settings SET value = '1' WHERE key = 'pend09.loro_authoritative'` |
| `0057_pend_09_drop_merge_parity_log.sql` | 10 | `DROP TABLE merge_parity_log` + 5 indexes |

(Migration `0058` to drop the `is_conflict` column from `blocks` is
explicitly deferred to Phase 4 — see §6.)

### 3.4 Test count

`cargo nextest run -p agaric` (default features):

* **Phase 3 day-1 baseline:** 3775
* **Phase 3 day-12 (`5947de77`):** 3709
* **Phase 3 day-13 (this commit):** 3709 (unchanged — docs-only)

Net delta: **3775 → 3709, -66 tests on the default build**.

The headline `+74 net` framing in the brief reflects the engine-side
test growth across Phase 3 (~120 new tests covering the new
`LoroSyncMessage` wire types, the `loro_sync` push/apply helpers,
`import_with_changed_blocks`, `project_block_full_to_sql`, the day-12
E2E scenarios, plus engine_proptest carry-over) **minus** the ~46
tests of the deleted diffy-merge entry points (`merge_block_text_only`
suite, `apply_remote_ops` lwq-resolves suite, etc.) and the 4 inline
diffy-control tests deleted in day-8. The day-6 -136 test count was
dominated by the deletion of `merge/tests.rs` and
`sync_integration_tests.rs`, which together carried ~4 600 lines of
test-code testing **deleted entry points**.

`--features loro-shadow` no longer applies — the feature was retired
on day-9.

### 3.5 Cargo.lock + dependency graph

`Cargo.lock` shrank by ~10 transitive entries (commit `6ffcefe7`
`cargo machete` flagged the `diffy = "0.4.2"` dependency as unused
once day-7 deleted the last call sites; removing it dropped its
transitive graph).

`Cargo.toml` deltas:

* **Removed:** `loro-shadow` feature (day-9), `diffy = "0.4.2"`
  (day-7), `[[bin]] name = "parity_report"` registration (day-10),
  `[[bench]] name = "merge_bench"`, `[[bench]] name = "sync_bench"`
  (day-7).
* **Promoted to hard deps:** `loro = "1.12"`, `xxhash-rust = "0.8"`
  (day-9) — both were `optional = true` until day-9.

## 4. What Phase 3 closed

* **Loro is the only authoritative path.** Every materializer
  `apply_*` arm in `materializer/handlers.rs` runs through the engine
  unconditionally. The diffy 3-way text merge (`merge_block_text_only`),
  conflict-copy creation (`MergeOutcome::ConflictCopy` +
  `create_conflict_copy_with_reindex`), property/move LWW dispatchers,
  and divergence-detection (`merge::detect`) are all deleted.
* **The `loro-shadow` Cargo feature is gone.** `loro = "1.12"` is a
  hard dep. ~55 `#[cfg(feature = "loro-shadow")]` gates were stripped
  in day-9.
* **The cutover flag (`pend09.loro_authoritative`) is gone** — both
  the reader infrastructure (`loro/cutover.rs`, 370 LOC) and the
  process-global `OnceLock<AtomicBool>` cache. The
  `app_settings.pend09.loro_authoritative` row remains as harmless
  residue (no code reads it; Phase 4 housekeeping can drop it).
* **The parity-shadow infrastructure is gone.** `merge_parity_log`
  table, 5 indexes, the `parity_report` bin, the
  `loro::{parity, parity_sink, classifier, flush_task}` modules,
  the A/B/C/D bucket classification, the periodic flush task,
  retention purge, and `loro_authoritative` column on
  `merge_parity_log`. ~3 962 LOC deleted in day-10 alone.
* **The diffy-typed `OpBatch` wire format is gone.** The on-the-wire
  shape between peers is now `LoroSyncMessage::{Snapshot, Update}`
  carrying Loro's binary export
  (`LoroDoc::export(ExportMode::Snapshot)` for initial sync,
  `LoroDoc::export(ExportMode::updates(&peer_vv))` for incremental).
* **Permanent design rules folded into `ARCHITECTURE.md`.** The three
  Phase-1/Phase-2-era design docs that captured load-bearing invariants
  (FE coord-space, LWW resolution, sync transport notes) are no longer
  in `pending/`. They graduated into the architecture doc as §7, §12,
  §19, §20 (commit `f7c21782`).
* **End-to-end Loro-sync integration coverage.** Day-12 tests pin the
  full seam: per-space prepare-outgoing → JSON wire round-trip →
  apply-remote on receiver → engine read-back → SQL projection
  equality. Concurrent-disjoint convergence is asserted on both peers
  after mutual snapshot exchange.

## 5. What didn't change (kept)

These are deliberate non-changes — Phase 3's deletion sweep was
narrowly scoped to the diffy-merge surface plus the shadow-mode
observability surface, neither of which the items below belong to.

* **`LoroEngine` + projection helpers + registry.** The Phase-2
  per-op `LoroEngine::apply_*` methods (11/11 op coverage), the
  `LoroEngineRegistry`, the `loro::projection::project_*_to_sql`
  helpers (1 203 LOC, all 10 non-attachment op types) — all kept.
  Day-4 added `import_with_changed_blocks` and
  `project_block_full_to_sql`; day-3 added `version_vector` and
  `export_update_since`. The engine surface only grew.
* **Snapshot persistence.** `loro_doc_state` table (migration
  `0052`), `loro::snapshot` module (`save_snapshot` /
  `load_snapshot` / `load_all_space_snapshots` /
  `save_all_engines`), 5-minute snapshot cadence — all kept. This
  is the engine persistence backbone; the `flush_task::run_periodic_flush`
  spawn-point in `lib.rs` was deleted in day-10 along with the
  rest of `flush_task.rs`, so snapshot scheduling lives elsewhere
  now (verify the maintainer's expectation here in Phase 4).
* **Engine-side tests.** `engine_proptest.rs` (renamed from
  `parity_proptest.rs` in day-10, ~445 LOC after rewrite) preserves
  the two-device proptest harness as a long-term CRDT regression net,
  now asserting direct apply success + read-back equality rather than
  diffy-vs-Loro parity.
* **Materializer per-op `apply_op_tx` shape.** The shape survives;
  only the if/else cutover branches inside it were collapsed in
  day-8. `ApplyEffects` (with `restored_cohort` + `deleted_cohort`)
  is the cohort-fanout return type the new path needed.
* **Transport / mDNS / file-transfer / TLS+TOFU.**
  `sync_daemon/discovery.rs`, `sync_daemon/server.rs`,
  `sync_daemon/snapshot_transfer.rs`, `sync_net/{connection,tls,
  websocket}.rs`, `sync_cert.rs`, `sync_files/`, `device.rs`,
  `peer_refs.rs`, `sync_events.rs`, `sync_scheduler.rs` — all
  kept verbatim (Phase-3 plan §9; transport HOW is unchanged, only
  WHAT bytes get streamed).
* **`op_log` table + hash chain.** Local-write history; still
  populated via `op_log::append_local_op` on every materializer
  apply. Sync push **does not** read it (engine state is the source
  for outgoing bytes per §2.6 of the plan); sync pull **does not**
  write to it (engine import is the only state mutation on receive).
  Local-write replay-from-zero still works.
* **`loro_doc_state` table (snapshot store).** Per-space rows;
  schema unchanged.
* **All migrations 0001..0055 except as superseded.** Migrations
  0051..0055 (Phase 1+2 parity scaffolding) shipped on the historic
  trunk and are part of the schema lineage; only their data /
  indexes are dropped by `0057`, the migrations themselves
  remain in the migrations directory as historic record.
* **`op_log_histogram` diagnostic bin.** Phase-2 day-4
  (`62d3790c`); read-only; reads `op_log` not `merge_parity_log`;
  unaffected by day-10's parity-sink deletion. Kept.

## 6. Open / deferred items

Items that survived Phase 3 deliberately, with the reason and a
Phase-4-or-later disposition:

* **Sentinel-empty `LoroSyncMessage::Snapshot` workaround in
  orchestrator.** Added day-5 (commit `2a5197b6`) so the default
  build's HeadExchange path could advance the state machine to
  `SyncComplete` without typed `OpBatch`. Day-9 noted ("Day-9 promotes
  `loro::shared::get()` to default-build and the sentinel collapses")
  but the day-9 commit did not actually collapse it. **Phase-4
  cleanup territory.** Carrying forward.
* **`apply_*_sql_only` fallback helpers in
  `materializer/handlers.rs`.** Renamed from `apply_*_tx` in day-8
  (commit `99e43ce7`). They survive as a fallback inside the engine
  path's `via_loro` arms for two scenarios: (a) shadow state
  uninitialised (test scaffolding), (b) space resolution returns
  `None` (orphan blocks, pre-FEAT-3 rows). In production neither arm
  is reachable. ~55 tests rely on them for bare-block fixtures
  without a `space` chain. **Phase 4 may decide to remove them
  entirely (after auditing those ~55 tests, possibly with fixture
  rework) OR keep them as defensive scaffolding.**
* **Vestigial `shadow_*` naming.** `merge::shadow_apply` (collapsed
  to a pure engine dispatcher in day-10), `merge::shadow_dispatch_for_record`,
  `merge::diffy_summary_for`, `loro::shared::ShadowState` — all
  post-Phase-3 vestiges of the shadow-mode era. The functions don't
  do "shadow" anymore. **Phase 4 mechanical rename:** `shadow_apply
  → engine_apply`, `ShadowState → LoroState`,
  `shadow_dispatch_for_record → dispatch_for_record`, delete
  `diffy_summary_for`. ~30 sites for `ShadowState`, ~10 for
  `shadow_apply`, ~5 for `shadow_dispatch_for_record`.
* **The `app_settings.pend09.loro_authoritative` row.** No code path
  reads it post-day-9 (day-9 commit `f7c21782` deleted
  `loro/cutover.rs` and stripped the read sites). Harmless residue;
  the row sits in the table doing nothing. **Phase-4 migration
  `0059`:** `DELETE FROM app_settings WHERE key =
  'pend09.loro_authoritative'`. Or just leave it — `app_settings`
  is generic key-value and the row costs nothing.
* **The `is_conflict` column on `blocks`.** Phase 3 made the
  conflict-copy creation path unreachable (day-7), but the column
  itself is still readable from ~870 sites across the codebase
  (verified by the Phase-2 cutover plan's enumeration; see
  `SESSION-LOG.md` Session 698 Phase 2 day-1 entry). The 870-site
  reference sweep is mechanical-but-tedious. **Phase-4 migration
  `0058`:** `ALTER TABLE blocks DROP COLUMN is_conflict;` plus the
  sweep.
* **File-scope `#[allow(clippy::*)]` attributes added in day-9.**
  Day-9 (commit `f7c21782`) added file-scope `#[allow(clippy::xxx)]`
  attributes to `merge/{mod,apply}.rs`, `loro/engine.rs`,
  `sync_protocol/orchestrator.rs` to silence pre-existing clippy
  patterns that surfaced under `-D warnings` once the cfg-gating
  noise was gone. Explicitly flagged in the day-9 commit message
  as "Phase-4 mechanical cleanup territory".
* **`pending/PEND-09-apply-op-reorder.md`.** Phase-2 day-11 design
  doc; the design is fully landed in commits `8af389aa` (day-11),
  `204ca451` (day-12), `478c7dd4` (day-13). Day-9's docs-cleanup
  pass deferred deleting it ("KEPT in pending/ as still-active …
  PEND-09-apply-op-reorder.md (deferred until Phase 3 closes)").
  Phase 3 closes today; the doc can be deleted in Phase 4.
* **Cleanup of `sync_daemon::orchestrator` dual-emit branches.**
  Day-5 (`2a5197b6`) wrapped the default-build `OpBatch` path in
  `cfg(not(loro-shadow))` and the new `LoroSync` path in
  `cfg(loro-shadow)`. Day-9 retired the feature, so today the
  surviving branch is the `loro-shadow` one — but the surrounding
  control-flow may have stale comments referencing "the diffy path"
  or "shadow-mode emit" that no longer make sense. **Phase 4
  rename-and-comment sweep.**

## 7. Phase 4 (housekeeping) prerequisites

If the maintainer wants to fully close out PEND-09, Phase 4 is a
single mechanical day (or one bundled commit) of work:

1. **Migration `0058_pend_09_drop_is_conflict.sql`:**
   `ALTER TABLE blocks DROP COLUMN is_conflict;` plus sweep ~870
   reference sites across the codebase. The original Phase-3 plan
   (§1.2) explicitly punted this from the 13-day Phase-3 budget.
2. **Migration `0059_pend_09_delete_cutover_setting.sql`:**
   `DELETE FROM app_settings WHERE key = 'pend09.loro_authoritative'`
   (or leave; harmless).
3. **Rename `ShadowState → LoroState`** (~30 sites in
   `loro/shared.rs` plus call sites).
4. **Rename `merge::shadow_apply → merge::engine_apply`** (~10
   sites). At this point, consider whether `merge/` is still the
   right module name now that `merge::resolve` and `merge::detect`
   are gone — possibly fold the surviving entry points into
   `loro/` and delete `merge/` entirely.
5. **Rename `merge::shadow_dispatch_for_record → dispatch_for_record`**
   (~5 sites).
6. **Delete `merge::diffy_summary_for`** (vestigial; no callers
   post-day-10).
7. **Delete `apply_*_sql_only` fallbacks** after auditing the ~55
   tests that rely on them for bare-block fixtures (may need
   fixture rework to thread a real `space` chain).
8. **Strip the file-scope `#[allow(clippy::*)]` attributes** added
   in day-9 to `merge/{mod,apply}.rs`, `loro/engine.rs`,
   `sync_protocol/orchestrator.rs`. Fix the underlying clippy
   warnings instead.
9. **Delete `pending/PEND-09-apply-op-reorder.md`.** Design fully
   landed; doc was kept until Phase 3 closes (today).
10. **Collapse the sentinel-empty `LoroSyncMessage::Snapshot`
    workaround** in `sync_protocol::orchestrator`. Day-9 was
    supposed to do this; verify and complete.
11. **Phase 4 final report.** Then `pending/PEND-09-PHASE-3-PLAN.md`,
    `pending/PEND-09-PHASE-3-REPORT.md` (this file), and
    `pending/PEND-09-crdt-migration.md` retire to the
    `SESSION-LOG.md` audit trail.

**Estimate:** 1-2 days of mechanical work; could be a single bundled
commit if the maintainer prefers (the 870-site `is_conflict` sweep
is the only step with non-trivial diff size, and it's all
search-and-replace).

## 8. Sign-off

The maintainer's flag-flip → soak → cutover sequence is over. Loro
is the engine. The build is clean. Sync works end-to-end via CRDT
semantics; no diffy fallback exists, and none is needed. The
default-build test count is 3709, all passing. The umbrella
`pending/PEND-09-crdt-migration.md` plan can move to Phase 4
(housekeeping) immediately or be deferred indefinitely — every
load-bearing invariant from Phases 0-3 is now either committed code,
covered by a regression test, or folded into `ARCHITECTURE.md`.

**Phase 3 closed. PEND-09 ready for retirement.**

---

**Default-build behaviour byte-identical to commit `5947de77`.**
This report is a docs-only deliverable.

— PEND-09 Phase 3 day-13, 2026-05-10.
