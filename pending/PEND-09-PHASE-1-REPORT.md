# PEND-09 Phase 1 — Shadow-mode report (cutover go/no-go)

Two-week (planned 3-4 week) Phase 1 closure deliverable.
Day 1 → day 10 complete on 2026-05-09.
Synthesis deliverable; the user reads this to decide whether to greenlight
Phase 2 (Cutover). All claims cited back to the running notebook in
`src-tauri/crates/loro-spike/SPIKE-NOTES.md`, the spike's
`SPIKE-REPORT.md`, the day-9 design docs in `pending/`, and the nine
daily Phase-1 commits enumerated in §2 below.

## 1. TL;DR

**Recommendation: GO-WITH-CAVEATS for Phase 2.** Shadow-mode infrastructure
is operationally complete: the `LoroEngine` ports clean from the spike
(`src-tauri/src/loro/engine.rs`, 871 LOC, gated behind the `loro-shadow`
cargo feature so the default build is byte-identical to pre-Phase-0
HEAD), the dual-write hook is wired at every `apply_op` site (merge
layer + materializer post-commit), parity events flow through an
in-memory ring + 30-day-retention SQLite sink + A/B/C/D classifier on a
30-second flush cadence, peer-id derivation is on `xxh3_64` with a
locked stability contract, and 256-case×3-test proptest streams report
**zero D-bucket sightings** in CI. No kill criterion #2 D-bucket has
been observed in synthetic or proptest streams.

The caveats — not blockers, but Phase-2-day-1 prerequisites — are
empirical and operational: (a) the **7-day real-`notes.db` shadow-mode
soak** that is the only meaningful evidence floor for "no D-bucket bug
exists" has not yet started (no synthetic test can prove its absence);
(b) the `loro_batch` envelope still carries typed JSON payloads, not
the Loro-exported binary bytes (`loro_bytes: Vec<u8>` schema column was
deferred from day 3 to the cutover wire-format swap); (c) two-device
concurrent-merge proptests were deferred from day 8 to keep Phase 1 on
its 10-day budget; (d) macOS RSS measurement on the day-4 replay bench
is still missing per the spike report. Each is a known, scoped Phase-2
day-1 task; the §4 readiness checklist enumerates them. None of them
gate the GO recommendation.

If any kill-criterion-#2 D-bucket sighting surfaces during the 7-day
soak, this recommendation flips to NO-GO and the cutover scope freezes
until the divergence is root-caused.

## 2. Phase 1 deliverables

| Day | Date | Commit | Headline outcome |
| --- | ---- | ------ | ---------------- |
| 1 | 2026-05-09 | `a250a06e` | Production scaffold: `loro-shadow` cargo feature, optional `loro = "1.12"` dep, `src-tauri/src/loro/{mod, engine, parity, tests}.rs` (1 060 LOC by `git show --stat`; the day-1 commit message reports "1 041" — typo in that message, corrected here); `merge::shadow_apply` stub; default tests 3734 (unchanged from pre-Phase-1 baseline `072bcfca`), feature-on tests 3738 |
| 2 | 2026-05-09 | `dcfc3637` | `shadow_apply` real body (~140 LOC dispatcher over 5 op types); `LoroEngineRegistry` (per-space lazy doc); `ShadowState` global init via `OnceLock`; three call sites in `merge/apply.rs` (clean / conflict-copy / on-original); `apply_edit_via_diff_splice` LCP/LCS USV splice ported from spike; default 3734, feature-on 3746 |
| 3 | 2026-05-09 | `16d369d2` | Materializer hot-path wiring: post-commit dispatch in `apply_op` + `BatchApplyOps`; double-dispatch deduped at clean-merge + conflict-copy sites; `LoroBatch` envelope schema (`loro_version: u8 = 1`, `payload_version: u8 = 1`, `original_op_type: String`, `payload: serde_json::Value`) with `TryFrom<&OpRecord>`; off-side `shadow_apply` stub deleted; default 3734, feature-on 3750 |
| 4 | 2026-05-09 | `95182e8c` | Persistent SQLite parity log: migration `0051_pend_09_merge_parity_log.sql` (STRICT table, columns `(id, op_id, space_id, op_type, diffy_result, loro_result, matched, bucket, created_at)`, three indexes); `parity_sink::{flush_to_sqlite, purge_old, default_retention_cutoff_ms}` with chunked QueryBuilder INSERTs (`FLUSH_CHUNK_ROWS = 100`) and 30-day default retention; `ParityEvent` extended with `space_id` + `op_type`; default 3734, feature-on 3757 |
| 5 | 2026-05-09 | `167fdf1d` | Periodic flush task: `flush_task::run_periodic_flush` async fn on a single `tokio::time::interval`, purge gated on `tick_count.is_multiple_of(ticks_per_purge)`; `FLUSH_INTERVAL_SECS = 30`, `PURGE_INTERVAL_SECS = 3600`; `tracing::warn!` on either error arm + continue (never panic); spawned via `tauri::async_runtime::spawn` in the `#[cfg(feature = "loro-shadow")]` setup block; default 3734, feature-on 3760 |
| 6 | 2026-05-09 | `55b2d65b` | A/B/C/D bucket classifier: `Bucket::{A,B,C,D}`, pure `classify(...)`, async `classify_unbucketed(pool)` (4 000-row SELECT chunks, 200-id UPDATE chunks, one tx per chunk); rule order `matched=true → A` short-circuit, `loro starts "error:" → D`, `diffy "conflict:" + loro non-conflict + non-error → B`, else C; idempotent; chained into `run_periodic_flush` after `flush_to_sqlite`; default 3734, feature-on 3769 |
| 7 | 2026-05-09 | `6fd6b389` | `xxhash-rust` peer-id swap: `peer_id_from_device_id` now hashes via `xxh3_64` (seed=0); locked known-value test (`peer_id_from_device_id("01ARZ3NDEKTSV4RRFFQ69G5FAV") == 0x11e7_9683_b730_ff1f`); `# Stability contract — DO NOT CHANGE WITHOUT A COORDINATED MIGRATION` block on the docstring; `xxhash-rust = "0.8"` added with `xxh3` feature, gated behind `loro-shadow`; default 3734, feature-on 3771 |
| 8 | 2026-05-09 | `89df17a2` | proptest-augmented parity: `parity_proptest.rs` with 3 cases × 256 default cases = 768 randomised single-author streams (`single_author_create_only_stream_is_bucket_a`, `single_author_mixed_op_stream_never_hits_bucket_d`, `single_author_mixed_op_stream_never_hits_bucket_b`); zero D-bucket sightings; +1.2 s wall-clock on `cargo nextest --features loro-shadow`; default 3734, feature-on 3774 |
| 9 | 2026-05-09 | `fcdae147` | Design docs: `pending/PEND-09-lww-resolution-rule.md` (wallclock UTC RFC 3339 → device_id lex → seq for property; lex `created_at` → device_id with `op_a`-wins-on-tie for move) and `pending/PEND-09-fe-edit-coordinate-space.md` (FE owns in-progress edits, BE owns persistence + DAG truth, blur is the flush boundary); two corrections caught against day-1 wording (LWW timebase is wallclock, not Lamport; move-LWW omits the `seq` tertiary tiebreak); no code changes; default 3734, feature-on 3774 |
| 10 | 2026-05-09 | (this doc) | Phase 1 final report; no code changes; default 3734, feature-on 3774; recommendation **GO-WITH-CAVEATS** |

**Total Phase 1 commit count: 10 (1 docs-only on day 10).** Default build
verdict: clean throughout, `loro` dependency NOT in default `cargo
tree`. `--features loro-shadow` build verdict: clean throughout,
`loro v1.12.x` + `xxhash-rust v0.8.x` at depth 1.

**Cross-reference to SPIKE-REPORT §6 readiness checklist (14 items).**
Items 1, 3, 4, 5, 6, 8, 9, 10 closed in Phase 1 (citations in the
table above). Item 7 (port the remaining ~5 integration shapes from
`merge/tests.rs`) was closed pre-Phase-1 in commit `87803fb9` —
parity corpus grew from 15/53 to 34/53 portable tests, all passing,
zero D-bucket sightings. Items 2 (real op-log histogram), 11 (macOS
RSS), 12 (`loro_doc_state` schema), 13 (conflict-copy migration rule),
14 (spike-archive step) remain open and are enumerated in §4.

## 3. Risk register update

Re-walk of the original `pending/PEND-09-crdt-migration.md` Risks table
(lines 105-123). Each risk gets one of three statuses:

- **Closed** — addressed in Phase 1; cite the closing artifact.
- **Mitigated** — partial fix; document remaining exposure.
- **Open** — Phase 2 must address.

| Plan risk (line) | Phase-1 status | Closing artifact / remaining exposure |
| ---------------- | -------------- | ------------------------------------- |
| Loro pre-1.0 breaking changes (108) | **Closed** | Spike kill-criterion #4 + day-1 dep landed at `loro = "1.12"` caret-1; SPIKE-REPORT §2 row 4. No 1.x → 2.x transition in the Phase-1 window. |
| Loro serialization format changes between versions (109) | **Closed for 1.x** | Spike day-1 evidence; `loro_version: u8 = 1` field on the `LoroBatch` envelope (`src-tauri/src/loro/envelope.rs`) is the documented mitigation lever for the eventual 2.x migration. |
| Op-log → Loro import bug causes silent data loss (110) | **Mitigated** (partial) | Shadow-mode dual-write is operational at every `apply_op` site (day-2 + day-3 commits); parity sink with bucket classifier is operational (day-4 + day-6); proptest streams report zero D (day-8). **Remaining exposure:** the actual production-soak data has not yet been collected — no real `notes.db` parity rows exist. Phase 2 day-1 prerequisite. |
| Loro perf cliff at large doc sizes (111) | **Closed for the spike-measured envelope** | Day-4 spike replay bench: 1.677 s wall-clock + 144 MiB peak RSS at 100K ops; SPIKE-REPORT §2 row 3. Phase 1 added no perf regressions because Loro is off the read hot path (SPIKE-REPORT §4.4). **Remaining exposure:** real-content lengths (50-500 chars typical, kilobyte-paste outliers) re-measurement deferred to Phase-2 day-1 (notebook Q9). |
| User loses awareness of concurrent edits (112) | **Phase-4 detail; no Phase-1 action** | Spike confirmed Loro silently merges character-level edits — exactly the user-visible promise. Phase 4 optional "recent merges" indicator is the right place for this. No Phase-1 surface. |
| Snapshot format change breaks recovery on legacy snapshots (113) | **Open** | Phase-2 cutover detail. The plan's "old `merge/` engine in binary as fallback for ≥1 release" remains the correct discipline; the cutover plan in §4 below names this as a Phase-2 day-1 deliverable. |
| Block tree invariant maintenance bugs (siblings same position; cycle) (114) | **Mitigated** | Spike day-5 confirmed both LoroMap+scalar and LoroTree leave invariant maintenance to the app layer. Phase-1 dual-write inherits the existing `merge::apply` invariant maintenance unchanged; no app-layer regression. **Remaining exposure:** the existing app-layer validation has been audited only against single-author streams (day-8 proptest); two-device concurrent reparent → cycle proptest deferred. |
| Materializer assumes `is_conflict` exists during Phase 1-2 (115) | **As-planned** | `is_conflict` column unchanged. Phase 1 makes no schema change to `blocks`. Phase 3 drops it per plan. |
| Materializer hot-path read cost from Loro doc (116) | **Closed** | Spike day-7 verdict — SQL stays as the read cache, Loro is sync truth-of-state. Phase 1 dual-write is write-side only; no read path was changed. SPIKE-REPORT §4.4. |
| Existing `is_conflict=1` rows in production (117) | **Open** | Phase-2 detail per plan Q8. Conversion rule (delete vs concat-into-merge-result vs keep-as-legacy) needs UX sign-off before Phase 2. Listed in §4 below. |
| Op-type dispatcher breaks when every op_type=='loro_batch' (118) | **Mitigated** (schema landed; not yet wired) | Day-3 `LoroBatch` envelope at `src-tauri/src/loro/envelope.rs` carries `original_op_type: String`. **Remaining exposure:** the `payload: serde_json::Value` field still carries the typed payload; the cutover swaps that to `loro_bytes: Vec<u8>`. Schema is forward-compatible (envelope can carry both fields during a transition window). |
| Test corpus may be insufficient to catch CRDT-specific bugs (119) | **Mitigated** | Day-8 proptest landed (3 cases × 256 = 768 randomised single-author streams). **Remaining exposure:** two-device concurrent-merge streams deferred. Listed in §4 below. |
| `OpTransfer` opaque payload prevents debugging (120) | **Mitigated** | Day-3 envelope carries `payload_version: u8` for forward-compat decoding. **Remaining exposure:** `agaric debug parity-report`-style diagnostic command not yet built (open question §7). |
| Tree-op conflict resolution semantics under LWW (121) | **Closed** | Day-9 design doc `pending/PEND-09-lww-resolution-rule.md` documents wallclock UTC + device_id lex (+ `seq` for property only) tiebreak rule; cites both the SQL implementation (`merge/resolve.rs:213-297`, `sync_protocol/operations.rs:699-822`) and the spike-side equivalence. Optional "remote-overrode-your-move" awareness log is Phase-4 polish. |
| Per-space doc size grows unbounded with usage (122) | **Closed for the spike envelope** | Day-4 extrapolation: 100K alive blocks ≈ 26 MiB; SPIKE-REPORT §2 row 3 + §3 Q3. **Remaining exposure:** production content lengths re-measurement (Phase-2 day-1, notebook Q9). |

**Summary:** 5 closed, 6 mitigated (residual exposure documented in §4),
3 open and explicitly Phase-2 day-1 territory. None of the 14 risks in
the original table are unaddressed.

## 4. Phase 2 readiness checklist

Concrete prerequisites for the cutover phase. Every item is one
Phase-2-day-1-or-day-2 task with a clear closing artifact. In rough
sequencing order:

1. **7-day real-`notes.db` shadow-mode soak.** Run the `--features
   loro-shadow` build on the maintainer's actual workstation for at
   least 7 calendar days. Sample the `merge_parity_log` table at the
   end of each day; assert every row has `bucket IN ('A','B','C')` and
   zero `bucket = 'D'`. **This is the empirical-evidence floor for the
   GO recommendation** — no synthetic test can prove the absence of
   D-bucket bugs in real workloads. Closing artifact: a query result
   pasted into the cutover-day-1 commit message; a dump of the
   `merge_parity_log` table archived alongside the cutover commit.
2. **Real op-log volume sampling (plan Q9).** A one-off counting script
   against the maintainer's real `notes.db` op_log; confirm the
   30/50/10/5/5 spike op-mix proxy is in the right ballpark, OR re-run
   the day-4 replay bench with the real distribution to confirm the
   kill-criterion margin (358× wall-clock, 14× heap) is robust to it.
   Closing artifact: histogram pasted into the cutover-day-1 commit
   message. Was scheduled for Phase 1 entry per SPIKE-REPORT §6 item 2;
   slipped to Phase 2 entry without consequence (margins are wide
   enough).
3. **`loro_doc_state` storage decision (plan Q4).** Plan recommends
   option (b) — `loro_doc_state` table inside `notes.db`, periodically
   snapshotted. Spike day-4 sizing (~6.4 MiB at 25K alive blocks; ≈26
   MiB extrapolated to 100K) confirms SQLite-blob storage is
   unproblematic. Decide: snapshot cadence (every N ops? every M
   minutes? on shutdown only?) + retention (keep last K snapshots? roll
   forward only?). Closing artifact: migration `0042_loro_doc_state.sql`
   (legacy plan filename; actual migration number will be ≥0052 given
   Phase 1 already used 0051) + a docstring on the snapshot scheduler.
4. **`loro_batch` envelope `loro_bytes: Vec<u8>` field schema.**
   Day-3's envelope (`src-tauri/src/loro/envelope.rs`) ships with
   `payload: serde_json::Value` carrying the typed op (forward-compat
   placeholder); the cutover wire-format swap adds a `loro_bytes:
   Vec<u8>` column carrying Loro's exported batch bytes. Schema is
   already designed to be additive — old envelopes (no `loro_bytes`)
   remain decodable, and during the transition window both fields can
   coexist. Closing artifact: schema bump in `envelope.rs`, a
   `loro_version` bump from 1 → 2, and a one-shot migration on first
   boot that re-encodes legacy `loro_batch` rows (or marks them
   "legacy-format" and decodes via the typed-payload path indefinitely).
5. **Two-device concurrent-merge proptests.** Day-8 covered single-
   author streams only (3 cases × 256). The harder shape — two `LoroEngine`
   handles diverging on a per-block edit, exchanging snapshots at random
   sync points, asserting bucket A/B/C/never-D — was deferred. Closing
   artifact: a fourth proptest in `parity_proptest.rs`, `two_peer_concurrent_edit_stream_never_hits_bucket_d`, structurally similar to the spike's
   `tests/concurrent_edit.rs` + `tests/concurrent_reparent_tree.rs` but with
   the production `LoroEngine`.
6. **macOS RSS measurement on the day-4 replay bench.** SPIKE-REPORT §6
   item 11 + §9 item 4. The `mach_task_basic_info` wrapper is a small
   amount of unsafe code with no extra dep; the wide kill-criterion
   margin (14×) means the verdict is robust to platform variance, but
   sign-off completeness benefits from a Mac re-run. Closing artifact:
   a follow-up commit on `crates/loro-spike/` adding the macOS branch
   to the RSS reader; one re-run of `cargo run --release -p loro-spike
   --bin replay_bench` on a Mac with the result pasted into the
   cutover-day-1 commit message.
7. **Spike-crate archive step.** SPIKE-REPORT §6 item 14 — when Phase 1
   lands, archive `src-tauri/crates/loro-spike/` (either to a
   `pending/PEND-09-spike-archive.tar.gz` blob, or convert to a git tag
   `pend-09/spike-archive` and remove the workspace member) so the
   throwaway spike code does not accrete maintenance burden alongside
   the production `src-tauri/src/loro/` module. The spike's
   `SPIKE-NOTES.md` and `SPIKE-REPORT.md` should be preserved
   (move to `pending/PEND-09-spike-{notes,report}.md`) since several
   risk-register and §4 entries cite them. Closing artifact: a single
   commit removing the workspace member, retagging the docs, and
   updating the cite-paths in this report and `PEND-09-crdt-migration.md`.
8. **Cutover plan written.** A standalone doc — proposed filename
   `pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` — that sequences the
   actual cutover. Must cover at minimum:
   - **Sequence of steps.** Order: (a) backfill `loro_doc_state` from
     existing `op_log`; (b) flip the materializer's source-of-truth to
     Loro on the post-commit hook; (c) start emitting `op_type =
     'loro_batch'` on new writes; (d) keep the diffy path running as a
     compiled-in fallback for ≥1 release per plan risks line 113.
   - **Rollback plan.** A "revert to diffy" commit that restores the
     pre-cutover `materializer/handlers.rs` and re-marks `loro_batch`
     rows as no-ops on apply; with the `loro_doc_state` snapshots
     untouched (so a re-cutover replays cheaply).
   - **Kill switch.** A runtime-toggleable env var or settings flag
     (`AGARIC_LORO_AUTHORITATIVE=0/1`) that disables the cutover
     materializer hook on next process launch without code changes.
     Lets the maintainer ship the cutover commit and back it out
     remotely if a real-user D-bucket surfaces.
   - **One-shot replay verification.** Reuse the day-4 replay-bench
     shape from the spike crate as the production verify path: replay
     the existing `op_log` into a fresh Loro doc, snapshot, replay
     again, assert byte-identical. Plan risks line 110 closing
     artifact.
   - **Conflict-copy → merge-result conversion rule** (plan Q8). For
     existing `is_conflict=1` rows in production data: decide between
     delete vs concat-into-merge-result vs keep-as-legacy-markers
     (spike's preferred default is concat). UX sign-off required
     before cutover.
   Closing artifact: the doc itself, reviewed before the cutover-day-1
   commit lands.

**Default-build behaviour byte-identical to commit `fcdae147`.** All
of the above are docs / Phase-2 work; nothing in §4 mutates the
default build.

## 5. What we learned

Non-obvious findings from Phase 1 that a Phase-2 reader should
internalise before the cutover commit:

1. **The diffy-vs-Loro LWW semantic mismatch (wallclock vs Lamport) is
   C-bucket and inherent.** Spike day-3 corpus port surfaced two C-bucket
   cases; one of them is the LWW tiebreak (SPIKE-REPORT §2 row 2). The
   day-9 `pending/PEND-09-lww-resolution-rule.md` doc is the load-bearing
   reference: agaric production uses **wallclock UTC RFC 3339** (via
   `crate::now_rfc3339()` at `src-tauri/src/lib.rs:288-290`) with
   `device_id` lex + `seq` tiebreaks; Loro's internal LWW is closer to
   Lamport-of-write-order. Both are CRDT-correct; they just pick
   different winners on certain rare ties. **Phase 2 cutover must
   commit to one or the other.** The clean shape is: keep wallclock
   semantics on the write side (continue stamping `created_at` from
   `now_rfc3339()` and feeding that into Loro's per-key timestamps),
   accept that the SQL-side `resolve_property_conflict` path becomes
   redundant once Loro is authoritative, and document a one-shot
   "re-run LWW with Loro's rule" pass for legacy `is_conflict=1` rows
   if the conversion rule from §4 item 7 calls for it. Day-1 commit
   message originally described agaric's LWW as "Lamport-keyed"; that
   was wrong, caught on day 9, and fixed.
2. **The materializer's per-op apply path is the natural shadow-write
   boundary.** Day-3 wired `shadow_apply` into both arms of
   `materializer/handlers.rs::apply_op` (the single-op arm and the
   `BatchApplyOps` arm) **after** `tx.commit`. This is the right
   choice for two reasons: (a) Loro never sees ops whose enclosing tx
   ultimately rolled back, so the parity log doesn't pollute with
   would-be-reverted state; (b) the merge layer's own dispatch sites
   (`merge/apply.rs`'s clean-merge + conflict-copy paths) enqueue
   their results to `MaterializeTask::ApplyOp`, which now also
   dispatches — so day-3 had to carefully **dedupe the double dispatch**
   (delete merge-layer dispatches at clean + conflict-copy sites; keep
   the merge-on-original record's dispatch since that record is never
   enqueued). Reviewer caught this; the dedup is load-bearing and
   tested.
3. **The merge layer's "ours wins + conflict-copy with theirs content"
   pattern has Loro-equivalent semantics.** Spike day-3 corpus port
   confirmed: `LoroMap` + scalar reparent produces the same LWW
   one-parent-wins state as `merge_diverged_blocks` does on disjoint
   property writes; `LoroText` produces clean character-level merges on
   block content where diffy would have produced a conflict copy
   (~27 % of sampled merges shift from B-bucket to A in the spike
   corpus). The cutover deletes the conflict-copy production code path
   entirely; Phase 3 reaps the ~4163 LOC saving.
4. **Per-op commit cadence is the right default.** Spike day-6
   measured K = 1 / 10 / 1000 / 10000 commit batching at 10K ops; best-
   case (K=1000) was only 1.29× faster than per-op, well below the 2×
   bar that would justify the operational complexity of batching.
   Phase 1 inherits per-op directly. The `apply_*_no_commit` plumbing
   is in place if a specific bulk-import path later needs it
   (Phase-2 one-shot `op_log` replay is the obvious candidate).
5. **The `ShadowState` `OnceLock` is process-global; the
   `LoroEngineRegistry` is the per-space sharder.** Day-2 design
   choice. Single global init via `tauri::async_runtime::spawn` in the
   `#[cfg(feature = "loro-shadow")]` setup block; the registry is a
   `RwLock<HashMap<SpaceId, LoroEngine>>` with lazy instantiation on
   first parity event for that space. This was load-bearing for the
   day-8 proptests: they bypass `shadow_apply` entirely and drive
   `LoroEngine` directly to avoid registry-mutex re-entrancy in the
   proptest harness.
6. **The classifier's "conservative C" rule (kill-criterion #2: when
   in doubt, not D) was reviewer-caught.** Day-6 first draft had the
   B-bucket rule firing on `loro starts "conflict:"` (forward-compat
   for a future production `diffy_summary_for` change). Reviewer
   pointed out that `diffy_summary_for` does NOT currently emit
   `conflict:` strings, so the rule's first-pass misclassified every
   real divergence as B. Fixed: the rule now requires `diffy
   "conflict:" + loro non-conflict + non-error → B`, with C as the
   conservative fallthrough. Documented inline in
   `src-tauri/src/loro/classifier.rs`; mutation-tested.
7. **The day-9 LWW doc caught a second, smaller, error.** First draft
   said move-LWW used the same three tiebreakers as property-LWW.
   Reviewer pointed out that move-LWW (in `sync_protocol/operations.rs:699-822`)
   uses raw lex compare on `created_at` (no RFC-3339 parse-with-fallback)
   and no `seq` tertiary tiebreak (`op_a` wins on full tie). This is
   acceptable because cross-device `device_id` ties are impossible by
   construction (each device's id is a ULID), but the simplification is
   intentional and worth documenting. Doc corrected; the discrepancy is
   recorded in the Day-9 commit message.

## 6. Numbers

Quantitative summary across Phase 1.

| Metric | Pre-Phase-1 | Day 1 | Day 10 | Δ Phase 1 |
| ------ | ----------- | ----- | ------ | --------- |
| Default test count (`cargo nextest run -p agaric`) | 3734 | 3734 | 3734 | 0 (byte-identical) |
| Feature-on test count (`--features loro-shadow`) | n/a* | 3738 | 3774 | **+40** |
| Migrations | 50 (`0050_*`) | 50 | 51 (`0051_pend_09_merge_parity_log.sql`) | +1 |
| `src-tauri/src/loro/` LOC (current) | 0 | 1060** | 3694*** | +3694 |
| Phase-1 module insertions across all touched files (`git diff --shortstat a250a06e^..fcdae147 -- loro/ migration 0051 merge/ lib.rs materializer/handlers.rs`) | — | — | — | **+4445 insertions** (16 files changed) |
| Loro feature dep depth (`cargo tree -e features --features loro-shadow \| grep -c '^[├└]'` at depth 1) | n/a | `loro v1.12.x` | `loro v1.12.x` + `xxhash-rust v0.8.x` | +2 |

\* The pre-Phase-1 baseline at commit `072bcfca` predates the
`loro-shadow` cargo feature, so a "feature-on" test count is undefined
there. The default (feature-off) count was 3734 at `072bcfca`, the
same as today; it remained 3734 throughout Phase 1. The feature-on
count's first defined value is 3738 at the close of day 1 (the day-1
commit that introduced both the feature and the first 4 tests behind
it: 1 smoke in `loro/tests.rs` + 3 in `loro/parity.rs`).

The day-by-day net feature-on delta — taken from each day's commit
message — is **+4 day-1, +8 day-2, +4 day-3, +7 day-4, +3 day-5, +9
day-6, +2 day-7, +3 day-8 = +40 total**, which reconciles exactly to
3774 − 3734. Note that some daily commit messages list "new tests
added" higher than the net delta on that day (e.g. day 2's commit
message reports 12 new tests for a net delta of +8) because a few
day-1 sampler scaffolds were refactored into the day-2 dispatch tests.
The net-delta numbers are the authoritative ones; the **+40 sum is
correct, not +37**. An earlier draft of this section reported +37 with
a fictitious 3737 baseline; that was a bookkeeping error caught during
day-10 review.

\*\* Day-1 `git show --stat a250a06e -- src-tauri/src/loro/`:
`engine.rs` 751 + `mod.rs` 56 + `parity.rs` 213 + `tests.rs` 40 = 1060
insertions in the new `loro/` directory. The day-1 commit message
itself rounds this to "1 041 LOC" in its prose; the stat-based 1060 is
the authoritative number.

\*\*\* `wc -l src-tauri/src/loro/*.rs` at commit `fcdae147`: 3694 LOC across
11 files (`classifier.rs` 554, `engine.rs` 871, `envelope.rs` 263,
`flush_task.rs` 407, `mod.rs` 82, `parity_proptest.rs` 496, `parity.rs`
284, `parity_sink.rs` 390, `registry.rs` 218, `shared.rs` 89, `tests.rs`
40), plus migration 0051 at 77 lines.

**Build verdicts (re-verified at day-10):**

| Scenario | Result |
| -------- | ------ |
| `cargo build` (default) | clean; `cargo tree` confirms `loro` NOT in dep graph |
| `cargo build --features loro-shadow` | clean (no warnings) |
| `cargo nextest run -p agaric` | 3734 / 3734 passed |
| `cargo nextest run -p agaric --features loro-shadow` | 3774 / 3774 passed |
| `npx markdownlint-cli2 pending/PEND-09-PHASE-1-REPORT.md` | (run at sign-off) |

## 7. Open questions

Items that surfaced during Phase 1 and aren't yet decided. Each is
small enough to scope into a Phase-2 sub-task; none is a cutover
blocker by itself.

1. **Should the shadow flush interval (30 s) become user-tunable in
   Phase 2?** Current values (`flush_task::FLUSH_INTERVAL_SECS = 30`,
   `PURGE_INTERVAL_SECS = 3600`) are compile-time constants. Options:
   (a) leave as constants — simplest, fine for shadow mode; (b) wire
   to a `tauri.conf.json` setting — power-user knob; (c) wire to a
   release-channel default (more aggressive flush in nightly, looser
   in release) — overkill for the maintainer's solo workflow.
   **Suggested resolution:** leave as constants until a real reason to
   change appears.
2. **Should we ship a `agaric debug parity-report` diagnostic command?**
   The plan risks line 120 calls out "`OpTransfer` opaque payload
   prevents debugging" — Phase 1 mitigated by structuring the
   `LoroBatch` envelope, but a CLI / IPC command that runs `SELECT
   bucket, COUNT(*), MAX(created_at) FROM merge_parity_log WHERE
   created_at > ? GROUP BY bucket` and pretty-prints would make the
   7-day soak observation in §4 item 1 trivial. **Suggested
   resolution:** add as a Phase-2 day-2 deliverable; the SQL is
   already written in `classifier::ClassifyStats`'s test harness.
3. **Cutover-phase op-log envelope migration: backfill old rows or
   only mark rows from cutover-onwards?** The cutover changes the
   payload encoding for new `op_type = 'loro_batch'` rows. Existing
   typed-op rows can either be (a) one-shot-rewritten into `loro_batch`
   envelopes carrying re-encoded Loro bytes, or (b) left as-is with the
   materializer dispatching by `op_type` and routing legacy rows
   through the diffy path forever. (a) is one big migration risk; (b)
   keeps the diffy code path live indefinitely (a maintenance tax,
   contrary to the Phase 3 cleanup goal). **Suggested resolution:** (a)
   with the one-shot replay verified via day-4 replay-bench shape;
   diffy code path stays compiled-in for ≥1 release as a fallback per
   plan risks line 113, then drops in Phase 3.
4. **Is `op_a`-wins-on-tie in move-LWW (no `seq` tertiary) a
   deferred-bug or an intentional simplification?** Day-9 doc concluded
   intentional (cross-device `device_id` ties impossible by ULID
   construction; same-device-same-ms ties don't arise because `seq`
   advances monotonically at sub-ms cadence). But the asymmetry with
   property-LWW is mildly concerning. **Suggested resolution:** add a
   `tracing::debug!` on the `op_a >= op_b` arm at
   `sync_protocol/operations.rs:772` so any real-world hit logs; if
   the log fires more than zero times in a year, revisit.
5. **The `merge_parity_log.bucket` column is currently nullable (NULL
   = pending classification).** Day-6 classifier fills NULLs on each
   flush tick. The `WHERE bucket IS NULL` query falls back to a full
   scan because `idx_merge_parity_log_matched` is keyed on `matched`
   only. **Suggested resolution:** Phase-2 follow-up index `CREATE
   INDEX idx_merge_parity_log_pending_bucket ON merge_parity_log(bucket)
   WHERE bucket IS NULL` (partial index — SQLite supports them since
   3.8.0). Captured in the day-6 commit message; not yet ticketed.

## 8. Sign-off

**Recommendation: GO-WITH-CAVEATS for Phase 2.** Dated **2026-05-09**.

**Caveats — Phase-2 day-1 prerequisites:**

- §4 item 1 — 7-day real-`notes.db` soak with zero D-bucket sightings.
- §4 item 2 — real op-log volume sampling.
- §4 item 8 — cutover plan doc with sequence, rollback, kill switch,
  and conflict-copy conversion rule written before the cutover commit.

**Caveats — Phase-2 day-2-or-later but pre-cutover-commit:**

- §4 item 3 — `loro_doc_state` storage decision + migration.
- §4 item 4 — `loro_batch` envelope `loro_bytes: Vec<u8>` field landed.
- §4 item 5 — two-device concurrent-merge proptests landed.
- §4 item 6 — macOS RSS measurement re-run on the day-4 replay bench.
- §4 item 7 — spike crate archived (`crates/loro-spike/` removed from
  workspace; notes/report docs preserved under `pending/`).

**User decision blocked-on items (the maintainer's call before
greenlighting Phase 2 day-1):**

- Confirm willingness to run the `--features loro-shadow` build on the
  primary workstation for ≥7 days. Without this, the GO recommendation
  is structurally weaker (proptest streams are necessary but not
  sufficient).
- Confirm the conflict-copy conversion rule for existing `is_conflict=1`
  rows (plan Q8) — concat-into-merge-result is the spike's preferred
  default; user UX sign-off needed.
- Confirm acceptable ≥1-release fallback window for the diffy code
  path (plan risks line 113); user names the release version that
  ships the Phase-3 cleanup.

**Next decision gate:** Phase 2 day-1, after the 7-day soak. If
zero-D holds at production scale on real `notes.db`, the cutover
commit is the default. If any D-bucket row appears, this report's
recommendation flips to **NO-GO** and the divergence is root-caused
before the scope unfreezes.

— PEND-09 Phase 1 day-10, 2026-05-09.
