# Session 1504 — #4502 prep: the materializer stops depending on the sync crate

The maintainer picked (C) for #4502 on 2026-09-03: invert the five `agaric_sync` couplings, then move `materializer/` into `agaric-engine` as the issue proposed. This is the first half. After it, `src/materializer/**` has no production reference to `agaric_sync`; the one that remains is a `#[cfg(test)]` pin.

The issue comment that called these five a redesign was wrong, and it is worth saying how each one actually went:

- **`foreground::LifecycleHooks`** is a two-field value struct (`Arc<AtomicBool>`, `Arc<Notify>`) with pure discrimination logic beside it. The whole `foreground.rs` moved to `agaric-core` untouched; `agaric-sync` re-exports the module, so every `agaric_sync::foreground::…` and `crate::foreground::…` path still resolves. Core gained `tokio` with the `sync` feature only, which was already in its graph through sqlx's runtime.
- **`SnapshotFallbackLast` / `AuditIngestStall`**, the two sync records `StatusInfo` carries, are plain specta data and now live in `agaric_core::sync_status`; the two sync metrics modules re-export them. The six counter reads and the scheduler's failure counts left `status_with_scheduler` and became a `SyncStatus` value the caller passes in: `Materializer::status_with_sync(SyncStatus)`, with `Default` for the no-sync case `status()` uses. `SchedulerLike` had no purpose left and is gone. `bindings.ts` regenerated to the same `StatusInfo` shape.
- **`ApplyHost for Materializer`** and the `From<Materializer> for Arc<dyn ApplyHost>` moved to a new app module, `src/sync_host.rs`, together with `sync_status(&SyncScheduler) -> SyncStatus`. The post-snapshot rebuild body is now an inherent `Materializer::enqueue_post_snapshot_rebuilds`; the trait impl is five delegations. The module descends into `agaric-sync` with the move, where the orphan rule lets sync implement its own trait for the engine's type; until then the app owns `Materializer`, so the impl is legal here.
- **`transport::RECV_TIMEOUT`** sized the attachment GC's reap window as twenty receive timeouts. The window is now the materializer's own constant and `reap_window_is_twenty_receive_timeouts` pins it to the sync constant.

Behaviour-preserving: no query changed (the four `.sqlx` caches are untouched), no schema, op type, store, queue or message type. Test count preserved plus the one pin.

Verification is in the PR body.
