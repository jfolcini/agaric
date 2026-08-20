# Session 1366 — Sync protocol bookkeeping: the empty-stream short-circuit and the catch-up identity (2026-08-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-20 |
| **Subagents** | orchestrator-only (adversarial review of an inherited working-tree diff) |
| **Items closed** | `#4096`, `#4097` |
| **Items modified** | — |
| **Tests added** | +0 (frontend) / +5 (backend) |
| **Files touched** | 5 |

**Summary:** Closed the two residue issues that fell out of #4084/#4085. #4096: the
streamer's empty-stream short-circuit completed a sync session while writing nothing at
all to `peer_refs` — it returns sixteen lines before `streamed_to_peer = true` and never
reaches the `SyncComplete` arm that carries every other completion's bookkeeping, so a
device whose sessions all take that branch read as "never synced" forever. The
bookkeeping now lives inside `reply_sync_complete` itself, unconditionally, and stamps
`streamed_at` — never `synced_at`, which is the scheduler's only staleness input. #4097:
the snapshot catch-up resolved the peer identity only at its completion write, so a
fallback-identity catch-up emitted every `Progress`/`SnapshotProgress`/`Complete`/`Error`
event with `remote_device_id: ""`; resolution moves to function entry and shadows the
parameter, the expected fallback drops to `debug!`, and the `warn!` moves to the
genuinely-no-identity branch that previously had none.

**Files touched (this session):**
- `src-tauri/agaric-sync/src/sync_protocol/session_state_machine.rs` (+89 / −0)
- `src-tauri/agaric-sync/src/sync_daemon/snapshot_transfer.rs` (+93 / −27)
- `src-tauri/src/sync_daemon/tests.rs` (+156 / −0)
- `src-tauri/src/sync_daemon/snapshot_transfer_tests.rs` (+208 / −6)
- `src-tauri/src/sync_protocol/tests.rs` (+99 / −0)

**What changed**

*#4096 — `reply_sync_complete` records the session it completes*

- `reply_sync_complete` now calls `resolve_remote_peer_id()`, then
  `record_stream_in_tx` + `persist_peer_loro_vvs`, before the `Complete` event. It is
  deliberately **not** gated on `streamed_to_peer`: the short-circuit returns before that
  flag is set, so a gated call would silently skip the exact path the issue is about.
  It has one caller (`head_exchange_outgoing_loro`'s empty-stream return), so nothing
  double-records.
- Column choice is `streamed_at`. `peers_due_for_resync` reads `synced_at` and only
  `synced_at`; a responder refreshing `synced_at` on every inbound session would never
  find the initiator overdue, which is #610's starvation re-entered through a new door.
- No identity from either source → the whole block is skipped, matching
  `complete_pull_session`. The session still completes (it shipped nothing and applied
  nothing) rather than failing as the `SyncComplete` arm does.

*#4097 — the catch-up identity is settled at frame 0*

- `catchup_peer_identity` (new, pure) resolves session-id-else-daemon-identity once at
  the top of `try_receive_snapshot_catchup`, and the result shadows the parameter, so
  every event, log field and bookkeeping write below is attributed to the resolved peer.
- `receive_loro_snapshot_catchup` loses its `expected_remote_id` parameter — its sole
  caller has already resolved — deleting the third hand-rolled copy of the fallback.
- The expected fallback logs `debug!`; the `warn!` moves to the no-identity-at-all case.
  Resolution *order* and the hard-error behaviour are unchanged: the error still fires
  after `apply_snapshot`, in the same place, with the same message.

**Review findings acted on (this diff was inherited, not authored here)**

1. *Doc gap on the load-bearing decision.* `reply_sync_complete`'s doc justified
   `streamed_at` against the scheduler but named neither of `streamed_at`'s two actual
   consumers nor the degraded reason the branch fires. Documented: the column has never
   meant "bytes moved" (`prepare_outgoing`'s incremental arm returns a message for a
   space with no new ops, so a steady-state responder already stamped on zero-substance
   sessions); it feeds `peer_pulled_from_us_recently` (#4120) as well as the device
   list's `MAX(synced_at, streamed_at)`; and the branch also fires when the #1257
   freshness gate refuses *every* space, where stamping is still the consistent answer
   because a *partial* refusal already streams and already stamps.
2. *Untested new hazard.* The unconditional bookkeeping gave this branch its first ever
   reach into `peer_refs`, so it inherited the empty-`peer_id` corruption hazard that
   `orchestrator_rejects_sync_complete_with_empty_peer_id` pins for the `SyncComplete`
   arm — with none of that coverage. Added
   `issue4096_short_circuit_writes_no_row_when_peer_is_unidentified`: a cert-less
   responder with an empty registry, handed a `HeadExchange` carrying only our own
   device id, must complete *and* leave `peer_refs` empty.
3. *`persist_peer_loro_vvs` on an empty stream.* Verified safe and documented why: the
   floor is the frontier the **peer** advertised holding, not a record of what we sent,
   so failing to satisfy it does not make it false. It is consulted only when the peer
   advertises no vv for a space next round, and a stale/ahead floor already falls back to
   a snapshot via `apply_remote`'s reachability gate.
4. `cargo fmt` had not been run by the builder; one line in
   `snapshot_transfer_tests.rs` was reflowed.

**Mutation-testing the assertions** (each mutation applied to the production file, test
run, file restored from backup):

| Mutation | Expected | Result |
|---|---|---|
| Remove the #4096 bookkeeping block | `streamed_at` assertion fails | FAIL ✓ |
| Stamp **both** columns (`record_pull_in_tx` alongside) | `synced_at.is_none()` fails | FAIL ✓ |
| Drop `persist_peer_loro_vvs` | `loro_vv_bytes` assertion fails | FAIL ✓ |
| Un-shadow so events keep the raw parameter | events test fails | FAIL ✓ |
| Restore `warn!` on the expected fallback | debug-level test fails | FAIL ✓ |
| Write unguarded (`unwrap_or_default()`) | new empty-id test fails (`left: 1`) | FAIL ✓ |

The "stamp both columns" variant is the one that makes the column choice load-bearing
rather than decorative, and it is genuinely load-bearing.

**Verification:**
- `cd src-tauri && cargo nextest run --workspace` — 5959 tests run, 5959 passed, 7
  skipped.
- `cargo fmt --check` — clean (after running `cargo fmt`).
- `cargo check --all-targets` — clean.
- `cargo clippy --workspace --all-targets` — clean, zero warnings.

**Process notes:** The diff's #4097 rationale was re-derived against what #4085 *actually*
shipped (`fc15ce29a`, PR #4103) rather than the issue's pre-implementation text. Because
`with_expected_remote_id` now seeds `session.remote_device_id`, the fallback WARN this
issue was filed about no longer fires on every daemon-driven catch-up — the remaining
substance is the empty-id events on any path that reaches the catch-up without a seeded
id, plus consistency with the state machine. The issue body overstates the log-level half;
the event half is real and is what the new test pins.

**Lessons learned (for future sessions):** When a fix adds a *first* write to a shared
keyed table from a branch that previously never touched it, the branch inherits every
guard that table's other writers already carry — check whether those guards are tested
from the new branch, not just from the old one. Finding 2 came from asking that question
rather than from reading the diff.

**Commit plan:** single commit.
