# PEND-09 Phase 3 — Cleanup + sync rebuild plan

Day-1 deliverable for Phase 3, written **2026-05-10**, the day after
the Phase-2 day-15 addendum
(`pending/PEND-09-PHASE-2-REPORT.md` §10, commit `2cf07f57`) closed
with a **GO-FOR-CUTOVER** recommendation, and the day-17 follow-up
(`ff272b0b`, `parity_report --purge-before`) closed clean against the
test suite.

This doc is the analog of `pending/PEND-09-PHASE-2-CUTOVER-PLAN.md`
scoped to Phase 3 — but Phase 3 is **not** a pure deletion pass. Per
the maintainer's 2026-05-10 clarification ("I want sync support. So
far I am the only user and I have NOT started using the old
[diffy-based] sync. I want to use the new Loro-based sync."), Phase 3
is a **top-down sync-layer rebuild**: the diffy 3-way-merge / LWW /
conflict-copy primitives in `src-tauri/src/sync_protocol/operations.rs`
plus `src-tauri/src/merge/{apply,detect,resolve}.rs` are replaced with
Loro-CRDT export/import over the existing transport. The diffy code is
deleted in the same pass — every reachable call site becomes
unreachable once the sync apply path swings to Loro, so keeping diffy
as a "fallback" buys nothing.

Every implementation claim is cited to file:line / commit /
`pending/*.md`. §10 enumerates the genuinely-open items the maintainer
must decide before specific days land.

## 1. Phase definition

### 1.1 What "Phase 3" means in this revised scope

The original plan
(`pending/PEND-09-crdt-migration.md` lines 67-68 + 144-150) framed
Phase 3 as a deletion pass: drop `merge/{apply,detect,resolve}.rs`,
drop the `is_conflict` column, sweep ~870 reference sites
(`pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §6.4 verified count), drop
`merge_parity_log`. Sync was assumed unchanged because it was already
running on the diffy primitives.

The maintainer's 2026-05-10 clarification reframes this. Sync is
**NOT** in production (no peers in the field, single-user codebase, no
backward-compat constraints). The diffy-based sync apply path
(`sync_protocol::apply_remote_ops` →
`sync_protocol::merge_diverged_blocks` → `merge::merge_block_text_only`
plus `merge::resolve_property_conflict` plus the inline LWW
dispatchers in `sync_protocol/operations.rs:515-822`) has never
delivered a converged-cross-device result to a real user. Phase 3
therefore swaps it out for a Loro-CRDT apply path
(`LoroEngine::import(bytes)` over the transport-layer envelopes wired
in Phase 2 day-3, commit `9d780586`).

Three things happen on the Phase-3 trunk, in order:

1. **Cutover-flag flips ON by default** (day 2). A migration updates
   the `app_settings.pend09.loro_authoritative` row from `'0'` to
   `'1'`. The materializer's per-arm `if is_loro_authoritative()`
   branches in
   `materializer/handlers.rs:609,620,664,702,714,725,736,747,758,769`
   begin routing local writes through Loro. Reversible via SQL UPDATE
   (Phase-2 §5.3); reversibility lasts through days 2-4 and
   disappears at day 9 when the cutover infrastructure itself gets
   deleted.
2. **The Loro-based sync apply path lands** (days 3-5). A new
   `sync_protocol::loro_sync` module replaces `apply_remote_ops` plus
   `merge_diverged_blocks`. Wire format:
   `LoroBatch.loro_bytes` (the Phase-2 day-3 envelope field at
   `src-tauri/src/loro/envelope.rs:120-148`) carries Loro-exported
   binary instead of typed JSON payloads. Sync push reads the
   per-space `LoroEngine`'s outgoing batch; sync pull calls
   `LoroEngine::import(bytes)` and lets the materializer project to
   SQL through the existing cutover-on path.
3. **The diffy code, the cutover flag, the parity infrastructure, and
   the `loro-shadow` Cargo feature all get deleted** (days 6-11).
   Every reachable call site becomes unreachable once day 5 swings
   the sync apply, so the deletion pass collapses ~5 400 LOC of
   `merge/` plus the inline diffy dispatchers in
   `sync_protocol/operations.rs:420-880` plus the cutover-flag
   reading machinery (`loro/cutover.rs`,
   `loro/parity*.rs`, `loro/classifier.rs`, `loro/parity_proptest.rs`,
   `loro/flush_task.rs::classify_unbucketed` plus `purge_old`).

### 1.2 Scope boundary — when Phase 3 closes

Phase 3 ends when **all** of the following are true:

* The cutover flag flips ON by default (day 2) and stays on.
* The Loro sync wire types ship (day 3).
* The Loro sync push path ships (day 4).
* The Loro sync pull path ships (day 5) — `apply_remote_ops` plus
  `merge_diverged_blocks` deleted, replaced by
  `apply_remote_loro_batch`.
* `merge::apply::merge_block_text_only` plus its callers in
  `sync_protocol::operations` deleted (day 6).
* `merge::resolve_property_conflict` plus `merge::detect` plus the
  conflict-copy creation arm deleted (day 7).
* `apply_*_via_loro` and `apply_*_tx` collapse to a single
  per-op-type apply path; the `if is_loro_authoritative()` branches
  in `materializer/handlers.rs` disappear (day 8).
* `loro-shadow` feature gate removed; `loro = "1.12"` becomes a hard
  dep; `xxhash-rust` becomes a hard dep (day 9). `loro/cutover.rs`
  vanishes.
* Migration drops `merge_parity_log` plus the
  `app_settings.pend09.loro_authoritative` row (day 10).
* Decision on the parity sink / classifier / flush task: re-purpose
  for sync confidence OR delete (day 11).
* End-to-end Loro-sync integration test passes (day 12).
* Phase 3 final report (day 13).

Phase 3 is **NOT**:

* **Not the FE-side Loro `subscribe()` integration.** The FE continues
  to read SQL rows projected from Loro state. The Loro-mode equivalence
  point in `pending/PEND-09-fe-edit-coordinate-space.md` § "Loro-mode
  equivalence" remains; Phase 3.5+ is when FE-side `subscribe()` and
  USV ↔ UTF-16 cursor bridging would land.
* **Not the `is_conflict` column drop.** Phase 3 makes the
  conflict-copy creation path unreachable (day 7) but the column
  itself stays readable. The drop migration deferred to Phase 4 — the
  870-site reference sweep is mechanical-but-tedious and orthogonal
  to the sync rebuild.
* **Not the iroh / internet-scale sync transition.** Same out-of-scope
  as the original plan (`pending/PEND-09-crdt-migration.md` line 7).
  Sync stays on the existing mDNS+WebSocket+TLS+TOFU stack
  (`src-tauri/src/sync_daemon/`, `src-tauri/src/sync_net/`,
  `src-tauri/src/sync_cert.rs`).

## 2. Architecture decisions

### 2.1 Wire format — `LoroBatch.loro_bytes` replaces typed `OpBatch`

Pre-Phase-3, `sync_protocol::types::SyncMessage::OpBatch` carries
`Vec<OpTransfer>` (per-op typed JSON payloads,
`src-tauri/src/sync_protocol/types.rs:155-162`). Each `OpTransfer` is
a fixed-shape `(device_id, seq, parent_seqs, hash, op_type, payload,
created_at)` tuple plus ~12 typed payload variants. The receiver
decodes each op's payload, calls `apply_remote_ops`, and calls
`merge_diverged_blocks` for 3-way text merge plus LWW property plus
LWW move resolution.

Post-Phase-3, the wire format is **Loro's own binary export**:

* `SyncMessage::OpBatch` is replaced with new variants
  `LoroSyncSnapshot { space_id, bytes }` and `LoroSyncUpdate {
  space_id, bytes, is_last }`.
* `LoroSyncSnapshot` carries a full state-plus-history export from
  `LoroDoc::export(ExportMode::Snapshot)`
  (`loro-1.12.0/src/lib.rs:1273`). Size ≈ 6.4 MiB at 25K alive blocks
  (`pending/PEND-09-SPIKE-REPORT.md` §3 row "Plan 3"); ≈ 26 MiB at
  100K. Used for **initial sync** (peer has no state) and the
  post-`ResetRequired` snapshot sub-flow already routed through
  `sync_daemon::snapshot_transfer`.
* `LoroSyncUpdate` carries an incremental delta from a known peer
  version vector via `LoroDoc::export(ExportMode::updates(&peer_vv))`
  (`loro-1.12.0/src/lib.rs:1297-1300`). Used for **incremental sync**
  (steady state). Size proportional to local
  `LoroDoc::oplog_vv()` (`loro-1.12.0/src/lib.rs:887`) minus peer VV.

**Decision: ship both.** Initial sync = snapshot; subsequent sync =
update. A new pre-stream `PeerVersionVectors` exchange (§8.3) tells
the sender which to send.

The `LoroBatch.loro_bytes` field
(`src-tauri/src/loro/envelope.rs:120-148`, Phase-2 day-3 commit
`9d780586`) is the **storage** primitive — same byte layout on the
wire and inside `op_log.payload`. The `payload_version` and
`loro_version` envelope fields handle forward-compat per §7.2.

**Per-space wire format.** One sync message per space being synced
(matches existing per-space partitioning per
`pending/PEND-09-crdt-migration.md` line 13 and the
`LoroEngineRegistry` in `src-tauri/src/loro/registry.rs`).

**Alternatives rejected.**

* (a) Keep typed `OpBatch`; project diffy results into Loro on
  import. The current Phase-2 cutover-on path. Rejected because the
  maintainer wants to **delete** diffy, not preserve it as a wire
  dependency.
* (b) JSON-encoded Loro update wire format (`export_json_updates`).
  Rejected because the binary format is the on-disk format inside
  `op_log.payload`'s `LoroBatch`; JSON would force re-encoding.
* (c) Per-op Loro export. Rejected for batch-level efficiency.
  `import_batch` (`loro-1.12.0/src/lib.rs:425`) already supports
  multi-batch imports if per-op granularity ever matters.

### 2.2 Sync push — engine state out, transport bytes in

**Today.** Local writes hit `apply_op` → `apply_op_tx`; with the
cutover flag on, an `apply_*_via_loro` helper updates the engine
first, then `apply_op_tx` projects to SQL (Phase-2 day-15,
`pending/PEND-09-PHASE-2-REPORT.md` §10.2 day 15). Sync push
re-fetches the typed `OpRecord` rows from `op_log` and serialises to
`OpBatch` (`sync_protocol::compute_ops_to_send`,
`sync_protocol/operations.rs:67-93`).

**Phase 3.** Local writes still hit the cutover-on materializer hot
path. Sync push changes shape:

```text
sync push (sender side):
  for each space being synced:
    let peer_vv = peer_refs::get_loro_vv(peer_id, space_id) ?? VersionVector::default()
    let bytes = registry.with_engine(space_id, |e| e.export_updates(&peer_vv))?
    if bytes.is_empty() { continue }       // peer is up-to-date for this space
    send LoroSyncUpdate { space_id, bytes, is_last }
```

For initial sync (peer has no `peer_refs` row for `space_id`):
`engine.export_snapshot()` and send `LoroSyncSnapshot`. The exact
threshold ("how stale is too stale to send updates? send a snapshot
instead") is §10.4; default = "if peer has no record, snapshot;
otherwise updates".

The local `op_log` rows continue to exist — they record local
single-author writes. They're just **not the wire format** anymore.
See §2.6 for the op-log-vs-engine source-of-truth question.

### 2.3 Sync pull — bytes in, Loro import, materializer projects

**Today.** Remote ops arrive as `OpBatch.ops: Vec<OpTransfer>`;
`apply_remote_ops` validates hashes, inserts into `op_log` (single
explicit transaction per chunk), enqueues `MaterializeTask::ApplyOp`
(`sync_protocol/operations.rs:124-280`-ish). Then
`merge_diverged_blocks` runs the LWW dispatchers
(`sync_protocol/operations.rs:420-880`).

**Phase 3.**

```text
sync pull (receiver side):
  on LoroSyncSnapshot { space_id, bytes }:
    registry.with_engine_or_create(space_id, |engine| engine.import(&bytes))?;
    materializer.notify_sync_apply(space_id, /*full_reproject=*/true);

  on LoroSyncUpdate { space_id, bytes, is_last }:
    let changed = registry.with_engine(space_id, |engine| {
        engine.import_with_changed_blocks(&bytes)
    })?;
    materializer.notify_sync_apply(space_id, /*changed=*/changed);
```

`LoroDoc::import` (`loro-1.12.0/src/lib.rs:710`) handles concurrent
ops via op-log merging — no "needs divergence resolution" outcome.
Per Phase-0 spike validation (`pending/PEND-09-SPIKE-REPORT.md` §2),
parity_corpus, Phase-1 day-8 single-author proptest commit `89df17a2`,
and Phase-2 day-2 two-device proptest commit `a9849adc` (1 024
randomised concurrent runs, zero D-bucket sightings), Loro converges
deterministically across two engines' op-logs.

### 2.4 Materializer projection after sync pull — per-block fanout

**The problem.** Today's per-op
`projection::project_*_to_sql` helpers
(`src-tauri/src/loro/projection.rs:1-1203`) take a typed payload plus
an engine reference and write the SQL row(s). A sync pull
`LoroEngine::import(bytes)` updates the engine in arbitrarily many
places at once — there's no per-op typed payload to drive the
helpers.

**Decision: re-derive the affected blocks from the engine** (Option
(i) — full enumeration).

* Loro 1.12 `import` returns an `ImportStatus` with per-peer change
  ranges (`loro-1.12.0/src/lib.rs:710`).
* Implement a new `LoroEngine::import_with_changed_blocks` that
  diffs `oplog_vv()` before/after import and walks the resulting
  `VersionVectorDiff` to enumerate touched block-IDs, OR subscribes
  to engine change events during the import scope.
* For each changed block: a new
  `project_block_full_to_sql(conn, engine, block_id)` helper reads
  the engine's current view and writes the SQL row(s).

Rejected: Option (ii) re-export old-VV → new-VV deltas, decode via
`export_json_updates` / `import_json_updates`, run per-op typed
projection helpers. Re-introduces the JSON-round-trip shape that
Phase-2 day-9.5 (`eb01c5f8`) just fixed
(`pending/PEND-09-PHASE-2-REPORT.md` §5).

**Atomicity.** Sync pull writes many SQL rows. Decision: **single tx
for the whole batch.** The engine import already happened before the
tx; a crash mid-projection leaves the engine ahead of SQL. Boot
crash recovery checks `(engine_block_count vs sql_block_count)` per
space and re-runs projection for any space where they disagree. The
day-6 snapshot scheduler (`loro/snapshot.rs`, Phase-2 commit
`88323c8e`) ensures the engine state survives a crash.

### 2.5 No conflict copies — UX implication

Diffy's `merge_block_text_only` (`merge/apply.rs:47-140`) emits a
`MergeOutcome::ConflictCopy` arm — the only place where two devices'
edits to the same block produce two persistent rows. Phase 3 deletes
this arm because Loro RGA-CRDT `LoroText` always converges to a
single string when two engines import each other's deltas.

**UX.** Loro's RGA tracks character identity, so the interleave on
concurrent overlapping edits is deterministic but may not match user
expectation. Insertions at different positions: both survive.
Concurrent edits to the same characters: both edits coexist, result
depends on op ordering. Concurrent property writes (same key on same
block): Loro's per-key LWW selects one value; the loser's value is
gone — matches diffy's existing `resolve_property_conflict` (later
`created_at` wins, `device_id` tiebreaker per
`pending/PEND-09-lww-resolution-rule.md`). Concurrent moves: same
per-key LWW.

**Existing `is_conflict=1` rows.** Per
`pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §7.1, a conversion rule is
needed for legacy rows **if any exist**. Verified 2026-05-10:
maintainer's primary `notes.db` is single-user, never-synced;
assumption is zero such rows. §10.3 carries the
assertion-vs-migrate decision.

### 2.6 Op-log: what's it for after sync rebuild?

**Today.** `op_log` records both local single-author writes (via
`op_log::append_local_op`) and every remote op pulled via
`apply_remote_ops`. The materializer reads from `op_log`, dispatches
per-op-type to `apply_op_tx`. The hash chain (`OpRecord.hash`) is
the sync protocol's integrity check.

**Phase 3 — two shapes.**

* **(a) `op_log` records local writes only; sync pull bypasses it.**
  Loro's own op-log inside the `LoroDoc` is the source of truth for
  synced ops. `op_log` becomes a local-write history table — useful
  for `op_log_histogram`, single-device replay-from-zero, hash chain
  on local writes — but no longer the input to sync push (engine is)
  nor the output of sync pull (engine plus direct SQL projection).
* **(b) Sync pull continues to write `op_log` rows for each remote
  op.** Materializer's existing path runs unchanged; minimum diff.

**Decision: option (a).** Cleaner architecturally (one source of
truth for synced state); avoids two parallel projection paths;
avoids synthetic op_log row construction (Loro's binary delta
doesn't decompose into per-op typed rows); integrity under Loro is
Loro's own checksum on the binary delta, not the op_log hash chain.

**Caveat.** `op_log` grows more slowly post-Phase-3 (only local
writes append; remote ops never touch it). The day-6 snapshot
scheduler becomes load-bearing: a fresh boot rehydrates from
`loro_doc_state` snapshots; if a snapshot is missing, the engine
starts empty and sync pull from a peer fills it. **There is no
replay-op_log path for synced spaces** — engine snapshot or
sync-pull is the only way to bring an empty engine to a
peer-converged state. Intentional.

**Migration concern.** Day 5 swings the apply. On day 5, the
maintainer's local `op_log` is assumed to have zero sync-pulled rows
(no peers used yet) — no "convert old sync-pulled op_log rows to
engine state" migration. If the single-user invariant is violated,
day 5 MUST include a one-shot import of pre-day-5 sync-pulled rows
before swinging the apply path. Default per maintainer's message:
invariant holds; no migration; assert at day 5 commit time.

### 2.7 LoroDoc state-per-space + boot rehydrate

The `loro_doc_state` table (Phase-2 day-6, migration `0052`,
`src-tauri/src/loro/snapshot.rs`) is the persistence backbone:

* One row per space (PK on `space_id`).
* `doc_bytes BLOB` carries `ExportMode::Snapshot`. Sized ≈ 6.4 MiB
  per 25K alive blocks.
* Cadence: every 5 minutes via `flush_task::SNAPSHOT_INTERVAL_SECS =
  300`.
* Boot rehydrate: synchronous via `tauri::async_runtime::block_on`
  (`src-tauri/src/lib.rs:707`-ish, Phase-2 day-9 commit `d0395805`).

Phase 3 keeps this as-is. 5-min cadence plus
single-source-of-truth-engine invariant means a hard crash loses at
most 5 minutes of synced state. Acceptable per
`pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §8.1 option (c). The
boot-latency telemetry concern from Phase 2
(`pending/PEND-09-PHASE-2-REPORT.md` §8.2) gets revisited as §10.6.

## 3. Day-by-day breakdown

13 days. Day 2 is the first irreversible-after step (default ON);
days 3-5 build the new sync path; days 6-11 are the destructive
deletions.

### Day 1 (today, 2026-05-10) — Phase 3 plan written

This document. Default-build behaviour byte-identical to commit
`ff272b0b`. `cargo nextest run -p agaric` reports **3775**
(unchanged); `--features loro-shadow` reports the Phase-2 day-17 close
count.

### Day 2 — Cutover flag default ON via migration — **COMMITTED 2026-05-10**

Migration `0056_pend_09_cutover_default_on.sql` landed; `loro/cutover.rs` gains the `migration_0056_flips_cutover_default_on` regression test (loro-shadow count 3901→3902). First behaviour-change commit since Phase 1 day 1; reversible via SQL UPDATE per below.

```sql
UPDATE app_settings
   SET value = '1', updated_at = datetime('now')
 WHERE key = 'pend09.loro_authoritative';
```

The flag plus cache plumbing already shipped (Phase-2 day-9
`d0395805`, `loro/cutover.rs:78` cache, `cutover.rs:298-311`
sub-100 µs timing test). Day 2 is **just the default flip**.

**Mini-soak.** Maintainer runs the day-2 build against the primary
workstation's `notes.db` for ≥1 calendar day, watches the
`parity_report` bin output for surprise D-bucket rows. The Phase-2
day-15 close (`pending/PEND-09-PHASE-2-REPORT.md` §10.3) verdict was
**GO-FOR-CUTOVER** with day-9.5's JSON-parse fix (`eb01c5f8`) plus
days 11-15 projection helpers covering all 10 non-attachment op
types (commits `8af389aa`, `204ca451`, `478c7dd4`, `fe5229bd`,
`d6bbf2db`).

**Reversibility.** SQL UPDATE flips the row back to `'0'`; cache
picks up the change via `cutover::set_loro_authoritative` or on the
next 30-second flush tick. Net data risk: zero.

**§10.1 user decision: skip mini-soak or run for ≥1 day?**

### Day 3 — Loro sync wire types — **COMMITTED 2026-05-10**

New module `src-tauri/src/sync_protocol/loro_sync_types.rs` (~190 LOC):
defines `LoroSyncMessage::{Snapshot, Update}` plus
`LoroVersionVector` type alias plus `LORO_SYNC_PROTOCOL_VERSION = 1`
constant.  Wired into `sync_protocol/mod.rs` as `pub mod
loro_sync_types`.  Intentionally NOT `#[cfg(feature =
"loro-shadow")]`-gated — day 5 deletes `OpBatch` and the default
build needs a sync wire type continuously through that swing.  The
matching engine surface `LoroEngine::version_vector` /
`LoroEngine::export_update_since` lands in `loro/engine.rs` and
remains feature-gated (the engine module itself is); day-4 wires
the senders.

The day-3 `LoroSyncMessage` shape collapses the plan's earlier
three-variant sketch (`PeerVersionVectors` + `LoroSyncSnapshot` +
`LoroSyncUpdate`) into two variants — the per-message
`from_vv: LoroVersionVector` field on `Update` carries the same
information without a separate pre-stream exchange.  §8.3's
`PeerVersionVectors` variant + `ExchangingPeerVVs` orchestrator
state are deferred to days 4-5 if the sender path actually needs
the round-trip; it currently does not (sender reads the receiver's
last vv from `peer_refs` per §8.1).

Existing `SyncMessage::OpBatch` left untouched — day-5 deletes it.

Verify Loro 1.12 `VersionVector::encode()` round-trips byte-stable
across runs via the `version_vector_returns_encoded_bytes` engine
test (decode-equals-direct-vv invariant) plus
`export_update_since_carries_only_post_vv_ops` (the
incremental-sync invariant).

Default count: **3775 → 3778** (3 new wire-shape round-trip / version
constant tests in `loro_sync_types`).  Feature-on count: **3902 →
3907** (3 default + 2 engine VV tests).  Both match the day-1 plan
estimate.

### Day 4 — Wire Loro sync push

Edit `sync_protocol/operations.rs` plus
`sync_daemon/orchestrator.rs`:

* Replace the `compute_ops_to_send` call site with
  `prepare_outgoing_loro_batch(registry, space_id, peer_vv)` per
  space.
* Wrap into `SyncMessage::LoroSyncUpdate { space_id, bytes,
  is_last }`. For initial sync:
  `prepare_outgoing_loro_snapshot` plus `LoroSyncSnapshot`.
* `peer_refs` table gains a `loro_vv_bytes BLOB NULL` column
  (migration in this commit per §10.5; column stores the last VV
  the peer was synced to).

Until day 5, the receiver still expects `OpBatch`. Day 4 lands
sender-only; receiver swing is day 5. §10.2 covers single-PR vs
two-PR sequencing.

#### Day 4 partial — Loro-sync push + apply helpers — **COMMITTED 2026-05-10**

Day-4's pure-helper layer landed additive: new module
`src-tauri/src/sync_protocol/loro_sync.rs` (~430 LOC including tests)
exposes `prepare_outgoing(registry, space_id, device_id, peer_vv) ->
LoroSyncMessage` and `apply_remote(pool, registry, device_id, message)
-> SpaceId`. New engine method
`LoroEngine::import_with_changed_blocks(bytes) -> Vec<BlockId>` and
projection helper `loro::projection::project_block_full_to_sql(tx,
space_id, block_id, Option<&BlockSnapshot>)` are the supporting
infrastructure. Five new tests under
`#[cfg(all(test, feature = "loro-shadow"))]` lock the snapshot/update
prepare paths, the engine import + SQL projection round-trip, and the
unsupported-protocol-version reject (Snapshot + Update). No transport
wiring yet — that's the rest of day-4 (sender) plus day-5 (receiver +
DELETE `OpBatch`).

`import_with_changed_blocks` uses the brute-force walk-all-blocks
fallback (engine.rs docstring): `loro::ImportStatus.success` is a
`VersionRange` of (peer, counter-range) accepted ops, not a
container-id set, so translating it to changed-block-ids would require
either op-log decode or root-subscribe instrumentation. The walk costs
O(N_blocks) per sync-pull but sync-pull is a cold path; day-5 / a
later benchmark can swap to a targeted enumeration if it ever lands
on a hot path. `project_block_full_to_sql` `None` → log warn + skip
per the plan's purge-deferral rule.

Default-build behaviour byte-identical to commit `b7496159` — module
declaration unconditional, function bodies feature-gated. Default
test count unchanged (**3778**); `--features loro-shadow` count goes
**3907 → 3912** (5 new tests, exactly matching the day-4 estimate).

### Day 5 — Wire Loro sync pull (DESTRUCTIVE)

The load-bearing day. Edit `sync_protocol/operations.rs` and
`sync_protocol/orchestrator.rs`:

* **Delete** `apply_remote_ops`
  (`sync_protocol/operations.rs:124-380`-ish, ~250 LOC).
* **Delete** `merge_diverged_blocks`
  (`sync_protocol/operations.rs:420-880`, ~460 LOC).
* **Delete** the inline property-LWW dispatcher
  (`sync_protocol/operations.rs:515-697`, ~180 LOC) and inline
  move-LWW dispatcher (`sync_protocol/operations.rs:699-822`, ~120
  LOC).
* **Delete** the `OpBatch` variant of `SyncMessage`
  (`sync_protocol/types.rs:162`).
* **Delete** the orchestrator's `apply_remote_ops` plus
  `merge_diverged_blocks` call sites
  (`sync_protocol/orchestrator.rs:401, 440`).
* **Add** `apply_remote_loro_batch` call sites in the orchestrator
  for the new `LoroSyncSnapshot` / `LoroSyncUpdate` variants.

After day 5, `merge::merge_block_text_only`,
`merge::resolve_property_conflict`, and
`merge::shadow_dispatch_for_record` are still **referenced** from
the materializer's `if is_loro_authoritative()` else-arm. They're
unreachable when the flag is on (day 2), but the code still
compiles. Day 6 starts deleting.

End-to-end smoke test: spin up two `LoroEngine` instances, simulate
a sync round-trip via the new wire types, assert convergence on
`(blocks.content, block_properties)` per space. (Full integration
is day 12.)

### Day 6 — Delete `merge_block_text_only` + callers

`merge_block_text_only` (`merge/apply.rs:47-140`, ~94 LOC) was the
3-way text-merge entry point. Day 5 deleted its only caller;
day 6 deletes the function and the `MergeOutcome::ConflictCopy`
variant. `merge/apply.rs` shrinks from 1 032 LOC to ~600 LOC. The
remaining surface is `shadow_apply` plus
`shadow_dispatch_for_record` plus `diffy_summary_for` (parity-sink
data path; deleted day 11).

### Day 7 — Delete `merge::resolve` + `merge::detect` + `merge/tests.rs`

`merge/resolve.rs` (579 LOC) — LWW-resolution layer; callers in the
inline LWW dispatchers (deleted day 5).
`merge/detect.rs` (604 LOC) — divergence-detection; callers in
`merge_diverged_blocks` (deleted day 5).
`merge/tests.rs` (2 852 LOC) — Phase-0 era 53-test corpus
exercising `merge_block_text_only` etc. Tests of deleted functions.

The §10.3 user-decision item — verify zero `is_conflict=1` rows on
the maintainer's `notes.db` — runs at day 7 commit time. If
non-zero: abort, surface to maintainer, ship a Phase-3.1 conversion
migration first.

After day 7, `src-tauri/src/merge/` contains: `mod.rs` (319 LOC,
mostly `shadow_apply` plus `diffy_summary_for` plumbing),
`apply.rs` (~600 LOC), `types.rs` (42 LOC).

### Day 8 — Collapse `apply_*_via_loro` + `apply_*_tx`

Today every `apply_*` arm in `materializer/handlers.rs` has shape
`if is_loro_authoritative() { via_loro path } else { _tx diffy path
}`. Day 8 deletes the else branches and unwraps the `if`. The
cutover flag's reader is no longer called from
`materializer/handlers.rs`; only `merge::shadow_apply` still reads
it (day 9 deletes that too).

Per-arm deletions: `apply_create_block_tx` (~150 LOC),
`apply_edit_block_tx` (~250 LOC), `apply_delete_block_tx` (~120
LOC), `apply_restore_block_tx` (~80 LOC), `apply_purge_block_tx`
(~100 LOC), `apply_move_block_tx` (~100 LOC), `apply_add_tag_tx` /
`apply_remove_tag_tx` (~120 LOC each), `apply_set_property_tx`
(~250 LOC), `apply_delete_property_tx` (~80 LOC). Total ~1 400-1
600 LOC.

`ApplyEffects` struct from Phase-2 day-9 (with `restored_cohort` and
`deleted_cohort`) — kept; it's the cohort-fanout return type the
new path also needs.

### Day 9 — Remove `loro-shadow` feature gate

The `loro-shadow` feature gates every `loro/*.rs` module
(`loro/mod.rs:48-108`). Day 9:

* `Cargo.toml`: delete the `loro-shadow` feature; promote
  `loro = "1.12"` and `xxhash-rust = "0.8"` to hard deps (drop
  `optional = true`). Per
  `pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §8.5: hard dep, not
  optional.
* Remove every `#[cfg(feature = "loro-shadow")]` gate (~80-100 sites
  via `grep -rn 'cfg(feature = "loro-shadow")' src-tauri/src/`).
* **Delete `src-tauri/src/loro/cutover.rs`** (317 LOC, Phase-2 day-9
  commit `d0395805`). `is_loro_authoritative()` reader,
  `init_cutover_flag` / `set_loro_authoritative` helpers,
  `OnceLock<AtomicBool>` cache. `merge::shadow_apply`'s flag read
  (Phase-2 day-14 `fe5229bd`) deletes with it.
* `merge/mod.rs`: delete the `shadow_apply` driver (~256 LOC). The
  materializer's per-arm unconditional `apply_*` is now the only
  apply driver. Delete the entire `src-tauri/src/merge/` directory.

Test counts collapse to one count post-day-9 (no more feature flag).

### Day 10 — Drop `merge_parity_log` and the `app_settings` row

Migration `0057_pend_09_drop_merge_parity_log.sql`:

* `DROP TABLE merge_parity_log` (created by `0051`).
* `DROP INDEX idx_merge_parity_log_unbucketed` (`0054`).
* `DROP INDEX idx_merge_parity_log_created_at` and
  `idx_merge_parity_log_bucket` (`0051`).
* `DELETE FROM app_settings WHERE key =
  'pend09.loro_authoritative'`.

The `app_settings` table itself stays — generic key-value, future
PEND tickets may use it.

### Day 11 — Decision: parity sink fate

Phase-2 shipped four files for shadow-mode parity analysis, all
under `loro/` and gated on `loro-shadow`:

* `loro/parity.rs` (295 LOC) — in-memory ring-buffer sampler.
* `loro/parity_sink.rs` (663 LOC) — DB-backed sink, batched flush,
  retention purge.
* `loro/classifier.rs` (651 LOC) — bucket A/B/C/D classifier.
* `loro/flush_task.rs` (513 LOC) — periodic flush, classifier
  invocation, snapshot scheduler.
* `loro/parity_proptest.rs` (956 LOC) — randomised concurrent
  edit streams, asserts bucket D = 0.

After days 9-10, no consumer reads `merge_parity_log` — the table's
gone. Two options:

* **(i) Re-purpose for sync confidence.** Rename to `sync_audit` or
  similar. Keep the sink; record per-sync-op "engine state matched
  expected SQL projection" rows. Useful as a release-channel signal;
  a maintainer-facing `sync_audit_report` bin (analog to
  `parity_report`) prints recent sync apply outcomes, flags any
  divergence between engine and SQL post-projection. Net ~600 LOC
  edited; ~1 200 LOC of bucket-classifier-specific code deleted (the
  A/B/C/D bucketing only makes sense for diffy/Loro parity).
* **(ii) Delete entirely.** Save ~3 070 LOC across the four files.
  The snapshot scheduler stays (engine persistence backbone). The
  `op_log_histogram` and `parity_report` bins delete with the sink
  (`parity_report` depends on `merge_parity_log`).

**Plan-author soft recommendation: (i).** Keeps the two-device
proptest harness as a long-term CRDT regression test; gives the
maintainer a sync-audit signal in production. §10.4 user decision.

### Day 12 — End-to-end Loro-sync integration test

In `src-tauri/src/sync_integration_tests.rs` or a new module:

1. Spin up two `LoroEngine` instances `A` and `B` with shared space.
2. Apply N ops to A via the materializer hot path; SQL state on A
   converges per the projection helpers.
3. Apply M ops to B (different seed, overlapping block IDs).
4. Simulate sync round-trip via the new wire types:
   `prepare_outgoing_loro_batch(A, peer_vv_B)` → bytes →
   `apply_remote_loro_batch(B, bytes, kind=Update)`. And reverse.
5. After bidirectional sync, assert engine VV equality plus SQL
   `blocks` rows match (block-by-block: content, parent_id, position,
   properties, tags). For LWW conflicts: deterministic winner per
   `pending/PEND-09-lww-resolution-rule.md`.

### Day 13 — Phase 3 final report

`pending/PEND-09-PHASE-3-REPORT.md` — analog to Phase-1/2 reports.
Sections: TL;DR plus recommendation; day-by-day deliverables table;
risk register update; numbers (LOC delta, test count delta, file
delta, dep delta); open questions → Phase 4 hand-off; sign-off.

Phase 3 closes with PEND-09 going from "active migration" to
"shipped"; Phase 4 (UX polish, `is_conflict` column drop, ~870-site
reference sweep) becomes a follow-up ticket.

## 4. Pre-Phase-3 gates

Lighter than Phase 2 because (a) cutover already happened and (b)
the no-peers-in-the-field invariant removes backward-compat
constraints.

* **Gate 1 — Maintainer has not started using sync.** Verified by
  maintainer's 2026-05-10 message. Closing artifact: this
  paragraph. If violated: abort day 5; ship a one-shot `op_log` →
  engine import migration first (§2.6 caveat), then resume.
* **Gate 2 — Phase 2 work all landed.** Closing artifact:
  `git log --oneline ff272b0b -10` shows commits through `ff272b0b`
  (day-17 `parity_report --purge-before`), `5ab90d4d` (day-16 E2E
  test), `2cf07f57` (Phase 2 report addendum GO-FOR-CUTOVER).
  Verified 2026-05-10.
* **Gate 3 — Maintainer has explicitly authorised the sync rebuild.**
  Closing artifact: maintainer's 2026-05-10 message. The scope
  expansion beyond pure cleanup was not implicit in the original
  plan.

## 5. Rollback

| Day | Step | Rollback | Recoverable | Lost |
| --- | ---- | -------- | ----------- | ---- |
| 1 | Plan | `git revert` | Plan doc | None |
| 2 | Flag default ON | SQL UPDATE `value='0'`; or `git revert` of `0056` | Flag state | None |
| 3 | Sync wire types | `git revert` (additive) | Wire types | None |
| 4 | Sync push | `git revert` (sender + receiver still understand `OpBatch`) | Push | None |
| 5 | **Sync pull (DESTRUCTIVE)** | `git revert` of day 5 plus days 6-7 if landed; data unchanged on single-user invariant | Pull | None at maintainer; if peers DID sync between day-5 land and the revert: lost cross-device convergence until re-sync |
| 6 | Delete `merge_block_text_only` | `git revert` | Code | None |
| 7 | Delete `merge::resolve` plus `merge::detect` plus `merge/tests.rs` | `git revert` | Code | None (assumes day-7 zero-`is_conflict` assertion held) |
| 8 | Collapse `apply_*_via_loro` plus `apply_*_tx` | `git revert` | Code | None |
| 9 | Remove `loro-shadow` feature | `git revert` | Build config | None |
| 10 | Drop `merge_parity_log` plus `app_settings.pend09.*` row | Migration `0057` is sticky; cannot un-DROP without restoring from backup. The `merge_parity_log` data is non-load-bearing per `pending/PEND-09-PHASE-2-REPORT.md` §5.5 | Code | The merge_parity_log historical data |
| 11 | Parity-sink fate | `git revert` if maintainer changes mind | Code | None |
| 12 | Sync integration test | `git revert` | Test code | None |
| 13 | Final report | `git revert` | Doc | None |

**Tag policy.** Tag `pend-09/phase-2-complete` on the day-2-final
commit (after the §10.1 mini-soak closes clean) **before** day 5
lands. Captures "Phase 2 cutover-on lived in production for ≥1
day" as a known-good restore point. §10.7 is the exact-commit
choice.

**Net data risk through day 5.** Zero through day 4 (additive
changes); day 5 onward depends on whether peers sync — at the
maintainer's single-user invariant, zero. Days 6-13 are pure code
deletions over an already-Loro-authoritative state.

## 6. What we keep vs delete

### 6.1 `src-tauri/src/merge/` — DELETED

| File | LOC | Day | Reason |
| ---- | --- | --- | ------ |
| `merge/apply.rs` | 1 032 | day 6 (`merge_block_text_only`) plus day 9 (rest) | All callers deleted day 5; `shadow_apply` deletes day 9 |
| `merge/detect.rs` | 604 | day 7 | Callers were `merge_diverged_blocks` (deleted day 5) |
| `merge/mod.rs` | 319 | day 9 | `shadow_apply` driver deleted with the rest |
| `merge/resolve.rs` | 579 | day 7 | Callers were inline LWW dispatchers (deleted day 5) |
| `merge/tests.rs` | 2 852 | day 7 | Tests of deleted functions |
| `merge/types.rs` | 42 | day 9 | Types of deleted code |

Total: 5 428 LOC. Original plan estimate: 4 163 LOC
(`pending/PEND-09-crdt-migration.md` line 5); the larger figure
accounts for `merge/tests.rs` plus `merge/mod.rs` expansion since
the original plan and Phase 1 / Phase 2 extensions to `apply.rs`'s
`shadow_dispatch_for_record` path.

### 6.2 `src-tauri/src/sync_protocol/` — REPLACED

| File | LOC | Disposition |
| ---- | --- | ----------- |
| `sync_protocol/mod.rs` | 32 | KEEP, edit re-exports |
| `sync_protocol/operations.rs` | 1 243 | DELETE most: `apply_remote_ops` (~250), `merge_diverged_blocks` (~460), property-LWW (~180), move-LWW (~120) — total ~1 010 LOC; `compute_ops_to_send` (~97 LOC) re-purposed to `prepare_outgoing_loro_batch`; `complete_sync` plus `complete_sync_in_tx` plus `get_local_heads` plus `check_reset_required` (~120 LOC) **kept** — peer-bookkeeping, not diffy-specific |
| `sync_protocol/orchestrator.rs` | 680 | KEEP, edit ~30-50 LOC at the deleted call sites |
| `sync_protocol/tests.rs` | 4 468 | EDIT — delete tests of deleted functions; add tests of `apply_remote_loro_batch`. Net likely -1 500 to -2 000 LOC |
| `sync_protocol/types.rs` | 245 | EDIT — delete `OpBatch`, `MergeResults`, `ApplyResult`; add `LoroSyncSnapshot`, `LoroSyncUpdate`, `PeerVersionVectors` |
| (NEW) `sync_protocol/loro_sync.rs` | ~300 | ADD (day 3) |

Net `sync_protocol/`: ~3 200 LOC reduction.

### 6.3 `src-tauri/src/loro/` — KEEP, simplify

| File | LOC | Disposition |
| ---- | --- | ----------- |
| `loro/classifier.rs` | 651 | DELETE (option ii) OR EDIT to ~150 LOC (option i) |
| `loro/cutover.rs` | 317 | DELETE (day 9) |
| `loro/engine.rs` | 1 492 | KEEP — engine is the path |
| `loro/envelope.rs` | 530 | EDIT — drop the typed-`payload` field; envelope becomes `(loro_version, payload_version, original_op_type, loro_bytes)` |
| `loro/flush_task.rs` | 513 | EDIT — keep `run_periodic_flush` (snapshot cadence); delete `classify_unbucketed` invocation; delete `purge_old` call |
| `loro/mod.rs` | 108 | EDIT — drop feature gates + `cutover` mod |
| `loro/parity.rs` | 295 | DELETE (option ii) OR repurpose (option i) |
| `loro/parity_proptest.rs` | 956 | KEEP (option i) — CRDT-correctness tests OR DELETE (option ii) |
| `loro/parity_sink.rs` | 663 | DELETE (option ii) OR rename to `sync_audit_sink.rs` (option i) |
| `loro/projection.rs` | 1 203 | KEEP — per-op projection helpers used by post-Loro-import projection too (§2.4) |
| `loro/registry.rs` | 344 | KEEP — per-space `LoroEngine` registry; sync needs this |
| `loro/shared.rs` | 89 | KEEP |
| `loro/snapshot.rs` | 459 | KEEP — engine backbone |
| `loro/tests.rs` | 40 | KEEP |

### 6.4 `src-tauri/src/materializer/` — SIMPLIFY

`materializer/handlers.rs` (~3 800 LOC) — DELETE per-arm
`apply_*_tx` (diffy paths), unwrap `if is_loro_authoritative()` to
unconditional `apply_*`. Net -1 400 to -1 600 LOC (day 8).

Other materializer files KEEP (cache reindex helpers, FTS, agenda
all unchanged).

### 6.5 Migrations

| Migration | Disposition | Day |
| --------- | ----------- | --- |
| `0051_pend_09_merge_parity_log.sql` | Existing; data dropped by `0057` | — |
| `0052_pend_09_loro_doc_state.sql` | KEEP — snapshot table load-bearing | — |
| `0053_pend_09_app_settings.sql` | KEEP table; row deleted by `0057` | — |
| `0054_pend_09_classifier_partial_index.sql` | Index dropped by `0057` | — |
| `0055_pend_09_parity_log_authoritative_column.sql` | Column dropped by `0057` | — |
| (NEW) `0056_pend_09_cutover_default_on.sql` | ADD | day 2 |
| (NEW) `0057_pend_09_drop_merge_parity_log.sql` | ADD | day 10 |

`0058_pend_09_drop_is_conflict.sql` deferred to **Phase 4**
(870-site sweep is too large for a 13-day Phase 3).

## 7. Risks

### 7.1 Loro `import` semantics under interleaved concurrent ops

**Risk.** If Loro 1.12's `import` doesn't correctly merge two
engines' op-logs given concurrent writes, Phase 3's premise is
wrong.

**Evidence.**

* Phase-0 `parity_corpus` validation
  (`pending/PEND-09-SPIKE-REPORT.md` §2 row 2: 53/53 cases pass).
* Phase-1 day-8 single-author proptest commit `89df17a2`: 256
  cases × 4 streams, zero D-bucket sightings.
* Phase-2 day-2 two-device proptest commit `a9849adc`: 1 024
  randomised concurrent runs, zero D-bucket sightings.
* Phase-2 days 11-15 wired projection helpers + cohort fanout for
  Restore + Delete; production materializer hot path runs through
  `LoroEngine::apply_*` for all 10 non-attachment op types.

**Confidence: HIGH.** Mitigation: keep the day-12 integration test
as a regression net.

### 7.2 Sync wire-format versioning under Loro 2.x

**Risk.** Loro ships 2.0 with a binary-format break;
`loro_version: u8` envelope field bumps to 3; readers older than
the bump-aware version cannot decode.

**Evidence.** Per
`pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §8.7 plus Phase-0 kill
criterion 4: format stability within 1.x is YELLOW (within-1.x
stable; 2.0 cross-major upgrade not under contract). No upstream
2.0 signal as of 2026-05-10.

**Mitigation.** Pin `loro = "1.12"` (caret-1) through Phase 3. Per
`loro_version: u8` field handles cross-major upgrades by
version-gating decode paths. Day-3 lands a unit test that round-trips
a `loro_version=2` envelope through a `loro_version=3` reader stub
(rejects unknowns; clean error).

### 7.3 Materializer atomicity under sync apply

**Risk.** Sync pull `LoroEngine::import(bytes)` runs **outside** a
SQL tx. Then projection runs inside one. If a crash happens between
the engine import and the SQL tx commit, the engine state is ahead
of SQL.

**Mitigation per §2.4.** Boot crash recovery checks
`(engine_block_count vs sql_block_count)` per space; if disagree,
re-runs projection. The day-6 snapshot scheduler ensures the engine
state survives a crash. Day-12 integration test includes a
crash-mid-projection simulation.

### 7.4 Deletion-pass build flow

**Risk.** Days 5-9 are aggressive deletions. A "deleted-but-
referenced" diagnostic might fire from a test not enumerated in §6.

**Mitigation.** Each day's deletion runs `cargo build` plus
`cargo nextest run -p agaric` clean before commit. Days 6-9 should
run `cargo mutants` (or equivalent) on the deleted code to verify
nothing tested the deletion target indirectly. The Phase-2
day-9.5 latent-JSON-parse bug
(`pending/PEND-09-PHASE-2-REPORT.md` §5) was caught only via
deliberate mutation testing — same discipline applies here.

### 7.5 Op-log size + replay-from-zero post-Phase-3

**Risk.** Per §2.6 option (a), `op_log` records local-writes only.
The day-6 snapshot scheduler is the recovery path for synced state.
A user who wipes `loro_doc_state` has no replay-from-zero for synced
ops — only local writes recover.

**Mitigation.** `loro_doc_state` is part of `notes.db`; standard
backups cover it. A future `loro_doc_state` rebuild from a peer's
snapshot is the same as initial sync. 5-min snapshot cadence plus
boot rehydrate means worst-case loss is 5 min of synced state.
Acceptable per `pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §8.1.

### 7.6 Boot rehydrate vs sync push race

**Risk.** A sync push from a peer arrives while
`rehydrate_registry` is still walking `loro_doc_state` rows. The
import lands on a partially-rehydrated engine; subsequent rehydrate
overwrites the imported delta.

**Evidence.** Today's boot sequence
(`src-tauri/src/lib.rs:723` rehydrate, `:1112` sync daemon start)
runs rehydrate synchronously via `tauri::async_runtime::block_on`
**before** the sync daemon's `start_if_peers_exist_with_lifecycle`
call. The daemon's listening socket is not bound until rehydrate
returns. No race today.

**Mitigation.** Phase 3 keeps the same boot ordering. Day 5's
`apply_remote_loro_batch` is reachable only through the daemon's
session loop, which is gated on the post-rehydrate startup. The
day-12 integration test asserts boot-rehydrate-then-sync-push
ordering by simulating a peer sending an `LoroSyncUpdate` 100 ms
after process start; the receiver must reject or queue the message
until rehydrate completes (existing daemon behaviour today is
"reject because socket not bound"; verify the same after day 5).

**Confidence: HIGH.** Carry-forward concern only if the boot order
is ever inverted (e.g., async rehydrate); flag in §10 if it changes.

### 7.7 Loro `oplog_vv()` / `ExportMode::updates` API stability

**Risk.** The version-vector machinery is the load-bearing
incremental-sync primitive. Within-1.x semantic changes would break
the wire format.

**Evidence.** `loro-1.12.0/src/lib.rs:887` documents `oplog_vv()`;
`lib.rs:1297-1299` documents `ExportMode::updates(&vv)`. Both 1.x
stable per Phase-0 kill criterion 4 (`pending/PEND-09-SPIKE-REPORT.md`
§2 row 4).

**Mitigation.** Pin Loro to caret-1; verify on each version bump.
Day-3 unit test round-trips
`oplog_vv() → encode → decode → vv equality` to catch within-1.x
regressions early.

## 8. Sync sub-architecture — what to actually build

### 8.1 New module: `sync_protocol::loro_sync`

```rust
// src-tauri/src/sync_protocol/loro_sync.rs
use crate::error::AppError;
use crate::loro::registry::LoroEngineRegistry;
use loro::VersionVector;

pub enum SyncKind { Snapshot, Update }

pub fn prepare_outgoing_loro_batch(
    registry: &LoroEngineRegistry,
    space_id: &str,
    peer_vv: Option<&VersionVector>,
) -> Result<(SyncKind, Vec<u8>), AppError> { ... }

pub async fn apply_remote_loro_batch(
    pool: &sqlx::SqlitePool,
    registry: &LoroEngineRegistry,
    materializer: &crate::materializer::Materializer,
    space_id: &str,
    bytes: &[u8],
    kind: SyncKind,
) -> Result<(), AppError> { ... }

pub fn local_oplog_vv_bytes(
    registry: &LoroEngineRegistry,
    space_id: &str,
) -> Result<Vec<u8>, AppError> { ... }
```

`LoroEngine` gets new methods (in `engine.rs`):

* `pub fn export_updates(&self, peer_vv: &VersionVector) -> Result<Vec<u8>, AppError>`
* `pub fn import_with_changed_blocks(&mut self, bytes: &[u8]) -> Result<Vec<BlockId>, AppError>`
* `pub fn oplog_vv_bytes(&self) -> Vec<u8>` — wraps `oplog_vv().encode()`

### 8.2 New `MaterializeTask::SyncApply` variant

```rust
pub enum MaterializeTask {
    ApplyOp(Arc<OpRecord>),  // local-write path
    SyncApply { space_id: String, changed_blocks: Vec<BlockId> },  // sync-pull path
    // ... existing variants
}
```

`SyncApply` handler reads each changed block via
`engine.read_block(block_id)` then writes the SQL row(s) via a new
`project_block_full_to_sql(conn, engine, block_id)` helper.

### 8.3 New `SyncMessage` variants — wire shape

```rust
pub enum SyncMessage {
    HeadExchange { heads: Vec<DeviceHead> },
    PeerVersionVectors {  // NEW day 3
        vvs: Vec<(String /* space_id */, Vec<u8> /* loro VV bytes */)>,
    },
    LoroSyncSnapshot { space_id: String, bytes: Vec<u8> },  // NEW day 3
    LoroSyncUpdate { space_id: String, bytes: Vec<u8>, is_last: bool },  // NEW day 3
    OpBatch { ops: Vec<OpTransfer>, is_last: bool },  // KEPT through day 4; DELETED day 5
    // ... existing ResetRequired, SnapshotOffer/Accept/Reject,
    // SyncComplete, Error, FileRequest/Offer/Received,
    // FileTransferComplete preserved verbatim.
}
```

`PeerVersionVectors` arrives **after** `HeadExchange` and **before**
the `LoroSync*` messages flow. Orchestrator state machine
(`sync_protocol/orchestrator.rs:401`) gains a new state between
`ExchangingHeads` and `StreamingOps`: `ExchangingPeerVVs`.

### 8.4 Tauri command shape

Default: no debug commands; sync runs through the existing daemon
orchestrator. If maintainer wants a debug-only push trigger,
`debug_loro_sync_push(peer_id, space_id) -> bytes` is feasible but
out-of-scope unless §10.2 surfaces it.

## 9. What stays — transport, peer, file-transfer, device

NOT diffy-specific. They're how peers find each other and stream
bytes. Phase 3 changes WHAT bytes get streamed; the HOW is unchanged.

* `src-tauri/src/peer_refs.rs` (~400 LOC) — peer enumeration,
  per-peer last-sync hash bookkeeping. Phase 3 day-4 adds a
  `loro_vv_bytes BLOB NULL` column for per-space VV tracking.
* `src-tauri/src/sync_files/` plus `src-tauri/src/sync_files.rs`
  (~144 KiB) — file-blob transfer for attachments. **KEEP entirely**
  — orthogonal. Attachments still log-and-skip in the engine per
  `pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §8.2.
* `src-tauri/src/device.rs` — device identity. **KEEP entirely**.
  Loro's `peer_id_from_device_id` (`loro/engine.rs:102`) reads
  from this — unchanged.
* `src-tauri/src/sync_events.rs` (~877 LOC) — sync event emission
  for the FE. **KEEP**.
* `src-tauri/src/sync_scheduler.rs` (~750 LOC) — when to run sync,
  retry/backoff, peer enumeration. **KEEP**.
* `src-tauri/src/sync_daemon/discovery.rs` — mDNS. **KEEP**.
* `src-tauri/src/sync_daemon/orchestrator.rs` — per-peer session
  orchestration. **EDIT** the `OpBatch`-builder call sites (replace
  with `LoroSyncSnapshot` / `LoroSyncUpdate` constructors).
* `src-tauri/src/sync_daemon/server.rs` — incoming-session acceptor.
  **KEEP unchanged**.
* `src-tauri/src/sync_daemon/snapshot_transfer.rs` — full-DB
  snapshot transfer (post-`ResetRequired`). **KEEP**. NOT the same
  as per-space Loro snapshot; this is whole-database-as-blob for
  catastrophic op-log reset.
* `src-tauri/src/sync_daemon/android_multicast.rs` — Android mDNS
  workaround. **KEEP**.
* `src-tauri/src/sync_net/{connection,tls,websocket}.rs` —
  TLS-pinned WebSocket transport. **KEEP entirely**.
* `src-tauri/src/sync_cert.rs` (~733 LOC) — TLS plus TOFU pinning.
  **KEEP entirely**.
* `src-tauri/src/op_log/` — local-write hash chain, `get_ops_since`
  (no longer used by sync push; deprecated but **KEEP** as debugging
  utility), `op_log_histogram` reader. `src-tauri/src/sync_constants.rs`
  — KEEP.

## 10. User-decision items

### 10.1 Day 2 mini-soak — skip or run for ≥1 day?

**Question.** Phase-2 day-15 close was GO-FOR-CUTOVER; days 16-17
shipped follow-up tests. Should day 2 (default ON) wait for ≥1 day
of mini-soak before proceeding to day 3?

**Plan-author resolution.** Run for ≥1 day. Cheap (single-user;
SQL UPDATE rollback). The Phase-2 day-9.5 JSON-parse incident
reinforces "verify-it-works-on-real-data before deleting code".

### 10.2 Day-4-then-day-5 sequencing — single PR or two?

**Question.** Day 4 (sync push wire) plus day 5 (sync pull rebuild
plus DELETE diffy) make a tight pair. Single PR or two?

**Plan-author resolution.** Two — day 4 additive, day 5 destructive.
Smaller commits help review; single-user atomicity moot.

### 10.3 Existing `is_conflict=1` rows — assert vs migrate?

**Question.** Per
`pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §7.1, the conversion rule
is "concat-into-merge-result with `---` separator, ours-first". Per
§2.5, the maintainer's primary `notes.db` is assumed to have zero
such rows.

* (a) Day 7 assert: `SELECT COUNT(*) FROM blocks WHERE
  is_conflict = 1` returns zero; if non-zero, abort the commit and
  ship a conversion migration as Phase 3.1 first.
* (b) Always-run conversion migration on day 7 — even if zero rows
  it's a no-op SQL.

**Plan-author resolution.** (a) — the assertion makes the invariant
explicit. The migration is non-trivial (separator choice, ordering,
side-effects on `block_links` / `block_tags`) and shouldn't run
unless needed.

### 10.4 Day 11 — parity sink fate

**Question.** §3 day 11 plus §6.3:

* (i) Re-purpose as sync-confidence infrastructure
  (`sync_audit_sink`). ~600 LOC churn; ~1 200 LOC bucket-classifier
  deletion.
* (ii) Delete entirely. Saves ~3 070 LOC.

**Plan-author resolution.** (i). Keeps the two-device proptest
harness as a long-term CRDT regression test; gives the maintainer a
release-channel sync-audit signal.

### 10.5 `peer_refs.loro_vv_bytes` schema — day 3 or day 4?

**Question.** The `peer_refs` table needs a `loro_vv_bytes BLOB
NULL` column for incremental-sync tracking (§8.1). Day 3 wire-types
commit, or day 4 sync-push commit?

**Plan-author resolution.** Day 4. Day 3 is purely wire-shape; the
schema bump is naturally scoped with the sender that writes the
column.

### 10.6 Boot rehydrate latency telemetry

Carry-forward from `pending/PEND-09-PHASE-2-REPORT.md` §8.2. Add
`tracing::info!` on rehydrate elapsed time per space at boot? If
yes: a 5-min one-line edit to `src-tauri/src/lib.rs`'s boot block.

**Plan-author resolution.** Yes; ship as part of day 9 (when the
cutover plumbing simplifies).

### 10.7 Tag `pend-09/phase-2-complete` — which commit?

**Question.** Per §5 footer: tag the Phase-2-final commit as a
known-good restore point before day 5 lands.

* `ff272b0b` (current `main` HEAD)?
* The day-2-final commit (Phase-3-cutover-on lived for ≥1 day)?

**Plan-author resolution.** Tag the day-2-final commit (after the
§10.1 mini-soak closes clean). Captures "Phase 2 cutover-on lived in
production for at least one day" — the most restore-worthy state.

---

**Default-build behaviour byte-identical to commit `ff272b0b`.**
This plan is a docs-only deliverable.

— PEND-09 Phase 3 day-1, 2026-05-10.
