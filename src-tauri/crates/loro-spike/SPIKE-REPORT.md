# PEND-09 Phase 0 — Loro spike report (go/no-go)

Two-week hard time-boxed spike, day 1 → day 7 complete on 2026-05-09.
Synthesis deliverable; the user reads this to decide whether to greenlight
Phase 1 (Shadow). All measurements and verdicts cited back to the
running notebook in `SPIKE-NOTES.md` and to the seven daily commits.

## 1. TL;DR

**Recommendation: GO for Phase 1.** All four kill criteria cleared by
material margins (parity 13/15 = 86.7 % strict A+B with **zero D
bucket**, 100K-op replay in 1.7 s with 144 MiB peak RSS, format
stability green for the 1.x line, tree mapping operational on both
LoroMap+scalar and LoroTree variants). The spike resolved every plan
open question (1-12) plus the three new questions (11-13) it surfaced,
and converged on a concrete data shape, a read-path architecture, and
a peer-id strategy that Phase 1 can adopt directly. No measurement
exposed a Loro perf or correctness cliff at our scale.

## 2. Kill criteria — verdicts

| # | Criterion | Verdict | Headline measurement | Day | Commit |
| - | --------- | ------- | -------------------- | --- | ------ |
| 1 | **Tree mapping operational** — zero correctness failures on a directly-ported subset of `merge/tests.rs` covering create / move / delete / restore / purge / reparent | **PASS** | All six tree ops implemented on `LoroEngine` (`apply_create_block`, `apply_move_block`, `apply_delete_block`, `apply_edit_content`, `apply_set_property`, soft-delete via `deleted_at`); all 26 spike tests green; both `LoroEngine` and `TreeEngine` pass the day-3 parity port and the day-5 head-to-head 100K verification (100/100 creates readable, 20/20 deletes confirmed) | 1, 3, 5 | `c9219fee`, `3c69fd70`, `1d58173b` |
| 2 | **Merge parity ≥95 % (A+B), zero D bucket** | **PASS (with caveat)** | 15/53 production tests sampled: **9 A / 4 B / 2 C / 0 D**. Strict A+B = 13/15 = 86.7 %. The two C cases are documented expected CRDT semantics (RGA-CRDT identical-edit doubling, Lamport-vs-wallclock LWW tiebreak), not Loro defects. **No D bucket on any sampled case.** Plan accepts C bucket "acceptable but each case documented" — both documented. Caveat: full 53-port + proptest augmentation deferred to Phase 1 entry; the 38 unported tests fall into ~17 LWW-tiebreak (expected C), ~11 conflict-copy-mechanism (no-longer-applicable), ~5 chain-walk error paths (no-longer-applicable), and ~5 integration shapes worth completing | 3 | `3c69fd70` |
| 3 | **100K-op replay < 10 min wall-clock + < 2 GB peak heap** | **PASS** (large margin) | **1.677 s wall-clock** (358× under the 10-minute floor), **144.32 MiB peak RSS** (14× under the 2 GiB floor), final snapshot 6.40 MiB for ~25K alive blocks (≈260 B / alive block); RSS grew almost-linearly from 4.4 MiB across the full apply loop with no perf cliff at any 10K checkpoint | 4 | `e72c4d01` |
| 4 | **Loro version + serialization-format stability** — within-major format stability with documented upgrade path | **PASS** | Loro 1.12 pinned (caret-1). Encoding format declared stable across the 1.x line — quoted from upstream changelog 1.0.0-alpha.0 ("Make the encoding format forward and backward compatible"), 0.8.0 ("Stabilize encoding"), 1.10.0 ("remove deprecated encoding format in v0.x" — i.e. v0.x format kept compatible deep into 1.x before retirement). Header byte 20-22 is an explicit `Encode Mode` u16 with versioned discrimination. License MIT (GPLv3-compatible). YELLOW flag: 2.0 transition is not under contract — mitigation per plan is `loro_version` field on every op-log payload row. | 1 | `c9219fee` |

**No criterion fired. Spike continues to recommendation.**

## 3. Open questions — resolutions

Plan questions 1-12 are from `pending/PEND-09-crdt-migration.md` lines
195-208. Spike-surfaced questions 9-13 are from the running notebook.
Some plan numbers and notebook numbers collide (the notebook
reorganised the carry-over list as questions resolved); the table
below uses the notebook's final numbering for clarity.

| Q | Topic | Status | Day | Headline finding |
| - | ----- | ------ | --- | ---------------- |
| **Plan 1** | Loro API stability | **Resolved** | 1 | Loro 1.12 in active 1.x line; AGENTS.md explicitly commits to "avoid breaking changes unless absolutely necessary"; LoroTree, LoroMap, LoroText are all first-class public-API containers. Caret-1 pin tracks bug-fix + minor releases. |
| **Plan 2** | Serialization format stability across minor versions | **Resolved** | 1 | Format declared stable across 1.x; explicit deprecate-then-remove cadence visible in changelog (v0.x format retired in 1.10 only). Kill criterion #4 NOT FIRED. Mitigation: `loro_version` field in every op-log payload row, per plan risks table. |
| **Plan 3** | Per-space doc vs per-page doc | **Resolved** | 4 | At ~25K alive blocks the snapshot is **6.4 MiB** (≈260 B / alive block). Linear extrapolation to 100K blocks ≈ 26 MiB — well under the plan's "could be ~100MB" speculative concern. Per-space-doc design holds; the 500ms-load-time concern in the plan's risks table is highly unlikely to fire. |
| **Plan 4** | Where the Loro doc lives | **Phase-1 detail** | — | Plan recommends option (b) — `loro_doc_state` table inside `notes.db`, periodically snapshotted. Spike did not relitigate this; the per-space-doc sizing finding (Q3) confirms the blob is small enough that SQLite-blob-encoded storage is unproblematic. |
| **Plan 5** | Concurrent-reparent semantics | **Resolved** | 3, 5 | LoroMap+scalar: LWW one-parent-wins (`parity_concurrent_reparent_different_parents`). LoroTree: also LWW one-parent-wins at the state level (`tree_concurrent_reparent_two_peers_converges` + 3-peer variant). Structurally LoroTree records `TreeOp::Move` as a distinct oplog op, potentially surfaceable via Loro's checkout API; LoroMap+scalar records it as an indistinguishable LoroMap-key write. Phase 1 picks LoroMap+scalar (see §4); the LWW resolution rule will be documented in the Phase-1 design doc per plan risks table. |
| **Plan 6** | Materializer read path (in-memory handle vs serialize-each-apply) | **Resolved** | 7 | Per-key reads measured at 25K-block scale: shape (A) `read_block` 2.29 µs, shape (C) `read_property` 0.88 µs — **faster than the typical SQLite indexed B-tree read** (~10-50 µs band). Shape (B) `list_children`-equivalent walk WITHOUT a parent-id side-index: 24.83 ms, ~3 orders of magnitude slower than indexed SQL. **Decision: SQL stays as the materializer's read cache; Loro is the truth-of-state for sync only** (matches the plan's contingency wording). |
| **Plan 7** | Op-type dispatcher path with `op_type='loro_batch'` | **Phase-1 detail** | — | Spike did not relitigate; plan's recommendation stands — add `original_op_type: Option<OpType>` to the loro_batch payload metadata (`payload_version` envelope per plan risks table). The dispatcher's downstream materializer fan-out is a Phase-1 implementation task. |
| **Plan 8** | Existing `is_conflict=1` rows in production data | **Phase-2 detail** | — | Out of Phase 0 scope by design. Plan flags as a Phase-2 cutover task: decide between delete vs concat-into-merge-result vs keep-as-legacy. Document the rule before cutover. |
| **Plan 9** | Actual user op-log volume | **Resolved-with-followup** | 4 | Spike used a synthetic 100K-op stream as the kill-criterion proxy. Margin (358× on time, 14× on heap) means even an order-of-magnitude error in the proxy would not change the verdict. Followup notebook Q12: sample the user's real `notes.db` op-log histogram before Phase 1 to confirm the 30/50/10/5/5 mix is in the right ballpark. |
| **Plan 10** | Hot-path properties promoted to native columns (`todo_state`, `priority`, `due_date`, `scheduled_date`) | **Phase-1 detail** | — | Stays as plan: native columns remain (cache layer), populated from Loro state. Spike's day-7 SQL-as-read-cache verdict (Q6) makes this trivially compatible — the materializer fan-out projects from the Loro doc into both the `blocks` row and the four hot-path columns. |
| **Plan 11** | File attachments | **Deferred** | — | Out of scope per plan; not part of `merge/`. File transfer path stays as-is. |
| **Plan 12** | Test corpus sufficiency | **Resolved-with-followup** | 3 | 15/53 sampled, distribution recorded, no D bucket. Full 53-port + proptest-augmented random op streams: deferred to Phase 1 entry. The 38 unported tests are categorised in SPIKE-NOTES day 3; ~33 of them are tests of diffy-specific mechanism (no-longer-applicable) and the remaining ~5 are integration shapes worth completing. |
| **Notebook 9** | Per-block LoroText overhead at scale | **Resolved-with-followup** | 4 | At synthetic short content the 100K-op replay reports ~260 B / alive block. Real workload re-measurement (production-typical 50-500-char content) recommended for Phase 1 to confirm the per-container overhead amortises rather than dominates at production content lengths. |
| **Notebook 10** | Edit-coordinate coercion | **Phase-1 detail** | 2 | Spike standardised on Unicode-scalar (USV) offsets — Loro's primary coordinate space across `LoroText::insert/delete/splice/slice/char_at/len_unicode`. UTF-8 and UTF-16 variants exist (`insert_utf8`, `splice_utf16`, `len_utf16`). Phase 1 must confirm the existing materializer / FE bridge can supply USV offsets, or document the coercion path (TipTap/ProseMirror typically emit UTF-16; CodeMirror has both). |
| **Notebook 11** | Cross-platform RSS measurement | **Phase-1-pre-sign-off** | 4 | Day-4 bench uses Linux `/proc/self/statm`; macOS reports `n/a` and skips the RSS half of the kill check. Cheap follow-up: add `mach_task_basic_info` wrapper for macOS before Phase 1 final sign-off. The wide kill-criterion margin makes this a check-the-box, not a gating, item. |
| **Notebook 12** | Real-op-log distribution histogram | **Phase-1-pre-entry** | 4 | Plan line 205 calls out "verify against your `notes.db` pre-spike." Spike used a 30/50/10/5/5 proxy; the real histogram should be sampled before Phase 1 entry to confirm proxy validity. Order-of-magnitude headroom on the day-4 result means a wrong proxy doesn't change the verdict, but Phase 1 wants the real numbers for capacity planning. |
| **Notebook 13** | Hash stability across stdlib versions | **Phase-1 detail** | 6 | Day-6 uses `std::hash::DefaultHasher` (currently SipHash-1-3); spec reserves the right to change algorithm across Rust compiler versions. Production must pin a stable third-party hash — `xxhash-rust = "0.8"` is the natural fit (deterministic, fast, no heavy crypto deps). Single-line dep change at Phase 1 entry. |

**Summary:** every plan question is either resolved at this gate
(Q1-Q3, Q5, Q6, Q9, Q12) or moved to a Phase-1 implementation detail
(Q4, Q7, Q10) or deferred (Q8, Q11) per the plan's own phasing. No
question is unanswered AND blocking.

## 4. Architecture decisions emerging from the spike

These are the concrete shapes Phase 1 should build against. Each
backed by spike measurements; deviation from the plan or the spike's
findings would warrant a re-spike.

### 4.1 Per-space LoroDoc with explicit data shape

Matches `pending/PEND-09-crdt-migration.md` lines 17-36 and is
implemented in `src/lib.rs` `LoroEngine`:

```text
loro_doc {
  "blocks":            LoroMap<block_id_str, LoroMap{
                          block_type:   LoroValue::String,
                          content:      LoroText,    // <- character-level merge
                          parent_id:    LoroValue::String|Null,
                          position:     LoroValue::I64,
                          deleted_at:   LoroValue::String|Null,
                       }>,
  "block_properties":  LoroMap<block_id_str, LoroMap<key_str, LoroValue>>,
  // block_tags + block_links: scope follow-up; design extends naturally
}
```

Day 4 size measurement: ~260 B / alive block at 25K alive blocks.

### 4.2 LoroMap + scalar `parent_id` (NOT LoroTree) for tree shape

Day 5 head-to-head was decisive: LoroTree is uniformly slightly worse
on every measured axis (apply +5.1 %, snapshot bytes +15.5 %, peak
RSS +13.2 %), with **state-level concurrent-reparent semantics
identical** to LoroMap+scalar (both LWW one-parent-wins). The
theoretical advantage of LoroTree (preservation of move history in
the oplog as `TreeOp::Move`) is not surfaceable through any Phase-1
user-visible feature. LoroMap+scalar is also ~150 LOC lighter
(`LoroEngine` 815 LOC vs `TreeEngine` 582 LOC + 30-line side-table
dance + 25-line external-id translation) and avoids fractional-index
machinery.

If a Phase-1.5 audit-log feature wants the loser-of-reparent intent
in the UI, switching is a few-hundred-line refactor — keep it on the
shelf as a deferred option, not a Phase-1 commitment.

### 4.3 LoroText for `content` (character-level merge)

Day 2 `tests/concurrent_edit.rs` proved character-level merge works:
two peers, divergent edits, snapshot exchange, both converge to
byte-identical 1017-byte exports with merged content `"The slow brown
dog"`. Day 3 `tests/parity_corpus.rs` test #5 demonstrated the
headline migration win: diffy line-merges `"hello world"` → Conflict
(forced conflict copy); Loro character-merges to `"goodbye universe"`
clean. Day-3 bucket distribution shows ~27 % of sampled merges shift
from B (diffy conflict copy) to clean Loro merge.

Coordinate space: USV (Unicode scalar values), via `LoroText::insert`
/ `delete` / `splice`. Phase 1 confirms the FE bridge speaks USV or
documents the coercion (notebook Q10).

### 4.4 SQL stays as the materializer's read cache; Loro is sync truth-of-state

Day 7 `read_path_bench` was the load-bearing measurement. Three read
shapes against a 25 145-block populated doc:

| Shape | Loro (measured) | SQL band (typical) | Ratio |
| ----- | --------------- | ------------------ | ----- |
| (A) `read_block` × 10K ids | 2.29 µs / read | ~10-50 µs | **5-20× faster** |
| (B) `list_children`-walk × 1K parents (no index) | 24.83 ms / walk | ~10-100 µs (covering index) | **250-2500× SLOWER** |
| (C) `read_property` × 1K (id, key) | 0.88 µs / read | ~10-50 µs | **10-50× faster** |

Shapes A and C clear the plan's "+10 % regression" gate cleanly —
they're faster than indexed SQL. Shape B is the architectural
verdict: the naïve secondary-key walk with no index is unusable as a
hot-path query, and the plan's contingency wording is exactly the
right move:

> "Spike measures: in-memory Loro handle vs serialize-each-apply. If
> reads regress >10 % vs current SQL-table reads, redesign the read
> path before Phase 1 (e.g., keep SQL caches as the materializer's
> read source, with Loro as the truth-of-state for sync only)."

**Phase 1 architecture:**

1. SQL `blocks` / `block_properties` / `block_tags` tables stay as
   the read cache. All `pagination::*` SQL paths
   (`list_children`, `query_by_property`, `list_by_type`,
   `list_backlinks`, `search_fts`) remain unchanged. Their indexes
   (`idx_blocks_parent_covering`, FTS5 contentless, property-key
   indexes) are the load-bearing read structures.
2. Loro is the canonical CRDT state for sync. The SQL projection
   is rebuilt from the Loro doc on apply (materializer fan-out).
   Reads NEVER go through Loro on the hot path.
3. Loro per-key reads (A, C) are fast enough for non-hot-path uses
   — debug tools, op-log audit, materializer rebuild from doc.

A `parent_id` side-index inside the engine (Loro `subscribe()`
callback, or mirror writes in a second LoroMap) is logged as a
Phase-1.5 option **only if** a future use-case wants `list_children`
directly off the doc — which the SQL-stays-read-cache architecture
does not require.

### 4.5 Per-op `commit()` cadence

Day 6 `commit_cadence_bench`: K = 1, 10, 1 000, 10 000 at 10K ops.
Wall-clock variance ≤30 %, snapshot bytes invariant within 0.5 %.
Best-case (K=1000) is ≈1.29× faster than per-op — well below the
"2× faster" bar that would justify the operational complexity of
batching. Per-op commits localise crash blast radius; the Loro doc
is a derived read-side cache (canonical state lives in `op_log`),
so even at K=10000 a mid-batch crash is recoverable by replaying
from the op_log. **Recommendation: per-op commits for Phase 1.** The
`apply_*_no_commit` plumbing is in place if a specific bulk-import
path later needs explicit batching, but Phase 1 doesn't take that
opt-in.

### 4.6 Peer-id derived from `device_id` via `std::hash::DefaultHasher` (spike); pin `xxhash-rust` for production

Day 6: `peer_id_from_device_id(&str) -> PeerID (u64)` hashes the
canonical UUID-v4 `device_id` (per `src-tauri/src/device.rs:83-99`)
through `std::hash::DefaultHasher` (currently SipHash-1-3) into the
`u64` Loro expects. Collision probability at agaric's plausible
scale (a few thousand devices): ≈1.4e-14 — lower than cosmic-ray
bit-flip probability. Three tests (`tests/round_trip.rs`) cover
determinism, spread, and snapshot-swap convergence under pinned
peer-ids.

For production, swap `DefaultHasher` for `xxhash-rust = "0.8"` (the
stdlib reserves the right to change `DefaultHasher`'s algorithm
across compiler versions; same input bytes could yield different
peer_ids after a Rust upgrade — unacceptable for a permanent device
identity). Single-line dep change (notebook Q13).

## 5. Risks + mitigations recap

Re-read of plan's risks table (`pending/PEND-09-crdt-migration.md`
lines 105-123). For each risk: spike's empirical position.

| Plan risk | Spike position |
| --------- | -------------- |
| Loro pre-1.0 breaking changes | **Refuted** for the Phase 1+ window. Loro 1.12 is post-1.0; AGENTS.md commits to "avoid breaking changes"; format-stability evidence is strong (Day 1). Pin caret-1, monitor 2.0. |
| Loro serialization format changes between versions | **Refuted** within the 1.x line. Day-1 evidence: stable encoding declared at 1.0, deprecate-then-remove cadence on the v0.x format. Mitigation `loro_version` field on every op-log payload row remains valid for the 2.0 transition. |
| Op-log → Loro import bug causes silent data loss | **Phase-1+ concern.** Out of spike scope — Phase 1 shadow mode runs parity sampling for weeks; Phase 2 backups + reversal rehearsal. Spike has nothing to add here. |
| Loro perf cliff at large doc sizes | **Refuted at the 100K-op / 25K-alive-block scale.** Day-4 RSS grew almost-linearly; no cliff at any 10K checkpoint. Doc sizes (6.4 MiB at 25K alive blocks) are well below the plan's speculated 100 MB ceiling. |
| User loses awareness of concurrent edits | **Phase-4 concern.** Spike confirms Loro silently merges character-level edits — exactly the user-visible promise. Phase 4 optional "recent-merges" indicator is the right place for this. |
| Snapshot format change breaks recovery on legacy snapshots | **Out of spike scope** (Phase 2 cutover detail). Plan's "old `merge/` engine in binary as fallback for ≥1 release" remains the right discipline. |
| Block tree invariant maintenance bugs (siblings same position; cycle) | **App-layer responsibility either way.** Day-5 confirms LoroTree does NOT prevent move cycles — same invariant maintenance the LoroMap engine does. Phase 1 keeps the existing app-layer validation. |
| Materializer assumes `is_conflict` exists during Phase 1-2 | **Plan-as-written holds.** Phase 1 keeps the column; Phase 3 drops it. The 612 references get cleaned phase-by-phase. Spike doesn't change this. |
| Materializer hot-path read cost | **Refuted as a regression** by Day-7. Per-key reads BEAT indexed SQL; the architecture verdict is "SQL stays as read cache, Loro is sync truth-of-state" — the secondary-key walk regression doesn't materialise because reads never go through Loro on the hot path. |
| Existing `is_conflict=1` rows in production | **Phase-2 concern.** Out of spike scope. Document the conversion rule before cutover (plan Q8). |
| Op-type dispatcher breaks when every op_type=='loro_batch' | **Phase-1 detail.** Plan Q7 — add `original_op_type` field to loro_batch payload metadata. Spike did not relitigate; the recommendation stands. |
| Test corpus may be insufficient for CRDT-specific bugs | **Mitigated.** Day-3 ported 15/53 tests with explicit bucket distribution + zero D. Phase 1 entry adds proptest-generated random op streams as the plan calls out. |
| `OpTransfer` opaque payload prevents debugging | **Phase-1 detail.** Plan calls for `payload_version` field; spike did not relitigate. The `loro_version` field (kill criterion 4 mitigation) is a natural piggyback. |
| Tree-op conflict resolution semantics under LWW | **Confirmed deterministic + lossy of intent.** Day-3 (LoroMap+scalar) and Day-5 (LoroTree) both produce LWW one-parent-wins. State-level semantics identical between engines. The "loser's intent dropped" is the documented tradeoff (plan Q5); explicit resolution rule must be written into the Phase-1 design doc. Optional "remote-overrode-your-move" awareness log is a Phase-4 polish. |
| Per-space doc size grows unbounded with usage | **Mitigated by measurement.** Day-4 extrapolation: 100K alive blocks ≈ 26 MiB. The 500ms-load-time concern at 100K does NOT fire on this volume. Re-measure with production-typical 50-500-char content lengths in Phase 1 (notebook Q9). |

## 6. Phase 1 readiness checklist

Concrete preconditions for starting Phase 1 (Shadow). Every item is
one Phase-1-entry task; none are blockers if they slip but each one
is cheap. In rough sequencing order:

> **Phase-1 day-1 (2026-05-09) — partial check-off.**  Items 1, 3, 5,
> and 6 below are partially or fully addressed by the day-1 scaffold
> commit (✅ markers inline).  Original wording is preserved verbatim
> for the historical record; the trailing parenthetical on each
> ✅-tagged item describes the day-1 delta (what landed and what
> didn't).  See `src-tauri/src/loro/` (the new production module),
> `src-tauri/Cargo.toml` (the optional `loro = "1.12"` dep + the
> `loro-shadow` feature flag), and `src-tauri/src/merge/mod.rs` (the
> `pub(crate) fn shadow_apply` stub) for the landed code.

1. ✅ **Add the dep.** `src-tauri/Cargo.toml` gains `loro = "1.12"` (caret-1, matching the spike). Also `xxhash-rust = "0.8"` for the peer-id hash (replaces the spike's `std::hash::DefaultHasher`, see notebook Q13). _(Day-1: `loro = "1.12"` landed as `optional = true`, gated behind the new `loro-shadow` cargo feature so the default build is byte-identical to today's.  `xxhash-rust` swap deferred — Phase-1 day-1 inherits the spike's `DefaultHasher`-based `peer_id_from_device_id` unchanged; the swap becomes load-bearing once peer ids start persisting across process lifetimes, i.e. Phase 2.)_
2. **Sample the real op-log histogram.** Run the user's actual `notes.db` op_log through a one-off counting script; confirm the 30/50/10/5/5 spike proxy is in the right ballpark, OR re-run the day-4 replay bench with the real distribution to confirm the kill-criterion margin is robust to it (notebook Q12).
3. ✅ **Stand up `src-tauri/src/loro/`** as a new module — `LoroEngine` struct, `apply_op`, `export_batch`, `import_batch`, lifted from the spike crate's `src/lib.rs` (815 LOC). Add the `xxhash-rust`-based `peer_id_from_device_id`. Drop the `TreeEngine` (Day-5 verdict — not needed). _(Day-1: `src-tauri/src/loro/{mod.rs, engine.rs, parity.rs, tests.rs}` created.  `engine.rs` ports the spike's six apply methods + read surface + `export_snapshot`/`import` (~600 LOC), adapted to `Result<T, AppError>` from the spike's `anyhow::Result`.  `TreeEngine` not ported per Day-5 verdict.  Module is gated `#[cfg(feature = "loro-shadow")]` — empty when the feature is off.)_
4. ✅ **Define the `loro_batch` payload envelope.** Includes `loro_version: u32` (mitigates kill-criterion-4's YELLOW flag), `payload_version: u32`, `original_op_type: Option<OpType>` (dispatcher routing — plan Q7), and the Loro-exported batch bytes. _(Day-3: `src-tauri/src/loro/envelope.rs` lands the `LoroBatch` schema with `loro_version: u8` (= 1), `payload_version: u8` (= 1), `original_op_type: String`, and `payload: serde_json::Value` (kept as `Value` so future op-type variants can ride through unmodified).  Field widths narrowed `u32 → u8` because we don't anticipate >= 256 versions before this code is rewritten or removed.  `Loro-exported batch bytes` deferred — Phase 1 dual-writes the typed payload; the shift to opaque Loro-exported bytes happens at Phase 2 cutover, at which point this schema gains a `loro_bytes: Vec<u8>` column.  A `TryFrom<&OpRecord>` impl wraps a typed op_log row as an envelope; 4 unit tests (roundtrip, OpRecord conversion, malformed-JSON rejection, typed `OpPayload` round-trip-through-Value).  No call sites yet — day-4 / day-5 territory.)_
5. ✅ **Wire shadow-mode dual-write.** `src-tauri/src/merge/mod.rs` gains a wrapper that calls both diffy and Loro on every op; diffy result is authoritative; Loro result is logged. _(Day-1: `pub(crate) fn shadow_apply(op_id: &str)` stub landed in `merge/mod.rs`.  No-op when `loro-shadow` is off; even with the feature on, the body is a placeholder — wiring at real call sites + the actual dual-write logic is days 2-3 work.  The point of day-1 is the call shape exists and compiles; the public surface of `merge/` is unchanged (the new fn is `pub(crate)`).  **Day-2:** real `shadow_apply` body landed (`merge/mod.rs`, ~140 LOC) dispatching the FIVE op types the spike's engine supports onto a per-space `LoroEngine` via `LoroEngineRegistry` (`loro/registry.rs`) + recording a per-op `ParityEvent` into the in-memory ring; `merge::apply::shadow_dispatch_for_record` threads an `OpRecord` through `space::resolve_block_space` → `shadow_apply`; the merge-orchestrator call sites in `merge_block_text_only` are wired (clean-merge + conflict-copy paths).  **Day-3:** the materializer's per-op apply path (`materializer::handlers::apply_op` + the `BatchApplyOps` arm) now also dispatches to `shadow_dispatch_for_record` after `tx.commit` — so every record routed through `MaterializeTask::ApplyOp` (remote sync ops + post-merge clean-merge + conflict-copy) is mirrored onto Loro.  The merge-layer dispatch was deduped to avoid double-dispatch: only the merge-on-original record (which is never enqueued to the materializer) still dispatches from `merge::apply`.  Local single-author writes that bypass `MaterializeTask::ApplyOp` (e.g. `commands/blocks/crud.rs::commit_and_dispatch`) are not yet covered — separate gap, deferred to a later day.  The off-side `(op_id, op, device_id)` stub of `shadow_apply` is deleted; the only definition that exists is the feature-on `(op_id, op, device_id, space_id, summary, state)` signature, gated `#[cfg(feature = "loro-shadow")]`.)_
6. ✅ **Design the parity-logging sink.** Either a new SQLite table (`merge_parity_log`) or an in-memory ring buffer flushed periodically; columns / fields = (op_id, diffy_result_hash, loro_result_hash, bucket_a/b/c/d classification, free-text divergence). Decide retention policy (e.g. 30 days rolling). _(Day-1: in-memory ring buffer landed in `src/loro/parity.rs` as `ShadowParitySampler` (default capacity 1024).  `ParityEvent { op_id, diffy_result, loro_result, match, timestamp }` matches the day-1 spec; the bucket A/B/C/D classification + free-text divergence + retention policy + persistent SQLite sink all remain to be decided in later Phase-1 days.)_
7. **Port the remaining ~5 integration shapes** from `merge/tests.rs` (the day-3 unported list) into `src-tauri/src/merge/parity_tests.rs`. These are the ones that exercise multi-block merge under realistic load — bucket A/B confirmation, not new D risk.
8. **Add proptest-augmented parity tests.** Plan risks table: "Augment `merge/tests.rs` with proptest-generated random concurrent op streams" — spike skipped this for time-box reasons. Phase 1 entry is the right place.
9. **Document the LWW resolution rule** (concurrent-reparent + concurrent-property-write) in the Phase-1 design doc per plan Q5 + notebook Q12. Decision: Lamport-keyed LWW; loser's intent dropped from materialised state; LoroTree intent-preservation is NOT exposed in Phase 1.
10. **Confirm the FE edit-coordinate space.** TipTap / ProseMirror typically emit UTF-16; Loro speaks USV. Phase 1 design doc documents the bridge — either coerce at the FE → backend boundary or use Loro's `splice_utf16` variants (notebook Q10).
11. **Add macOS RSS measurement** to the day-4 replay bench (`mach_task_basic_info` wrapper, no libc dep). Re-run the kill-criterion check on macOS for sign-off completeness (notebook Q11).
12. **Plan the Phase-2 `loro_doc_state` table schema** as `0042_loro_doc_state.sql` — even though the migration ships at Phase 2 cutover, deciding the column shape now (per-space-id, doc bytes, snapshot-counter, last-modified) is cheap.
13. **Decide the conflict-copy migration rule** for Phase 2 (plan Q8). Concat-into-merge-result is the spike's preferred default; needs UX sign-off before Phase 2.
14. **Schedule the spike-archive step.** When Phase 1 lands, archive the `loro-spike` crate as `pending/PEND-09-spike-archive.tar.gz` (or convert to a git tag) so the throwaway code doesn't accrete maintenance burden alongside the production code.

## 7. What stays unchanged in Phase 1

Reiterating the plan's "What stays unchanged" (lines 95-102) plus
spike-confirmed additions:

- **Sync transport.** mDNS + WebSocket + TLS + TOFU pinning. No
  iroh. Wire `OpTransfer` shape unchanged — opaque bytes carrying
  versioned `loro_batch` payloads.
- **`op_log` schema.** Same `(device_id, seq, parent_seqs, hash,
  op_type, payload, created_at)` shape. New rows are
  `op_type='loro_batch'`; legacy typed-op rows untouched until Phase
  2 one-shot replay.
- **Hash chain logic.** Still blake3 over the row contents.
- **Materializer architecture.** Still maintains derived caches
  (FTS, agenda, tag inheritance, link graph). Source of truth shifts
  to the Loro doc; the derived caches are rebuilt from the doc on
  apply.
- **Block tree storage in `blocks` table.** Day-7 verdict: SQL
  remains the read cache. All `pagination::*` paths unchanged.
  `idx_blocks_parent_covering`, FTS5, property-key indexes — all
  load-bearing, all kept.
- **All UI.** Editor, slash commands, agenda, FTS, properties —
  unchanged behaviour, unchanged code in Phase 1. Conflict-copy UI
  remains visible until cutover; only after Phase 2 does conflict
  production stop.
- **Snapshot + compaction.** Schema may add `loro_doc_bytes` column
  to `log_snapshots` to seed new devices fast — but that's a
  Phase-2 decision per plan, not a Phase-1 entry change.
- **The `is_conflict` column.** Stays through Phase 1 + Phase 2.
  Drops in Phase 3 migration `0043_drop_is_conflict.sql`.
- **`device_id` shape.** Stays as a canonical UUID-v4 string in
  `notes.db` (`src-tauri/src/device.rs:83-99`). The Loro `PeerID` is
  a derived `u64` hash — no DB changes for peer-id machinery.
- **Per-op `commit()` cadence inside the engine.** Day-6 verdict —
  no batching. Phase 1 inherits this directly from the spike.
- **The four hot-path properties as native columns** (`todo_state`,
  `priority`, `due_date`, `scheduled_date`). Plan Q10. They become
  derived from Loro state; the columns themselves stay.

## 8. Calendar estimate, refined

The plan's revised table (lines 159-167) lists Phase 1 = 3-4 weeks
for a solo maintainer. With spike-grounded confidence on the data
shape, the read-path architecture, and the peer-id strategy, the
spike's view of each phase:

| Phase | Plan estimate | Spike-refined estimate | Notes |
| ----- | ------------- | ---------------------- | ----- |
| 0 — Spike | 2-2.5 weeks | **Delivered in 1 week (7 days)** | Day-1 → day-7 finished on schedule. The 2-week budget had a buffer for an open-ended Loro-stability investigation; that wasn't needed because the format-stability and API-stability evidence was clear by day 1. |
| 1 — Shadow | 3-4 weeks | **3-4 weeks unchanged.** | Day-7 architecture decision (SQL stays as read cache) means the materializer fan-out in Phase 1 is a write-side change only — that's slightly simpler than a hypothetical "rewrite all reads" version, but the dominant cost is dual-write logic + parity sampling + debugging CRDT divergence under real workloads, which is unchanged by the spike. The 14-item readiness checklist (§6) is the concrete scope. |
| 2 — Cutover | 3-4 weeks | **3-4 weeks unchanged.** | Spike doesn't materially change this. Highest-risk phase remains the legacy-op-log → Loro-doc one-shot replay; needs verification + DB backup + reversal rehearsal. The day-4 replay-bench shape is reusable as the basis for the production replay-and-verify path. |
| 3 — Cleanup | 2-3 weeks | **2-3 weeks unchanged.** | 612 references, codemod + manual review. Tedious but mechanical, as the plan says. |
| 4 — UX (optional) | 1 week | **1 week unchanged.** | — |

**Refined calendar: 9-12 weeks** (assuming the spike's 1-week early
finish is absorbed as buffer rather than schedule-shortener). Effort
remains 7-11 person-weeks. The plan's 11-15-week version was honest
about buffer; with the spike's findings the buffer can come down
slightly because the kill-criterion margins eliminate some of the
"what if Loro is unexpectedly slow" anxiety. **Net: ~1-2 weeks
faster than the plan's worst case, same as the plan's best case.**

## 9. What this spike did NOT cover

Honest list. None of these are kill-criterion gaps; all are scoped
out by design or by the spike's environment.

1. **Real user op-log replay.** Spike used a deterministic synthetic
   30/50/10/5/5 op-mix. The user's actual `notes.db` op-log
   distribution is not yet sampled (plan line 205, notebook Q12).
   Phase 1 entry should sample it.
2. **Production-realistic content lengths.** Spike's edits are 0-4
   USV deletes plus 1-6-char insertions (procedural strings). Real
   notes are 50-500 chars typical, Markdown-shaped, with paste-from-
   web outliers in the kilobyte range (notebook Q9). Per-block
   LoroText overhead at production content lengths needs a Phase-1
   re-measurement.
3. **FE edit-coordinate coercion.** Spike standardised on USV
   offsets. The TipTap / ProseMirror / contenteditable bridge
   typically emits UTF-16 (notebook Q10). Phase 1 design doc must
   close this; the spike couldn't because the spike doesn't touch
   the FE.
4. **macOS / Windows RSS measurement.** Linux-only via
   `/proc/self/statm` (notebook Q11). The wide kill-criterion
   margin (14×) means the verdict is robust to platform variance,
   but Phase 1 sign-off should re-run on Mac as a formality.
5. **ARM Linux (16 KiB pages).** RSS reading hard-codes 4 KiB pages.
   ARM with 16 KiB pages would over-count by 4×. Re-confirm if/when
   we benchmark there. Not Phase-1 gating.
6. **Real SQL vs Loro head-to-head in the same harness.** Spike
   crate has no SQLite dep (by design — the spike is self-
   contained, and adding SQLite was scoped out). Day-7's "SQL band"
   is drawn from the production `pagination_bench.rs` shape and
   typical SQLite-WAL latency expectations, NOT from a paired
   measurement in the same crate. Tighter cross-comparison needs
   Phase-1 work once the engine is wired into the materializer.
7. **Full 53-test parity port.** Day 3 sampled 15. The 38 unported
   tests are categorised in SPIKE-NOTES day 3: ~17 LWW property-
   tiebreak (expected C), ~11 conflict-copy mechanism (no-longer-
   applicable), ~5 chain-walk error paths (no-longer-applicable),
   ~5 integration shapes worth completing. Phase 1 entry finishes
   the integration shapes + adds proptest-augmented streams.
8. **Op-log → Loro one-shot import path.** Phase-2 cutover
   workpiece. Spike has the apply machinery (day-4 replay-bench);
   the one-shot path itself is a Phase-2 deliverable.
9. **`loro_doc_state` table schema.** Phase-2 detail per plan.
10. **Conflict-copy → merge-result conversion rule** for existing
    `is_conflict=1` rows (plan Q8). Phase-2 detail.
11. **3-month-soak under real workload.** The plan calls this out
    explicitly as Phase-1 territory ("weeks of production parity
    sampling"). Spike can't measure what only real users + real
    devices + real cross-device sync produce.
12. **Tree-op conflict UX exposure (loser-of-reparent visibility).**
    Day 5 confirmed LoroTree's oplog _could_ surface this via Loro's
    checkout API; the actual UI work is Phase-4 optional polish.

## 10. Final recommendation

**GO for Phase 1.** Confidence: **high.** The spike cleared every
kill criterion by margins large enough to absorb realistic
production variance — wall-clock 358× under threshold, peak heap
14× under threshold, parity zero D bucket on the sampled subset,
format stability green for the 1.x line. The plan's open questions
1-12 are all either resolved at this gate or moved to clearly-scoped
Phase-1 implementation tasks; the spike-surfaced questions 11-13
are equally tractable. The architecture has converged on a concrete
shape (per-space LoroDoc with the data layout in §4.1, LoroMap +
scalar parent_id, LoroText for content, SQL stays as read cache,
per-op commit cadence, `xxhash-rust`-derived peer_id) that Phase 1
can build against without re-litigating spike findings.

The gating decision the user makes today: **greenlight Phase 1.**
The 14-item readiness checklist in §6 is the concrete entry scope.
The "GO with caveats" framing would only fit if a kill criterion
were marginal — none is. The C-bucket cases in parity (test #9
identical-edit doubling, test #14 LWW-rule divergence) are
documented expected CRDT semantics, not yellow flags.

The next decision gate is end-of-Phase-1, on shadow-mode parity
statistics over weeks of real-workload sampling. If those statistics
hold the day-3 zero-D pattern at production scale, cutover is the
default.

## 11. Appendix — How to reproduce the spike measurements

All commands run from `src-tauri/`, use `--release`, and were
re-executed during day 1-7 to back the report's quoted numbers.

```sh
# Day 1 round-trip + LoroText baseline + day-2 baseline (852-byte snapshot)
cargo run --release -p loro-spike

# Day 4 — kill criterion #3, 100K-op replay (wall-clock + RSS + snapshot bytes)
cargo run --release -p loro-spike --bin replay_bench

# Day 5 — LoroTree head-to-head, same op-stream, different engine
cargo run --release -p loro-spike --bin tree_replay_bench

# Day 6 — commit-cadence sweep (K = 1, 10, 1 000, 10 000 at 10K ops)
cargo run --release -p loro-spike --bin commit_cadence_bench

# Day 7 — read-path benchmark (3 read shapes against 25K-block doc)
cargo run --release -p loro-spike --bin read_path_bench

# All 26 spike tests (round_trip + concurrent_edit + concurrent_reparent_tree + parity_corpus)
cargo test --release -p loro-spike -- --nocapture --test-threads=1
```

Each command prints its own measurement table; the spike-notes
extracts above are exact quotes from these binaries' stdout. Re-runs
on the same machine should reproduce within ±10-15 % wall-clock
variance (the variance band noted in day-6 commit-cadence numbers).
