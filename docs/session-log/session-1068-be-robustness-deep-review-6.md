# Session 1068 — /batch-issues loop: backend robustness, batch 18 (2026-06-19)

## What happened

Eighteenth batch of the `/loop /batch-issues` run: two backend robustness findings
from the multi-agent deep review, each on a disjoint module, built by parallel
subagents (≤2 concurrent Rust) and adversarially reviewed. Ran overlapped with
frontend batch 17 (`fix/fe-polish-deep-review-1`).

## Shipped

Single PR `fix/be-robustness-deep-review-6`:

- **#1581** (MEDIUM, resource exhaustion) — incoming responder sync sessions were
  spawned unbounded: every accepted TCP connection spawned a ≤180 s responder task
  with no concurrency cap, so a reconnect-looping peer could pin unbounded tasks /
  file descriptors and starve the 6-connection DB pool. Added a process-wide
  `Arc<Semaphore>` of `MAX_CONCURRENT_RESPONDER_SESSIONS = 16` (new named const in
  `sync_constants.rs`). The permit is acquired with `try_acquire_owned()` in the
  accept loop **immediately after `listener.accept()` and before the TLS-handshake
  `tokio::spawn`**, so a connection at capacity is dropped (TCP close) without
  spending handshake CPU/FDs; the permit is moved through the `on_conn` callback into
  the responder session task and held for the whole session, freed on
  graceful/error/panic completion. Required changing `SyncServer::start`'s callback
  signature from `Fn(SyncConnection)` to `Fn(SyncConnection, OwnedSemaphorePermit)`;
  the orchestrator's callback now `move |conn, permit|` and moves the permit into the
  spawned `handle_incoming_sync` task. Cap rationale: no prior limit existed; per
  AGENTS.md §Threat Model (single trusted user, a handful of paired devices, DoS
  hardening out of scope) 16 is a stability bound — generous headroom over realistic
  paired-device count and over the 6-connection pool, while bounding task/FD fan-out.
  New test `responder_sessions_capped_by_semaphore` proves the cap holds and excess
  connections are rejected pre-handshake.
- **#1574** (MEDIUM, OOM) — `replay_sync_inbox` loaded the entire sync inbox with a
  single `.fetch_all` of all blob rows at boot, so a large backlog could OOM during
  crash recovery. Rewritten as an id-ascending chunked walk
  (`WHERE id > ? ORDER BY id ASC LIMIT 200`, reusing `replay::REPLAY_CHUNK_SIZE`,
  promoted to `pub(crate)` rather than duplicating the constant). The cursor advances
  past **every** row attempted — success or poison — before processing, matching the
  op-log replay's monotonic-cursor semantics, so a permanently-failing slot can never
  be re-fetched into the next chunk (no infinite boot loop); the #792/#1054 poison
  drop-or-leave logic inside `replay_inbox_row` is untouched. Also made purged-space
  tolerance observable: an inbox row whose space is absent from the `spaces` registry
  table still replays and clears (the loro projection stamps `blocks.space_id` via a
  `(SELECT id FROM spaces WHERE id = ?)` subquery → NULL, no FK violation), and a
  `tracing::warn!` now records the condition instead of it passing silently. Both new
  queries use compile-time macros (`query!` / `query_scalar!`), so the #646
  dynamic-SQL baseline was NOT touched; two new `.sqlx` entries, all 236 prior entries
  intact. GC of old inbox rows (issue's optional item #3) deferred — filed as
  follow-up, since naive age-based deletion risks dropping recoverable data from an
  interrupted projection; a safe bound must key on repeated replay failure, not age.

## Review pass

Two adversarial reviewers, both items verified correct:

- **#1581 reviewer** confirmed the permit is acquired before the TLS handshake (no
  handshake spent at capacity), held for the full session lifetime, all
  `SyncServer::start` call sites updated (no leftover E0593 1-arg closures), the cap
  is a named const with sound rationale, `try_acquire_owned()` is the non-blocking
  reject variant (accept loop never blocks), and the new test fails if the semaphore
  is removed. Ran the real `cargo clippy --all-targets -- -D warnings` gate + targeted
  nextest.
- **#1574 reviewer** focused on the highest-risk defect — the infinite-boot-loop
  cursor — and confirmed `last_seen` advances on the poison/error path, not just
  success; verified strict `id > ?` (no boundary re-process), correct termination on a
  short chunk, purged-space row clears (not a wedge), no new dynamic SQL, and `.sqlx`
  integrity (2 new, 0 modified). Ran the targeted `sync_inbox`/`replay`/`recovery`
  filter (full `--all-targets` clippy owned by the #1581 reviewer to avoid concurrent
  cargo target-lock/OOM contention).

## Notes

- Files: `sync_constants.rs`, `sync_net/websocket.rs`, `sync_daemon/orchestrator.rs`,
  `recovery/sync_inbox.rs`, `recovery/replay.rs` (+ test call-site updates in
  `sync_net/tests.rs`, `sync_daemon/tests.rs`, `sync_files/tests.rs`) and two new
  `.sqlx` entries. No frontend/codegen beyond the `.sqlx`.
- Branch base (`7a804e94`) was stale vs current `origin/main` (`58dff693`), but a diff
  confirmed origin changed **none** of the 8 touched files, so the rebase onto
  origin/main was conflict-free.
- Pushed serially with frontend batch 17 to avoid concurrent heavy pre-push (OOM).
