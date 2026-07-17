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
//! own `partial_start_vv` (via [`agaric_engine::loro::engine::LoroEngine::unreachable_update_in_blob`])
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

use crate::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};
use agaric_core::error::AppError;
use agaric_engine::loro::registry::LoroEngineRegistry;
use agaric_store::space::SpaceId;
use loro::VersionVector;

/// #2188 — run a CPU-bound CRDT encode/decode closure so it does not stall the
/// async reactor while holding the per-space engine mutex (#2205 sharded the
/// old process-global registry mutex: the long lock is now scoped to ONE
/// space, so only same-space work waits behind the encode — but the reactor
/// worker would still be pinned without this helper).
///
/// On a **multi-thread** tokio runtime (production: tauri's default async
/// runtime + the daemon's `tokio::spawn`) this delegates to
/// [`tokio::task::block_in_place`], which tells the runtime this worker is about
/// to block so a sibling worker can take over the reactor for the duration. The
/// closure still runs inline on THIS thread, so the owned engine guard
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
        changed_blocks: Vec<agaric_core::ulid::BlockId>,
        /// #2264: block ids the import hard-purged (`PurgeBlock`), disjoint
        /// from `changed_blocks` (which enumerates live blocks only — #2128).
        /// Surfaced so the orchestrator can distinguish a complete no-op
        /// import (both sets empty → skip the derived-cache fan-out
        /// entirely) from a purge-only import (aggregate caches like
        /// `tags_cache.usage_count` / `pages_cache` counts still need a
        /// refresh even though no live block changed).
        purged_blocks: Vec<agaric_core::ulid::BlockId>,
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
pub fn classify_from_vv_reachability(
    local_encoded: &[u8],
    peer_encoded: &[u8],
) -> Result<Option<String>, AppError> {
    let local_vv = VersionVector::decode(local_encoded).map_err(|e| {
        AppError::validation(format!(
            "loro_sync: decode local oplog_vv for reachability check: {e}",
        ))
    })?;
    let peer_vv = VersionVector::decode(peer_encoded).map_err(|e| {
        AppError::validation(format!(
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
///   snapshot via [`agaric_engine::loro::engine::LoroEngine::export_snapshot`].
///   Receiver's [`apply_remote`] imports unconditionally.
/// * `peer_vv == Some(vv)` — incremental sync; the sender produces
///   an update covering ops added since the peer's vv via
///   [`agaric_engine::loro::engine::LoroEngine::export_update_since`].  The
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
/// ([`agaric_engine::loro::engine::apply::...apply_delete_block`] sets the
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
/// ([`super::session_state_machine::SyncOrchestrator::head_exchange_outgoing_loro`] via
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
            // holding this space's engine mutex (#2205 — per-space, so other
            // spaces' engine work proceeds concurrently). Wrapping the guard
            // acquisition + encode in `cpu_block_in_place` lets the multi-thread
            // reactor drive other tasks for the duration instead of stalling
            // the async worker. This does NOT release the engine lock — the
            // guard is still held across the encode, preserving same-space
            // atomicity vs concurrent mutation exactly as before. The guard is
            // `!Send`, but the closure runs inline on this same worker thread,
            // so a `!Send` guard inside it is fine. See `cpu_block_in_place`
            // for the current-thread-runtime fallback.
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
            // CPU-bound under the per-space engine lock, so it runs inside
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
/// [`super::session_state_machine::SyncOrchestrator::head_exchange_outgoing_loro`] —
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
/// ([`super::session_state_machine::SyncOrchestrator::head_exchange_outgoing_loro`])
/// invokes this once before iterating spaces and threads the returned set into
/// every `prepare_outgoing` call. The set is small (tombstones, periodically
/// purged); its content does not depend on the space being exported.
pub async fn read_sql_soft_deleted_ids(
    pool: &SqlitePool,
) -> Result<std::collections::HashSet<String>, AppError> {
    let sql_deleted: std::collections::HashSet<String> =
        sqlx::query_scalar!("SELECT id FROM blocks WHERE deleted_at IS NOT NULL")
            .fetch_all(pool)
            .await
            .map_err(|e| {
                AppError::validation(format!(
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
pub fn first_engine_live_block_sql_deleted(
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
                return Err(AppError::validation(format!(
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
                return Err(AppError::validation(format!(
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
    // `agaric_store::db::now_ms()` — wall-clock epoch-ms, same helper the rest of
    // the ms-timestamp schema uses (0079/0082).
    let created_at = agaric_store::db::now_ms();
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
        // Live apply: the engine import delta carries the purged set, so no
        // tombstone is threaded in here (it is WRITTEN by import_and_project,
        // #2292). Only the recovery replay path supplies a recovered set.
        &[],
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
/// 0073). The recursive CTE mirrors `agaric_store::cache::page_id`'s ancestor walk
/// (Invariant #9 `depth < 100` runaway guard) but is scoped to just the
/// changed-block id set instead of the whole vault — bounded by the number of
/// blocks one inbound sync message actually touched.
///
/// Blocks with no resolvable page ancestor (orphans, or cross-doc ordering
/// where the page block has not yet arrived) contribute no id; the result may
/// therefore be empty even when `changed_blocks` is not. The frontend treats
/// an empty set as "fall back to a full reload", so a missed resolution
/// degrades to the old behaviour rather than dropping an update.
pub async fn resolve_changed_page_ids(
    pool: &SqlitePool,
    changed_blocks: &[agaric_core::ulid::BlockId],
) -> Result<Vec<String>, AppError> {
    if changed_blocks.is_empty() {
        return Ok(Vec::new());
    }

    // Walk each seed block up its parent chain until a `page` row is hit
    // (or an orphan dead-ends it). `WHERE a.cur_type != 'page'` stops the
    // recursion as soon as the page root is reached, so a page block seeded
    // directly resolves to itself at depth 0.
    //
    // R27: the walk is depth-UNBOUNDED. Each batch keeps invariant #9
    // (`a.depth < 100` in the recursive arm) and additionally returns the
    // cap-boundary rows (`depth = 100`, non-page), which seed the NEXT
    // batch — so a block arbitrarily deep below its page (a merged sync
    // tree can legally exceed the local depth bound) still resolves its
    // owning page instead of silently never invalidating it. The `visited`
    // set guarantees termination even on a corrupted (cyclic) chain. Seeds
    // bind as ONE json_each parameter (no MAX_SQL_PARAMS chunking needed).
    // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
    const RESOLVE_SQL: &str = "WITH RECURSIVE ancestors(cur_id, cur_type, depth) AS ( \
         SELECT b.id, b.block_type, 0 FROM blocks b \
         WHERE b.id IN (SELECT value FROM json_each(?1)) \
         UNION ALL \
         SELECT parent.id, parent.block_type, a.depth + 1 \
         FROM ancestors a \
         JOIN blocks child ON child.id = a.cur_id \
         JOIN blocks parent ON parent.id = child.parent_id \
         WHERE a.cur_type != 'page' \
           AND a.depth < 100 \
     ) \
     SELECT DISTINCT cur_id, cur_type FROM ancestors \
     WHERE cur_type = 'page' OR depth = 100";

    let mut page_ids: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut frontier: Vec<String> = changed_blocks
        .iter()
        .map(|b| b.as_str().to_string())
        .collect();
    let mut visited: std::collections::HashSet<String> = frontier.iter().cloned().collect();
    let mut rounds: u32 = 0;
    while !frontier.is_empty() {
        rounds += 1;
        let payload = serde_json::Value::from(std::mem::take(&mut frontier)).to_string();
        // dynamic-sql: recursive ancestor CTE with a json_each seed list;
        // not expressible as a compile-checked `query!` form. #646.
        let rows: Vec<(String, String)> = sqlx::query_as(RESOLVE_SQL)
            .bind(&payload)
            .fetch_all(pool)
            .await?;
        for (cur_id, cur_type) in rows {
            if cur_type == "page" {
                if seen.insert(cur_id.clone()) {
                    page_ids.push(cur_id);
                }
            } else if visited.insert(cur_id.clone()) {
                // Cap-boundary row: continue the walk from it next round.
                frontier.push(cur_id);
            }
        }
    }
    if rounds > 1 {
        tracing::warn!(
            rounds,
            changed = changed_blocks.len(),
            "changed-page resolution crossed the depth-100 ancestor-CTE cap; \
             continued in batches (merged sync tree deeper than the local \
             depth bound — R27)",
        );
    }
    Ok(page_ids)
}

/// How the payload handed to [`import_and_project`] reached us — decides
/// whether a complete no-op import diff may be trusted as "SQL is already
/// consistent" (#2264 review; see the fn's "no-op short-circuit" docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InboundDeliveryKind {
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
/// boot recovery (`crate::recovery::replay_sync_inbox` (app-side), via
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
/// heals too. Gap boundary (#2128 / #2292): the additive Live no-op fallback
/// still cannot sweep purged rows — a purge whose Pass D never committed is
/// invisible to a redundant re-import (the engine index already dropped the
/// subtree, so the purged delta is empty), so this fallback leaves those stale
/// rows (pre-existing #2128). The RECOVERY-REPLAY path, however, IS now fixed:
/// it re-sweeps them from the durable `purged_ids` tombstone persisted on the
/// inbox row (#2292), independent of the (empty) re-import delta. Remaining
/// non-goal: a Live redelivery into a space that still holds a leftover
/// tombstoned slot reprojects the tree but does NOT consult that slot's
/// tombstone, so its stale rows persist until the next boot replay sweeps them
/// (down from "forever").
// #2292: crossed the 7-arg clippy ceiling adding `inbox_id` + `tombstone_purged`
// (the durable-tombstone plumbing). Threading them as fields of a struct here
// would obscure the linear import→project flow for no real benefit.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn import_and_project(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
    space_id: &SpaceId,
    bytes: &[u8],
    inbox_id: i64,
    // #2292: purged ids recovered from a crashed apply's durable tombstone
    // (`loro_sync_inbox.purged_ids`). Unioned into Pass D so a purge whose
    // engine delta is now empty (subtree already gone) is still re-swept from
    // SQL. Empty on the live apply path (the engine delta carries the set).
    tombstone_purged: &[agaric_core::ulid::BlockId],
    delivery: InboundDeliveryKind,
) -> Result<
    (
        Vec<agaric_core::ulid::BlockId>,
        Vec<agaric_core::ulid::BlockId>,
    ),
    AppError,
> {
    use agaric_engine::loro::projection::{
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
        Vec<agaric_core::ulid::BlockId>,
        Vec<agaric_core::ulid::BlockId>,
        agaric_engine::loro::engine::TagScope,
    ) = {
        // #2188: the CRDT import (decode + diff resolution) is CPU-bound and
        // runs while holding this space's engine mutex (#2205 — per-space).
        // `cpu_block_in_place` lets the multi-thread reactor drive other tasks
        // for the duration without releasing the lock (the guard is held across
        // the decode, so same-space atomicity vs concurrent mutation is
        // unchanged). The
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

    // #2292: durable tombstone of the purged id set on the write-ahead inbox
    // slot. Written in its OWN autocommit tx on `pool` — NOT the Phase-2
    // projection tx below — precisely so it survives a crash mid-projection:
    // the slot row (INSERTed before the engine import) and this tombstone must
    // both outlive the window in which the engine has already imported the
    // purge but the SQL Pass-D sweep has not yet committed. On recovery the
    // engine delta is empty (the subtree is already gone), so the purged set
    // can no longer be recomputed from the engine — this durable copy is the
    // only way to re-sweep the stale SQL rows without a FORBIDDEN "SQL minus
    // engine" reconcile (#779). Cleared for free by the in-tx slot DELETE when
    // the projection commits.
    //
    // Placed right after the engine import to minimize the window in which the
    // engine may be persisted (periodic `save_all_engines`) with no durable
    // tombstone yet.
    //
    // Guard: only when the engine actually purged something this import. The
    // empty-set skip is load-bearing on the replay re-import path — replay's
    // engine delta is empty, so writing an empty tombstone here would CLOBBER
    // the real one recovered from the row.
    if !purged_blocks.is_empty() {
        // #2292 (CR, Fix 5): persist the UNION of the engine's purged set and
        // any tombstone recovered from this row, so a recovery re-import that
        // recomputes a non-empty purge set does not overwrite/lose the
        // originally-recovered tombstone ids. `BlockId` is
        // `#[serde(transparent)]`, so serializing the `&str` view yields the
        // identical JSON array of id strings the decoder expects. On the live
        // path `tombstone_purged` is empty, so the union is exactly
        // `purged_blocks` (unchanged behaviour). `AppError: From<serde_json::Error>`
        // handles the (only theoretically possible) encode failure.
        let mut union: Vec<&str> = purged_blocks
            .iter()
            .map(agaric_core::ulid::BlockId::as_str)
            .collect();
        union.extend(
            tombstone_purged
                .iter()
                .map(agaric_core::ulid::BlockId::as_str),
        );
        union.sort_unstable();
        union.dedup();
        let purged_json = serde_json::to_string(&union)?;
        sqlx::query!(
            "UPDATE loro_sync_inbox SET purged_ids = ? WHERE id = ?",
            purged_json,
            inbox_id,
        )
        .execute(pool)
        .await?;
    }

    // #2292 (CR, Fix 2): a block the engine currently holds LIVE must not be
    // swept by a stale recovered tombstone (a later move can resurrect a
    // previously-purged id; Pass A upserts it live, and an unfiltered Pass D
    // would then delete it → SQL-behind-engine divergence). Narrow the recovered
    // tombstone to ids the engine no longer holds. Stays within #779: an engine
    // that reloaded empty holds nothing live, so it still sweeps the full
    // tombstone (the device's own durable record). Uncertain reads (Err) are
    // treated as LIVE and excluded — prefer leaving a stale row over deleting a
    // live one.
    let tombstone_to_sweep: Vec<agaric_core::ulid::BlockId> = if tombstone_purged.is_empty() {
        Vec::new()
    } else {
        let mut guard = registry.for_space(space_id, device_id)?;
        let engine = guard.engine_mut();
        tombstone_purged
            .iter()
            .filter(|id| matches!(engine.read_block(id.as_str()), Ok(None)))
            .cloned()
            .collect()
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
        && matches!(&tag_scope, agaric_engine::loro::engine::TagScope::Subtrees(roots) if roots.is_empty());
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
        (full, agaric_engine::loro::engine::TagScope::Global)
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
            .map(agaric_core::ulid::BlockId::as_str)
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

    let mut tx = agaric_store::db::begin_immediate_logged(pool, "sync_apply_remote").await?;

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
    // helper re-derives the SQL cascade from the seed timestamp (an
    // ancestor check prevents a snapshot re-import from resurrecting a
    // soft-deleted subtree, and — R9 — a live block whose post-merge
    // parent chain crosses a tombstoned ancestor is swept into that
    // ancestor's cohort, converging the concurrent delete-vs-move-in
    // merge to the same SQL on every peer). Every `(id, deleted_at)`
    // pair the pass stamps is collected for the post-commit engine
    // fan-out below.
    let mut swept_tombstones: Vec<(String, i64)> = Vec::new();
    for (block_id, (_, _, _, engine_deleted_at)) in changed_blocks.iter().zip(&block_states) {
        let stamped =
            reproject_block_deleted_at_from_engine(&mut tx, block_id, engine_deleted_at.as_deref())
                .await?;
        swept_tombstones.extend(stamped);
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
    // #2292: sweep the UNION of the engine's purged set and the durable
    // tombstone recovered from the inbox row — NARROWED (Fix 2) to
    // `tombstone_to_sweep`, the recovered ids the engine no longer holds live,
    // so a stale tombstone can never delete a block a later move resurrected.
    // On a live apply the tombstone is empty and this is exactly the engine set;
    // on a crash-recovery replay the engine set is empty (subtree already gone)
    // and the narrowed tombstone carries the ids. `project_purge_blocks_to_sql`
    // is idempotent (INSERT OR IGNORE into a keyed temp table, then joined
    // DELETEs), so re-sweeping already-gone ids is a no-op and the dedup below
    // is a courtesy, not a correctness requirement.
    let mut purge_union: Vec<&str> = purged_blocks
        .iter()
        .map(agaric_core::ulid::BlockId::as_str)
        .collect();
    purge_union.extend(
        tombstone_to_sweep
            .iter()
            .map(agaric_core::ulid::BlockId::as_str),
    );
    purge_union.sort_unstable();
    purge_union.dedup();
    if !purge_union.is_empty() {
        project_purge_blocks_to_sql(&mut tx, &purge_union).await?;
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

    // R9: fan the Pass-C tombstones out to the ENGINE for every stamped
    // block whose engine meta still says "live". The SQL cascade/sweep can
    // legally reach blocks no peer ever wrote a delete op for (a block
    // concurrently moved INTO the deleted subtree), and an engine-live /
    // SQL-deleted block permanently wedges the #1257 outbound freshness
    // gate. This mirrors the local delete path's #2344
    // `dispatch_delete_descendants` fan-out (same cohort timestamp,
    // idempotent per-block engine writes), and is deterministic across
    // peers — each peer derives the identical set from the identical
    // converged CRDT state. Runs AFTER the committed projection and is
    // best-effort: a failure must NOT turn the committed projection into
    // an `Err` (same policy as the tag rebuild below); the next import /
    // boot replay re-derives the same fan-out.
    if !swept_tombstones.is_empty() {
        let fanout_result: Result<(), AppError> = (|| {
            let mut guard = registry.for_space(space_id, device_id)?;
            let engine = guard.engine_mut();
            for (id, ts) in &swept_tombstones {
                if engine.read_deleted_at(id)?.is_none() {
                    engine.apply_delete_block(id, &ts.to_string())?;
                }
            }
            Ok(())
        })();
        if let Err(err) = fanout_result {
            tracing::warn!(
                error = %err,
                "engine tombstone fan-out failed AFTER the projection \
                 committed; the committed SQL state stands; the #1257 \
                 freshness gate may refuse outbound export for this space \
                 until a later import / boot replay re-derives the fan-out"
            );
        }
    }

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
    //
    // #2275 — the projection tx has ALREADY committed above (the #535 inbox
    // slot is gone), so this derived-cache rebuild is best-effort: it must NOT
    // turn a committed projection into an `Err`. If it fails, the committed
    // block/tag state stands and the `block_tag_inherited` cache heals on the
    // next FULL rebuild: any subsequent local tag/move op enqueues
    // `MaterializeTask::RebuildTagInheritanceCache` (a full rebuild), a later
    // Global-scope import rebuild does the same, and snapshot restore enqueues
    // it too. Until one of those runs, inherited-tag reads (tag search) may see
    // stale rows for the affected subtrees. Propagating the error here would be
    // strictly worse: the caller would treat a committed import as unprojected
    // while the inbox slot is already deleted (no retry possible), with the
    // cache exactly as stale. Log loudly and continue instead.
    let rebuild_result: Result<(), AppError> = async {
        match tag_scope {
            agaric_engine::loro::engine::TagScope::Global => {
                agaric_store::tag_inheritance::rebuild_all(pool).await?;
            }
            agaric_engine::loro::engine::TagScope::Subtrees(roots) => {
                if !roots.is_empty() {
                    let mut tag_tx =
                        agaric_store::db::begin_immediate_logged(pool, "tag_inheritance_subtrees")
                            .await?;
                    for root in &roots {
                        agaric_store::tag_inheritance::recompute_subtree_inheritance(
                            &mut tag_tx,
                            root.as_str(),
                        )
                        .await?;
                    }
                    tag_tx.commit().await?;
                }
            }
        }
        Ok(())
    }
    .await;
    if let Err(err) = rebuild_result {
        tracing::warn!(
            error = %err,
            "inherited-tags cache rebuild failed AFTER the projection committed; \
             the committed state stands; inherited-tag reads may be stale until \
             the next full RebuildTagInheritanceCache (local tag op, \
             global-scope import, or snapshot restore) runs"
        );
    }

    Ok((changed_blocks, purged_blocks))
}

/// Boot-recovery entry point: re-run [`import_and_project`] for a single
/// leftover write-ahead inbox row `(space_id, bytes, inbox_id)`.
///
/// #535: thin `pub(crate)` wrapper so the recovery module doesn't need to
/// reconstruct a [`SpaceId`] or know the projection internals. Returns the
/// `(changed, purged)` block-id sets so the caller can fan out the SAME
/// inbound cache/FTS rebuilds the live path fires after `apply_remote`
/// (`Materializer::enqueue_inbound_sync_rebuilds` (app-side, via the `ApplyHost` trait)) —
/// the per-block projection here does NOT refresh the derived caches or the
/// FTS index, and no later boot step reconciles them. On success the inbox
/// row is deleted (in-tx, by `import_and_project`); on error the row is left
/// in place so a later boot can retry.
///
/// #792 / #1054: before the import, two guards mirror `apply_remote`'s
/// pre-import gates and DROP the slot (their own small DELETE) rather than
/// Import it: the own-peer fork guard (#792) and the `from_vv`
/// reachability gate (#1054). Both routes leave the next live sync session to
/// re-detect the condition in `apply_remote` and fall back to snapshot
/// catch-up — preventing a permanent poison row that would re-error at every
/// boot.
pub async fn replay_inbox_row(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
    space_id: &str,
    bytes: &[u8],
    inbox_id: i64,
    // #2292: purged ids decoded from this row's durable `purged_ids` tombstone
    // (empty for a non-purge slot). Forwarded into `import_and_project` so
    // Pass D re-sweeps the stale SQL rows even though the re-imported engine
    // delta is now empty.
    tombstone_purged: &[agaric_core::ulid::BlockId],
) -> Result<
    (
        Vec<agaric_core::ulid::BlockId>,
        Vec<agaric_core::ulid::BlockId>,
    ),
    AppError,
> {
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
        return Ok((Vec::new(), Vec::new()));
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
        return Ok((Vec::new(), Vec::new()));
    }

    // Both sets are returned to the caller: `replay_sync_inbox` accumulates
    // them across all replayed slots and fires ONE
    // `enqueue_inbound_sync_rebuilds` fan-out — the same load-bearing
    // cache/FTS reconciliation the live path runs after every import
    // (session_state_machine.rs); the per-block projection alone leaves the
    // derived caches and FTS stale. `RecoveryReplay` disables the #2264
    // no-op fast path: this slot's survival proves its projection never
    // committed, even if the engine (rehydrated from a `loro_doc_state`
    // persisted ahead of the crash) already holds every op in `bytes` — the
    // full-projection fallback reconciles SQL instead of silently dropping
    // the slot.
    import_and_project(
        pool,
        registry,
        device_id,
        &space,
        bytes,
        inbox_id,
        tombstone_purged,
        InboundDeliveryKind::RecoveryReplay,
    )
    .await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// #2621 Sync-D: `loro_sync_tests.rs` is hosted app-side by the `sync_protocol`
// shim (`src/sync_protocol/mod.rs`) — it references app-only `Materializer` /
// `recovery`, so the declaration lives in the app crate, not here.
