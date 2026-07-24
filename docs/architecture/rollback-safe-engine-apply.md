# Rollback-safe engine apply (#2604)

Status: **design + measurement** (this doc), implementation is follow-up work.

## The invariant at stake

In the command write path, `op_log` and the SQL `blocks` projection commit
**atomically** in one `BEGIN IMMEDIATE` transaction. The in-memory per-space
Loro engine, however, is mutated **outside** that transaction: the materializer
`apply_*_via_loro` handlers
(`src-tauri/src/materializer/handlers/loro_apply.rs`) take the per-space engine
guard, apply the op, read back a `BlockSnapshot`, drop the guard, then project
that snapshot to SQL. The SQL COMMIT happens **afterwards**, in the caller
(`apply_op` → `tx.commit()`, or the LOCAL command path →
`CommandTx::commit_and_dispatch`).

So a COMMIT failure — or a crash — **between** the engine apply and the SQL
COMMIT leaves the **engine ahead of committed SQL**. The reconciliation net is
asymmetric (pinned by #2603's crash-injection test):

- **LOCAL** ops (`advance_cursor = false`) self-heal on boot replay — the op is
  in the local `op_log`, replayed idempotently.
- **REMOTE** ops (`advance_cursor = true`) never land in the local `op_log`
  (#490-M1), so boot replay can't see them; the only net is the #2504
  disaster-recovery `reproject_blocks_from_engine`.

The #2604 goal: make the engine apply **transactional-by-construction** so that
no engine-ahead-of-SQL state is reachable, eliminating the divergence axis
rather than papering over it with replay.

## The shape any fix must fit

Two constraints make this non-trivial:

1. **The engine mutation must happen before the SQL projection.** The SQL
   projection reads back the engine's *post-apply* snapshot (content, parent,
   the authoritative sibling order for the dense-position reprojection). So we
   cannot simply defer the engine apply to after COMMIT.
2. **The commit decision happens in the caller, after the guard is dropped.**
   The per-space engine guard is `!Send` and cannot cross an `.await`; the SQL
   projection and COMMIT run after it is dropped.

So the mechanism is necessarily: apply to a **stand-in**, read back from the
stand-in for the SQL projection, and **promote** the stand-in into the canonical
engine only once the caller's SQL tx commits (discard on abort).

## Candidate mechanisms

### (A) Full-fork staging — `LoroDoc::fork` per op

Fork the per-space doc, apply the op to the fork, read back from the fork,
export the promotable delta; on COMMIT import the delta into the canonical doc,
on abort drop the fork. This is option (b) from the issue.

`fork_staging` (this PR, `src-tauri/agaric-engine/src/loro/engine/staging.rs`) is the building
block. Two problems surface immediately:

- **Cost.** `LoroDoc::fork` is documented **O(n) in time and space**. A fork per
  write op is therefore linear in the per-space doc size — the exact thing the
  benchmark below quantifies against the interactive SLO.
- **Peer identity (subtle, not in the issue).** `fork` "duplicates the document
  with a **different** PeerID". An op applied to a foreign-peer fork is credited
  to a throwaway peer; importing its delta into the canonical doc would inject an
  op under a peer id that is **not this device's**, breaking the
  `device_id → peer_id` stability contract (`peer_id_from_device_id`) that sync
  accounting, `export_update_since`, and the #792 fork guards all rest on.
  `fork_staging` neutralises this by **re-pinning** the fork's peer id to the
  source engine's, so a staged op mints at `(own_peer, next_counter)` — identical
  to a direct apply — and promotes back as a contiguous own-history delta. But
  the re-pin only makes it *correct*; it does nothing for the O(n) cost.

### (B) Lighter checkpoint — capture-delta / replay-inverse

Apply in place to the canonical doc, read back, project; on abort, revert the
one op. Avoids the O(n) fork, but needs a cheap, correct **revert** primitive.
Loro has no public "truncate ops after a frontier", and `checkout` detaches the
doc (forking history on the next forward op). The realistic revert primitives
are its native `UndoManager`, or capturing a small inverse and replaying it —
both carry their own correctness questions (interaction with remote ops already
merged, with the movable-tree CRDT, with the fractional index), which is why the
issue flags it as a fallback to *evaluate*, not a settled answer.

### (C) Per-op snapshot restore point

Export a full snapshot before each op; restore it on abort. Strictly worse than
(A) at scale (a full `export_snapshot` per op) — measured only as a reference
ceiling.

## Measurements

Bench: `src-tauri/benches/groups/engine_checkpoint_bench.rs` (a `mod` of the
consolidated `engine_bench` binary, #2879). Run the full table with
`ENGINE_CHECKPOINT_FULL=1 cargo bench --bench engine_bench -- engine_checkpoint`
(release profile; the 10K/100K scales are gated so the CI `--test` smoke gate
stays cheap; the trailing filter scopes the run to just the checkpoint groups). Figures below are **µs per op**, release profile on the session's
CI-equivalent runner (single sample run — read them as orders of magnitude, not
sub-µs-precise, and re-run for a hardware-specific number). The 100K column is
extrapolated from the measured `O(n)` trend (`fork` grows ~linearly, so 100K ≈
10× the 10K figure); re-run with `ENGINE_CHECKPOINT_FULL=1` for the measured
value:

| measurement | 100 | 1K | 10K | 100K (extrapolated) |
|---|---|---|---|---|
| `fork_only` (O(n) fork tax) | 914 | 7 833 | 150 736 | ≈ 1 500 000 |
| `stage_op` (fork + apply + export delta) | 1 073 | 8 358 | 157 019 | ≈ 1 570 000 |
| `promote_import` (fork + import 1-op delta) | 1 064 | 8 265 | 158 726 | ≈ 1 590 000 |
| `snapshot_export` (per-op restore point) | 229 | 2 475 | 55 794 | ≈ 560 000 |

`stage_op` is the added **pre-commit** latency on the interactive path;
`promote_import − fork_only` isolates the post-commit promote (`import`) cost —
a 1-op delta import is a few ms even at 10K, i.e. **the fork dominates entirely**.

### Reading against the SLO

The product SLO is interactive commands ≤ 200 ms p95 @ 100K
(`docs/architecture/operations.md` § Product SLO). A write command already
spends its budget on the `BEGIN IMMEDIATE` acquire, the op-log append, the SQL
projection, and the derived-cache maintenance; the engine-checkpoint overhead is
**added on top** and must stay a small fraction of the per-command budget.

The numbers are decisive. `fork_only` grows linearly with doc size (≈8.5× from
100→1K, ≈19× from 1K→10K — consistent with the documented `O(n)`): it is
**~150 ms per op at just 10K blocks** and **~1.5 s per op at 100K** — on its own,
~7× the entire 200 ms whole-command budget. `stage_op` tracks `fork_only` (the
apply + delta-export are a rounding error next to the fork). Per-op
`snapshot_export` (mechanism C) is ~3× cheaper than a fork but still **~56 ms @
10K / ~560 ms @ 100K** — also far past budget.

**Verdict:** full-fork staging (A) and per-op snapshot (C) are categorically
infeasible on the interactive path — both are `O(doc-size)` per op, and the
per-space doc is exactly the thing that grows. The mechanism MUST be
`O(op-size)`, not `O(doc-size)`.

## Decision (chosen mechanism)

1. **Reject the full fork (A) as the per-op path.** `fork_staging` stays in the
   tree as the correctness reference / test oracle (it *is* rollback-safe, just
   too costly) and as the right tool for a rare whole-doc checkpoint, but it must
   not run per interactive op.

2. **Mechanism B — apply in place + `fork_at`-rewind on abort — with the O(n)
   cost pushed onto the rare abort path.** The insight the bench unlocks: the
   expensive operation only has to happen on ABORT, which is exceptional.
   - **Common path (commit):** `checkpoint_frontiers()` — an `O(1)`
     `oplog_frontiers()` read — before the apply; apply in place and project as
     today; on COMMIT the op simply stays. Near-zero added latency.
   - **Abort path (rare — crash / constraint violation / COMMIT failure):**
     `revert_to_frontier(&checkpoint)` — `fork_at(frontier)` truncates the
     aborted op(s), re-pin the peer id (same `device_id → peer_id` fix as
     `fork_staging`), adopt it as canonical, rebuild the index. `O(n)`, but off
     the hot path.

   Both primitives live in `src-tauri/agaric-engine/src/loro/engine/staging.rs` with unit
   tests (rewind-to-checkpoint, identity-preserved-and-usable). Chosen over the
   two alternatives: **explicit inverse ops** (must exactly invert CRDT semantics
   — fractional index, tombstones — per op type; more code + edge cases) and
   **Loro `UndoManager`** (its semantics interact with remote merges and aren't
   designed for materializer-internal use).

3. **Keep replay reconciliation as the backstop** until (2) has soaked; retiring
   it is a later, separate decision once no divergence has been observed.

## Write-path wiring

The primitives wire into the tx lifecycle via a per-tx **revert log** on
`LoroState` and an RAII **`RevertScope`** (`src-tauri/agaric-engine/src/loro/revert.rs`):

- **Checkpoint capture.** The mutation handlers acquire their engine through
  `LoroEngineRegistry::for_space_recording`, which — when a `RevertScope` is
  armed — captures the touched space's `checkpoint_frontiers()` (first-touch per
  space) into the log alongside the exact engine `Arc`. The `BEGIN IMMEDIATE`
  write lock serialises writers, so at most one tx mutates the engines at a time,
  making a single un-keyed in-flight log race-free (design-Q *Concurrency*
  resolved). `for_space` in production is exclusively a mutation chokepoint, so
  an armed log never records a concurrent reader.
- **Commit / abort hooks.** The tx owner arms a `RevertScope` after
  `BEGIN IMMEDIATE`; once the apply has run it `detach`es the recorded
  checkpoints out of the shared log — WHILE THE WRITE LOCK IS STILL HELD, so the
  log is only ever armed under that lock (no concurrent writer can record into
  another tx's log). On COMMIT success the detached checkpoints are dropped (the
  ops stay); on an apply error or a failing `commit()` the owner calls
  `DetachedRevert::revert`, which runs `revert_to_frontier` for each recorded
  space. The `RevertScope`'s `Drop` is a panic-only safety-net for an unwind
  between arming and detaching. Together these cover the commit-failure,
  mid-apply-error, and panic paths.
- **Cursor interaction (design-Q).** Unchanged: the apply cursor advances only
  inside the committed tx (`advance_apply_cursor`), so a reverted engine and a
  rolled-back cursor stay consistent by construction.

### Status

- **REMOTE / single-op path (`apply_op`) — DONE (this PR).** This is the path
  #2603 pins and the one that does NOT self-heal at runtime (only a
  `reproject_blocks_from_engine` recovery pass reconciled it before). `apply_op`
  now arms a `RevertScope` around the apply+commit; a rolled-back tx rewinds the
  engine in lock-step. Test:
  `remote_op_abort_under_revert_scope_rewinds_engine_no_divergence_2604` — the
  same injection as the #2603 test, asserting *no divergence* and that the
  rewound engine stays usable (re-apply + commit converges, no reprojection). The
  #2603 test is retained: it documents the raw (unwired) primitive behaviour.
- **LOCAL command path (`CommandTx`) — DONE.** The owner is `CommandTx`, which
  commits internally and can touch multiple spaces in one tx, so the arm/detach
  live in `CommandTx` itself: `CommandTx::arm_engine_rollback(state)` arms
  `state.revert` right after `BEGIN IMMEDIATE`; `commit_and_dispatch` /
  `commit_without_dispatch` detach the checkpoints before the inner `commit()`
  (still under the write lock) and revert on a failing commit; `rollback` and the
  abort/panic `Drop` revert too. Every engine-driving command owner (block
  CRUD/move/batch, tags, properties, spaces, journal, `delete_property_core`, the
  chunked markdown/bibliography importers — re-armed per chunk) calls
  `arm_engine_rollback`; a command that turns out not to touch the engine arms an
  empty log (a no-op). The undo/redo/history owners bypass `apply_op_projected`,
  so their one engine mutation — the reverse move in `reverse_move_block` —
  switched from `for_space` to `for_space_recording` and those owners arm too.
  Tests: `local_command_tx_abort_rewinds_engine_no_divergence_2604` (dropped
  armed `CommandTx` rewinds the in-place apply) and
  `local_command_tx_commit_keeps_engine_and_projects_sql_2604` (commit keeps the
  op and lands the SQL projection).
- **Backstop.** Boot-replay reconciliation stays as the belt to these suspenders
  until the transactional apply has soaked; retiring it is a later, separate
  decision (#2603's test still guards it).
