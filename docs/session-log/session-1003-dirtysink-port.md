# Session 1003 — arch: invert gcal_push out of the materializer (#643)

Continuation of the arch focus. Single-issue PR, adversarially reviewed.

## Shipped

- **`refactor(materializer)` #643** — the core projection pipeline named one specific
  cloud integration: `coordinator.rs`/`consumer.rs`/`handlers/*` imported
  `gcal_push::connector::GcalConnectorHandle` and `coordinator.rs` directly computed gcal
  dirty events via `gcal_push::dirty_producer::{snapshot_block, compute_dirty_event,
  BlockDateSnapshot}`. The next integration (CalDAV, OS-notification scheduling) would have
  doubled the coupling.

  **Inversion:** a new `materializer/dirty_sink.rs` defines a `DirtySink` trait
  (`is_active`, `snapshot_for_op(&mut conn, record) -> DirtySnapshot`, `notify(events)`),
  with `DirtySnapshot = Box<dyn Any + Send>` so the materializer never names what the sink
  stores. `gcal_push` implements `DirtySink for GcalConnectorHandle` and the gcal-specific
  dirty-date mapping (`compute_dirty_event`, local-clock `today`) moved wholly into
  `gcal_push/connector.rs`. `lib.rs` registers the handle as the sink at wiring time. The
  apply/consumer hot path now names zero `gcal_push::*` types.

  **Behavior-preserving** (verified): same pre-mutation snapshot point inside the apply tx,
  same `chrono::Local::now()` clock, same gate (the sole implementor inherits
  `is_active = true`, collapsing to "handle wired" — identical to the old `OnceLock::is_some`),
  same post-commit notify timing, no event dropped/duplicated. The `gcal_hook` contract tests
  (5 materializer-path + 11 command-path) pass unchanged. Full materializer+gcal suite 608/0,
  clippy clean.

  Two `gcal_push::`-named shims remain in `coordinator.rs` (`set_gcal_handle`,
  `notify_gcal_for_op`) because the out-of-scope `commands/` layer calls them directly; both
  are now thin adapters routing through the `DirtySink` seam (no `compute_dirty_event`
  survives in the materializer). Closes #643.

## Related / deferred

- #142 (connector channel hygiene) is the natural companion seam — left for a follow-up.
- #642 (commands↔fts cycle) still gated behind #875 (recurrence) merging, since it touches
  the recurrence module.
