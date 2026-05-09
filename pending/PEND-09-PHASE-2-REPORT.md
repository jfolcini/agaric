# PEND-09 Phase 2 — Cutover-plumbing report (flag-flip go/no-go)

Two-week (planned 10-day plus 2 sub-days) Phase 2 closure deliverable.
Day 1 → day 10 + day-8.5 + day-9.5 complete on 2026-05-09.
Synthesis deliverable; the user reads this to decide whether the
cutover plumbing is solid enough to commit to the actual `apply_op`
reorder. All claims cited back to the Phase-2 day-1 plan
(`pending/PEND-09-PHASE-2-CUTOVER-PLAN.md`, commit `6de54fa7`), the
Phase-1 closure (`pending/PEND-09-PHASE-1-REPORT.md`, commit
`c6666d9d`), the spike-archive notebook
(`pending/PEND-09-SPIKE-NOTES.md` + `pending/PEND-09-SPIKE-REPORT.md`,
both moved out of the now-archived `src-tauri/crates/loro-spike/` in
day 8 — see git tag `pend-09/spike-archive` →
`3e8a1267`), and the thirteen Phase-2 commits enumerated in §2 below
(twelve day-rows plus the day-10 test-coverage follow-up `e6ae744e`).

## 1. TL;DR

**Recommendation: GO-WITH-PREREQUISITES for the cutover flag-flip.**
Dated **2026-05-09**.

The Phase-2 cutover **plumbing** is operationally complete:

- The `loro_authoritative` runtime flag exists, persists in
  `app_settings` (`src-tauri/migrations/0053_pend_09_app_settings.sql`),
  reads sub-100 µs from a `OnceLock<AtomicBool>` cache
  (`src-tauri/src/loro/cutover.rs:78`, regression-tested at
  `cutover.rs:298-311` with 1 000-iter timing).
- Per-space `LoroDoc` snapshots persist in `loro_doc_state`
  (migration `0052_pend_09_loro_doc_state.sql`, scheduler at
  `src-tauri/src/loro/snapshot.rs`, 5-minute cadence at
  `flush_task::SNAPSHOT_INTERVAL_SECS = 300`).
- Boot rehydrate is now **synchronous**
  (`tauri::async_runtime::block_on` at `src-tauri/src/lib.rs` setup
  block, day-9 commit `d0395805`) — the day-6 reviewer's
  fire-and-forget gap is closed.
- The `LoroEngine` covers all 12 production op-types after the
  day-8.5 expansion (`src-tauri/src/loro/engine.rs:1492` LOC vs
  Phase-1's 871; +5 apply methods for tags, restore, purge,
  delete-property — commit `c09bd8cb`). Attachments deliberately
  remain log-and-skip (file-blob ops outside CRDT state).
- Restore-cascade asymmetry (day-8.5 reviewer's flag #1: SQL walks
  the descendant CTE; engine was per-block-id) is closed via
  materializer-side fanout (`src-tauri/src/materializer/handlers.rs`
  `dispatch_restore_descendants_shadow`, commit `d0395805`).
- Two-device concurrent-merge proptests landed
  (`src-tauri/src/loro/parity_proptest.rs`, +4 tests under
  `#[cfg(all(test, feature = "loro-shadow"))]`, commit `a9849adc`):
  256 cases × 4 streams = 1 024 randomised two-device runs, **zero
  D-bucket sightings**.
- Diagnostic surface: `op_log_histogram` (commit `62d3790c`) and
  `parity_report` (commit `3e8a1267`) bins compile in default
  builds and are read-only against `notes.db`.
- Spike crate retired (commit `4c5e9cc9`), tag
  `pend-09/spike-archive` → `3e8a1267`. `pending/PEND-09-SPIKE-*.md`
  preserved.
- Cross-platform RSS reading on the replay bench (commit
  `2ad8e5bc`) — Linux re-run reproduces the kill-criterion-#3
  144 MiB peak within 0.003 %; macOS / Windows code paths in place.

**The prerequisite gating GO is the actual `apply_op` reorder.** The
flag exists; the engine covers every op type; the snapshot scheduler
is wired; the diagnostic bins are deployed; but **no code path
currently branches on `is_loro_authoritative()`**. Verified
2026-05-09 by `grep -rn 'is_loro_authoritative' src-tauri/src/` —
the only readers are the `cutover.rs` test module
(`cutover.rs:239,248,257,260,274,298`) and the docstring blocks.
The Phase-2 day-9 commit `d0395805` deliberately scoped the reorder
out as a "separate substantive day" (commit message paragraph 2);
day-9.5 (`eb01c5f8`) then surfaced and fixed a load-bearing latent
bug (§5) that meant the foundation wasn't actually solid until
2026-05-09 evening. Until the reorder lands, flipping the flag to
`'1'` changes nothing observable. **The flag-flip cannot happen
until the reorder is implemented.** §4 estimates 1-2 days of
build + review.

The other prerequisite is calendar-time: the **7-day real-`notes.db`
shadow-mode soak** (Phase-1 §4 item 1, Phase-2 plan Gate 1) cannot
start until the day-9.5 dispatcher fix (`eb01c5f8`) is running on
the maintainer's primary workstation, because every prior soak
window's `merge_parity_log` rows are no-op data (§5).

If the maintainer is willing to run the reorder day(s) and then a
≥7-day post-reorder soak, the cutover commit is the default
outcome. If a real-user D-bucket appears post-soak, the
recommendation flips to **NO-GO** per the cutover-plan §3 day-11+
hard floor; the flag-off rollback is a single-row SQL UPDATE.

## 2. Phase 2 deliverables

| Day | Date | Commit | Headline outcome |
| --- | ---- | ------ | ---------------- |
| 1 | 2026-05-09 | `6de54fa7` | Cutover plan written: `pending/PEND-09-PHASE-2-CUTOVER-PLAN.md`, ~900 lines covering 8 readiness gates + day-by-day sequence + rollback + kill-switch + Phase-3 hand-off + 7 user-decision items + 7 open questions; default 3734, feature-on 3774 (both unchanged). |
| 2 | 2026-05-09 | `a9849adc` | Two-device concurrent-merge proptests: 4 new tests under `parity_proptest.rs` (`two_device_concurrent_create_only_stream_loro_converges`, `..._edit_same_block_loro_converges`, `..._set_property_loro_lww_wins`, `..._move_loro_lww_wins`); 256 cases × 4 streams = 1 024 runs, zero D-bucket sightings; default 3734, feature-on 3774 → 3778 (+4); closes Phase-2 plan Gate 2. |
| 3 | 2026-05-09 | `9d780586` | `loro_bytes: Vec<u8>` envelope field (`src-tauri/src/loro/envelope.rs`); `CURRENT_LORO_VERSION` 1 → 2; `LoroBatch::with_loro_bytes(...)` constructor; back-compat decode test using a `V1Envelope` mirror struct serialised through `serde_json` (real v1 bytes); default 3734, feature-on 3778 → 3782 (+4); closes Phase-2 plan Gate 3. |
| 4 | 2026-05-09 | `62d3790c` | `op_log_histogram` diagnostic bin (`src-tauri/src/bin/op_log_histogram.rs`): read-only `SqliteConnectOptions::filename(...).read_only(true)`, deterministic ordering (`count DESC, op_type ASC`), ASCII-only output, comparison against the spike's 30/50/10/5/5 proxy with `[over]` / `[under]` / `[not-in-proxy]` / `[absent-in-actual]` flags; default 3734 → 3749 (+15), feature-on 3782 → 3797 (+15); closes Phase-2 plan Gate 4. Day-9 added the read-only contract test (see day 9). |
| 5 | 2026-05-09 | `2ad8e5bc` | Cross-platform RSS measurement on replay bench: replaces Linux-only `/proc/self/statm` parse with `memory-stats = "1.2"` (Linux/macOS/Windows/FreeBSD); Linux re-run reports `peak_rss_kib=147784` ≈ 144.30 MiB vs Phase-0 day-4's 144.32 MiB (0.003 % delta); kill criterion #3 unchanged with ≈14× margin; bench output gains machine-readable `key=value` summary stanza; default 3734 (unchanged — `memory-stats` lives only in spike crate, verified by `cargo tree -p agaric -i memory-stats`); closes Phase-2 plan Gate 5. |
| 6 | 2026-05-09 | `88323c8e` | `loro_doc_state` snapshot persistence: migration `0052_pend_09_loro_doc_state.sql` (STRICT table, columns `(space_id PK, snapshot BLOB, updated_at, op_count)` + index on `updated_at`); new module `src-tauri/src/loro/snapshot.rs` with `save_snapshot` / `load_snapshot` / `load_all_space_snapshots` / `rehydrate_registry` / `save_all_engines`; `LoroEngineRegistry::install_engine` + `snapshot_all_engines` (collect-under-mutex, save-without); `flush_task::run_periodic_flush` extended with `snapshot_interval` (default `SNAPSHOT_INTERVAL_SECS = 300`); boot setup spawns `rehydrate_registry` before periodic-flush loop (option C — eager-load on boot); reviewer flagged async-fire-and-forget for cutover (closed in day 9); default 3749 (unchanged), feature-on 3797 → 3807 (+10); closes Phase-2 plan Gate 6. |
| 7 | 2026-05-09 | `3e8a1267` | `parity_report` diagnostic bin (`src-tauri/src/bin/parity_report.rs`): read-only against `notes.db`; `sqlite_master` probe refuses to auto-run migrations against a non-shadow-build DB (exit 2); sections — header (date range + total events), bucket counts (NULL/unclassified first), op-type breakdown (count DESC, op_type ASC), recent divergent ops (`bucket IN ('C','D') ORDER BY created_at DESC, id DESC LIMIT 20`), verdict line (OK/ALERT); ASCII-only, pipe-friendly; hand-rolled `fmt_timestamp_ms` (Howard Hinnant days-from-civil) avoids pulling a date crate; `pad_right_chars` uses char-count padding; default 3749 → 3768 (+19), feature-on 3807 → 3826 (+19); closes Phase-2 plan Gate 7. |
| 8 | 2026-05-09 | `4c5e9cc9` | Spike-crate archive: annotated tag `pend-09/spike-archive` → `3e8a1267` (the latest spike-touching commit, after day-5 RSS swap and day-7 `parity_report` doc-link updates); `SPIKE-REPORT.md` → `pending/PEND-09-SPIKE-REPORT.md`, `SPIKE-NOTES.md` → `pending/PEND-09-SPIKE-NOTES.md` (with archive notes + recovery instructions at top, internal sibling links rewritten); removed `crates/loro-spike` from `[workspace] members`; deleted 12 spike source files (~362 KiB); updated 5 `pending/*.md` files + comments in `src/lib.rs` / `src/loro/{mod,engine,parity_proptest}.rs` / `benches/loro_vs_sql_reads.rs`; `cargo test -p loro-spike` correctly errors with "package not found"; `cargo machete` clean; tag NOT pushed; default 3768 (unchanged); closes Phase-2 plan Gate 8. |
| 8.5 | 2026-05-09 | `c09bd8cb` | Engine op-coverage expansion: 5 new apply methods on `LoroEngine` — `apply_add_tag` (manual dedup walk; idempotent), `apply_remove_tag` (idempotent on missing/empty), `apply_restore_block` (clears `deleted_at` to `Null`; silent no-op on unknown block, matches SQL `UPDATE`-zero-rows), `apply_purge_block` (cascades blocks + block_properties + block_tags; per-block scope), `apply_delete_property` (distinct from `set_property(value=None)`); plus `read_tags` companion; `merge::shadow_apply` extended with 5 new dispatch arms; `diffy_summary_for` extended with typed summaries (`add_tag:bid:tid`, `remove_tag:bid:tid`, `restore:bid`, `purge:bid`, `delete_property:bid:key`) so bucket A is reachable; tags as `LoroMap<block_id, LoroList<String>>` under `block_tags` root; attachments intentionally remain log-and-skip (file-blob ops outside CRDT state); reviewer flagged real day-9 cutover blocker on restore-cascade asymmetry (closed in day 9 via materializer fanout); reviewer killed all 3 mutations; default 3768 (unchanged), feature-on 3826 → 3848 (+22). Closes the §8.2 op-type-engine-coverage gap from the cutover plan. |
| 9 | 2026-05-09 | `d0395805` | Cutover-toggle infrastructure (load-bearing day): migration `0053_pend_09_app_settings.sql` (STRICT key-value table seeded with `pend09.loro_authoritative = '0'`); new `src-tauri/src/loro/cutover.rs` (317 LOC, feature-gated): `is_loro_authoritative()` (sub-100 µs `OnceLock<AtomicBool>`), `init_cutover_flag(pool)` (populate cache from `app_settings`), `set_loro_authoritative(pool, value)` (update row + cache), `cache_read_is_sub_100_microseconds` 1 000-iter timing test; **boot ordering fix** (day-6 reviewer flag #1) — rehydrate is now SYNCHRONOUS via `tauri::async_runtime::block_on` BEFORE `recover_at_boot`; `shared::init` + `rehydrate_registry` + `init_cutover_flag` run sequentially in `#[cfg(feature = "loro-shadow")]` setup block, the long-running `run_periodic_flush` remains `tauri::async_runtime::spawn`'d; **restore cascade fanout** (day-8.5 reviewer flag #1) — `ApplyEffects { restored_cohort }` returned from `apply_op_tx`, `collect_restore_cohort` SELECT, `dispatch_restore_descendants_shadow` fans out one `shadow_apply` call per cohort entry (cohort INCLUDES seed for idempotency-via-redundancy under the latent JSON bug — see §5); **read-only contract test** (day-4 reviewer flag) — `read_only_pool_rejects_writes` opens a pool with `read_only(true)` and asserts INSERT fails with a "readonly" message; commit message documents the latent JSON-parse bug surfaced by the day-9 reviewer (closed in day 9.5). **The actual `apply_op` reorder is NOT in this commit** — explicitly deferred to a separate day (commit message paragraph 2). Default 3768 → 3769 (+1), feature-on 3848 → 3855 (+7). |
| 9.5 | 2026-05-09 | `eb01c5f8` | **CRITICAL** — repair `shadow_dispatch_for_record` JSON parse: latent bug verified by the day-9 reviewer; every op via the materializer hot path was silently failing the JSON parse since Phase 1 day 2 (commit `dcfc3637`, ~14 days). Root cause: `OpPayload` is `#[serde(tag = "op_type")]` (internally tagged), but `op_log::serialize_inner_payload` strips the tag (it lives in the `op_log.op_type` column). `serde_json::from_str::<OpPayload>(&record.payload)` ALWAYS fails — parse needs the tag, JSON doesn't have it; function logged a `tracing::warn!` and silently returned. Integration tests build typed `OpPayload`s in-memory and call `shadow_apply` directly — they bypassed the JSON round-trip and didn't catch it. Fix: branch on `record.op_type`, parse the corresponding inner-only payload struct (mirroring `materializer/handlers::apply_op_tx` arms); all 12 op types covered (`src-tauri/src/merge/apply.rs:186-260`-ish). Two regression tests built through the production `op_log::append_local_op` write path (`shadow_dispatch_for_record_applies_create_block`, `shadow_dispatch_for_record_applies_edit_and_set_property`) plus a precondition tripwire asserting the persisted payload has no `op_type` field. Reviewer killed all 3 mutations. Default 3769 (unchanged), feature-on 3855 → 3857 (+2). See §5 for the data-integrity implications. |
| 10 | 2026-05-09 | `6edf5a39` + `e6ae744e` | Partial index for classifier scan: migration `0054_pend_09_classifier_partial_index.sql` (`CREATE INDEX idx_merge_parity_log_unbucketed ON merge_parity_log (id) WHERE bucket IS NULL`); closes the Phase-1 §7 item 5 follow-up (day-6 classifier's `WHERE bucket IS NULL` SELECT now probes a partial index instead of full-scanning `merge_parity_log`); index keyed on `id` (the column the SELECT reads); on-disk size minimal in steady state (divergent ops typically <1 % of total events); `EXPLAIN QUERY PLAN` regression test `classify_unbucketed_uses_partial_index_for_query` inserts 1 000 mixed-bucket rows and asserts the planner uses the index (`SCAN merge_parity_log USING INDEX idx_merge_parity_log_unbucketed`); SQLite has supported partial indexes since 3.8.0 (2013); follow-up commit `e6ae744e` extracts the production SELECT into a shared `const SELECT_UNBUCKETED_SQL` so the EXPLAIN test reads the exact production string (closes a day-10-reviewer gap where mutating only the production SELECT did not fail the test); default 3769 (unchanged — migration runs on every DB but the classifier is feature-gated, so no new default-build test), feature-on 3857 → 3858 (+1). |

**Total Phase 2 commit count: 12 code-bearing commits (13 if day-1
plan-doc commit is counted, which it is in the table above; day-10
ships as two commits — `6edf5a39` for the migration + classifier
work and `e6ae744e` for the test-coverage follow-up extracting
`SELECT_UNBUCKETED_SQL`).**
Default-build verdict: clean throughout, `loro` dependency NOT in
default `cargo tree`. `--features loro-shadow` build verdict: clean
throughout; the spike crate is no longer in the workspace
(`cargo machete` clean as of day 8).

**Net feature-on test delta: +84 (Phase 1 close 3774 → Phase 2
close 3858).** Per-day net deltas above: +4 (d2) +4 (d3) +15 (d4)
+0 (d5) +10 (d6) +19 (d7) +0 (d8) +22 (d8.5) +7 (d9) +2 (d9.5) +1
(d10) = +84. Matches arithmetic.

**Net default test delta: +35 (3734 → 3769).** Per-day net deltas:
+0 +0 +15 (d4) +0 +0 +19 (d7) +0 +0 +1 (d9) +0 +0 = +35.

## 3. Pre-cutover gates — final status

Cross-reference to `pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §2
(the 8 readiness items). Each gets one of three statuses:

- **Closed** — landed in Phase 2; cite the commit.
- **Calendar-time** — closed by code; needs user-time to actually
  run.
- **Open** — material gap that blocks cutover; cite specific
  blocker.

| Plan gate | Phase-2 status | Closing artifact / remaining exposure |
| --------- | -------------- | ------------------------------------- |
| Gate 1 — 7-day real-`notes.db` shadow-mode soak | **Calendar-time + dependency on §5 fix** | The classifier + flush + sink stack is all closed (Phase 1 + day 10 partial index `6edf5a39`). The actual 7-day soak has not started. **Material caveat:** any soak before the day-9.5 fix (`eb01c5f8`) is moot — `loro_result` rows from before today reflect always-empty engine state (§5). Soak window starts 2026-05-09 evening at the earliest. |
| Gate 2 — Two-device concurrent-merge proptests | **Closed** | Day-2 commit `a9849adc`; 1 024 runs, zero D-bucket sightings; seeds checked in under `proptest-regressions/loro/`. |
| Gate 3 — `loro_bytes: Vec<u8>` envelope schema | **Closed** | Day-3 commit `9d780586`; `CURRENT_LORO_VERSION` 1 → 2; v1 row decodes to v2 struct with empty bytes; v2 with empty bytes serialises as v1. |
| Gate 4 — Op-log volume sampling | **Closed (code) + Calendar-time (run)** | Day-4 commit `62d3790c` ships `op_log_histogram` bin; the actual histogram run against the maintainer's real `notes.db` is calendar-time. The wide kill-criterion margin (358× wall-clock, 14× heap) means this is about *knowing*, not gating. |
| Gate 5 — macOS / Windows RSS measurement | **Closed (code) + Calendar-time (mac re-run)** | Day-5 commit `2ad8e5bc`; Linux re-run pasted into commit message and reproduces 144 MiB peak within 0.003 %; macOS / Windows code paths in place via `memory-stats` crate; an actual macOS re-run is sign-off completeness, not risk reduction (14× margin). |
| Gate 6 — `loro_doc_state` storage decision + migration | **Closed** | Day-6 commit `88323c8e`; migration `0052`, snapshot module, scheduler at 5-minute cadence (`SNAPSHOT_INTERVAL_SECS = 300`); rehydrate-on-boot now synchronous via day-9's `block_on`; cadence decision is option (c)-flavored — periodic snapshots from the flush task, plus eager-load on boot, with rebuild from `op_log` as the safety net (cutover plan §8.1). |
| Gate 7 — `agaric debug parity-report` diagnostic | **Closed** | Day-7 commit `3e8a1267`; `parity_report` bin compiles in default builds, read-only against `notes.db`, deterministic ordering, ASCII-only output, OK/ALERT verdict line. |
| Gate 8 — Spike-crate archive | **Closed** | Day-8 commit `4c5e9cc9`; tag `pend-09/spike-archive` → `3e8a1267` (annotated, tag object `f849c06a`); `pending/PEND-09-SPIKE-{NOTES,REPORT}.md` preserved; spike workspace member removed; `cargo machete` clean. Tag NOT pushed (user decision). |

**8.5 (cutover-plan day 8.5 — engine op-type coverage gap):**
**Closed** by `c09bd8cb`. The cutover plan §8.2 flagged this as
"the single biggest risk to the day-9 schedule"; it landed cleanly
1 day late.

**Day 9 — cutover toggle infrastructure:** **Closed for the flag
plumbing** (`d0395805`); **but the actual `apply_op` reorder is
NOT closed** (§4 below). The plan's §3 day-9 block calls for
"`apply_op` and `apply_batch_ops` reorder so the LoroEngine apply
runs **before** `apply_op_tx`" plus "`apply_op_tx` skips its own
merge logic; instead reads resolved post-Loro state from the
per-space `LoroEngine` and projects directly into `blocks` /
`block_properties` / `block_tags` rows". Day 9 delivered the
infrastructure (flag + boot-ordering fix + restore-cascade
fanout + read-only contract test) but **not the reorder itself**
— the
day-9 commit message paragraph 2 explicitly defers it.

**Day 9.5 — JSON-parse repair:** **Closed** by `eb01c5f8`. Not in
the original cutover plan because it was not a known gap at
plan-write time; surfaced by the day-9 reviewer. See §5 for full
incident write-up.

**Day 10 — partial index:** **Closed** by `6edf5a39`. Was a
Phase-1 §7 item 5 follow-up; landed on schedule.

## 4. What's left before flipping the flag

Three items, in order of effort.

### 4.1 The `apply_op` reorder

**The big one.** Today the `loro_authoritative` flag exists, the
read is sub-100 µs, but **no code path branches on it**. Verified
2026-05-09 by `grep -rn 'is_loro_authoritative' src-tauri/src/`:
the only readers are inside the `cutover.rs` test module
(`cutover.rs:239,248,257,260,274,298`) and a docstring. The
materializer hot path (`src-tauri/src/materializer/handlers.rs`
`apply_op` and `BatchApplyOps` arms) **always** runs
`apply_op_tx` first and the post-commit `shadow_apply` second,
regardless of the flag value.

The reorder needs to do, when `is_loro_authoritative()` returns
true:

1. **Loro apply runs first.** The per-space `LoroEngine`
   (`src-tauri/src/loro/engine.rs`, 1 492 LOC after day-8.5)
   applies the op into the `LoroDoc` **before** any SQL projection
   runs.
2. **The materializer projects from Loro state into SQL.** The
   `blocks`, `block_properties`, `block_tags` tables, and the
   four hot-path columns (`todo_state`, `priority`, `due_date`,
   `scheduled_date`) are written by reading the post-apply Loro
   state and projecting into SQL. The diffy `apply_op_tx` body
   (and its merge-logic dependents — `merge::merge_block_text_only`
   at `merge/apply.rs:47-140`, `merge::resolve_property_conflict`
   at `merge/resolve.rs:224+`, the move-LWW dispatcher at
   `sync_protocol/operations.rs:699-822`, the property-LWW
   dispatcher at `sync_protocol/operations.rs:515-697`) becomes
   reachable only on the `is_loro_authoritative() == false` arm —
   the feature-gated fallback.
3. **`block_links` and `block_tag_inherited` re-derive.** Both
   are derived caches today (`cache::reindex_block_links` at
   `src-tauri/src/cache/block_links.rs`,
   `cache::reindex_block_tag_refs` for tag inheritance); the
   cutover plan §3 day 9 confirms they re-derive correctly from
   the Loro-projected `blocks.content` / parent-relationship.
   No new Loro container required.

The cutover plan §8.4 raised two reorder shapes: **Option A** —
`apply_op` becomes `loro_apply` → `apply_op_tx (now reads from Loro
state)`. **Option B** — `apply_op` becomes `loro_apply` →
`project_from_loro_to_sql` (a new function bypassing
`apply_op_tx`). The plan suggested Option B as cleaner. The
choice is still open; the day-9 commit did not decide it because
the reorder was deferred.

**Why it wasn't done in Phase 2.** Three reasons:

1. **Size of change.** Option B requires writing
   `project_from_loro_to_sql` from scratch (~200-400 LOC per
   the cutover plan §8.4); Option A requires editing every code
   path inside `apply_op_tx` that "knows" diffy is authoritative
   — a much larger churn surface. Either way, the change is
   substantial enough to deserve its own review cycle.
2. **Latent-bug discovery (§5) shifted the foundation.** The
   day-9 reviewer's flag exposed that ~14 days of shadow-mode
   work was a no-op via the materializer hot path. Until day-9.5
   (`eb01c5f8`) shipped, building the reorder on top of an
   untested shadow-write path would have layered uncertainty on
   uncertainty.
3. **Day-9's own deliverable was already substantial.** Day-9
   landed three reviewer-flagged prerequisite fixes (boot ordering,
   restore cascade, read-only contract) plus the toggle module
   plus a new migration. Adding the reorder on top would have
   inflated the commit beyond reviewable size.

**Estimate.** Realistically 1-2 days of build + review for the
reorder itself, assuming Option B (cleaner) and assuming the
existing engine surface (12 op types, day-8.5 expansion) covers
every shape `project_from_loro_to_sql` needs to write. The
attachment ops remain log-and-skip per the cutover plan §8.2 —
they do not block the reorder because they don't write
CRDT-merged state.

### 4.2 The 7-day shadow-mode soak

Calendar-time. Cutover plan Gate 1; Phase-1 §4 item 1. The
classifier + flush + sink stack is all closed. The 7-day window
starts when the day-9.5-fixed dispatcher begins running on the
maintainer's primary workstation. **It cannot have started before
2026-05-09 evening** because every prior soak run was producing
no-op data (§5).

Closing artifact per the plan: a `SELECT bucket, COUNT(*),
MAX(created_at) FROM merge_parity_log WHERE created_at > ? GROUP
BY bucket` result pasted into the cutover commit message, plus a
table dump archived alongside. The day-7 `parity_report` bin
(`3e8a1267`) automates this query.

### 4.3 The pre-day-9.5 `merge_parity_log` data integrity issue

Before today, the dispatcher was silently failing JSON parse on
every op (§5). Every `merge_parity_log` row written before
`eb01c5f8` has `loro_result` reflecting always-empty engine state.
Some are bucketed B/C/D from the classifier's perspective; all of
them are garbage data for parity analysis purposes. **Recommend
purging `merge_parity_log` before the next parity audit /
cutover-soak.** A single SQL DELETE is sufficient; the table is
not load-bearing for any other code path. User decision item §7.5
below.

## 5. Critical incident — the latent JSON-parse bug

This deserves its own section. Discovered by the day-9 reviewer;
fixed in commit `eb01c5f8` (day 9.5).

### 5.1 Root cause

`shadow_dispatch_for_record` (`src-tauri/src/merge/apply.rs:157`)
was calling
`serde_json::from_str::<OpPayload>(&record.payload)`. `OpPayload`
is declared `#[serde(tag = "op_type")]` (internally tagged), so
the parse demands a `"op_type": "..."` field in the JSON. But
`op_log::serialize_inner_payload` deliberately strips the tag —
the op-type discriminator lives in the `op_log.op_type` column,
not in the JSON blob. Therefore the parse **always failed** on a
production-shape payload.

The function logged a `tracing::warn!` and returned silently. No
op via the materializer hot path reached the `LoroEngine`. The
broken state was introduced in Phase 1 day 2 commit `dcfc3637`
("shadow_apply call-site wiring") and persisted ~14 days, through
all of Phase 1 days 2-10 and Phase 2 days 1-9.

### 5.2 How it was caught

The day-9 reviewer ran an isolated repro: serialise a typed
`CreateBlockPayload` through `op_log::append_local_op`, then read
the row back and feed `record.payload` to
`from_str::<OpPayload>`. The parse errored. A mutation test
(removing the `apply_create_block` call inside the dispatcher's
`OpPayload::CreateBlock` arm) failed to trip any test, confirming
no test exercised the JSON path through the dispatcher to the
engine.

### 5.3 How it was fixed

Day-9.5 commit `eb01c5f8`:

1. Branch on `record.op_type` (the dedicated `op_log` column).
2. Parse the corresponding inner-only payload struct
   (`crate::op::CreateBlockPayload`,
   `crate::op::EditBlockPayload`, etc.) — mirroring the
   per-variant pattern in
   `materializer/handlers::apply_op_tx`'s match arms.
3. Re-wrap as `OpPayload` so the rest of
   `shadow_dispatch_for_record` (block-id extraction, space
   resolve, `shadow_apply` call) is untouched.

All 12 op types covered:
`create_block`, `edit_block`, `delete_block`, `restore_block`,
`purge_block`, `move_block`, `add_tag`, `remove_tag`,
`set_property`, `delete_property`, `add_attachment`,
`delete_attachment` (the last two still log-and-skip downstream
in `shadow_apply`, but they now reach the dispatcher cleanly —
unknown-`op_type` returns are a separate arm).

Two regression tests built through the production
`op_log::append_local_op` write path so the JSON round-trip is
exercised end-to-end:
`shadow_dispatch_for_record_applies_create_block` (with a
precondition tripwire asserting the persisted payload has no
`op_type` field — so a future change to
`serialize_inner_payload` that re-introduces the tag would trip
the tripwire, not the dispatcher) and
`shadow_dispatch_for_record_applies_edit_and_set_property`
(chains Create + Edit + SetProperty to verify multi-op state).

Reviewer killed all 3 mutations (skip create_block; corrupt edit
to_text; skip set_property).

### 5.4 What the fix changed

Now ALL 12 op types reach the engine via the materializer hot
path. Pre-fix, **only** ops constructed in-memory inside
integration tests (which built typed `OpPayload`s and called
`shadow_apply` directly, skipping the JSON round-trip) actually
exercised the engine. Day-9's restore-cascade fanout fixed the
restore arm by parsing `RestoreBlockPayload` directly inside the
fanout helper — so restore was the one arm working pre-day-9.5.
Every other op type was dead-on-arrival via the hot path; the
day-8 proptests (which call `LoroEngine` directly and bypass
`shadow_dispatch_for_record`) caught nothing.

### 5.5 Data integrity

Pre-day-9.5 `merge_parity_log` rows reflect always-empty engine
state. Specifically:

- The `diffy_result` column is correct — diffy was authoritative
  throughout, and the diffy summary was computed before the
  shadow dispatch even ran.
- The `loro_result` column is `error:Validation(...)` (or similar
  empty-state stub) for every row, because the engine never saw
  the op so its read-back returned the pre-op state.
- The `bucket` classifier therefore filed essentially every op as
  D (loro non-conflict + non-error mismatch with diffy) or B —
  but the bucketing is structurally meaningless because the input
  to one of the two halves was a no-op.

**Recommendation: purge `merge_parity_log` before the next parity
audit / cutover-soak.** The table is not load-bearing for any
other code path. The diffy authoritative path was unaffected
throughout; this is **not** a correctness issue. The data is just
garbage for analysis purposes. User decision item §7.5 below.

### 5.6 Process improvement

The integration tests that "exercised the engine" through Phase 1
days 2-10 and Phase 2 days 1-8 were testing through `shadow_apply`
directly with typed `OpPayload`s, not through the full op-log →
materializer → `shadow_dispatch_for_record` path. **The tests had
the wrong contract surface.** They covered `LoroEngine` correctness
and `shadow_apply` correctness, but not the JSON serialisation
path between them — which is the path used in production.

**Phase 3 prerequisite (recommended):** every shadow-write test
should drive through `op_log::append_local_op` (or an equivalent
helper that goes through the full serialisation path), not
through in-memory `OpPayload` construction. Day-9.5's two new
tests are the right shape; they should become the template.

The mutation-testing discipline caught the bug eventually
(reviewer mutation #1 removing `apply_create_block` did not trip
any test), but the bug's lifetime was long enough — 14 days —
that the lesson is "mutation testing is necessary but not
sufficient when the test surface is structurally narrow".

## 6. Numbers

Quantitative summary across Phase 2.

| Metric | Phase-1 close (`c6666d9d`) | Phase-2 close (`e6ae744e`) | Δ Phase 2 |
| ------ | -------------------------- | -------------------------- | --------- |
| Default test count (`cargo nextest run -p agaric`) | 3734 | 3769 | **+35** |
| Feature-on test count (`--features loro-shadow`) | 3774 | 3858 | **+84** |
| Migrations | 51 (`0051_pend_09_merge_parity_log.sql`) | 54 (`0054_pend_09_classifier_partial_index.sql`) | **+3** (`0052` snapshot, `0053` app_settings, `0054` partial index) |
| `src-tauri/src/loro/` LOC (`wc -l src-tauri/src/loro/*.rs`) | 3 694 | 6 162 | **+2 468** |
| Phase-2 module insertions / deletions (`git diff --shortstat a9849adc^..6edf5a39`) | — | — | **+6 538 / -5 888** across 41 files (large `-` count is the spike-crate deletion in day 8) |
| Code-only Phase-2 insertions excluding doc + spike-archive churn (`git diff --shortstat a9849adc^..6edf5a39 -- src-tauri/src/ src-tauri/migrations/`) | — | — | **+6 343 / -79** across 18 files |
| `LoroEngine` LOC (`engine.rs`) | 871 | 1 492 | **+621** (day-8.5 op-coverage expansion) |
| New modules | — | `cutover.rs` (317), `snapshot.rs` (459) | **+2** modules |
| Bins added | — | `op_log_histogram` (day 4), `parity_report` (day 7) | **+2** bins |
| Phase-2 commit count | — | — | **12 code-bearing** (days 1[plan-doc] + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 8.5 + 9 + 9.5 + 10 [`6edf5a39`] + 10-followup [`e6ae744e`] = 13 total; `e6ae744e` is test-only) |
| Tag created | — | `pend-09/spike-archive` → `3e8a1267` (annotated, object `f849c06a`) | **+1** tag |

**Build verdicts (re-verified at day-10, 2026-05-09):**

| Scenario | Result |
| -------- | ------ |
| `cargo build` (default) | clean; `cargo tree` confirms `loro` NOT in dep graph |
| `cargo build --features loro-shadow` | clean (no warnings) |
| `cargo nextest run -p agaric` | 3769 / 3769 passed (1 flaky retry passed; same flake reported in Phase 1) |
| `cargo nextest run -p agaric --features loro-shadow` | 3858 / 3858 passed |
| `npx markdownlint-cli2 pending/PEND-09-PHASE-2-REPORT.md` | (run at sign-off) |

**Default-build behaviour byte-identical to commit `e6ae744e`**
(the day-10 follow-up that extracted the partial-index SELECT into a
shared const for the regression test). This report is a docs-only
deliverable. The flag-flip cutover commit will mutate observable
behaviour; this report does not.

## 7. User-decision blocked-on items

Carried forward from the Phase-1 final report §8 plus four new
items this Phase-2 report introduces.

### 7.1 (carried) Conflict-copy conversion rule for existing `is_conflict=1` rows

`pending/PEND-09-crdt-migration.md` Q8. Spike's preferred default
is "concat-into-merge-result". The cutover plan §7.1 ships a
pseudo-migration that the maintainer must sign off on (separator
`---`, ours-first vs theirs-first ordering) **before** the
flag-flip cutover commit lands. Still open.

### 7.2 (carried) Diffy fallback release window

`pending/PEND-09-crdt-migration.md` line 113 — "at least one full
release after Phase 2 cutover". Maintainer names the actual
release version that ships Phase 3. Still open.

### 7.3 (new) Cutover-soak duration

Cutover plan §7.3: minimum 1 calendar week, recommended 2-3 weeks.
Maintainer names the actual. Note this duration starts **after**
the `apply_op` reorder lands (§4.1), not after this report.

### 7.4 (new) Cutover release version

Cutover plan §7.4: the release version that ships the day-9
toggle (with the flag defaulting **off**). Could be (a) ship the
toggle and the flip in the same release after private soak, or
(b) ship the toggle dark in release N, flip on in N+1 after public
soak. Plan recommended (a). Still open.

### 7.5 (new) `merge_parity_log` purge before cutover-soak

§5.5 above. Pre-day-9.5 rows are garbage data. The maintainer's
call: should `DELETE FROM merge_parity_log WHERE created_at < ?`
(timestamp = the moment `eb01c5f8` was deployed) run before the
cutover-soak begins? Recommended **yes** — the garbage data has
no analysis value, and the soak's hard floor (zero D-bucket rows)
becomes meaningful only against post-fix data. Out-of-scope for
day 10's docs-only deliverable; this is a one-line SQL the
maintainer runs.

### 7.6 (new) D-bucket sighting policy

Cutover plan §7.5: zero is the floor; how is a violation
surfaced? Plan suggested a status-bar indicator that turns red on
any D-bucket row in the last 24 hours, click-through to
`parity_report`. Plan recommended deferring to Phase 3 polish.
Still open; the day-7 `parity_report` bin (`3e8a1267`) is
sufficient for manual maintainer-only soak.

### 7.7 (new) `apply_op` reorder ownership

Cutover plan §3 day 9 calls for it; this report's §4.1 documents
it as the single biggest gap before flag-flip. Does the maintainer
want this same agent to continue with the reorder in a future
session, or hand off? Either is feasible; the agent has full
context. The reorder is one of the more delicate changes in the
PEND-09 series — Option A vs B (cutover plan §8.4) is still
unresolved, and the existing materializer code paths each "know"
diffy is authoritative in non-obvious ways. Estimate 1-2 days
plus a review cycle.

## 8. Open questions

Items that surfaced during Phase 2 and aren't yet decided. Each
is small enough to scope into the reorder day or a follow-up;
none is a flag-flip blocker by itself once the reorder lands.

### 8.1 Day-8.5 reviewer flag #1 — restore cascade asymmetry

The cutover plan §3 day 9 prerequisite block called this out
explicitly: "the engine's `apply_restore_block` is per-block-id
only, but SQL's `apply_restore_block_tx` walks the descendant
CTE and restores every block in the matching `deleted_at_ref`
cohort. Day 9 MUST either (a) make the materializer fan out
RestoreBlock per descendant (mirroring the existing PurgeBlock
cascade), (b) extend the engine to walk descendants in
`apply_restore_block`, or (c) thread `deleted_at_ref` through
and gate the engine walk on matching ref."

**Resolution: option (a).** Day 9 commit `d0395805` lands the
materializer-side fanout. `ApplyEffects { restored_cohort }` is
returned from `apply_op_tx`; `collect_restore_cohort` SELECTs
the cohort post-commit; `dispatch_restore_descendants_shadow`
fans out one `shadow_apply` call per cohort entry. Cohort
**includes** the seed (idempotency-via-redundancy under the
latent JSON bug — once the bug was fixed in day 9.5, the seed
applies twice on RestoreBlock; engine's `apply_restore_block` is
a no-op on an already-restored block, so the redundancy is
harmless). Verified by reading `d0395805`'s commit message and
the cutover plan §3 day-9 prerequisite block.

This question is **closed** for the flag-flip cutover; flagged
here for completeness because it was a load-bearing day-9
prerequisite.

### 8.2 Boot-ordering fix — synchronous rehydrate latency

Day-9 commit `d0395805` made `rehydrate_registry` SYNCHRONOUS via
`tauri::async_runtime::block_on` BEFORE `recover_at_boot`. The
day-6 commit message had flagged the original async-fire-and-forget
shape as "a correctness bug for the cutover toggle"; day 9
closed it.

The remaining concern: **boot-latency cost.** Synchronous
rehydrate walks every space's `loro_doc_state` blob, builds a
`LoroEngine`, imports the snapshot, installs into the registry.
With Spike day-4 sizing of ~6.4 MiB at 25K alive blocks / ~26 MiB
at 100K, and Loro's import being O(snapshot-size), the
synchronous walk's wall-clock cost is bounded but non-trivial
for users with many large spaces. No measurement landed in
Phase 2.

**Question:** is the boot-latency cost acceptable in production?
**Suggested resolution:** add a `tracing::info!` on rehydrate
elapsed time + per-space byte count; if any user reports
>500 ms boot-rehydrate, revisit (a `tokio::watch` "rehydrate
complete" gate that lets `apply_op` block briefly only when it
races boot is the obvious refinement). Out-of-scope for the
flag-flip; no real-user data exists to measure against yet.

### 8.3 Cutover-toggle reorder shape (Option A vs B)

Cutover plan §8.4. Plan suggested Option B (clean — write
`project_from_loro_to_sql` from scratch). Day-9 deferred the
decision because the reorder was deferred. Still open. §4.1
above flags this as part of the reorder day.

### 8.4 The `merge_parity_log` retention window during reorder + soak

Phase-1 day-4 set 30-day retention (`parity_sink::default_retention_cutoff_ms`).
With the day-9.5 fix in place and a fresh soak starting today,
30 days is more than enough. **No change needed.** Listed here
for completeness because it interacts with §7.5's purge: the
purge is a one-shot DELETE; ongoing retention continues at
30 days.

### 8.5 Should the `is_loro_authoritative()` cache refresh on a flush-task tick?

Cutover plan §5.2 specified a 30-second refresh cadence so a
direct `UPDATE app_settings` (without going through
`set_loro_authoritative`) flips without a process restart. Day-9
commit message documents this as **not** part of the day-9
shipped scope: "the flush-tick refresh is a follow-up day". Still
open. Materially: if the maintainer flips the flag via the typed
helper (`set_loro_authoritative`), no refresh is needed — the
helper updates row + cache. Only a raw SQL UPDATE would suffer
the lag. The flush-tick refresh is a polish item, not a
correctness item; out-of-scope for the flag-flip.

### 8.6 Attachment ops still log-and-skip in `shadow_apply`

Day-8.5 commit message documents this as intentional: "If
attachment metadata becomes CRDT-merged in Phase 3, those arms
get added then." After day-9.5 the dispatcher reaches the
attachment arms cleanly (parses `AddAttachmentPayload` /
`DeleteAttachmentPayload` from the JSON); `shadow_apply` itself
log-and-skips. The cutover's projection-from-Loro cannot rely on
Loro state for attachment metadata; the existing SQL
`attachments` table writes (in `materializer/handlers.rs`)
remain authoritative. **Caveat for the reorder**: when
`is_loro_authoritative()` is on, `apply_op_tx`'s attachment write
path must remain on the SQL side, not be moved into
`project_from_loro_to_sql`. This is consistent with the cutover
plan §8.2's deferral of attachment ops; flagged here so the
reorder day doesn't accidentally regress.

## 9. Sign-off

**Recommendation: GO-WITH-PREREQUISITES for the cutover
flag-flip.** Dated **2026-05-09**.

**Prerequisites — must close before flag-flip cutover commit:**

- §4.1 — the `apply_op` reorder. Realistically 1-2 days of
  build + review. Option A vs B (cutover plan §8.4) decided on
  the reorder day. Single biggest remaining gap.
- §4.2 — the 7-day post-reorder shadow-mode soak with zero
  D-bucket rows. Calendar-time. Cannot have started before
  2026-05-09 evening per §5.5.
- §4.3 — `merge_parity_log` purge of pre-day-9.5 garbage data
  (one-line SQL). User decision item §7.5.

**Prerequisites — must close before flag-flip cutover commit
lands but are not gating in the calendar sense:**

- §7.1 — UX sign-off on the `is_conflict=1` conversion rule
  (concat separator + ordering).
- §7.2 — release version that ships the cutover.
- §7.3 — cutover-soak duration (1 / 2 / 3 weeks).
- §7.4 — cutover release version.
- §7.7 — `apply_op` reorder ownership (continue or hand off).

**Open polish items not gating cutover:**

- §7.6 — D-bucket sighting policy (status-bar indicator).
- §8.2 — boot-rehydrate latency telemetry.
- §8.5 — flush-tick refresh of the cutover-flag cache.

**Critical incident captured:** §5 — the latent
`shadow_dispatch_for_record` JSON-parse bug. Pre-day-9.5
`merge_parity_log` rows are no-op data. Diffy authoritative path
unaffected throughout — this is **not** a correctness issue, but
it does mean the Phase-1 + early-Phase-2 shadow-mode evidence is
weaker than it appeared. The cutover-soak's 7-day window must
start from a post-`eb01c5f8` baseline.

**Process improvement captured:** §5.6 — every shadow-write test
should drive through the full op-log → materializer →
`shadow_dispatch_for_record` path, not through in-memory
`OpPayload` construction. Day-9.5's two new tests
(`shadow_dispatch_for_record_applies_create_block`,
`shadow_dispatch_for_record_applies_edit_and_set_property`) are
the right shape and should become the template. Phase 3
prerequisite.

**Next decision gate:** the `apply_op` reorder commit (§4.1).
After the reorder lands and the 7-day soak closes with zero
D-bucket rows, the flag-flip cutover commit is the default
outcome. If the soak surfaces any D-bucket row, this report's
recommendation flips to **NO-GO** per the cutover-plan §3
day-11+ hard floor; the flag-off rollback is a single-row SQL
UPDATE (`set_loro_authoritative(false)`), no code revert needed.

— PEND-09 Phase 2 day-10, 2026-05-09.
