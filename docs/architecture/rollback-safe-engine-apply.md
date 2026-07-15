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

`fork_staging` (this PR, `src-tauri/src/loro/engine/staging.rs`) is the building
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

Bench: `src-tauri/benches/engine_checkpoint_bench.rs`. Run the full table with
`ENGINE_CHECKPOINT_FULL=1 cargo bench --bench engine_checkpoint_bench`
(release profile; the 10K/100K scales are gated so the CI `--test` smoke gate
stays cheap). Figures below are **µs per op**, release profile on the session's
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

   Both primitives live in `src-tauri/src/loro/engine/staging.rs` with unit
   tests (rewind-to-checkpoint, identity-preserved-and-usable). Chosen over the
   two alternatives: **explicit inverse ops** (must exactly invert CRDT semantics
   — fractional index, tombstones — per op type; more code + edge cases) and
   **Loro `UndoManager`** (its semantics interact with remote merges and aren't
   designed for materializer-internal use).

3. **Keep replay reconciliation as the backstop** until (2) has soaked; retiring
   it is a later, separate decision once no divergence has been observed.

## Follow-up: write-path wiring

The remaining work wires the two primitives into the tx lifecycle. It is
cross-cutting (high-risk) and its own PR:

- **Checkpoint capture.** Before the first engine mutation to a space in a tx,
  record `(space_id, checkpoint_frontiers())` in a per-tx revert log. The
  `BEGIN IMMEDIATE` write lock serialises writers, so at most one tx mutates the
  engines at a time — making even a per-`LoroState` in-flight log race-free
  (design-Q *Concurrency* resolved).
- **Commit / abort hooks.** On commit success, clear the log (the ops stay). On
  abort/drop, `revert_to_frontier` each recorded space. The trigger points are
  `apply_op`'s `tx.commit()` (REMOTE / single-op) and every LOCAL command's tx
  boundary — `apply_op_projected(advance_cursor=false)` is called from
  `commands/blocks/{crud,move_ops}.rs`, `commands/mod.rs`, … each owning its
  commit — plus `CommandTx`'s Drop for the panic path.
- **Cursor interaction (design-Q).** Unchanged: the apply cursor already advances
  only inside the committed tx (`advance_apply_cursor`), so a reverted engine and
  a rolled-back cursor stay consistent by construction.
- **Acceptance test.** Flip #2603's crash-injection test to assert *no divergence
  reachable by construction* for both local and remote ops, and add an
  abort-path rewind test.
