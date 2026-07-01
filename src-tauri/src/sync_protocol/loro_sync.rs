//! Loro-based sync push + apply helpers.
//!
//! ## Module layout
//!
//! * [`prepare_outgoing`] — sender side. Given a peer's last-known
//!   version vector (or `None` for initial sync), produce a
//!   [`super::loro_sync_types::LoroSyncMessage`] carrying either a
//!   full snapshot or an incremental update.
//! * [`apply_remote`] — receiver side. Given a parsed
//!   [`super::loro_sync_types::LoroSyncMessage`], import the bytes
//!   into the per-space engine and project every changed block into
//!   the SQL `blocks` table inside a single transaction.  Returns an
//!   [`ApplyOutcome`] discriminating between successful import and a
//!   snapshot-fallback request (see below).
//!
//! ## Snapshot-fallback path
//!
//! Before importing a [`LoroSyncMessage::Update`], [`apply_remote`]
//! verifies that the peer's declared `from_vv` is **reachable** from
//! our current `oplog_vv()`: for every `(peer_id, counter)` entry in
//! `from_vv`, our local vv has an entry for the same `peer_id` with a
//! counter `>=` the peer's.  If any entry is missing or our counter
//! lags, the update cannot be applied without losing ops — Loro would
//! otherwise surface this as an opaque decode error from
//! `import_with_changed_blocks`.
//!
//! On a miss, [`apply_remote`] short-circuits **before** the engine
//! import and returns [`ApplyOutcome::SnapshotFallbackRequested`].  The
//! orchestrator translates that into a [`super::types::SyncMessage::ResetRequired`],
//! which the daemon layer's snapshot catch-up sub-flow
//! ([`crate::sync_daemon::snapshot_transfer`]) already handles —
//! identical to the first-time-pairing / log-compacted path.
//!
//! #1054: the boot-replay path ([`replay_inbox_row`]) mirrors this same
//! gate. A leftover write-ahead inbox slot stores only `(space_id, bytes)`
//! (no `from_vv`), so it recovers the update's causal base from the blob's
//! own `partial_start_vv` (via [`crate::loro::engine::LoroEngine::unreachable_update_in_blob`])
//! and, on a miss, DROPs the slot — rather than importing unconditionally and
//! leaving an opaque-error poison row that re-fails at every boot. The next
//! live sync session re-detects the gap in [`apply_remote`] and routes into
//! the snapshot catch-up. Snapshot-shaped slots stay safe to import
//! unconditionally.
//!
//! ## TODOs
//!
//! * `peer_refs.loro_vv_bytes` schema / read. Callers pass the peer's
//!   vv as `Option<&[u8]>`; the read-from-SQL piece lands with the
//!   push wiring.

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::loro::registry::LoroEngineRegistry;
use crate::space::SpaceId;
use crate::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};
use loro::VersionVector;

/// #2188 — run a CPU-bound CRDT encode/decode closure so it does not stall the
/// async reactor while holding the process-global registry mutex.
///
/// On a **multi-thread** tokio runtime (production: tauri's default async
/// runtime + the daemon's `tokio::spawn`) this delegates to
/// [`tokio::task::block_in_place`], which tells the runtime this worker is about
/// to block so a sibling worker can take over the reactor for the duration. The
/// closure still runs inline on THIS thread, so the registry `MutexGuard`
/// (`!Send`) it acquires and holds across the encode is fine, and — critically —
/// `block_in_place` does NOT release that lock: atomicity vs concurrent mutation
/// is exactly as before, we merely stop pinning the reactor.
///
/// `block_in_place` PANICS on a **current-thread** runtime, which the sync
/// integration tests (`#[tokio::test]`) and the `agaric-mcp` binary use. On that
/// flavor there is no sibling worker to hand the reactor to anyway, so we simply
/// run the closure inline — identical behaviour to the pre-#2188 code. This
/// keeps the optimisation where it helps (production is always multi-thread)
/// without introducing a panic on the current-thread paths.
#[inline]
fn cpu_block_in_place<T>(f: impl FnOnce() -> T) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current().map(|h| h.runtime_flavor()) {
        Ok(RuntimeFlavor::MultiThread) => tokio::task::block_in_place(f),
        // Current-thread runtime (tests / agaric-mcp) or no runtime at all:
        // `block_in_place` would panic, so run the closure inline.
        _ => f(),
    }
}

/// Outcome of [`apply_remote`].  Discriminates between a successful
/// engine import and a `from_vv`-unreachable snapshot-fallback signal.
///
/// Callers (the orchestrator) must `match` on this to
/// decide whether to transition into `Complete` (after a successful
/// import) or `ResetRequired` (to trigger the snapshot catch-up
/// sub-flow at the daemon layer).
#[derive(Debug, Clone)]
pub enum ApplyOutcome {
    /// The message was imported into the engine (and, for Update /
    /// Snapshot variants, projected into SQL).  Carries the targeted
    /// [`SpaceId`] so the caller can invalidate per-space caches, plus the
    /// set of block ids the import actually changed.
    ///
    /// #421: `changed_blocks` is exactly the id set `apply_remote` already
    /// computed (via `import_with_changed_blocks`) and used to drive the
    /// per-block SQL projection. Surfacing it lets the orchestrator reindex
    /// FTS for just those blocks (`UpdateFtsBlock`) instead of a full
    /// O(vault) `RebuildFtsIndex` on every inbound sync message.
    Imported {
        /// Per-space scope of the imported message.
        space_id: SpaceId,
        /// Block ids the import changed (may be empty for a no-op import).
        changed_blocks: Vec<crate::ulid::BlockId>,
        /// #2264: block ids the import hard-purged (`PurgeBlock`), disjoint
        /// from `changed_blocks` (which enumerates live blocks only — #2128).
        /// Surfaced so the orchestrator can distinguish a complete no-op
        /// import (both sets empty → skip the derived-cache fan-out
        /// entirely) from a purge-only import (aggregate caches like
        /// `tags_cache.usage_count` / `pages_cache` counts still need a
        /// refresh even though no live block changed).
        purged_blocks: Vec<crate::ulid::BlockId>,
        /// #1071: the deduped set of owning *page* ids (page-root block ids)
        /// the changed blocks belong to. Resolved from the committed
        /// `parent_id`/`block_type` chain right after the projection tx (a
        /// page block resolves to itself). The orchestrator threads these
        /// out via [`crate::sync_events::SyncEvent::Complete`] so the
        /// frontend can reload ONLY the affected page stores instead of
        /// every mounted BlockTree. May be empty when no blocks changed or
        /// when a changed block has no resolvable page ancestor (orphan /
        /// cross-doc ordering) — the frontend falls back to a full reload
        /// when the set is empty.
        changed_page_ids: Vec<String>,
    },
    /// The message was a [`LoroSyncMessage::Update`] whose `from_vv`
    /// is not reachable from our current `oplog_vv()` — applying the
    /// delta would yield an incoherent CRDT state.  The engine import
    /// was **not** attempted; callers should request a fresh snapshot
    /// from the peer (the orchestrator translates this into
    /// [`super::types::SyncMessage::ResetRequired`]).
    SnapshotFallbackRequested {
        /// Per-space scope of the rejected message.
        space_id: SpaceId,
        /// Human-readable reason — surfaced in `SyncEvent::Error` /
        /// `SyncMessage::ResetRequired::reason` for log + telemetry.
        reason: String,
    },
}

/// Internal: classify whether a peer's `from_vv` (encoded) is
/// reachable from our local `oplog_vv()` (encoded).
///
/// "Reachable" — for every `(peer_id, counter)` entry in the peer's
/// vv, our local vv has an entry for the same `peer_id` with a
/// counter `>=` the peer's.  An entry the peer has at counter `c > 0`
/// that we lack entirely is **also** unreachable (we have zero ops
/// from that peer, the peer believes we have `c`).
///
/// Returns `Ok(None)` for reachable; `Ok(Some(reason))` for
/// unreachable with a human-readable diagnostic.  Decode failures on
/// either side surface as [`AppError::Validation`] — a malformed vv
/// on the wire is a protocol error, distinct from a clean miss.
fn classify_from_vv_reachability(
    local_encoded: &[u8],
    peer_encoded: &[u8],
) -> Result<Option<String>, AppError> {
    let local_vv = VersionVector::decode(local_encoded).map_err(|e| {
        AppError::Validation(format!(
            "loro_sync: decode local oplog_vv for reachability check: {e}",
        ))
    })?;
    let peer_vv = VersionVector::decode(peer_encoded).map_err(|e| {
        AppError::Validation(format!(
            "loro_sync: decode peer from_vv for reachability check: {e}",
        ))
    })?;

    // VersionVector derefs to FxHashMap<PeerID, Counter>; the
    // contract is "every peer entry in `peer_vv` must be matched by
    // an entry in `local_vv` whose counter is >=".  A `0` counter on
    // the peer side carries no ops and is trivially reachable; treat
    // it as a no-op to avoid spurious misses against fresh peers.
    for (peer_id, &peer_counter) in peer_vv.iter() {
        if peer_counter == 0 {
            continue;
        }
        match local_vv.get(peer_id) {
            Some(&local_counter) if local_counter >= peer_counter => continue,
            Some(&local_counter) => {
                return Ok(Some(format!(
                    "peer's from_vv requires peer={peer_id} counter>={peer_counter}, \
                     local oplog_vv has counter={local_counter}",
                )));
            }
            None => {
                return Ok(Some(format!(
                    "peer's from_vv requires peer={peer_id} counter>={peer_counter}, \
                     local oplog_vv has no entry for that peer",
                )));
            }
        }
    }
    Ok(None)
}

/// Build the next outgoing [`LoroSyncMessage`] for `space_id`.
///
/// * `peer_vv == None` — initial sync; the sender produces a full
///   snapshot via [`crate::loro::engine::LoroEngine::export_snapshot`].
///   Receiver's [`apply_remote`] imports unconditionally.
/// * `peer_vv == Some(vv)` — incremental sync; the sender produces
///   an update covering ops added since the peer's vv via
///   [`crate::loro::engine::LoroEngine::export_update_since`].  The
///   receiver imports against its existing engine state.
///
/// `device_id` is the sender's own [`crate::device`] identity — the
/// registry uses it to lazy-instantiate the engine if this is the
/// first call for `space_id` since process boot.  Production callers
/// pass the process-stable UUID-v4 from `crate::device`.
///
/// # #1257 — sync-export freshness gate
///
/// Returns `Ok(None)` when the engine is **stale** relative to SQL for
/// this space and the round MUST emit no payload (the caller skips the
/// space and a rebuild-from-op-log is signalled). `Ok(Some(msg))` is the
/// unchanged happy path.
///
/// ## Why per-block `deleted_at` reconciliation, not a vv freshness gate
///
/// The engine tombstones rather than removes on delete
/// ([`crate::loro::engine::apply::...apply_delete_block`] sets the
/// `deleted_at` meta but the node survives in the `LoroDoc` and is still
/// exported). The hazard a future eager-local-apply introduces is a
/// *divergence* where SQL has soft-deleted a block but the engine still
/// holds it as live — so `prepare_outgoing` would export a block SQL
/// considers gone.
///
/// An op-log-head vv gate cannot detect this. `version_vector()` /
/// `oplog_vv()` are Loro `(PeerID, Counter)` coordinates — the SAME
/// coordinate system the receive-side `classify_from_vv_reachability`
/// uses, so a vv gate would *type-check*. But the divergence is not
/// expressible in vv terms: a block soft-deleted in SQL *only* (the
/// eager-apply gap) produces NO change to the engine's `oplog_vv` — the
/// engine never observed a delete op for it. The engine frontier and the
/// committed op-log head stay byte-identical while SQL and the engine
/// disagree about that block's liveness. The vv gate is therefore
/// structurally blind to exactly the hazard we must catch.
///
/// So the gate reconciles per-block: take the set of blocks the engine
/// would export as LIVE (`live_block_ids()`) and ask SQL which of them are
/// soft-deleted (`deleted_at IS NOT NULL`). If ANY engine-live block is
/// SQL-deleted, the engine is stale for this space → refuse (return
/// `Ok(None)`, log, signal rebuild). No inline repair.
///
/// Sender-side helper.
///
/// # #2040 — soft-deleted-id read hoisted out of the per-space loop
///
/// `sql_deleted` is the vault-wide set of SQL-soft-deleted block ids
/// (`deleted_at IS NOT NULL`). It is read ONCE per sync round by the caller
/// ([`super::orchestrator::SyncOrchestrator::head_exchange_outgoing_loro`] via
/// [`read_sql_soft_deleted_ids`]) and threaded through every per-space
/// `prepare_outgoing` call. Previously each call re-ran the same full-vault
/// `SELECT id FROM blocks WHERE deleted_at IS NOT NULL` into a fresh
/// `HashSet`, so S spaces meant S identical full-vault reads every sync tick /
/// debounced change / mDNS discovery. The set is small (deletes are
/// periodically-purged tombstones) and identical across spaces in a round, so
/// sharing it is behaviour-preserving — the #1257 freshness gate still
/// intersects it against each space's engine-live set independently.
pub async fn prepare_outgoing(
    registry: &LoroEngineRegistry,
    space_id: &SpaceId,
    device_id: &str,
    peer_vv: Option<&[u8]>,
    sql_deleted: &std::collections::HashSet<String>,
) -> Result<Option<LoroSyncMessage>, AppError> {
    // #1257 freshness gate. Snapshot the engine-live block id set under
    // the guard, then drop the guard BEFORE the SQL round-trip (the guard
    // is not `Send` across an `.await`, and the read is a pure snapshot —
    // the daemon is dormant so nothing mutates the engine concurrently).
    let live_block_ids: Vec<String> = {
        let mut guard = registry.for_space(space_id, device_id)?;
        guard.engine_mut().live_block_ids()?
    };
    if let Some(stale_id) = first_engine_live_block_sql_deleted(&live_block_ids, sql_deleted) {
        // Refuse + signal rebuild. Emit NO payload this round; a future
        // caller can trigger a rebuild-from-op-log to reconcile the engine
        // With SQL. Do NOT repair inline (that is territory).
        tracing::warn!(
            space_id = %space_id.as_str(),
            device_id = %device_id,
            stale_block_id = %stale_id,
            "loro_sync: #1257 freshness gate REFUSED export — engine holds a \
             block SQL has soft-deleted (engine stale vs SQL); emitting no sync \
             payload this round, rebuild-from-op-log required"
        );
        return Ok(None);
    }

    match peer_vv {
        None => {
            // Initial sync — full snapshot.
            //
            // #2188: the CRDT snapshot encode is CPU-bound and runs while
            // holding the process-global registry mutex. Wrapping the guard
            // acquisition + encode in `cpu_block_in_place` lets the multi-thread
            // reactor drive other tasks for the duration instead of stalling
            // the async worker. This does NOT release the registry lock — the
            // guard is still held across the encode, preserving atomicity vs
            // concurrent mutation exactly as before. The guard is `!Send`, but
            // the closure runs inline on this same worker thread, so a `!Send`
            // guard inside it is fine. See `cpu_block_in_place` for the
            // current-thread-runtime fallback.
            let bytes = cpu_block_in_place(|| {
                let mut guard = registry.for_space(space_id, device_id)?;
                guard.engine_mut().export_snapshot()
            })?;
            Ok(Some(LoroSyncMessage::Snapshot {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: space_id.clone(),
                bytes,
            }))
        }
        Some(vv) => {
            // Incremental — export only ops since `vv`.
            //
            // #2188: see the `None` arm — the incremental encode is likewise
            // CPU-bound under the registry lock, so it runs inside
            // `cpu_block_in_place` to unblock the reactor without releasing the
            // lock.
            let bytes = cpu_block_in_place(|| {
                let mut guard = registry.for_space(space_id, device_id)?;
                guard.engine_mut().export_update_since(vv)
            })?;
            Ok(Some(LoroSyncMessage::Update {
                protocol_version: LORO_SYNC_PROTOCOL_VERSION,
                space_id: space_id.clone(),
                from_vv: vv.to_vec(),
                bytes,
            }))
        }
    }
}

/// #2040: single-space convenience wrapper around [`prepare_outgoing`] that
/// reads the SQL-soft-deleted set itself (via [`read_sql_soft_deleted_ids`])
/// before delegating.
///
/// This preserves the pre-#2040 self-contained one-shot signature for callers
/// that prepare exactly ONE space (tests, the snapshot/daemon seed paths) and
/// therefore gain nothing from hoisting the read. The hot multi-space round —
/// [`super::orchestrator::SyncOrchestrator::head_exchange_outgoing_loro`] —
/// reads the set ONCE and calls [`prepare_outgoing`] directly per space, so it
/// does NOT pay one full-vault read per space. Behaviour is identical to the
/// old inline read: the set is exactly what `prepare_outgoing` would have read.
pub async fn prepare_outgoing_for_pool(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    space_id: &SpaceId,
    device_id: &str,
    peer_vv: Option<&[u8]>,
) -> Result<Option<LoroSyncMessage>, AppError> {
    let sql_deleted = read_sql_soft_deleted_ids(pool).await?;
    prepare_outgoing(registry, space_id, device_id, peer_vv, &sql_deleted).await
}

/// #2040: read the vault-wide set of SQL-soft-deleted block ids
/// (`deleted_at IS NOT NULL`) ONCE for a whole sync round.
///
/// Hoisted out of [`prepare_outgoing`] so the per-space loop does not re-run
/// this identical full-vault scan once per space. The caller
/// ([`super::orchestrator::SyncOrchestrator::head_exchange_outgoing_loro`])
/// invokes this once before iterating spaces and threads the returned set into
/// every `prepare_outgoing` call. The set is small (tombstones, periodically
/// purged); its content does not depend on the space being exported.
pub(crate) async fn read_sql_soft_deleted_ids(
    pool: &SqlitePool,
) -> Result<std::collections::HashSet<String>, AppError> {
    let sql_deleted: std::collections::HashSet<String> =
        sqlx::query_scalar!("SELECT id FROM blocks WHERE deleted_at IS NOT NULL")
            .fetch_all(pool)
            .await
            .map_err(|e| {
                AppError::Validation(format!(
                    "loro_sync: #1257 freshness gate: read SQL soft-deleted ids: {e}"
                ))
            })?
            .into_iter()
            .collect();
    Ok(sql_deleted)
}

/// #1257: return the first `block_id` that the engine holds as live but
/// which SQL has soft-deleted (`deleted_at IS NOT NULL`), or `None` when the
/// two agree.
///
/// `sql_deleted` is the pre-fetched vault-wide soft-deleted set (#2040 — read
/// once per round by [`read_sql_soft_deleted_ids`], not per space). We
/// intersect the engine-live set against it in memory rather than emitting an
/// `IN (...)` over a potentially large live set. Returns a deterministic first
/// hit for stable log output.
///
/// #2040: the deterministic first hit is the lexicographically smallest
/// matching id. The previous code collected all matches into a `Vec`, sorted
/// it, and took `.into_iter().next()` (the minimum); `.iter().min()` selects
/// the same element under the same ordering without the allocation + full
/// sort.
fn first_engine_live_block_sql_deleted(
    live_block_ids: &[String],
    sql_deleted: &std::collections::HashSet<String>,
) -> Option<String> {
    live_block_ids
        .iter()
        .filter(|id| sql_deleted.contains(*id))
        .min()
        .cloned()
}

/// Apply an incoming [`LoroSyncMessage`] to the local engine and
/// project the changed blocks to SQL.
///
/// Returns an [`ApplyOutcome`]:
///
/// * [`ApplyOutcome::Imported`] — engine import + SQL projection
///   succeeded; the carried [`SpaceId`] lets the caller invalidate
///   per-space caches (FE event emission, agenda recompute, etc.).
/// * [`ApplyOutcome::SnapshotFallbackRequested`] — the
///   message was a [`LoroSyncMessage::Update`] whose `from_vv` is
///   ahead of (or concurrent with) our `oplog_vv()`.  The engine
///   import is **not** attempted; the caller MUST request a fresh
///   snapshot from the peer (orchestrator emits
///   [`super::types::SyncMessage::ResetRequired`] for this).
///
/// Atomicity contract: the engine import happens **before** the SQL
/// transaction. A crash between the two leaves the engine ahead of
/// SQL; boot crash recovery reconciles by re-running projection over
/// each engine block.
pub async fn apply_remote(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
    message: LoroSyncMessage,
) -> Result<ApplyOutcome, AppError> {
    // Validate protocol version + extract bytes / space_id.  For
    // Update, also gate the import on the reachability
    // check — if the peer's `from_vv` is unreachable from our local
    // `oplog_vv()`, short-circuit with `SnapshotFallbackRequested`
    // instead of letting `import_with_changed_blocks` surface an
    // opaque Loro decode error.
    let (space_id, bytes) = match message {
        LoroSyncMessage::Snapshot {
            protocol_version,
            space_id,
            bytes,
        } => {
            if protocol_version != LORO_SYNC_PROTOCOL_VERSION {
                return Err(AppError::Validation(format!(
                    "loro_sync: unsupported snapshot protocol version {protocol_version} \
                     (this build speaks {LORO_SYNC_PROTOCOL_VERSION})",
                )));
            }
            (space_id, bytes)
        }
        LoroSyncMessage::Update {
            protocol_version,
            space_id,
            from_vv,
            bytes,
        } => {
            if protocol_version != LORO_SYNC_PROTOCOL_VERSION {
                return Err(AppError::Validation(format!(
                    "loro_sync: unsupported update protocol version {protocol_version} \
                     (this build speaks {LORO_SYNC_PROTOCOL_VERSION})",
                )));
            }
            // Verify peer's `from_vv` is reachable from
            // our current `oplog_vv()`.  Read the local vv off the
            // engine BEFORE the import — and BEFORE any SQL tx — so
            // a miss returns without side-effects.
            let local_vv_bytes: Vec<u8> = {
                let mut guard = registry.for_space(&space_id, device_id)?;
                guard.engine_mut().version_vector()
            };
            match classify_from_vv_reachability(&local_vv_bytes, &from_vv)? {
                None => {
                    // Reachable — fall through to the import.
                }
                Some(reason) => {
                    // #1319: feed the process-global cross-session
                    // aggregate (count + last reason/peer/space) BEFORE
                    // returning. Observability only — the control flow
                    // below (returning SnapshotFallbackRequested →
                    // snapshot catch-up) is unchanged. The per-session
                    // surfacing stays the orchestrator's `SyncEvent::Error`
                    // / `ResetRequired` line.
                    super::snapshot_fallback_metrics::record(device_id, space_id.as_str(), &reason);
                    return Ok(ApplyOutcome::SnapshotFallbackRequested { space_id, reason });
                }
            }
            (space_id, bytes)
        }
    };

    // #792: own-peer fork guard — runs for BOTH Snapshot and Update,
    // BEFORE the write-ahead inbox insert (a forked blob must never be
    // persisted for boot replay) and BEFORE the engine import. A vault
    // that went through a pre-epoch snapshot RESET re-minted ops under
    // its old deterministic PeerID; the peer still holds the pre-reset
    // ops under the same id, so an inbound blob can carry "our" ops at
    // counters beyond what our doc holds. Importing it makes loro skip
    // the overlapping counter range and apply the rest against the
    // wrong causal prefix — panicking inside loro-internal 1.12 (debug
    // assertions) or silently corrupting state (release). Short-circuit
    // into the snapshot-fallback path instead: the daemon-level
    // catch-up applies the peer's SQL snapshot, and `apply_snapshot`
    // now bumps the peer-id epoch, permanently healing the fork.
    let fork = {
        let mut guard = registry.for_space(&space_id, device_id)?;
        guard.engine_mut().own_peer_fork_in_blob(&bytes)
    };
    if let Some(reason) = fork {
        tracing::warn!(
            space_id = %space_id,
            reason = %reason,
            "loro_sync: inbound blob forks our own (peer,counter) space (#792); \
             requesting snapshot fallback instead of importing"
        );
        return Ok(ApplyOutcome::SnapshotFallbackRequested { space_id, reason });
    }

    // #535: write-ahead inbox. Durably persist the raw incoming bytes in
    // their OWN committed tx BEFORE the engine import. If a crash strikes
    // after the engine import + Loro persist but before the SQL projection
    // commits (the data-loss window this issue closes), this row survives;
    // boot recovery (`crate::recovery::replay_sync_inbox`) replays it. The
    // matching DELETE lives inside the Phase-2 projection tx in
    // `import_and_project`, so the slot is cleared atomically with the SQL
    // projection. Re-import on replay is idempotent (Loro import is
    // idempotent; SQL projections are upserts) and bypasses the
    // reachability gate, so only `space_id` + raw bytes are stored.
    //
    // NOTE: a reachability miss above returns WITHOUT writing the inbox —
    // no import is attempted there, so there is nothing to replay.
    // `crate::db::now_ms()` — wall-clock epoch-ms, same helper the rest of
    // the ms-timestamp schema uses (0079/0082).
    let created_at = crate::db::now_ms();
    let space_id_str = space_id.as_str();
    let inbox_id: i64 = sqlx::query_scalar!(
        "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
         VALUES (?, ?, ?) RETURNING id",
        space_id_str,
        bytes,
        created_at,
    )
    .fetch_one(pool)
    .await?;

    let (changed_blocks, purged_blocks) = import_and_project(
        pool,
        registry,
        device_id,
        &space_id,
        &bytes,
        inbox_id,
        InboundDeliveryKind::Live,
    )
    .await?;

    // #1071: resolve the owning page id of every changed block so the
    // orchestrator can thread a targeted-invalidation set out via
    // `SyncEvent::Complete`. Runs AFTER `import_and_project`'s projection tx
    // committed, so the `parent_id`/`block_type` chain it walks reflects the
    // ops just applied.
    let changed_page_ids = resolve_changed_page_ids(pool, &changed_blocks).await?;

    // #421: hand the changed-block set to the caller so it can drive a
    // targeted FTS reindex (per-block `UpdateFtsBlock`) instead of a full
    // O(vault) rebuild. The set is moved out here (last use).
    Ok(ApplyOutcome::Imported {
        space_id,
        changed_blocks,
        purged_blocks,
        changed_page_ids,
    })
}

/// #1071: resolve the deduped set of owning *page* ids (page-root block ids)
/// for `changed_blocks`, walking the committed `parent_id` chain in SQL.
///
/// A page block resolves to itself (`page_id = id` invariant, migration
/// 0073). The recursive CTE mirrors [`crate::cache::page_id`]'s ancestor walk
/// (Invariant #9 `depth < 100` runaway guard) but is scoped to just the
/// changed-block id set instead of the whole vault — bounded by the number of
/// blocks one inbound sync message actually touched.
///
/// Blocks with no resolvable page ancestor (orphans, or cross-doc ordering
/// where the page block has not yet arrived) contribute no id; the result may
/// therefore be empty even when `changed_blocks` is not. The frontend treats
/// an empty set as "fall back to a full reload", so a missed resolution
/// degrades to the old behaviour rather than dropping an update.
async fn resolve_changed_page_ids(
    pool: &SqlitePool,
    changed_blocks: &[crate::ulid::BlockId],
) -> Result<Vec<String>, AppError> {
    if changed_blocks.is_empty() {
        return Ok(Vec::new());
    }

    // Bind the changed ids as an IN-list (bounded by message size, well under
    // MAX_SQL_PARAMS in practice; chunk defensively to stay within the SQLite
    // variable limit for an unusually large single-message import).
    let mut page_ids: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for chunk in changed_blocks.chunks(crate::db::MAX_SQL_PARAMS) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        // Walk each seed block up its parent chain until a `page` row is hit
        // (or depth/orphan cuts it off). `WHERE a.cur_type != 'page'` stops
        // the recursion as soon as the page root is reached, so a page block
        // seeded directly resolves to itself at depth 0.
        let sql = format!(
            "WITH RECURSIVE ancestors(seed_id, cur_id, cur_type, depth) AS ( \
                 SELECT b.id, b.id, b.block_type, 0 FROM blocks b \
                 WHERE b.id IN ({placeholders}) \
                 UNION ALL \
                 SELECT a.seed_id, parent.id, parent.block_type, a.depth + 1 \
                 FROM ancestors a \
                 JOIN blocks child ON child.id = a.cur_id \
                 JOIN blocks parent ON parent.id = child.parent_id \
                 WHERE a.cur_type != 'page' \
                   AND a.depth < 100 \
             ) \
             SELECT DISTINCT cur_id FROM ancestors WHERE cur_type = 'page'",
        );
        // dynamic-sql: recursive ancestor CTE with a runtime-built IN-list
        // placeholder set (chunked over the changed-block ids); not expressible
        // as a compile-checked `query_scalar!` because the placeholder count
        // varies per chunk. #646.
        let mut q = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.as_str()));
        for id in chunk {
            q = q.bind(id.as_str());
        }
        let rows = q.fetch_all(pool).await?;
        for id in rows {
            if seen.insert(id.clone()) {
                page_ids.push(id);
            }
        }
    }
    Ok(page_ids)
}

/// How the payload handed to [`import_and_project`] reached us — decides
/// whether a complete no-op import diff may be trusted as "SQL is already
/// consistent" (#2264 review; see the fn's "no-op short-circuit" docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InboundDeliveryKind {
    /// A live sync-session delivery ([`apply_remote`]): the inbox slot was
    /// inserted moments ago by us, so a no-op diff is trusted unless some
    /// OTHER leftover slot for the space marks a prior failed projection.
    Live,
    /// A #535 boot-recovery replay of a surviving inbox slot
    /// ([`replay_inbox_row`]): the slot's survival proves its projection
    /// never committed — a no-op diff is NEVER trusted.
    RecoveryReplay,
}

/// Import `bytes` into the per-space engine and project every changed
/// block into the SQL `blocks` table (+ properties / tags / deleted_at),
/// clearing the write-ahead inbox slot `inbox_id` atomically with the
/// projection.
///
/// #535: this is the shared import+project core called by both
/// [`apply_remote`] (after it has durably written the inbox slot) and
/// boot recovery ([`crate::recovery::replay_sync_inbox`], via
/// [`replay_inbox_row`]). The Phase-2 tx's `DELETE FROM loro_sync_inbox
/// WHERE id = ?` makes "slot cleared" and "SQL projected" a single atomic
/// fact — a crash either leaves the slot present (replay re-runs this) or
/// gone (projection committed).
///
/// Idempotency contract: re-running this with the SAME bytes is safe —
/// Loro import is idempotent and every SQL projection here is an upsert —
/// which is exactly what makes boot replay (and a double replay) safe.
///
/// Returns `(changed_blocks, purged_blocks)` — the live blocks the import
/// changed (projected in Passes A–C) and the blocks it hard-purged (Pass D).
/// #2264: both are surfaced so callers can tell a complete no-op import
/// apart from a purge-only one and skip downstream work accordingly.
///
/// ## #2264 — no-op short-circuit (and when it must NOT fire)
///
/// A redelivered / echoed payload that adds zero new ops (the engine's
/// oplog-frontier check, #2036) produces empty changed + purged sets and an
/// empty tag scope. An empty import diff proves the ENGINE already holds
/// every op in `bytes` — it does NOT prove SQL ever projected them. The two
/// facts diverge exactly when a prior delivery of these ops imported them
/// into the engine but died before its projection tx committed: that failure
/// always leaves ITS OWN write-ahead inbox slot behind (#535), and
/// `loro_doc_state` may meanwhile have been persisted ahead of SQL (the
/// periodic / exit `save_all_engines`). So the fast path — skip the whole
/// Phase-2 projection tx, clear the slot with a single autocommit DELETE
/// instead of a `BEGIN IMMEDIATE` writer-lock round-trip — is taken only
/// when the caller-supplied [`InboundDeliveryKind`] lets us rule that out:
///
/// * [`InboundDeliveryKind::Live`]: trusted iff NO OTHER inbox slot exists
///   for this space (ours was just inserted by [`apply_remote`]). A leftover
///   slot marks a prior failed projection whose ops this redelivery may
///   duplicate — SQL could be stale, so fall through to the full-projection
///   fallback, which heals it immediately.
/// * [`InboundDeliveryKind::RecoveryReplay`] (#535 boot path): NEVER trusted
///   — the slot being replayed is itself the evidence that the projection
///   for these bytes never committed (it is deleted only in-tx with a
///   committed projection).
///
/// The untrusted fallback reprojects the WHOLE live tree with a global
/// tag-inheritance rebuild — the pre-#2036 recovery behaviour (idempotent
/// upserts), returned as the changed set so the caller's FTS / cache fan-out
/// heals too. Known pre-existing gap (#2128, unchanged here): a purge whose
/// Pass D never committed is invisible to a redundant re-import (the engine
/// index already dropped the subtree, so the purged delta is empty); the
/// stale purged rows are NOT swept by this additive fallback.
pub(crate) async fn import_and_project(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
    space_id: &SpaceId,
    bytes: &[u8],
    inbox_id: i64,
    delivery: InboundDeliveryKind,
) -> Result<(Vec<crate::ulid::BlockId>, Vec<crate::ulid::BlockId>), AppError> {
    use crate::loro::projection::{
        project_block_full_to_sql, project_purge_blocks_to_sql,
        reproject_block_deleted_at_from_engine, reproject_block_properties_from_engine,
        reproject_block_tags_from_engine,
    };

    // Phase 1 — import bytes into the engine, capture changed AND purged
    // blocks. #2128: a remote `PurgeBlock` removes the seed + its whole
    // subtree from the engine index and so never appears in `changed_blocks`
    // (which enumerates only the live tree). The purged delta drives Pass D
    // below; without it the purged rows + descendants linger in SQL forever.
    // #2036: the engine resolves the import diff to the precise set of changed
    // (live) blocks, the purged set, and a `TagScope` describing how to refresh
    // the inherited-tag cache — falling back to a whole-tree enumeration +
    // global rebuild on any diff shape it cannot resolve.
    let (changed_blocks, purged_blocks, tag_scope): (
        Vec<crate::ulid::BlockId>,
        Vec<crate::ulid::BlockId>,
        crate::loro::engine::TagScope,
    ) = {
        // #2188: the CRDT import (decode + diff resolution) is CPU-bound and
        // runs while holding the process-global registry mutex.
        // `cpu_block_in_place` lets the multi-thread reactor drive other tasks
        // for the duration without releasing the lock (the guard is held across
        // the decode, so atomicity vs concurrent mutation is unchanged). The
        // `!Send` guard is fine inside the closure — it runs inline on this same
        // worker thread. See `cpu_block_in_place` for the current-thread-runtime
        // fallback.
        cpu_block_in_place(|| {
            let mut guard = registry.for_space(space_id, device_id)?;
            guard
                .engine_mut()
                .import_with_changed_purged_tagscope(bytes)
        })?
    };

    // #2264: complete no-op import diff (a redelivered / echoed payload that
    // added zero new ops — the engine's oplog-frontier short-circuit, #2036).
    // The empty diff proves the ENGINE already had everything in `bytes`; it
    // does NOT prove SQL projected it — see the "#2264 — no-op short-circuit"
    // section of the fn docs for the trust rule applied here. The trusted
    // fast path's only remaining obligation is clearing the write-ahead inbox
    // slot (#535) with a single autocommit DELETE (no `BEGIN IMMEDIATE`
    // writer lock); the DELETE is a no-op if the row is already gone,
    // preserving the double-replay safety of the tx-coupled path below.
    let noop_diff = changed_blocks.is_empty()
        && purged_blocks.is_empty()
        && matches!(&tag_scope, crate::loro::engine::TagScope::Subtrees(roots) if roots.is_empty());
    let (changed_blocks, tag_scope) = if noop_diff {
        let trusted = match delivery {
            // The replayed slot itself proves the projection never committed.
            InboundDeliveryKind::RecoveryReplay => false,
            // Trusted iff no OTHER slot (a prior delivery's failed
            // projection, whose ops this payload may duplicate) is pending
            // for this space. Runtime query (not `query!`): one-off
            // static-string probe on the rare no-op path.
            InboundDeliveryKind::Live => {
                // dynamic-sql: static-string COUNT probe guarding the no-op fast path
                // (#2264 review); runtime form to keep the rare path off the macro cache.
                let leftover: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM loro_sync_inbox WHERE space_id = ? AND id != ?",
                )
                .bind(space_id.as_str())
                .bind(inbox_id)
                .fetch_one(pool)
                .await?;
                leftover == 0
            }
        };
        if trusted {
            sqlx::query!("DELETE FROM loro_sync_inbox WHERE id = ?", inbox_id)
                .execute(pool)
                .await?;
            return Ok((changed_blocks, purged_blocks));
        }
        // Untrusted no-op: SQL may be behind the engine (the crash window
        // #535 exists to heal). Reproject the whole live tree + globally
        // rebuild tag inheritance — the pre-#2036 recovery behaviour. The
        // full set is returned as `changed_blocks` so the caller's FTS /
        // derived-cache fan-out heals as well. (Purged-rows gap: see fn
        // docs — pre-existing #2128 limitation, additive fallback only.)
        let full = {
            let mut guard = registry.for_space(space_id, device_id)?;
            guard.engine_mut().live_blocks_preorder()
        };
        (full, crate::loro::engine::TagScope::Global)
    } else {
        (changed_blocks, tag_scope)
    };

    // Phase 2 — project each changed block to SQL in a single tx.
    //
    // #540: snapshot EVERY changed block's engine state under ONE guard
    // acquisition, drop the guard, then do all SQL writes. The previous
    // shape re-acquired the `Mutex<LoroEngine>` once per block across three
    // passes (3N acquisitions for N blocks); this reads all four projections
    // per block under a single lock (1 acquisition total) into a local Vec,
    // so the SQL writes never contend with — or hold — the engine mutex.
    // Reads stay consistent (one atomic view of the engine); the three SQL
    // passes below still run A→B→C for the FK ordering documented on each.
    let block_states: Vec<_> = {
        let mut guard = registry.for_space(space_id, device_id)?;
        let engine = guard.engine_mut();
        // #1621: derive every block's `position` from a per-parent ordered-
        // children index built ONCE (read_blocks_bulk), not a per-block O(K)
        // `child_rank_position` sibling scan. For N changed blocks in a flat
        // space (K≈N) the old loop was O(N²); this is ~O(N). The projected
        // snapshot (incl. `position`) is byte-identical to `read_block`'s.
        let block_id_refs: Vec<&str> = changed_blocks
            .iter()
            .map(crate::ulid::BlockId::as_str)
            .collect();
        let snapshots = engine.read_blocks_bulk(&block_id_refs)?;
        let mut states = Vec::with_capacity(changed_blocks.len());
        for (block_id, snapshot) in changed_blocks.iter().zip(snapshots) {
            let props = engine.read_all_properties_typed(block_id.as_str())?;
            let tag_ids = engine.read_tags(block_id.as_str())?;
            let deleted_at = engine.read_deleted_at(block_id.as_str())?;
            states.push((snapshot, props, tag_ids, deleted_at));
        }
        states
    };

    let mut tx = crate::db::begin_immediate_logged(pool, "sync_apply_remote").await?;

    // Pass A — core columns + properties.  This upserts EVERY changed
    // block (including the tag blocks themselves), so all `blocks` rows
    // referenced by `block_tags.tag_id` (FK to `blocks(id)`) exist before
    // Pass B's tag-edge inserts.
    //
    // Load property_definitions ONCE for the whole pass (hoisted out of
    // the per-block loop to avoid an N+1 SELECT against a static table).
    // #2264: skipped when the import changed no live block (purge-only
    // imports reach this tx solely for Pass D + the inbox DELETE).
    let value_types: std::collections::HashMap<String, String> = if changed_blocks.is_empty() {
        std::collections::HashMap::new()
    } else {
        sqlx::query!("SELECT key, value_type FROM property_definitions")
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|r| (r.key, r.value_type))
            .collect()
    };
    for (block_id, (snapshot_opt, props, _, _)) in changed_blocks.iter().zip(&block_states) {
        project_block_full_to_sql(&mut tx, space_id, block_id, snapshot_opt.as_ref()).await?;
        // Re-project the block's properties: mirrors remote
        // SetProperty / DeleteProperty changes into `block_properties`.
        reproject_block_properties_from_engine(&mut tx, block_id, props, &value_types).await?;
    }

    // Pass B — tags. Mirrors remote AddTag / RemoveTag
    // changes into `block_tags`.  Runs AFTER Pass A so every referenced
    // tag block already has its `blocks` row (FK ordering, see above).
    // Read the tag list under the guard, then write in the tx — same
    // read-under-guard-then-write-in-tx discipline as the property pass.
    for (block_id, (_, _, tag_ids, _)) in changed_blocks.iter().zip(&block_states) {
        reproject_block_tags_from_engine(&mut tx, block_id, tag_ids).await?;
    }

    // Pass C — soft-delete state (Phase 2). Mirrors remote
    // DeleteBlock / RestoreBlock changes into `blocks.deleted_at`.  Runs
    // AFTER Pass A so every changed block's `parent_id` row exists — the
    // helper's descendant-cascade / ancestor-guard CTE walks depend on
    // it.  The engine stores `deleted_at` on the delete seed only, so the
    // helper re-derives the SQL cascade from the seed timestamp (and an
    // ancestor check prevents a snapshot re-import from resurrecting a
    // soft-deleted subtree).
    for (block_id, (_, _, _, engine_deleted_at)) in changed_blocks.iter().zip(&block_states) {
        reproject_block_deleted_at_from_engine(&mut tx, block_id, engine_deleted_at.as_deref())
            .await?;
    }

    // Pass D — hard-purge (#2128). Mirrors a remote `PurgeBlock` by deleting
    // the purged seed + every descendant from ALL derived tables (the same
    // table set as the local SQL cascade). Runs LAST and in the SAME tx so it
    // removes any rows the earlier passes may have upserted for a block that is
    // net-purged in this import: Pass A's `project_block_full_to_sql(None)`
    // already skips a purged id (the engine returns no live snapshot for it),
    // but a block that was changed earlier in the same import and then purged
    // could still have a stale row — Pass D guarantees it is gone. The engine
    // handed us the COMPLETE purged set, so no descendant CTE is needed.
    // Atomic with the rest of the projection: a rollback leaves SQL untouched.
    if !purged_blocks.is_empty() {
        let purged_refs: Vec<&str> = purged_blocks
            .iter()
            .map(crate::ulid::BlockId::as_str)
            .collect();
        project_purge_blocks_to_sql(&mut tx, &purged_refs).await?;
    }

    // #535: clear the write-ahead inbox slot in the SAME tx as the SQL
    // projection. This is the atomicity hinge — the slot disappears IFF the
    // projection commits. On replay, the slot is either still present (this
    // re-runs) or already gone (projection committed). The DELETE is a no-op
    // if the row was already removed (e.g. a concurrent replay), which keeps
    // double-replay safe.
    sqlx::query!("DELETE FROM loro_sync_inbox WHERE id = ?", inbox_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // Refresh the derived `block_tag_inherited` cache. `block_tags` only carries
    // direct edges; inherited tags are a recursive-CTE projection over
    // `(block_tags, blocks.parent_id)`, so a remote tag change shifts inherited
    // rows for the changed block's whole subtree, and a structural move/create
    // re-inherits the moved subtree's new ancestor chain.
    //
    // #2036 stage 3: scope the recompute to the affected subtrees (the engine
    // deduped them to top-most roots). Falls back to the global rebuild when the
    // import could not be resolved incrementally. Purged blocks' inherited rows
    // were already removed by Pass D. Runs after the projection tx commits (the
    // subtree CTE reads the just-projected `blocks.parent_id`), mirroring the
    // previous global rebuild's placement.
    match tag_scope {
        crate::loro::engine::TagScope::Global => {
            crate::tag_inheritance::rebuild_all(pool).await?;
        }
        crate::loro::engine::TagScope::Subtrees(roots) => {
            if !roots.is_empty() {
                let mut tag_tx =
                    crate::db::begin_immediate_logged(pool, "tag_inheritance_subtrees").await?;
                for root in &roots {
                    crate::tag_inheritance::recompute_subtree_inheritance(
                        &mut tag_tx,
                        root.as_str(),
                    )
                    .await?;
                }
                tag_tx.commit().await?;
            }
        }
    }

    Ok((changed_blocks, purged_blocks))
}

/// Boot-recovery entry point: re-run [`import_and_project`] for a single
/// leftover write-ahead inbox row `(space_id, bytes, inbox_id)`.
///
/// #535: thin `pub(crate)` wrapper so the recovery module doesn't need to
/// reconstruct a [`SpaceId`] or know the projection internals. Returns the
/// changed-block set (discarded by the caller — boot recovery does its own
/// FTS reconciliation). On success the inbox row is deleted (in-tx, by
/// `import_and_project`); on error the row is left in place so a later boot
/// can retry.
///
/// #792 / #1054: before the import, two guards mirror `apply_remote`'s
/// pre-import gates and DROP the slot (their own small DELETE) rather than
/// Import it: the own-peer fork guard (#792) and the `from_vv`
/// reachability gate (#1054). Both routes leave the next live sync session to
/// re-detect the condition in `apply_remote` and fall back to snapshot
/// catch-up — preventing a permanent poison row that would re-error at every
/// boot.
pub(crate) async fn replay_inbox_row(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
    space_id: &str,
    bytes: &[u8],
    inbox_id: i64,
) -> Result<Vec<crate::ulid::BlockId>, AppError> {
    let space = SpaceId::from_trusted(space_id);

    // #792: mirror `apply_remote`'s own-peer fork guard. `apply_remote`
    // refuses to even write a forked blob into the inbox, but a slot
    // persisted by a pre-#792 build (or a blob that only became forked
    // relative to the engine after a crazy crash interleave) would
    // otherwise be imported at every boot — corrupting loro-internal's
    // causal state (debug panic → SIGABRT → boot crash loop). Replaying
    // it can never succeed, so drop the slot (its own tiny commit, like
    // the in-tx DELETE on the success path) and skip: the next sync
    // session re-detects the fork in `apply_remote` and routes into the
    // snapshot catch-up that heals it.
    let fork = {
        let mut guard = registry.for_space(&space, device_id)?;
        guard.engine_mut().own_peer_fork_in_blob(bytes)
    };
    if let Some(reason) = fork {
        tracing::warn!(
            space_id,
            inbox_id,
            reason = %reason,
            "loro_sync: boot-replay inbox slot forks our own (peer,counter) \
             space (#792); dropping the slot — the next sync session will \
             fall back to snapshot catch-up"
        );
        sqlx::query!("DELETE FROM loro_sync_inbox WHERE id = ?", inbox_id)
            .execute(pool)
            .await?;
        return Ok(Vec::new());
    }

    // #1054: mirror `apply_remote`'s live reachability gate.
    // `apply_remote` refuses to import an `Update` whose declared `from_vv`
    // is unreachable from our `oplog_vv()` — returning `SnapshotFallbackRequested`
    // BEFORE any side-effect — because such an update would otherwise surface
    // as an OPAQUE Loro decode error from `import_with_changed_blocks`. The
    // boot-replay path here imported unconditionally, so a slot whose causal
    // base out-runs the rehydrated-then-op-log-replayed engine (the engine can
    // be BEHIND the surviving Update's base: `loro_doc_state` is persisted only
    // periodically and op-log replay never reconstructs remote Loro-only ops)
    // re-errored on EVERY boot — a permanent poison row.
    //
    // The inbox row stores only `(space_id, bytes)` — no `from_vv` — so we
    // recover the base from the blob itself (`partial_start_vv`) and run the
    // same reachability rule. Snapshot-shaped blobs are self-contained and
    // stay safe to import unconditionally (only Update-shaped blobs are gated,
    // exactly as in the live gate). On a miss, drop the slot via its own small
    // DELETE — mirroring the #792 fork branch above — and skip: the next live
    // sync session re-detects the gap in `apply_remote` and routes into the
    // snapshot catch-up that reconciles it. This trades a never-reconciled
    // poison slot for a clean, self-healing gap.
    let unreachable = {
        let mut guard = registry.for_space(&space, device_id)?;
        guard.engine_mut().unreachable_update_in_blob(bytes)
    };
    if let Some(reason) = unreachable {
        tracing::warn!(
            space_id,
            inbox_id,
            reason = %reason,
            "loro_sync: boot-replay inbox slot's update base is unreachable from \
             the local engine (#1054); dropping the slot — the next sync session \
             will detect the gap and fall back to snapshot catch-up"
        );
        sqlx::query!("DELETE FROM loro_sync_inbox WHERE id = ?", inbox_id)
            .execute(pool)
            .await?;
        return Ok(Vec::new());
    }

    // Boot recovery consumes only the changed set (its FTS reconciliation
    // is its own pass); the purged delta is projected in-tx by Pass D.
    // `RecoveryReplay` disables the #2264 no-op fast path: this slot's
    // survival proves its projection never committed, even if the engine
    // (rehydrated from a `loro_doc_state` persisted ahead of the crash)
    // already holds every op in `bytes` — the full-projection fallback
    // reconciles SQL instead of silently dropping the slot.
    import_and_project(
        pool,
        registry,
        device_id,
        &space,
        bytes,
        inbox_id,
        InboundDeliveryKind::RecoveryReplay,
    )
    .await
    .map(|(changed, _purged)| changed)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::loro::engine::LoroEngine;
    use crate::loro::registry::LoroEngineRegistry;
    use crate::space::SpaceId;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const SPACE_A: &str = "01HZ00000000000000000000SP";
    const BLOCK_A: &str = "01HZ00000000000000000000A1";
    const BLOCK_B: &str = "01HZ00000000000000000000B2";
    const BLOCK_C: &str = "01HZ00000000000000000000C3";
    const BLOCK_D: &str = "01HZ00000000000000000000D4";
    const BLOCK_E: &str = "01HZ00000000000000000000E5";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("loro_sync_test.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    /// `prepare_outgoing(None)` → Snapshot variant carrying the full
    /// engine state.  Initial-sync invariant.
    #[tokio::test]
    async fn prepare_outgoing_with_no_peer_vv_returns_snapshot() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        // Seed the engine with one block so the snapshot has a payload.
        {
            let mut g = registry.for_space(&space, "device-S").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "hello", None, 0)
                .expect("create");
        }

        let msg = prepare_outgoing_for_pool(&pool, &registry, &space, "device-S", None)
            .await
            .expect("prepare_outgoing")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        match msg {
            LoroSyncMessage::Snapshot {
                protocol_version,
                space_id,
                bytes,
            } => {
                assert_eq!(protocol_version, LORO_SYNC_PROTOCOL_VERSION);
                assert_eq!(space_id, space);
                assert!(!bytes.is_empty(), "snapshot bytes must be non-empty");
            }
            other => panic!("expected Snapshot, got {other:?}"),
        }
    }

    /// `prepare_outgoing(Some(vv))` → Update variant carrying only the
    /// post-vv ops.  Mirrors the engine's `export_update_since`
    /// invariant: receiver re-creates the post-vv blocks but not the
    /// pre-vv ones (it has those already).
    #[tokio::test]
    async fn prepare_outgoing_with_peer_vv_returns_update() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        // Apply 3 ops, capture vv, apply 2 more.
        let vv_after_first_batch = {
            let mut g = registry.for_space(&space, "device-S").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "first", None, 0)
                .expect("create A");
            e.apply_create_block(BLOCK_B, "content", "second", None, 1)
                .expect("create B");
            e.apply_create_block(BLOCK_C, "content", "third", None, 2)
                .expect("create C");
            let vv = e.version_vector();
            e.apply_create_block(BLOCK_D, "content", "fourth", None, 3)
                .expect("create D");
            e.apply_create_block(BLOCK_E, "content", "fifth", None, 4)
                .expect("create E");
            vv
        };

        let msg = prepare_outgoing_for_pool(
            &pool,
            &registry,
            &space,
            "device-S",
            Some(&vv_after_first_batch),
        )
        .await
        .expect("prepare_outgoing")
        .expect("#1257 freshness gate must not refuse a consistent engine");

        let (from_vv, delta_bytes) = match msg {
            LoroSyncMessage::Update {
                protocol_version,
                space_id,
                from_vv,
                bytes,
            } => {
                assert_eq!(protocol_version, LORO_SYNC_PROTOCOL_VERSION);
                assert_eq!(space_id, space);
                assert!(!bytes.is_empty(), "update bytes must be non-empty");
                (from_vv, bytes)
            }
            other => panic!("expected Update, got {other:?}"),
        };
        assert_eq!(
            from_vv, vv_after_first_batch,
            "Update.from_vv must echo the peer-vv passed by the caller"
        );

        // Verify the delta carries D and E but NOT A/B/C: import into
        // a receiver that already has A/B/C.
        let mut receiver = LoroEngine::with_peer_id("device-S").expect("rcv");
        receiver
            .apply_create_block(BLOCK_A, "content", "first", None, 0)
            .expect("rcv create A");
        receiver
            .apply_create_block(BLOCK_B, "content", "second", None, 1)
            .expect("rcv create B");
        receiver
            .apply_create_block(BLOCK_C, "content", "third", None, 2)
            .expect("rcv create C");
        assert!(receiver.read_block(BLOCK_D).unwrap().is_none());
        assert!(receiver.read_block(BLOCK_E).unwrap().is_none());

        receiver.import(&delta_bytes).expect("import delta");
        assert!(receiver.read_block(BLOCK_D).unwrap().is_some());
        assert!(receiver.read_block(BLOCK_E).unwrap().is_some());
    }

    /// Apply A's snapshot to a fresh B; assert B's engine sees the
    /// blocks A had.  Engine-level convergence after a Snapshot
    /// import.
    #[tokio::test]
    async fn apply_remote_imports_snapshot_into_engine() {
        let (pool, _dir) = fresh_pool().await;

        // Build A and produce a Snapshot message.
        let registry_a = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create");
        }
        let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        // Apply on B (fresh registry).
        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        match outcome {
            ApplyOutcome::Imported {
                space_id: returned, ..
            } => assert_eq!(returned, space),
            ApplyOutcome::SnapshotFallbackRequested { reason, .. } => {
                panic!("expected Imported, got SnapshotFallbackRequested: {reason}")
            }
        }

        // B's engine now sees BLOCK_A.
        let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
        let snap = g
            .engine_mut()
            .read_block(BLOCK_A)
            .expect("read")
            .expect("BLOCK_A must be present after import");
        assert_eq!(snap.content, "from-A");
    }

    /// #2188 — the `block_in_place` wrap around the CPU-bound CRDT
    /// export (`prepare_outgoing`) and import (`apply_remote`) must:
    ///   1. NOT panic on a genuine multi-thread tokio runtime, and
    ///   2. preserve behaviour — the exported bytes import into an
    ///      equivalent doc (full-snapshot AND incremental-update round
    ///      trips), converging both the engine and SQL projection.
    ///
    /// `block_in_place` PANICS on a current-thread runtime; production
    /// sync always runs on tauri's multi-thread async runtime / the
    /// daemon's `tokio::spawn`, so this test pins the multi-thread flavor
    /// to exercise the real path. A regression that ran these calls on a
    /// current-thread runtime would panic here.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_import_round_trips_through_block_in_place_2188() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Sender A: seed three blocks, capture vv, then add two more so
        // we can exercise BOTH the snapshot and the incremental-update
        // export paths (each wrapped in `block_in_place`).
        let registry_a = LoroEngineRegistry::new();
        let vv_after_first_batch = {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "first", None, 0)
                .expect("create A");
            e.apply_create_block(BLOCK_B, "content", "second", None, 1)
                .expect("create B");
            e.apply_create_block(BLOCK_C, "content", "third", None, 2)
                .expect("create C");
            let vv = e.version_vector();
            e.apply_create_block(BLOCK_D, "content", "fourth", None, 3)
                .expect("create D");
            e.apply_create_block(BLOCK_E, "content", "fifth", None, 4)
                .expect("create E");
            vv
        };

        // --- Full snapshot export (block_in_place) → apply on fresh B ---
        let snapshot_msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare snapshot")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", snapshot_msg)
            .await
            .expect("apply snapshot");
        assert!(
            matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
            "snapshot apply must report Imported, got {outcome:?}"
        );

        // B's engine converged to A's full state via the block_in_place import.
        {
            let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
            let e = g.engine_mut();
            for id in [BLOCK_A, BLOCK_B, BLOCK_C, BLOCK_D, BLOCK_E] {
                assert!(
                    e.read_block(id).expect("read").is_some(),
                    "block {id} must be present in B after snapshot import"
                );
            }
        }
        assert_eq!(
            registry_b.loro_vv(&space).expect("b vv"),
            registry_a.loro_vv(&space).expect("a vv"),
            "B's version vector must match A's after snapshot round-trip"
        );

        // --- Incremental update export (block_in_place) → apply on B ---
        // B now shares A's exact causal lineage (it imported A's snapshot),
        // so an incremental update A produces after adding MORE ops imports
        // cleanly (no `(peer,counter)` fork). This exercises the
        // `export_update_since` + `import_with_changed_purged_tagscope`
        // block_in_place paths on a genuinely reachable delta.
        let _ = vv_after_first_batch; // captured above for documentation only
        let vv_before_delta = registry_b.loro_vv(&space).expect("b vv pre-delta");
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_create_block("01HZ00000000000000000000F6", "content", "sixth", None, 5)
                .expect("create F");
        }

        let update_msg = prepare_outgoing_for_pool(
            &pool,
            &registry_a,
            &space,
            "device-A",
            Some(&vv_before_delta),
        )
        .await
        .expect("prepare update")
        .expect("#1257 freshness gate must not refuse a consistent engine");

        let outcome = apply_remote(&pool, &registry_b, "device-B", update_msg)
            .await
            .expect("apply update");
        assert!(
            matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
            "incremental update apply must report Imported, got {outcome:?}"
        );

        // The delta carried the new block; B now holds it.
        {
            let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
            assert!(
                g.engine_mut()
                    .read_block("01HZ00000000000000000000F6")
                    .expect("read F")
                    .is_some(),
                "delta must have added the sixth block"
            );
        }
        assert_eq!(
            registry_b.loro_vv(&space).expect("b vv post-delta"),
            registry_a.loro_vv(&space).expect("a vv"),
            "B must converge to A's vv after the incremental round-trip"
        );
    }

    /// `apply_remote` writes the projected `blocks` row to SQL.
    /// SQL-level convergence end-to-end through the helper.
    #[tokio::test]
    async fn apply_remote_projects_changed_blocks_to_sql() {
        let (pool, _dir) = fresh_pool().await;

        // Build A and produce a Snapshot message.
        let registry_a = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "from-A", None, 7)
                .expect("create");
        }
        let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        // Apply on B (fresh registry, fresh DB).
        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        assert!(
            matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
            "snapshot apply must report Imported, got {outcome:?}"
        );

        // SQL now has the projected `blocks` row.
        let row: (String, String, String, Option<String>, i64) = sqlx::query_as(
            "SELECT id, block_type, content, parent_id, position FROM blocks WHERE id = ?",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch row");
        assert_eq!(row.0, BLOCK_A);
        assert_eq!(row.1, "content");
        assert_eq!(row.2, "from-A");
        assert_eq!(row.3, None);
        // #400: the engine maps the legacy sparse position 7 to a sibling slot
        // and the materializer reprojects the authoritative DENSE 1-based rank.
        // BLOCK_A is the sole root child, so its rank is 1.
        assert_eq!(row.4, 1);
    }

    /// Regression (end-to-end): an inbound sync that
    /// re-projects an already-materialised block must NOT cascade-wipe
    /// that block's tags / properties. The bug was `INSERT OR REPLACE`,
    /// which deletes the `blocks` row first so the `ON DELETE CASCADE`
    /// FKs delete `block_tags` / `block_properties`; the fix is an
    /// upsert that updates only the core columns.
    #[tokio::test]
    async fn apply_remote_does_not_wipe_existing_block_derived_state() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Pre-seed B's SQL with the state a prior sync had materialised:
        // block X plus a tag-block, a tag edge, and a property row.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'old', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        // Pre-seed a page block so BLOCK_A can carry a `page_id` — the
        // genuine F1 cascade witness. `page_id` is rebuilt by NO inbound
        // re-projection (not by the core upsert, the property pass, or the
        // Phase-2 deleted_at pass) and is in the `ON DELETE CASCADE`
        // set, so it survives a correct UPSERT but a REPLACE regression
        // (delete + re-insert the row) resets it to NULL.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'page', 'pg', NULL, 0)",
        )
        .bind(BLOCK_C)
        .execute(&pool)
        .await
        .unwrap();
        // `deleted_at` is now re-projected by the Phase-2 pass
        // (Pass C): A's engine carries BLOCK_A alive, so the pre-seeded
        // soft-delete must be cleared on inbound sync (the converged engine
        // state wins). Asserted below.
        //
        // `todo_state` is a reserved hot-path column the
        // reserved-key pass re-projects under authoritative-replace: A's
        // engine carries none for BLOCK_A, so the stale SQL-only value must
        // be NULLed (same authoritative-replace semantics as the `sql_only`
        // block_properties sweep below).
        sqlx::query(
            "UPDATE blocks SET deleted_at = 1777593600000, todo_state = 'DOING', \
             page_id = ? \
             WHERE id = ?",
        )
        .bind(BLOCK_C)
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'tag-X', NULL, 0)",
        )
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'effort', '3')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        // A second, SQL-only property that A's engine will NOT carry — under
        // the new authoritative-replace semantics it must be swept by the
        // inbound re-projection (proves the behavior isn't just "re-affirm").
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES (?, 'sql_only', 'should-be-swept')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(BLOCK_A)
            .bind(BLOCK_B)
            .execute(&pool)
            .await
            .unwrap();

        // A edits X's content and sends a snapshot.  A's engine carries
        // the same `effort` property AND the same tag edge B already
        // materialised (both derived from the same CRDT) — so the inbound
        // Property/tag re-projections (re-affirm
        // those rows rather than sweeping them.  The point of this test is
        // that the *core* upsert does not cascade-wipe the block's derived
        // tags/properties.
        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "edited-by-A", None, 0)
                .expect("create");
            e.apply_create_block(BLOCK_B, "tag", "tag-X", None, 0)
                .expect("create tag block");
            e.apply_set_property(BLOCK_A, "effort", Some("3"))
                .expect("set effort");
            e.apply_add_tag(BLOCK_A, BLOCK_B).expect("add tag");
        }
        // #1257: `pool` here is the RECEIVER B's SQL (pre-seeded with a
        // soft-deleted BLOCK_A to exercise the inbound clear). The sender A
        // has no SQL of its own, so gate A's export against a fresh empty A
        // pool — otherwise the freshness gate would (correctly) see B's
        // soft-deleted-but-engine-live divergence and refuse.
        let (pool_a, _dir_a) = fresh_pool().await;
        let msg = prepare_outgoing_for_pool(&pool_a, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        // B applies the inbound snapshot.
        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        assert!(
            matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
            "snapshot apply must report Imported, got {outcome:?}"
        );

        // Content updated from the inbound edit.
        let content: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch content");
        assert_eq!(
            content.0, "edited-by-A",
            "content must update from the inbound edit"
        );

        // The genuine, un-masked F1 guard: `page_id` is rebuilt by NO
        // re-projection, so it must survive the core upsert. A REPLACE
        // regression would delete + re-insert the row, resetting it to NULL.
        //
        // `deleted_at`, by contrast, is now re-projected by the
        // Phase-2 pass (Pass C): A's engine carries BLOCK_A alive, so the
        // pre-seeded soft-delete must be cleared (the converged engine state
        // wins on inbound sync).
        //
        // `todo_state` is a reserved hot-path column the
        // reserved-key pass re-projects under authoritative-replace: A's
        // engine carries none for BLOCK_A, so the stale SQL-only value must be
        // NULLed (same authoritative-replace semantics as the `sql_only`
        // block_properties sweep below).
        let projected: (Option<String>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT page_id, deleted_at, todo_state FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch projected columns");
        assert_eq!(
            projected,
            (Some(BLOCK_C.to_string()), None, None),
            "page_id must survive the inbound core upsert (F1); the pre-seeded \
             deleted_at is cleared by the Phase-2 deleted_at re-projection \
             (engine alive); the stale SQL-only todo_state is swept by the \
             reserved-key re-projection"
        );

        // block_tags is re-affirmed by the tag re-projection (the engine
        // carries this edge). NOTE: this no longer isolates the cascade-wipe
        // on its own — re-projection would re-insert it even after a REPLACE
        // cascade — which is why the `page_id` assertion above is the real F1
        // guard. This still verifies the tag re-projection path.
        let tag_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch tag count");
        assert_eq!(
            tag_count.0, 1,
            "block_tags must survive the inbound sync (F1)"
        );

        // Engine-backed property is re-affirmed; the SQL-only property
        // (absent from A's engine) is swept by the authoritative replace.
        let prop_keys: Vec<(String,)> =
            sqlx::query_as("SELECT key FROM block_properties WHERE block_id = ? ORDER BY key")
                .bind(BLOCK_A)
                .fetch_all(&pool)
                .await
                .expect("fetch prop keys");
        let keys: Vec<String> = prop_keys.into_iter().map(|r| r.0).collect();
        assert_eq!(
            keys,
            vec!["effort".to_string()],
            "engine-backed `effort` survives; SQL-only `sql_only` is swept by re-projection"
        );
    }

    /// #1071 happy path: `apply_remote` resolves the owning *page* id of every
    /// changed block and surfaces a DEDUPED set on `ApplyOutcome::Imported`.
    /// A page block and two of its content children, all touched by one
    /// inbound snapshot, must collapse to the single page-root id (the page
    /// resolves to itself; the children resolve up the `parent_id` chain).
    #[tokio::test]
    async fn apply_remote_imported_carries_deduped_changed_page_ids() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        // No `spaces` row needed: `project_block_full_to_sql` stamps
        // `blocks.space_id` via a `(SELECT id FROM spaces WHERE id = ?)`
        // subquery that resolves to NULL when the space block isn't
        // registered, and the #1071 page-id resolution walks `parent_id`
        // independent of `space_id`.

        // A builds a page (BLOCK_C) with two content children (A1, D4) and
        // syncs a full snapshot to B.
        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_C, "page", "the page", None, 0)
                .expect("create page");
            e.apply_create_block(BLOCK_A, "content", "child one", Some(BLOCK_C), 0)
                .expect("create child A1");
            e.apply_create_block(BLOCK_D, "content", "child two", Some(BLOCK_C), 1)
                .expect("create child D4");
        }
        let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");

        let page_ids = match outcome {
            ApplyOutcome::Imported {
                changed_page_ids, ..
            } => changed_page_ids,
            other => panic!("expected Imported, got {other:?}"),
        };
        assert_eq!(
            page_ids,
            vec![BLOCK_C.to_string()],
            "the page and both its children must resolve to the single page-root id (deduped)"
        );
    }

    /// #1071 empty case: when an import changes no blocks, the resolved
    /// page-id set is empty — the frontend then falls back to a full reload
    /// rather than skipping a phantom update. Exercised directly through the
    /// resolution helper (no changed blocks → empty), which is the exact
    /// degenerate path `apply_remote` hits for a no-op import.
    #[tokio::test]
    async fn resolve_changed_page_ids_empty_when_no_blocks_changed() {
        let (pool, _dir) = fresh_pool().await;
        let page_ids = resolve_changed_page_ids(&pool, &[]).await.expect("resolve");
        assert!(
            page_ids.is_empty(),
            "no changed blocks must yield no page ids, got {page_ids:?}"
        );
    }

    /// #1071: an orphan changed block (no page ancestor in the `parent_id`
    /// chain) contributes no page id — the resolution degrades to empty
    /// rather than inventing a root, so the frontend falls back to a full
    /// reload (the in-doubt-reload-everything contract).
    #[tokio::test]
    async fn resolve_changed_page_ids_skips_orphan_without_page_ancestor() {
        let (pool, _dir) = fresh_pool().await;
        // A content block whose parent chain never reaches a `page` row.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'orphan', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        let page_ids = resolve_changed_page_ids(&pool, &[crate::ulid::BlockId::from(BLOCK_A)])
            .await
            .expect("resolve");
        assert!(
            page_ids.is_empty(),
            "an orphan block resolves to no page id, got {page_ids:?}"
        );
    }

    /// Phase 2: a remote `DeleteBlock` of a subtree seed
    /// propagates the soft-delete to SQL for the seed AND its
    /// descendants — even though the engine marks only the seed.
    /// `apply_remote`'s deleted_at pass re-derives the SQL descendant
    /// cascade from the seed timestamp.
    #[tokio::test]
    async fn apply_remote_cascades_remote_subtree_delete_to_sql() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // A builds a 3-level subtree and soft-deletes the seed (the page)
        // with a real timestamp. The engine marks ONLY the seed.
        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "page", "pg", None, 0)
                .expect("page");
            e.apply_create_block(BLOCK_B, "content", "c1", Some(BLOCK_A), 0)
                .expect("c1");
            e.apply_create_block(BLOCK_C, "content", "c2", Some(BLOCK_B), 0)
                .expect("c2");
            e.apply_delete_block(BLOCK_A, "1779703200000")
                .expect("delete seed");
        }
        let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        let registry_b = LoroEngineRegistry::new();
        apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");

        // Seed + both descendants are soft-deleted at the seed's timestamp.
        for id in [BLOCK_A, BLOCK_B, BLOCK_C] {
            let deleted_at: Option<i64> =
                sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .expect("fetch deleted_at");
            assert_eq!(
                deleted_at,
                Some(1_779_703_200_000),
                "block {id} must be soft-deleted at the seed's cohort timestamp"
            );
        }
    }

    /// Phase 2: a remote `RestoreBlock` of a subtree seed clears
    /// the soft-delete in SQL for the whole cohort.
    #[tokio::test]
    async fn apply_remote_propagates_remote_subtree_restore_to_sql() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // B has already materialised the subtree as soft-deleted at T (a
        // prior sync delivered the delete cascade).
        for (id, parent) in [
            (BLOCK_A, None),
            (BLOCK_B, Some(BLOCK_A)),
            (BLOCK_C, Some(BLOCK_B)),
        ] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
                 VALUES (?, 'content', '', ?, 0, 1779703200000)",
            )
            .bind(id)
            .bind(parent)
            .execute(&pool)
            .await
            .unwrap();
        }

        // A carries the same subtree ALIVE (it restored the seed); the
        // engine marks the seed alive.
        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "", None, 0)
                .expect("a");
            e.apply_create_block(BLOCK_B, "content", "", Some(BLOCK_A), 0)
                .expect("b");
            e.apply_create_block(BLOCK_C, "content", "", Some(BLOCK_B), 0)
                .expect("c");
        }
        // #1257: `pool` is the RECEIVER B's SQL (pre-seeded soft-deleted). A's
        // engine carries the subtree alive, so gate A's export against a fresh
        // empty A pool — passing B's stale pool would (correctly) trip the
        // freshness gate.
        let (pool_a, _dir_a) = fresh_pool().await;
        let msg = prepare_outgoing_for_pool(&pool_a, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        let registry_b = LoroEngineRegistry::new();
        apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");

        for id in [BLOCK_A, BLOCK_B, BLOCK_C] {
            let deleted_at: Option<i64> =
                sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .expect("fetch deleted_at");
            assert_eq!(
                deleted_at, None,
                "block {id} must be restored (deleted_at cleared) by the inbound restore"
            );
        }
    }

    /// Phase 2 centerpiece: re-importing a snapshot whose seed is
    /// soft-deleted must NOT resurrect the already-soft-deleted
    /// descendants. The engine marks only the seed, so a naive per-block
    /// re-projection would read each descendant's `deleted_at` as `None`
    /// and clear it; the ancestor guard in the deleted_at pass keeps a
    /// descendant of a still-deleted ancestor soft-deleted.
    #[tokio::test]
    async fn apply_remote_reimport_does_not_resurrect_soft_deleted_subtree() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "page", "pg", None, 0)
                .expect("page");
            e.apply_create_block(BLOCK_B, "content", "c1", Some(BLOCK_A), 0)
                .expect("c1");
            e.apply_create_block(BLOCK_C, "content", "c2", Some(BLOCK_B), 0)
                .expect("c2");
            e.apply_delete_block(BLOCK_A, "1779703200000")
                .expect("delete seed");
        }

        let registry_b = LoroEngineRegistry::new();
        // #1257: `pool` is the RECEIVER B's SQL. After the first import it holds
        // the descendants soft-deleted, while A's engine still carries them
        // live (only the seed is tombstoned engine-side) — exactly the kind of
        // divergence the freshness gate refuses. But that divergence is B's,
        // not the sender A's: A's own SQL never had these rows. Gate A's export
        // against a fresh empty A pool so the (correct) gate doesn't fire on a
        // receiver-side state that is irrelevant to the sender.
        let (pool_a, _dir_a) = fresh_pool().await;
        // First import: cascades the soft-delete onto B's SQL (seed + descendants).
        let msg1 = prepare_outgoing_for_pool(&pool_a, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare 1")
            .expect("#1257 freshness gate must not refuse a consistent engine");
        apply_remote(&pool, &registry_b, "device-B", msg1)
            .await
            .expect("apply 1");

        // Second import of the SAME snapshot. The descendants are now
        // deleted in SQL but read back `None` from the (seed-only) engine —
        // the resurrection trap. The ancestor guard must keep them deleted.
        let msg2 = prepare_outgoing_for_pool(&pool_a, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare 2")
            .expect("#1257 freshness gate must not refuse a consistent engine");
        apply_remote(&pool, &registry_b, "device-B", msg2)
            .await
            .expect("apply 2");

        for id in [BLOCK_A, BLOCK_B, BLOCK_C] {
            let deleted_at: Option<i64> =
                sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .expect("fetch deleted_at");
            assert_eq!(
                deleted_at,
                Some(1_779_703_200_000),
                "block {id} must stay soft-deleted after re-import (no resurrection)"
            );
        }
    }

    /// A Snapshot envelope with `protocol_version != 1` must be
    /// rejected before any engine import — wire-format-version
    /// invariant.
    #[tokio::test]
    async fn apply_remote_rejects_unsupported_protocol_version() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        // Hand-craft a Snapshot with a bumped protocol_version. The
        // bytes payload doesn't matter — apply_remote MUST reject
        // before importing.
        let bad_snapshot = LoroSyncMessage::Snapshot {
            protocol_version: 99,
            space_id: space.clone(),
            bytes: vec![0xff, 0xff, 0xff],
        };
        let err = apply_remote(&pool, &registry, "device-B", bad_snapshot)
            .await
            .expect_err("must reject unsupported protocol_version");
        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("99") && msg.contains("protocol version"),
                    "error must mention the rejected version, got: {msg}"
                );
            }
            other => panic!("expected AppError::Validation, got {other:?}"),
        }

        // Same check for Update.
        let bad_update = LoroSyncMessage::Update {
            protocol_version: 99,
            space_id: space.clone(),
            from_vv: vec![],
            bytes: vec![0xff],
        };
        let err = apply_remote(&pool, &registry, "device-B", bad_update)
            .await
            .expect_err("must reject unsupported protocol_version (Update)");
        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("99") && msg.contains("protocol version"),
                    "error must mention the rejected version, got: {msg}"
                );
            }
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    // -----------------------------------------------------------------
    // #792 — own-peer (peer,counter) fork guard
    // -----------------------------------------------------------------

    /// #792 — an inbound Snapshot carrying OUR peer id at counters
    /// beyond what our doc holds, while we already minted ops under
    /// that id (the post-RESET fork a pre-epoch build created), must
    /// short-circuit into `SnapshotFallbackRequested` WITHOUT touching
    /// the engine, the inbox, or SQL. Importing it would corrupt
    /// loro-internal's causal state (the issue's inbound SIGABRT — not
    /// reproducible in-suite because the failure is a destructor panic
    /// → process abort, which is exactly why the guard must fire first).
    #[tokio::test]
    async fn apply_remote_snapshot_into_forked_doc_requests_fallback_792() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // The peer's copy of device-F's pre-reset history (3 blocks).
        let registry_pre = LoroEngineRegistry::new();
        {
            let mut g = registry_pre.for_space(&space, "device-F").expect("pre");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "pre 1", None, 0)
                .expect("a");
            e.apply_create_block(BLOCK_B, "content", "pre 2", None, 1)
                .expect("b");
            e.apply_create_block(BLOCK_C, "content", "pre 3", None, 2)
                .expect("c");
        }
        let msg = prepare_outgoing_for_pool(&pool, &registry_pre, &space, "device-F", None)
            .await
            .expect("peer-held history")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        // device-F after a pre-#792 RESET: fresh registry, SAME device
        // id (epoch 0 ⇒ same peer id), one re-minted block — the fork.
        let registry_forked = LoroEngineRegistry::new();
        {
            let mut g = registry_forked
                .for_space(&space, "device-F")
                .expect("forked");
            g.engine_mut()
                .apply_create_block(BLOCK_D, "content", "post reset", None, 0)
                .expect("post");
        }

        let outcome = apply_remote(&pool, &registry_forked, "device-F", msg)
            .await
            .expect("the guard returns a typed fallback, not an error");
        match outcome {
            ApplyOutcome::SnapshotFallbackRequested { space_id, reason } => {
                assert_eq!(space_id, space);
                assert!(
                    reason.contains("#792") && reason.contains("fork"),
                    "reason must be self-diagnosing, got: {reason}"
                );
            }
            ApplyOutcome::Imported { .. } => {
                panic!("a forked blob must NEVER be imported (#792)")
            }
        }

        // Side-effect-free: no engine import (BLOCK_A absent), no SQL
        // projection, and — critically — no write-ahead inbox slot that
        // boot replay would re-import into a crash loop.
        {
            let mut g = registry_forked
                .for_space(&space, "device-F")
                .expect("forked");
            assert!(g.engine_mut().read_block(BLOCK_A).unwrap().is_none());
        }
        let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .expect("count blocks");
        assert_eq!(blocks, 0, "no SQL projection on a fork miss");
        let inbox: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(inbox, 0, "a forked blob must not be persisted for replay");
    }

    /// #792 control — the CLEAN post-reset shape: the locally reset doc
    /// has NO own ops, so the peer's snapshot (which contains our
    /// pre-reset ops) imports cleanly and projects to SQL. The guard
    /// must not block the very resync that heals a reset.
    #[tokio::test]
    async fn apply_remote_snapshot_into_empty_post_reset_doc_imports_792() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_pre = LoroEngineRegistry::new();
        {
            let mut g = registry_pre.for_space(&space, "device-F").expect("pre");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "pre", None, 0)
                .expect("a");
        }
        let msg = prepare_outgoing_for_pool(&pool, &registry_pre, &space, "device-F", None)
            .await
            .expect("peer-held history")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        // Post-reset, zero local ops minted (the safe window).
        let registry_fresh = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_fresh, "device-F", msg)
            .await
            .expect("clean resync");
        assert!(
            matches!(outcome, ApplyOutcome::Imported { .. }),
            "an op-free post-reset doc must accept its own history back, got {outcome:?}"
        );
        let content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("projected row");
        assert_eq!(content, "pre");
    }

    /// #792 — `replay_inbox_row` (boot recovery) must DROP a forked
    /// write-ahead slot instead of importing it: a slot persisted by a
    /// pre-#792 build would otherwise SIGABRT the app at every boot
    /// (crash loop). The slot is deleted so the next session's
    /// `apply_remote` guard can route into snapshot catch-up.
    #[tokio::test]
    async fn replay_inbox_row_drops_forked_slot_792() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Peer-held pre-reset history bytes.
        let registry_pre = LoroEngineRegistry::new();
        let history_bytes = {
            let mut g = registry_pre.for_space(&space, "device-F").expect("pre");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "pre 1", None, 0)
                .expect("a");
            e.apply_create_block(BLOCK_B, "content", "pre 2", None, 1)
                .expect("b");
            e.export_snapshot().expect("snap")
        };

        // A leftover inbox slot holding those bytes (as a pre-#792
        // build would have persisted before crashing mid-projection).
        let inbox_id: i64 = sqlx::query_scalar(
            "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
             VALUES (?, ?, 0) RETURNING id",
        )
        .bind(space.as_str())
        .bind(&history_bytes)
        .fetch_one(&pool)
        .await
        .expect("seed slot");

        // The forked engine (same device id, re-minted op).
        let registry_forked = LoroEngineRegistry::new();
        {
            let mut g = registry_forked
                .for_space(&space, "device-F")
                .expect("forked");
            g.engine_mut()
                .apply_create_block(BLOCK_D, "content", "post reset", None, 0)
                .expect("post");
        }

        let changed = replay_inbox_row(
            &pool,
            &registry_forked,
            "device-F",
            space.as_str(),
            &history_bytes,
            inbox_id,
        )
        .await
        .expect("replay must not error — it drops the slot and skips");
        assert!(changed.is_empty(), "nothing imported from a forked slot");

        // The slot is gone (no boot crash loop) and the engine untouched.
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(remaining, 0, "the forked slot must be deleted");
        {
            let mut g = registry_forked
                .for_space(&space, "device-F")
                .expect("forked");
            assert!(g.engine_mut().read_block(BLOCK_A).unwrap().is_none());
        }
    }

    // -----------------------------------------------------------------
    // `from_vv` reachability check + snapshot-fallback
    // -----------------------------------------------------------------

    /// Happy-path: peer's `from_vv` is exactly our current
    /// `oplog_vv()`.  Reachability passes; `apply_remote` performs the
    /// engine import and returns `ApplyOutcome::Imported`.
    ///
    /// Locks the wire-shape pin for normal flow — every
    /// in-band incremental sync between two peers that have been
    /// continuously paired hits this path.
    #[tokio::test]
    async fn apply_remote_update_with_reachable_from_vv_imports() {
        let (pool, _dir) = fresh_pool().await;

        // Build A with one block, capture B's vv (== A's vv before
        // the next op), then A adds a second block; A exports the
        // delta with `from_vv = b_vv`.
        let registry_a = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "first", None, 0)
                .expect("create A");
        }
        // Mirror A's pre-second-op state into B so B's local vv
        // exactly matches the `from_vv` A will use.
        let registry_b = LoroEngineRegistry::new();
        let snap_msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare snapshot")
            .expect("#1257 freshness gate must not refuse a consistent engine");
        let snap_outcome = apply_remote(&pool, &registry_b, "device-B", snap_msg)
            .await
            .expect("apply snapshot");
        assert!(
            matches!(snap_outcome, ApplyOutcome::Imported { .. }),
            "seed snapshot must import cleanly, got {snap_outcome:?}"
        );

        let b_vv: Vec<u8> = {
            let mut g = registry_b
                .for_space(&space, "device-B")
                .expect("for_space B");
            g.engine_mut().version_vector()
        };
        assert!(!b_vv.is_empty(), "B's vv must be non-empty after import");

        {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A2");
            g.engine_mut()
                .apply_create_block(BLOCK_B, "content", "second", None, 1)
                .expect("create B");
        }
        let update = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&b_vv))
            .await
            .expect("prepare update")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        let outcome = apply_remote(&pool, &registry_b, "device-B", update)
            .await
            .expect("apply update");
        match outcome {
            ApplyOutcome::Imported { space_id: s, .. } => assert_eq!(s, space),
            ApplyOutcome::SnapshotFallbackRequested { reason, .. } => {
                panic!("reachable from_vv must Imported, got SnapshotFallbackRequested: {reason}")
            }
        }

        // B's engine actually advanced — BLOCK_B is now visible.
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B3");
        assert!(
            g.engine_mut()
                .read_block(BLOCK_B)
                .expect("read B")
                .is_some(),
            "BLOCK_B must be visible after a reachable Update is imported",
        );
    }

    /// Miss-path: peer's `from_vv` claims ops from a peer we have
    /// never heard of (counter > 0 for an unknown peer).  Reachability
    /// fails; `apply_remote` returns `SnapshotFallbackRequested`
    /// **without** attempting the engine import.
    ///
    /// Invariant. Pre-fix the engine raised an opaque Loro
    /// decode error from `import_with_changed_blocks`; the new path
    /// emits a typed fallback signal the orchestrator can route to
    /// the snapshot catch-up sub-flow.
    #[tokio::test]
    async fn apply_remote_update_with_unreachable_from_vv_requests_fallback() {
        let (pool, _dir) = fresh_pool().await;

        // B starts fresh (vv is empty / contains only its own peer
        // at counter 0).  We then hand B an Update whose `from_vv`
        // claims a third peer's ops at a non-zero counter — B has
        // no entry for that peer, so the import would lose context.
        let registry_b = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        // Construct a `from_vv` that includes a phantom peer with a
        // non-zero counter.  Use a real LoroEngine with a distinct
        // device_id to manufacture the encoded vv; this matches the
        // production wire shape (a postcard-encoded VersionVector).
        let phantom_vv_bytes: Vec<u8> = {
            let mut phantom = LoroEngine::with_peer_id("device-PHANTOM").expect("phantom engine");
            phantom
                .apply_create_block(BLOCK_C, "content", "phantom-op", None, 0)
                .expect("phantom op");
            phantom.version_vector()
        };

        // The `bytes` payload must be syntactically a valid Update
        // body so that, if the reachability check were ever
        // bypassed, the test would loudly fail on the import call
        // rather than coincidentally pass.  Use an Update produced by
        // the phantom engine itself against a known prior vv.
        let payload_bytes: Vec<u8> = {
            let phantom = LoroEngine::with_peer_id("device-PHANTOM").expect("phantom payload");
            let empty_vv = phantom.version_vector();
            // Produce a delta from the *initial* empty vv — even if
            // this is somehow imported, it does not contain the ops
            // referenced by `phantom_vv_bytes`, so the assertion
            // below ("BLOCK_C not present on B") still pins the
            // "import NOT attempted" invariant.
            phantom
                .export_update_since(&empty_vv)
                .unwrap_or_else(|_| vec![0u8])
        };

        let unreachable_update = LoroSyncMessage::Update {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: space.clone(),
            from_vv: phantom_vv_bytes,
            bytes: payload_bytes,
        };

        let outcome = apply_remote(&pool, &registry_b, "device-B", unreachable_update)
            .await
            .expect("apply_remote must NOT error on unreachable from_vv — it must return the typed fallback variant");

        match outcome {
            ApplyOutcome::SnapshotFallbackRequested {
                space_id: returned_space,
                reason,
            } => {
                assert_eq!(returned_space, space);
                assert!(
                    reason.contains("from_vv") || reason.contains("oplog_vv"),
                    "reason should mention the vv mismatch context, got: {reason}"
                );
            }
            ApplyOutcome::Imported { .. } => {
                panic!("unreachable from_vv MUST NOT report Imported")
            }
        }

        // Side-effect-free guarantee: the import was NOT attempted.
        // B's engine has no entry for BLOCK_C (the phantom's op).
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        assert!(
            g.engine_mut()
                .read_block(BLOCK_C)
                .expect("read C")
                .is_none(),
            "BLOCK_C must NOT be present on B — the engine import must be skipped on a fallback miss",
        );

        // Same guarantee at the SQL layer.
        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BLOCK_C)
            .fetch_one(&pool)
            .await
            .expect("count rows");
        assert_eq!(
            row_count, 0,
            "no blocks must be projected to SQL when fallback is requested",
        );
    }

    /// Miss-path corner: peer has us **behind** on a peer we DO
    /// share — same peer_id in both vvs, peer's counter is strictly
    /// greater than ours.  Reachability must reject.
    #[tokio::test]
    async fn apply_remote_update_with_behind_counter_requests_fallback() {
        let (pool, _dir) = fresh_pool().await;

        // A and B share device-A as a peer, but A is 2 ops ahead.
        // B receives an Update whose `from_vv` echoes A's full vv —
        // since B's vv has device-A at counter 0 (B has no ops from
        // A), the reachability check must fail.
        let registry_a = LoroEngineRegistry::new();
        let registry_b = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "a1", None, 0)
                .expect("a1");
            e.apply_create_block(BLOCK_B, "content", "a2", None, 1)
                .expect("a2");
        }
        let a_vv: Vec<u8> = {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A2");
            g.engine_mut().version_vector()
        };
        // A produces a third op then an Update whose from_vv == its
        // *pre-third-op* vv (which B does not have).
        {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A3");
            g.engine_mut()
                .apply_create_block(BLOCK_D, "content", "a3", None, 2)
                .expect("a3");
        }
        let update = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&a_vv))
            .await
            .expect("prepare update")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        let outcome = apply_remote(&pool, &registry_b, "device-B", update)
            .await
            .expect("apply_remote must return fallback variant cleanly");

        assert!(
            matches!(outcome, ApplyOutcome::SnapshotFallbackRequested { .. }),
            "behind-on-shared-peer from_vv must yield SnapshotFallbackRequested, got {outcome:?}",
        );

        // Engine import was skipped — none of A's blocks landed.
        let mut g = registry_b
            .for_space(&space, "device-B")
            .expect("for_space B");
        let e = g.engine_mut();
        for blk in [BLOCK_A, BLOCK_B, BLOCK_D] {
            assert!(
                e.read_block(blk).expect("read").is_none(),
                "{blk} must NOT be present after a fallback miss",
            );
        }
    }

    /// Unit-test the reachability classifier in isolation against
    /// hand-built version vectors — three cases:
    ///  - exact match  → reachable
    ///  - local ahead  → reachable
    ///  - local behind → unreachable (with diagnostic)
    ///  - peer mentions an unknown peer at counter==0 → reachable
    ///    (no-op entries do not gate reachability)
    #[tokio::test]
    async fn classify_from_vv_reachability_cases() {
        // Build two engines + extract their encoded vvs at known
        // states.  Using real engines avoids hand-rolling postcard.
        let mut e_local = LoroEngine::with_peer_id("device-L").expect("L");
        let mut e_peer = LoroEngine::with_peer_id("device-L").expect("peer-L"); // same peer_id

        // Local: 2 ops.  Peer (echo): 2 ops too → exact match.
        for (eng, prefix) in [(&mut e_local, "l"), (&mut e_peer, "p")] {
            eng.apply_create_block(BLOCK_A, "content", &format!("{prefix}1"), None, 0)
                .expect("op1");
            eng.apply_create_block(BLOCK_B, "content", &format!("{prefix}2"), None, 1)
                .expect("op2");
        }
        let local_vv = e_local.version_vector();
        let peer_vv_eq = e_peer.version_vector();
        assert!(
            classify_from_vv_reachability(&local_vv, &peer_vv_eq)
                .expect("decode")
                .is_none(),
            "exact match must be reachable",
        );

        // Local ahead: local has 3 ops, peer still at 2.
        e_local
            .apply_create_block(BLOCK_C, "content", "l3", None, 2)
            .expect("l3");
        let local_vv_ahead = e_local.version_vector();
        assert!(
            classify_from_vv_reachability(&local_vv_ahead, &peer_vv_eq)
                .expect("decode")
                .is_none(),
            "local ahead must be reachable (we have everything peer claims)",
        );

        // Local behind: peer has 4 ops, local still at 3.
        e_peer
            .apply_create_block(BLOCK_C, "content", "p3", None, 2)
            .expect("p3");
        e_peer
            .apply_create_block(BLOCK_D, "content", "p4", None, 3)
            .expect("p4");
        let peer_vv_ahead = e_peer.version_vector();
        let miss = classify_from_vv_reachability(&local_vv_ahead, &peer_vv_ahead)
            .expect("decode")
            .expect("local-behind must be unreachable");
        assert!(
            miss.contains("counter") || miss.contains("peer"),
            "diagnostic should mention peer/counter, got: {miss}",
        );
    }

    // -----------------------------------------------------------------
    // #1054 — boot-replay reachability gate (mirrors the live
    // gate in the inbox replay path).
    // -----------------------------------------------------------------

    /// #1054 — a leftover write-ahead inbox slot holding an *Update*-shaped
    /// blob whose causal base (`partial_start_vv`) is UNREACHABLE from the
    /// rehydrated-then-op-log-replayed engine must be DROPPED at boot
    /// replay — not imported. Pre-fix it was imported unconditionally,
    /// surfacing an opaque Loro decode error and re-erroring at every boot
    /// (a permanent poison row, since op-log replay never advances the
    /// engine past the remote gap). The fix mirrors the live gate: drop the
    /// slot and let the next live sync re-detect the gap and snapshot
    /// catch-up.
    #[tokio::test]
    async fn replay_inbox_row_drops_unreachable_update_slot_1054() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Producer A: 2 ops → capture vv → a 3rd op. The update exported
        // since the post-2-ops vv has a non-trivial `partial_start_vv`
        // (peer A at counter 2) — the causal base a fresh replaying engine
        // does NOT hold.
        let registry_a = LoroEngineRegistry::new();
        let base_vv = {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "a1", None, 0)
                .expect("a1");
            e.apply_create_block(BLOCK_B, "content", "a2", None, 1)
                .expect("a2");
            let vv = e.version_vector();
            e.apply_create_block(BLOCK_C, "content", "a3", None, 2)
                .expect("a3");
            vv
        };
        let update_bytes: Vec<u8> = {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A2");
            g.engine_mut().export_update_since(&base_vv).expect("delta")
        };

        // A leftover inbox slot holding that update (as a crash mid-projection
        // would have left behind).
        let inbox_id: i64 = sqlx::query_scalar(
            "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
             VALUES (?, ?, 0) RETURNING id",
        )
        .bind(space.as_str())
        .bind(&update_bytes)
        .fetch_one(&pool)
        .await
        .expect("seed slot");

        // A FRESH replaying engine (device-B) that has never seen A's ops:
        // its oplog_vv has no entry for peer A, so the update's base is
        // unreachable.
        let registry_b = LoroEngineRegistry::new();
        let changed = replay_inbox_row(
            &pool,
            &registry_b,
            "device-B",
            space.as_str(),
            &update_bytes,
            inbox_id,
        )
        .await
        .expect("replay must not error — it drops the slot and skips");
        assert!(
            changed.is_empty(),
            "nothing imported from an unreachable update slot"
        );

        // The slot is gone (no permanent poison row, no boot re-error).
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(remaining, 0, "the unreachable update slot must be deleted");

        // Engine state is NOT corrupted: the unreachable ops never landed.
        {
            let mut g = registry_b
                .for_space(&space, "device-B")
                .expect("for_space B");
            let e = g.engine_mut();
            for blk in [BLOCK_A, BLOCK_B, BLOCK_C] {
                assert!(
                    e.read_block(blk).expect("read").is_none(),
                    "{blk} must NOT be present — the unreachable update was not imported"
                );
            }
        }

        // No SQL projection either.
        let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .expect("count blocks");
        assert_eq!(blocks, 0, "no SQL projection on a dropped slot");
    }

    /// #1054 control — a leftover Update slot whose base IS reachable from
    /// the replaying engine must still replay normally (import + project +
    /// clear the slot). The gate must not block a legitimately-applicable
    /// boot replay.
    #[tokio::test]
    async fn replay_inbox_row_replays_reachable_update_slot_1054() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Producer A: 2 ops → capture vv → a 3rd op; export the delta since
        // the post-2-ops vv (base = peer A @ counter 2).
        let registry_a = LoroEngineRegistry::new();
        let (seed_bytes, base_vv) = {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "a1", None, 0)
                .expect("a1");
            e.apply_create_block(BLOCK_B, "content", "a2", None, 1)
                .expect("a2");
            let vv = e.version_vector();
            let seed = e.export_snapshot().expect("seed snapshot");
            e.apply_create_block(BLOCK_C, "content", "a3", None, 2)
                .expect("a3");
            (seed, vv)
        };
        let update_bytes: Vec<u8> = {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A2");
            g.engine_mut().export_update_since(&base_vv).expect("delta")
        };

        // The replaying engine (device-B) already holds A's first 2 ops —
        // so the update's base IS reachable.
        let registry_b = LoroEngineRegistry::new();
        {
            let mut g = registry_b
                .for_space(&space, "device-B")
                .expect("for_space B");
            g.engine_mut().import(&seed_bytes).expect("seed import");
        }

        let inbox_id: i64 = sqlx::query_scalar(
            "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
             VALUES (?, ?, 0) RETURNING id",
        )
        .bind(space.as_str())
        .bind(&update_bytes)
        .fetch_one(&pool)
        .await
        .expect("seed slot");

        let changed = replay_inbox_row(
            &pool,
            &registry_b,
            "device-B",
            space.as_str(),
            &update_bytes,
            inbox_id,
        )
        .await
        .expect("reachable update must replay cleanly");
        assert!(
            !changed.is_empty(),
            "a reachable update must import its changed block(s)"
        );

        // The slot is cleared (in-tx with the projection).
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(remaining, 0, "a successfully-replayed slot is cleared");

        // The update's new block (BLOCK_C) landed in the engine and SQL.
        {
            let mut g = registry_b
                .for_space(&space, "device-B")
                .expect("for_space B2");
            assert!(
                g.engine_mut().read_block(BLOCK_C).expect("read").is_some(),
                "BLOCK_C from the reachable update must be imported"
            );
        }
        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BLOCK_C)
            .fetch_one(&pool)
            .await
            .expect("count rows");
        assert_eq!(row_count, 1, "BLOCK_C must be projected to SQL");
    }

    /// #1054 — a Snapshot-shaped slot is self-contained and must always
    /// replay unconditionally, even against a fresh engine. The gate only
    /// applies to Update-shaped blobs (mirrors the live gate, which only
    /// checks `LoroSyncMessage::Update`).
    #[tokio::test]
    async fn replay_inbox_row_replays_snapshot_slot_1054() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Producer A's full snapshot (carries its own causal base).
        let registry_a = LoroEngineRegistry::new();
        let snapshot_bytes: Vec<u8> = {
            let mut g = registry_a
                .for_space(&space, "device-A")
                .expect("for_space A");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "a1", None, 0)
                .expect("a1");
            e.apply_create_block(BLOCK_B, "content", "a2", None, 1)
                .expect("a2");
            e.export_snapshot().expect("snapshot")
        };

        let inbox_id: i64 = sqlx::query_scalar(
            "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
             VALUES (?, ?, 0) RETURNING id",
        )
        .bind(space.as_str())
        .bind(&snapshot_bytes)
        .fetch_one(&pool)
        .await
        .expect("seed slot");

        // A FRESH replaying engine — a snapshot must import regardless.
        let registry_b = LoroEngineRegistry::new();
        let changed = replay_inbox_row(
            &pool,
            &registry_b,
            "device-B",
            space.as_str(),
            &snapshot_bytes,
            inbox_id,
        )
        .await
        .expect("a snapshot slot must replay unconditionally");
        assert!(!changed.is_empty(), "the snapshot must import its blocks");

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(remaining, 0, "the snapshot slot is cleared on success");

        {
            let mut g = registry_b
                .for_space(&space, "device-B")
                .expect("for_space B");
            let e = g.engine_mut();
            for blk in [BLOCK_A, BLOCK_B] {
                assert!(
                    e.read_block(blk).expect("read").is_some(),
                    "{blk} from the snapshot must be imported"
                );
            }
        }
    }

    // -----------------------------------------------------------------
    // Inbound property re-projection (end-to-end).
    // -----------------------------------------------------------------

    /// Seed the `property_definitions` rows the re-projection consults to
    /// recover SQL types for the typed-column assertions below.
    async fn seed_property_defs(pool: &SqlitePool) {
        // `INSERT OR REPLACE` so these test-chosen types win over any
        // builtin seed (e.g. migration 0014 seeds `effort` as `select`).
        for (key, value_type) in [
            ("note", "text"),
            ("effort", "number"),
            ("done", "boolean"),
            ("due", "date"),
        ] {
            sqlx::query(
                "INSERT OR REPLACE INTO property_definitions (key, value_type, created_at) \
                 VALUES (?, ?, '2026-01-01T00:00:00Z')",
            )
            .bind(key)
            .bind(value_type)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    /// A remote engine sets several typed properties on a block; after
    /// `apply_remote`, each `block_properties` row carries the correct
    /// typed column (text/number/boolean/date), recovered from
    /// `property_definitions`.
    #[tokio::test]
    async fn apply_remote_reprojects_typed_properties_to_sql() {
        let (pool, _dir) = fresh_pool().await;
        seed_property_defs(&pool).await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Build A: create a block and set typed properties (string form,
        // mirroring the engine's single-string storage).
        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create");
            e.apply_set_property(BLOCK_A, "note", Some("hello"))
                .expect("set note");
            e.apply_set_property(BLOCK_A, "effort", Some("2.5"))
                .expect("set effort");
            e.apply_set_property(BLOCK_A, "done", Some("true"))
                .expect("set done");
            e.apply_set_property(BLOCK_A, "due", Some("2026-01-01"))
                .expect("set due");
        }
        let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        // Apply on B.
        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        assert!(
            matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
            "snapshot apply must report Imported, got {outcome:?}"
        );

        // Each property landed in the right typed column.
        let note: (Option<String>, Option<f64>, Option<i64>) = sqlx::query_as(
            "SELECT value_text, value_num, value_bool FROM block_properties \
             WHERE block_id = ? AND key = 'note'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch note");
        assert_eq!(note, (Some("hello".into()), None, None));

        let effort: (Option<f64>, Option<String>) = sqlx::query_as(
            "SELECT value_num, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'effort'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch effort");
        assert_eq!(effort, (Some(2.5), None));

        let done: (Option<i64>, Option<String>) = sqlx::query_as(
            "SELECT value_bool, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'done'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch done");
        assert_eq!(done, (Some(1), None));

        let due: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT value_date, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'due'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch due");
        assert_eq!(due, (Some("2026-01-01".into()), None));
    }

    /// A property present after a first sync, then removed on the remote
    /// (engine `apply_delete_property`), must have its `block_properties`
    /// row gone after a second `apply_remote`.  Pins remote-delete
    /// propagation via the authoritative-replace DELETE.
    #[tokio::test]
    async fn apply_remote_reproject_removes_deleted_property_on_resync() {
        let (pool, _dir) = fresh_pool().await;
        seed_property_defs(&pool).await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create");
            e.apply_set_property(BLOCK_A, "note", Some("hello"))
                .expect("set note");
        }
        let registry_b = LoroEngineRegistry::new();

        // First sync: B materialises the `note` property.
        let msg1 = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare 1")
            .expect("#1257 freshness gate must not refuse a consistent engine");
        apply_remote(&pool, &registry_b, "device-B", msg1)
            .await
            .expect("apply 1");
        let count_before: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'note'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("count before");
        assert_eq!(count_before, 1, "note must be present after first sync");

        // A deletes the property, then re-syncs (incremental update).
        let b_vv: Vec<u8> = {
            let mut g = registry_b
                .for_space(&space, "device-B")
                .expect("for_space B");
            g.engine_mut().version_vector()
        };
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_delete_property(BLOCK_A, "note")
                .expect("delete note");
        }
        let msg2 = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&b_vv))
            .await
            .expect("prepare 2")
            .expect("#1257 freshness gate must not refuse a consistent engine");
        apply_remote(&pool, &registry_b, "device-B", msg2)
            .await
            .expect("apply 2");

        let count_after: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'note'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("count after");
        assert_eq!(
            count_after, 0,
            "note row must be gone after the remote deletes it and re-syncs"
        );
    }

    // -----------------------------------------------------------------
    // Inbound tag re-projection (end-to-end).
    // -----------------------------------------------------------------

    /// A remote engine creates a tag block and tags a content block;
    /// after `apply_remote`, the `block_tags` edge exists in SQL (and
    /// the FK to the tag block is satisfied because Pass A upserts the
    /// tag block before Pass B inserts the edge).
    #[tokio::test]
    async fn apply_remote_reprojects_added_tag_to_sql() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // BLOCK_A = content block, BLOCK_B = tag block, edge A→B.
        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "tagged", None, 0)
                .expect("create content");
            e.apply_create_block(BLOCK_B, "tag", "tag-X", None, 1)
                .expect("create tag block");
            e.apply_add_tag(BLOCK_A, BLOCK_B).expect("add tag");
        }
        let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        assert!(
            matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
            "snapshot apply must report Imported, got {outcome:?}"
        );

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(BLOCK_A)
                .bind(BLOCK_B)
                .fetch_one(&pool)
                .await
                .expect("count edge");
        assert_eq!(count, 1, "tag edge must be projected after apply_remote");
    }

    /// A tag present after a first sync, then removed on the remote
    /// (engine `apply_remove_tag`), must have its `block_tags` row gone
    /// after a second `apply_remote`.  Pins remote-removal propagation
    /// via the authoritative-replace DELETE in the tag re-projection.
    #[tokio::test]
    async fn apply_remote_reproject_removes_tag_on_resync() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "tagged", None, 0)
                .expect("create content");
            e.apply_create_block(BLOCK_B, "tag", "tag-X", None, 1)
                .expect("create tag block");
            e.apply_add_tag(BLOCK_A, BLOCK_B).expect("add tag");
        }
        let registry_b = LoroEngineRegistry::new();

        // First sync: B materialises the edge.
        let msg1 = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare 1")
            .expect("#1257 freshness gate must not refuse a consistent engine");
        apply_remote(&pool, &registry_b, "device-B", msg1)
            .await
            .expect("apply 1");
        let before: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(BLOCK_A)
                .bind(BLOCK_B)
                .fetch_one(&pool)
                .await
                .expect("count before");
        assert_eq!(before, 1, "edge must exist after first sync");

        // A removes the tag, then re-syncs (incremental update).
        let b_vv: Vec<u8> = {
            let mut g = registry_b
                .for_space(&space, "device-B")
                .expect("for_space B");
            g.engine_mut().version_vector()
        };
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_remove_tag(BLOCK_A, BLOCK_B)
                .expect("remove tag");
        }
        let msg2 = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&b_vv))
            .await
            .expect("prepare 2")
            .expect("#1257 freshness gate must not refuse a consistent engine");
        apply_remote(&pool, &registry_b, "device-B", msg2)
            .await
            .expect("apply 2");

        let after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(BLOCK_A)
                .bind(BLOCK_B)
                .fetch_one(&pool)
                .await
                .expect("count after");
        assert_eq!(
            after, 0,
            "tag edge must be gone after the remote removes it and re-syncs"
        );
    }

    /// Inheritance: a parent block tagged on the sender, with a child
    /// block.  After `apply_remote`, `block_tag_inherited` must carry the
    /// child's inherited row — proving the post-commit `rebuild_all` ran
    /// off the freshly re-projected `block_tags`.
    #[tokio::test]
    async fn apply_remote_rebuilds_inherited_tags_for_child() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // BLOCK_A = tagged parent, BLOCK_C = child of A, BLOCK_B = tag block.
        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "parent", None, 0)
                .expect("create parent");
            e.apply_create_block(BLOCK_C, "content", "child", Some(BLOCK_A), 0)
                .expect("create child");
            e.apply_create_block(BLOCK_B, "tag", "tag-X", None, 1)
                .expect("create tag block");
            e.apply_add_tag(BLOCK_A, BLOCK_B).expect("tag parent");
        }
        let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");
        assert!(
            matches!(outcome, ApplyOutcome::Imported { space_id: ref s, .. } if s == &space),
            "snapshot apply must report Imported, got {outcome:?}"
        );

        // Direct edge on the parent.
        let direct: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(BLOCK_A)
                .bind(BLOCK_B)
                .fetch_one(&pool)
                .await
                .expect("count direct");
        assert_eq!(direct, 1, "parent's direct tag edge must be projected");

        // Inherited row on the child — proves rebuild_all ran.
        let inherited: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM block_tag_inherited \
             WHERE block_id = ? AND tag_id = ? AND inherited_from = ?",
        )
        .bind(BLOCK_C)
        .bind(BLOCK_B)
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("count inherited");
        assert_eq!(
            inherited.0, 1,
            "child must inherit the parent's tag after apply_remote (rebuild_all ran)"
        );
    }

    /// #2036 stage 3 divergence guard: after a sequence of INCREMENTAL updates
    /// applied through the scoped per-subtree recompute path (tag-add, then a
    /// structural move that drops an inherited tag), `block_tag_inherited` must
    /// be byte-identical to a from-scratch global `rebuild_all`.
    #[tokio::test]
    async fn incremental_tag_inheritance_matches_global_rebuild() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // A: parent BLOCK_A with children BLOCK_C, BLOCK_D; BLOCK_B is the tag.
        let reg_a = LoroEngineRegistry::new();
        {
            let mut g = reg_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "parent", None, 0)
                .unwrap();
            e.apply_create_block(BLOCK_C, "content", "c1", Some(BLOCK_A), 0)
                .unwrap();
            e.apply_create_block(BLOCK_D, "content", "c2", Some(BLOCK_A), 1)
                .unwrap();
            e.apply_create_block(BLOCK_B, "tag", "tag-X", None, 1)
                .unwrap();
        }

        // Initial snapshot sync A -> B.
        let reg_b = LoroEngineRegistry::new();
        let msg = prepare_outgoing_for_pool(&pool, &reg_a, &space, "device-A", None)
            .await
            .unwrap()
            .unwrap();
        apply_remote(&pool, &reg_b, "device-B", msg).await.unwrap();

        let b_vv = |reg_b: &LoroEngineRegistry| {
            let mut g = reg_b.for_space(&space, "device-B").unwrap();
            g.engine_mut().version_vector()
        };

        // Update 1: tag the parent — BLOCK_C and BLOCK_D inherit it.
        {
            let mut g = reg_a.for_space(&space, "device-A").unwrap();
            g.engine_mut().apply_add_tag(BLOCK_A, BLOCK_B).unwrap();
        }
        let vv = b_vv(&reg_b);
        let msg = prepare_outgoing_for_pool(&pool, &reg_a, &space, "device-A", Some(&vv))
            .await
            .unwrap()
            .unwrap();
        apply_remote(&pool, &reg_b, "device-B", msg).await.unwrap();

        // Update 2: move BLOCK_D out to root — it must LOSE the inherited tag.
        {
            let mut g = reg_a.for_space(&space, "device-A").unwrap();
            g.engine_mut().apply_move_block(BLOCK_D, None, 2).unwrap();
        }
        let vv = b_vv(&reg_b);
        let msg = prepare_outgoing_for_pool(&pool, &reg_a, &space, "device-A", Some(&vv))
            .await
            .unwrap()
            .unwrap();
        apply_remote(&pool, &reg_b, "device-B", msg).await.unwrap();

        // Scoped-incremental result.
        let scoped: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT block_id, tag_id, inherited_from FROM block_tag_inherited ORDER BY 1, 2, 3",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        // Force a global rebuild and re-read.
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();
        let global: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT block_id, tag_id, inherited_from FROM block_tag_inherited ORDER BY 1, 2, 3",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(
            scoped, global,
            "scoped incremental inheritance diverged from global rebuild",
        );
        assert!(
            scoped.iter().any(|(b, t, f)| b.as_str() == BLOCK_C
                && t.as_str() == BLOCK_B
                && f.as_str() == BLOCK_A),
            "BLOCK_C must still inherit the parent's tag, got {scoped:?}",
        );
        assert!(
            !scoped.iter().any(|(b, _, _)| b.as_str() == BLOCK_D),
            "moved BLOCK_D must not inherit any tag, got {scoped:?}",
        );
    }

    // -----------------------------------------------------------------
    // #535 — write-ahead inbox durability + boot replay.
    // -----------------------------------------------------------------

    /// Happy path: a normal `apply_remote` inserts an inbox slot then deletes
    /// it in the projection tx, so the table is EMPTY after success.
    #[tokio::test]
    async fn apply_remote_leaves_inbox_empty_on_success() {
        let (pool, _dir) = fresh_pool().await;

        let registry_a = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create");
        }
        let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", None)
            .await
            .expect("prepare")
            .expect("#1257 freshness gate must not refuse a consistent engine");

        let registry_b = LoroEngineRegistry::new();
        apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("apply_remote");

        let inbox_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(
            inbox_rows, 0,
            "inbox slot must be cleared atomically with the projection on success"
        );
    }

    /// Crash recovery: simulate the data-loss window — an inbox row whose
    /// projection never committed — then replay it and assert (a) the block
    /// is now projected into SQL and (b) the inbox row is gone.
    #[tokio::test]
    async fn replay_sync_inbox_projects_leftover_slot_and_clears_it() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Produce valid snapshot bytes from an engine that has a block.
        let snapshot_bytes: Vec<u8> = {
            let mut e = LoroEngine::with_peer_id("device-A").expect("engine");
            e.apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create");
            e.export_snapshot().expect("export")
        };

        // Simulate the crash: insert the inbox row but DO NOT project.
        let created_at = crate::db::now_ms();
        sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, ?)")
            .bind(space.as_str())
            .bind(&snapshot_bytes)
            .bind(created_at)
            .execute(&pool)
            .await
            .expect("seed inbox");

        // Boot replay.
        let registry = LoroEngineRegistry::new();
        let replayed = crate::recovery::replay_sync_inbox(&pool, &registry, "device-B")
            .await
            .expect("replay_sync_inbox");
        assert_eq!(replayed, 1, "exactly one slot must be replayed");

        // (a) the block is now projected into SQL.
        let content: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("block must be projected after replay");
        assert_eq!(content.0, "from-A");

        // (b) the inbox row is gone.
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(remaining, 0, "the replayed slot must be cleared");
    }

    /// Idempotent replay: replaying the same payload twice does not error and
    /// leaves SQL consistent (one `blocks` row, inbox empty).
    #[tokio::test]
    async fn replay_sync_inbox_is_idempotent_across_two_replays() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let snapshot_bytes: Vec<u8> = {
            let mut e = LoroEngine::with_peer_id("device-A").expect("engine");
            e.apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create");
            e.export_snapshot().expect("export")
        };

        let registry = LoroEngineRegistry::new();

        // First replay cycle.
        let created_at = crate::db::now_ms();
        sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, ?)")
            .bind(space.as_str())
            .bind(&snapshot_bytes)
            .bind(created_at)
            .execute(&pool)
            .await
            .expect("seed inbox 1");
        let r1 = crate::recovery::replay_sync_inbox(&pool, &registry, "device-B")
            .await
            .expect("replay 1");
        assert_eq!(r1, 1);

        // Second replay cycle with the SAME bytes (re-seeded as if a second
        // crashed apply landed the identical snapshot). Re-import is idempotent.
        sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, ?)")
            .bind(space.as_str())
            .bind(&snapshot_bytes)
            .bind(crate::db::now_ms())
            .execute(&pool)
            .await
            .expect("seed inbox 2");
        let r2 = crate::recovery::replay_sync_inbox(&pool, &registry, "device-B")
            .await
            .expect("replay 2 must not error");
        assert_eq!(r2, 1);

        // SQL is consistent: exactly one BLOCK_A row, inbox empty.
        let block_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("count blocks");
        assert_eq!(
            block_count, 1,
            "idempotent replay must not duplicate the block"
        );
        let inbox_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(inbox_count, 0, "both slots must be cleared");
    }

    /// #1257 freshness gate — DIVERGENCE case. The sender's engine still
    /// holds a block as LIVE while SQL has soft-deleted it (the eager-apply
    /// gap: a delete reached SQL but not the engine). `prepare_outgoing` MUST
    /// refuse: emit NO payload (`Ok(None)`) and never export the stale block.
    #[tokio::test]
    async fn prepare_outgoing_refuses_when_engine_live_block_is_sql_deleted() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        // Engine A holds BLOCK_A as live (never deleted in the engine).
        {
            let mut g = registry.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create A");
        }
        // The engine indeed reports it as exportable-live.
        {
            let mut g = registry.for_space(&space, "device-A").expect("for_space");
            let live = g.engine_mut().live_block_ids().expect("live ids");
            assert!(
                live.iter().any(|id| id == BLOCK_A),
                "precondition: engine must hold BLOCK_A as live"
            );
        }

        // SQL has the row but it is SOFT-DELETED (deleted_at set) — and the
        // engine was NOT told. This is the divergence the gate must catch.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'from-A', NULL, 1, ?)",
        )
        .bind(BLOCK_A)
        .bind(crate::db::now_ms())
        .execute(&pool)
        .await
        .expect("insert soft-deleted block");

        // Initial-sync (snapshot) export must REFUSE.
        let snap = prepare_outgoing_for_pool(&pool, &registry, &space, "device-A", None)
            .await
            .expect("prepare_outgoing must not error");
        assert!(
            snap.is_none(),
            "stale engine (engine-live block is SQL-deleted) must refuse the \
             snapshot export, got a payload: {snap:?}"
        );

        // Incremental (update) export must ALSO refuse — the gate runs before
        // the export branch, independent of peer_vv.
        let some_vv: Vec<u8> = {
            let mut g = registry.for_space(&space, "device-A").expect("for_space");
            g.engine_mut().version_vector()
        };
        let upd = prepare_outgoing_for_pool(&pool, &registry, &space, "device-A", Some(&some_vv))
            .await
            .expect("prepare_outgoing must not error");
        assert!(
            upd.is_none(),
            "stale engine must refuse the update export too, got: {upd:?}"
        );
    }

    /// #1257 freshness gate — HAPPY PATH (no false-refuse). When the engine
    /// and SQL agree (the block is live in both), `prepare_outgoing` exports
    /// exactly as before and the block is present in the snapshot.
    #[tokio::test]
    async fn prepare_outgoing_exports_normally_when_engine_and_sql_agree() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space = SpaceId::from_trusted(SPACE_A);

        {
            let mut g = registry.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "from-A", None, 0)
                .expect("create A");
        }
        // SQL row exists and is ALIVE (deleted_at NULL) — consistent state.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'from-A', NULL, 1)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .expect("insert alive block");

        let msg = prepare_outgoing_for_pool(&pool, &registry, &space, "device-A", None)
            .await
            .expect("prepare_outgoing must not error")
            .expect("consistent engine must NOT be refused (no false-refuse)");

        // The exported snapshot must carry BLOCK_A: import into a fresh
        // receiver engine and read it back.
        let bytes = match &msg {
            LoroSyncMessage::Snapshot { bytes, .. } => bytes.clone(),
            other => panic!("expected Snapshot, got {other:?}"),
        };
        let mut receiver = LoroEngine::with_peer_id("device-B").expect("rcv");
        receiver.import(&bytes).expect("import snapshot");
        assert!(
            receiver.read_block(BLOCK_A).expect("read").is_some(),
            "happy-path export must include the live block"
        );
    }

    // ---------------------------------------------------------------------
    // #2040 — soft-deleted-id read hoisted out of the per-space loop
    // ---------------------------------------------------------------------

    /// #2040 unit: `first_engine_live_block_sql_deleted` selects the SAME
    /// element the pre-refactor `Vec` + `sort()` + `into_iter().next()` chose —
    /// the lexicographically smallest engine-live id that SQL has soft-deleted —
    /// but via `.iter().min()` with no allocation / full sort. The live set is
    /// passed out of `due_date` order on purpose so a no-op (returning the
    /// first encountered, not the minimum) would fail.
    #[test]
    fn first_engine_live_block_sql_deleted_picks_min_like_old_sort() {
        let sql_deleted: std::collections::HashSet<String> = [BLOCK_A, BLOCK_C, BLOCK_E]
            .iter()
            .map(std::string::ToString::to_string)
            .collect();

        // Engine-live set: two are soft-deleted (C3, A1), one is alive (B2).
        // Insertion order puts the LARGER deleted id (C3) first to prove we
        // return the minimum, not the first hit.
        let live = vec![
            BLOCK_C.to_string(),
            BLOCK_B.to_string(),
            BLOCK_A.to_string(),
        ];
        let hit = first_engine_live_block_sql_deleted(&live, &sql_deleted);
        assert_eq!(
            hit.as_deref(),
            Some(BLOCK_A),
            "must return the lexicographically smallest matching id (old sort+first)"
        );

        // Replicate the OLD algorithm explicitly and assert parity.
        let mut old: Vec<String> = live
            .iter()
            .filter(|id| sql_deleted.contains(*id))
            .cloned()
            .collect();
        old.sort();
        assert_eq!(
            hit,
            old.into_iter().next(),
            "must match the old sort-then-first"
        );

        // No engine-live block is soft-deleted → None.
        let none_live = vec![BLOCK_B.to_string(), BLOCK_D.to_string()];
        assert_eq!(
            first_engine_live_block_sql_deleted(&none_live, &sql_deleted),
            None,
            "no intersection must yield None"
        );
        // Empty live set → None (the old early-return path).
        assert_eq!(
            first_engine_live_block_sql_deleted(&[], &sql_deleted),
            None,
            "empty live set must yield None"
        );
    }

    /// #2040 integration: the soft-deleted set is read ONCE and reused across
    /// multiple spaces. We read it via `read_sql_soft_deleted_ids`, assert its
    /// contents, then drive `prepare_outgoing` for two different spaces with
    /// that SINGLE shared set — both must succeed and select the expected
    /// outgoing message, proving the per-space loop no longer needs its own
    /// vault read. (The orchestrator hoists exactly this read out of the loop.)
    #[tokio::test]
    async fn read_sql_soft_deleted_ids_read_once_reused_across_spaces() {
        let (pool, _dir) = fresh_pool().await;
        const SPACE_B: &str = "01HZ00000000000000000000SQ";

        // Seed SQL with two ALIVE blocks and two SOFT-DELETED blocks. Only the
        // soft-deleted ids must appear in the set.
        for (id, alive) in [
            (BLOCK_A, true),
            (BLOCK_B, false),
            (BLOCK_C, true),
            (BLOCK_D, false),
        ] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', 'x', NULL, 0)",
            )
            .bind(id)
            .execute(&pool)
            .await
            .expect("insert block");
            if !alive {
                sqlx::query("UPDATE blocks SET deleted_at = 1777593600000 WHERE id = ?")
                    .bind(id)
                    .execute(&pool)
                    .await
                    .expect("soft-delete");
            }
        }

        // Read ONCE for the whole round.
        let sql_deleted = read_sql_soft_deleted_ids(&pool)
            .await
            .expect("read soft-deleted ids");
        let mut got: Vec<String> = sql_deleted.iter().cloned().collect();
        got.sort();
        assert_eq!(
            got,
            vec![BLOCK_B.to_string(), BLOCK_D.to_string()],
            "set must contain exactly the soft-deleted ids (read once)"
        );

        // Two distinct spaces, each with an engine holding only ALIVE blocks
        // (A1 in space A, C3 in space B). Neither engine-live block is in the
        // shared soft-deleted set, so BOTH exports must succeed using the
        // single shared set — no per-space re-read needed.
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);
        {
            let mut g = registry
                .for_space(&space_a, "device-A")
                .expect("for_space A");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "in-a", None, 0)
                .expect("create A");
        }
        {
            let mut g = registry
                .for_space(&space_b, "device-A")
                .expect("for_space B");
            g.engine_mut()
                .apply_create_block(BLOCK_C, "content", "in-b", None, 0)
                .expect("create C");
        }

        let msg_a = prepare_outgoing(&registry, &space_a, "device-A", None, &sql_deleted)
            .await
            .expect("prepare A")
            .expect("space A export must not be refused (A1 is alive)");
        let msg_b = prepare_outgoing(&registry, &space_b, "device-A", None, &sql_deleted)
            .await
            .expect("prepare B")
            .expect("space B export must not be refused (C3 is alive)");
        assert!(
            matches!(msg_a, LoroSyncMessage::Snapshot { ref space_id, .. } if space_id == &space_a),
            "space A must export its own snapshot"
        );
        assert!(
            matches!(msg_b, LoroSyncMessage::Snapshot { ref space_id, .. } if space_id == &space_b),
            "space B must export its own snapshot"
        );

        // Now make space B's engine hold a block that SQL soft-deleted (B2):
        // the SAME shared set must drive a per-space REFUSAL for B while A
        // still exports — proving the shared set is applied independently per
        // space (the #1257 gate is preserved under the #2040 hoist).
        let registry2 = LoroEngineRegistry::new();
        {
            let mut g = registry2
                .for_space(&space_a, "device-A")
                .expect("for_space A2");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "in-a", None, 0)
                .expect("create A2");
        }
        {
            let mut g = registry2
                .for_space(&space_b, "device-A")
                .expect("for_space B2");
            g.engine_mut()
                .apply_create_block(BLOCK_B, "content", "deleted-in-sql", None, 0)
                .expect("create B2");
        }
        let a_again = prepare_outgoing(&registry2, &space_a, "device-A", None, &sql_deleted)
            .await
            .expect("prepare A again");
        let b_refused = prepare_outgoing(&registry2, &space_b, "device-A", None, &sql_deleted)
            .await
            .expect("prepare B refused-path");
        assert!(
            a_again.is_some(),
            "space A still exports under the shared set"
        );
        assert!(
            b_refused.is_none(),
            "space B must be refused: its engine-live B2 is in the shared soft-deleted set"
        );
    }

    const TAG_X: &str = "01HZ0000000000000000000TX1";
    const TAG_Y: &str = "01HZ0000000000000000000TY2";

    /// Sync a full snapshot from a fresh sender registry into a fresh
    /// receiver registry + pool. Returns the receiver registry.
    async fn seed_receiver_via_snapshot(
        pool: &SqlitePool,
        registry_a: &LoroEngineRegistry,
        space: &SpaceId,
    ) -> LoroEngineRegistry {
        let msg = prepare_outgoing_for_pool(pool, registry_a, space, "device-A", None)
            .await
            .expect("prepare snapshot")
            .expect("freshness gate must not refuse");
        let registry_b = LoroEngineRegistry::new();
        let outcome = apply_remote(pool, &registry_b, "device-B", msg)
            .await
            .expect("apply snapshot");
        assert!(
            matches!(outcome, ApplyOutcome::Imported { .. }),
            "snapshot apply must import, got {outcome:?}"
        );
        registry_b
    }

    /// Produce an incremental update from A covering everything past
    /// B's current vv and apply it on B, returning the outcome.
    async fn round_trip_update(
        pool: &SqlitePool,
        registry_a: &LoroEngineRegistry,
        registry_b: &LoroEngineRegistry,
        space: &SpaceId,
    ) -> ApplyOutcome {
        let b_vv = registry_b.loro_vv(space).expect("B vv");
        let msg = prepare_outgoing_for_pool(pool, registry_a, space, "device-A", Some(&b_vv))
            .await
            .expect("prepare update")
            .expect("freshness gate must not refuse");
        apply_remote(pool, registry_b, "device-B", msg)
            .await
            .expect("apply update")
    }

    /// #2264 (a): an inbound delta that edited ONE block of a multi-block
    /// vault reports a changed set bounded to exactly that block — not the
    /// whole vault — so the per-block SQL projection, page-id resolution and
    /// FTS reindex all scale with the delta.
    #[tokio::test]
    async fn inbound_small_delta_changed_set_bounded_to_touched_block_2264() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            for (i, id) in [BLOCK_A, BLOCK_B, BLOCK_C, BLOCK_D, BLOCK_E]
                .iter()
                .enumerate()
            {
                let pos = i64::try_from(i).expect("seed index fits i64");
                e.apply_create_block(id, "content", "seed", None, pos)
                    .expect("create");
            }
        }
        let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

        // Remote one-block content edit.
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_edit_content(BLOCK_C, 0, 0, "x")
                .expect("edit C");
        }
        let outcome = round_trip_update(&pool, &registry_a, &registry_b, &space).await;
        match outcome {
            ApplyOutcome::Imported {
                changed_blocks,
                purged_blocks,
                ..
            } => {
                let changed: Vec<&str> = changed_blocks
                    .iter()
                    .map(crate::ulid::BlockId::as_str)
                    .collect();
                assert_eq!(
                    changed,
                    vec![BLOCK_C],
                    "a one-block content delta must report exactly that block \
                     as changed, not the whole vault (#2264)"
                );
                assert!(purged_blocks.is_empty(), "content edit purges nothing");
            }
            other => panic!("expected Imported, got {other:?}"),
        }
        // And the projection converged that block in SQL.
        let content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(BLOCK_C)
            .fetch_one(&pool)
            .await
            .expect("read C");
        assert_eq!(content, "xseed", "the edited block's row converged");
    }

    /// #2264: a redelivered (already-imported) update is a complete no-op —
    /// empty changed / purged / page-id sets — and still clears its
    /// write-ahead inbox slot via the short-circuit path.
    #[tokio::test]
    async fn redelivered_update_is_complete_noop_2264() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "seed", None, 0)
                .expect("create");
        }
        let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_edit_content(BLOCK_A, 0, 0, "y")
                .expect("edit A");
        }
        // Build ONE update message and deliver it twice.
        let b_vv = registry_b.loro_vv(&space).expect("B vv");
        let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&b_vv))
            .await
            .expect("prepare update")
            .expect("freshness gate must not refuse");
        let first = apply_remote(&pool, &registry_b, "device-B", msg.clone())
            .await
            .expect("first apply");
        assert!(
            matches!(&first, ApplyOutcome::Imported { changed_blocks, .. } if !changed_blocks.is_empty()),
            "first delivery imports the edit, got {first:?}"
        );

        let second = apply_remote(&pool, &registry_b, "device-B", msg)
            .await
            .expect("second apply");
        match second {
            ApplyOutcome::Imported {
                changed_blocks,
                purged_blocks,
                changed_page_ids,
                ..
            } => {
                assert!(changed_blocks.is_empty(), "redelivery changes nothing");
                assert!(purged_blocks.is_empty(), "redelivery purges nothing");
                assert!(changed_page_ids.is_empty(), "no page invalidation on no-op");
            }
            other => panic!("expected Imported, got {other:?}"),
        }
        // The no-op short-circuit still cleared the write-ahead inbox slot.
        let inbox_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(inbox_rows, 0, "no-op path must clear its inbox slot (#535)");
    }

    /// #2265 (b): a content-only inbound delta triggers NO tag-inheritance
    /// rebuild work — neither the global `rebuild_all` nor a scoped subtree
    /// recompute. Observable via a deliberately-wrong sentinel row in
    /// `block_tag_inherited`: ANY recompute covering the touched subtree
    /// would sweep it; a content-only delta must leave it in place.
    #[tokio::test]
    async fn content_only_inbound_delta_skips_tag_inheritance_rebuild_2265() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(TAG_X, "tag", "tag-x", None, 0)
                .expect("create tag x");
            e.apply_create_block(TAG_Y, "tag", "tag-y", None, 1)
                .expect("create tag y");
            e.apply_create_block(BLOCK_A, "content", "parent", None, 2)
                .expect("create AA");
            e.apply_create_block(BLOCK_B, "content", "child", Some(BLOCK_A), 0)
                .expect("create BB");
            e.apply_add_tag(BLOCK_A, TAG_X).expect("tag AA");
        }
        let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

        // Snapshot projection computed the genuine inherited row.
        let inherited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_tag_inherited \
             WHERE block_id = ? AND tag_id = ? AND inherited_from = ?",
        )
        .bind(BLOCK_B)
        .bind(TAG_X)
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("count inherited");
        assert_eq!(
            inherited, 1,
            "child inherits the parent's tag after snapshot"
        );

        // Sentinel: a row NO recompute would produce (BB does not inherit
        // TAG_Y from anywhere). A global rebuild_all — or a subtree
        // recompute covering AA/BB — would delete it.
        sqlx::query(
            "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) \
             VALUES (?, ?, ?)",
        )
        .bind(BLOCK_B)
        .bind(TAG_Y)
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .expect("insert sentinel");

        // Content-only remote edit on the tagged parent.
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_edit_content(BLOCK_A, 0, 0, "z")
                .expect("edit AA");
        }
        let outcome = round_trip_update(&pool, &registry_a, &registry_b, &space).await;
        match outcome {
            ApplyOutcome::Imported { changed_blocks, .. } => {
                let changed: Vec<&str> = changed_blocks
                    .iter()
                    .map(crate::ulid::BlockId::as_str)
                    .collect();
                assert_eq!(changed, vec![BLOCK_A], "content edit changes only AA");
            }
            other => panic!("expected Imported, got {other:?}"),
        }

        let sentinel: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_tag_inherited \
             WHERE block_id = ? AND tag_id = ?",
        )
        .bind(BLOCK_B)
        .bind(TAG_Y)
        .fetch_one(&pool)
        .await
        .expect("count sentinel");
        assert_eq!(
            sentinel, 1,
            "a content-only inbound delta must trigger NO tag-inheritance \
             recompute (the sentinel row would have been swept) — #2265"
        );
    }

    /// #2265 (c): an inbound MOVE recomputes inherited tags for the moved
    /// block's WHOLE subtree — descendants included, even though they are
    /// not in the changed set — because a move changes the ancestor chain
    /// for every node under it, with or without tag ops in the delta.
    #[tokio::test]
    async fn inbound_move_delta_recomputes_descendant_inherited_tags_2265() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(TAG_X, "tag", "tag-x", None, 0)
                .expect("create tag x");
            e.apply_create_block(TAG_Y, "tag", "tag-y", None, 1)
                .expect("create tag y");
            // AA (tagged X) → BB → DD;  CC (tagged Y) is the move target.
            e.apply_create_block(BLOCK_A, "content", "old parent", None, 2)
                .expect("create AA");
            e.apply_create_block(BLOCK_C, "content", "new parent", None, 3)
                .expect("create CC");
            e.apply_create_block(BLOCK_B, "content", "moved", Some(BLOCK_A), 0)
                .expect("create BB");
            e.apply_create_block(BLOCK_D, "content", "descendant", Some(BLOCK_B), 0)
                .expect("create DD");
            e.apply_add_tag(BLOCK_A, TAG_X).expect("tag AA");
            e.apply_add_tag(BLOCK_C, TAG_Y).expect("tag CC");
        }
        let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

        let inherited_pairs = |pool: &SqlitePool, block: &'static str| {
            let pool = pool.clone();
            async move {
                let rows: Vec<(String, String)> = sqlx::query_as(
                    "SELECT tag_id, inherited_from FROM block_tag_inherited \
                     WHERE block_id = ? ORDER BY tag_id",
                )
                .bind(block)
                .fetch_all(&pool)
                .await
                .expect("fetch inherited");
                rows
            }
        };

        assert_eq!(
            inherited_pairs(&pool, BLOCK_D).await,
            vec![(TAG_X.to_string(), BLOCK_A.to_string())],
            "pre-move: DD inherits X from AA"
        );

        // Remote structural move: BB (with DD under it) from AA to CC.
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_move_block(BLOCK_B, Some(BLOCK_C), 0)
                .expect("move BB under CC");
        }
        let outcome = round_trip_update(&pool, &registry_a, &registry_b, &space).await;
        match outcome {
            ApplyOutcome::Imported { changed_blocks, .. } => {
                let changed: Vec<&str> = changed_blocks
                    .iter()
                    .map(crate::ulid::BlockId::as_str)
                    .collect();
                assert_eq!(
                    changed,
                    vec![BLOCK_B],
                    "move delta changed set is bounded to the moved block + \
                     affected sibling groups (here: just BB) — NOT the subtree"
                );
                assert!(
                    !changed.contains(&BLOCK_D),
                    "descendant DD must not need to be in the changed set"
                );
            }
            other => panic!("expected Imported, got {other:?}"),
        }

        // The scoped subtree recompute covered the whole moved subtree.
        assert_eq!(
            inherited_pairs(&pool, BLOCK_B).await,
            vec![(TAG_Y.to_string(), BLOCK_C.to_string())],
            "post-move: BB inherits Y from CC (X swept)"
        );
        assert_eq!(
            inherited_pairs(&pool, BLOCK_D).await,
            vec![(TAG_Y.to_string(), BLOCK_C.to_string())],
            "post-move: descendant DD re-inherits through the new ancestor \
             chain even though it was not in the changed set (#2265)"
        );
        // And the moved block's row converged.
        let parent: Option<String> =
            sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
                .bind(BLOCK_B)
                .fetch_one(&pool)
                .await
                .expect("read BB parent");
        assert_eq!(parent.as_deref(), Some(BLOCK_C), "BB reparented in SQL");
    }

    /// #535/#2264 review: a boot-replay of a surviving inbox slot whose ops
    /// the engine ALREADY holds (`loro_doc_state` was persisted ahead of the
    /// crashed SQL projection — exactly the window the write-ahead inbox
    /// exists to heal) must STILL project to SQL and clear the slot in-tx.
    /// Trusting the no-op import diff here would drop the slot and leave SQL
    /// permanently diverged from the engine.
    #[tokio::test]
    async fn replay_projects_slot_even_when_engine_already_has_ops_2264() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Device A mints a block; its snapshot is the slot's payload.
        let registry_a = LoroEngineRegistry::new();
        let bytes = {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            let e = g.engine_mut();
            e.apply_create_block(BLOCK_A, "content", "recovered", None, 0)
                .expect("create");
            e.export_snapshot().expect("export")
        };

        // Receiver: the ENGINE already imported the bytes (as after a crash
        // where `save_all_engines` persisted the doc ahead of SQL), but the
        // SQL projection never committed — the write-ahead slot survives.
        let registry_b = LoroEngineRegistry::new();
        {
            let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
            g.engine_mut()
                .import(&bytes)
                .expect("pre-import into engine");
        }
        let inbox_id: i64 = sqlx::query_scalar(
            "INSERT INTO loro_sync_inbox (space_id, bytes, created_at) \
             VALUES (?, ?, ?) RETURNING id",
        )
        .bind(space.as_str())
        .bind(&bytes)
        .bind(crate::db::now_ms())
        .fetch_one(&pool)
        .await
        .expect("seed surviving slot");

        let changed = replay_inbox_row(
            &pool,
            &registry_b,
            "device-B",
            space.as_str(),
            &bytes,
            inbox_id,
        )
        .await
        .expect("replay");
        assert!(
            changed.iter().any(|b| b.as_str() == BLOCK_A),
            "replay must distrust the no-op import diff and fall back to the \
             full live-tree projection (#2264 review)"
        );

        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("count block");
        assert_eq!(n, 1, "the slot's block must be projected to SQL");

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(remaining, 0, "slot cleared atomically with the projection");
    }

    /// #2264 review: a LIVE no-op redelivery is fast-pathed only when no
    /// OTHER slot is pending for the space. Here a leftover slot (a prior
    /// delivery whose projection failed after the engine import) marks SQL
    /// as possibly stale: the redelivery must fall back to the full
    /// projection — healing SQL immediately — and leave the leftover slot
    /// for boot replay.
    #[tokio::test]
    async fn live_noop_redelivery_with_leftover_slot_forces_full_projection_2264() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let registry_a = LoroEngineRegistry::new();
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_create_block(BLOCK_A, "content", "seed", None, 0)
                .expect("create");
        }
        let registry_b = seed_receiver_via_snapshot(&pool, &registry_a, &space).await;

        // Remote edit; build ONE update message for it.
        {
            let mut g = registry_a.for_space(&space, "device-A").expect("for_space");
            g.engine_mut()
                .apply_edit_content(BLOCK_A, 0, 0, "y")
                .expect("edit A");
        }
        let b_vv = registry_b.loro_vv(&space).expect("B vv");
        let msg = prepare_outgoing_for_pool(&pool, &registry_a, &space, "device-A", Some(&b_vv))
            .await
            .expect("prepare update")
            .expect("freshness gate must not refuse");
        let LoroSyncMessage::Update { ref bytes, .. } = msg else {
            panic!("expected an Update message");
        };

        // Simulate delivery 1 dying AFTER the engine import but BEFORE its
        // projection tx: import into B's ENGINE only + leave its slot behind.
        {
            let mut g = registry_b.for_space(&space, "device-B").expect("for_space");
            g.engine_mut().import(bytes).expect("engine-only import");
        }
        sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, ?)")
            .bind(space.as_str())
            .bind(&bytes[..])
            .bind(crate::db::now_ms())
            .execute(&pool)
            .await
            .expect("seed leftover slot");

        // Redelivery: the import diff is a no-op, but the leftover slot must
        // veto the fast path and force the healing full projection.
        let outcome = apply_remote(&pool, &registry_b, "device-B", msg.clone())
            .await
            .expect("redelivery apply");
        match outcome {
            ApplyOutcome::Imported { changed_blocks, .. } => {
                assert!(
                    changed_blocks.iter().any(|b| b.as_str() == BLOCK_A),
                    "leftover slot must force the full-projection fallback"
                );
            }
            other => panic!("expected Imported, got {other:?}"),
        }

        // SQL healed: the edit that delivery 1 failed to project is now there.
        let content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("read A");
        assert_eq!(content, "yseed", "the failed delivery's edit converged");

        // Our own slot was cleared in-tx; the leftover stays for boot replay.
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loro_sync_inbox")
            .fetch_one(&pool)
            .await
            .expect("count inbox");
        assert_eq!(
            remaining, 1,
            "redelivery clears its own slot in-tx and leaves the leftover \
             slot for boot replay"
        );
    }
}
