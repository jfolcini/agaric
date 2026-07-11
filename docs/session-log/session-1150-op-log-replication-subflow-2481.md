## Session 1150 — audit-only op-log replication: Phase 1 sub-flow wiring (#2481) (2026-07-11)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-11 |
| **Subagents** | 1 explore (map wiring points) + orchestrator-driven build/review |
| **Items closed** | — (advances #2481 Phase 1; issue stays open for Phase 2/3) |
| **Items modified** | #2481 |
| **Tests added** | +6 backend (5 sync_protocol unit, 1 sync_daemon E2E) |
| **Files touched** | 6 |

**Summary:** Wired the live send/receive of `SyncMessage::OpLogBatch` into production
sync sessions, so audit-only op-log replication (#2481, DECIDED option a) actually
runs — the merged #2495 primitives had zero production callers. The streamer appends
the op records the puller lacks to the tail of its streaming reply (after the
`LoroSync` deltas, via the existing `next_message` drain); the puller buffers them and
ingests via `dag::insert_replicated_op` at session completion. Fully back-compat by
construction (capability-gated, no new wire round-trip). Two consequential fixes fell
out of exercising it end-to-end: a write-lock contention fix (buffer + materializer
flush before the audit write, #611) and completing the #778 cert-authoritative peer
identity (heads are frontier advertisements, not an identity claim, once a device
holds foreign replicated frontiers).

**Design decision (maintainer-approved in-session):** stream `OpLogBatch` within the
delta phase rather than as a post-delta daemon sub-flow. Sessions are pull-only and the
responder never sends a `HeadExchange` back, so the initiator cannot observe the
responder's capability — a post-delta sub-flow would deadlock a new-initiator /
old-responder pair. Routing through the existing streaming drain is the only fully
back-compat framing (an old responder queues nothing; the puller never blocks on it).

**Files touched (this session):**
- `src-tauri/src/sync_protocol/session_state_machine.rs` — responder queues op batches
  after LoroSync (`collect_op_batches_for_peer`); `next_message` drains both queues with
  a single terminal `is_last`; puller buffers received records and ingests them in
  `complete_pull_session` after a materializer flush; cert-CN-authoritative peer identity.
- `src-tauri/src/sync_daemon/server.rs` — retired the heads-vs-cert B-34 pre-check
  (invalid under multi-device frontier advertisement); identity from cert CN, unpaired
  peers still gated by S-1.
- `src-tauri/src/sync_protocol/types.rs` — `OpLogBatch` doc updated (streaming-phase, not
  a separate daemon sub-flow).
- `docs/architecture/sync-protocol-spec.md` — `OpLogBatch` message + handshake/state-machine
  flow + completion-time buffered ingest.
- `src-tauri/src/sync_protocol/tests.rs` — 5 new tests; reframed the peer-identity test.
- `src-tauri/src/sync_daemon/tests.rs` — E2E replication over a real socket; updated the
  #2536 message-count and cert-CN-mismatch tests for the new flow.

**Verification:**
- `cargo nextest run -E 'test(sync_protocol::) + test(sync_daemon::)'` — 343 tests, all pass.
- New `test(2481)` filter — all green (5 unit + 1 real-socket E2E).

**Process notes:** exercising #611 (oversized block) surfaced a real inline-ingest write
contention with the materializer's background FTS rebuild; the #2141 round-robin surfaced
the latent multi-device peer-identity gap. Both were fixed rather than worked around.

**Commit plan:** single commit; draft PR (Phase 1 wiring; Phase 2 History surfacing and
Phase 3 self-healing/docs remain).
