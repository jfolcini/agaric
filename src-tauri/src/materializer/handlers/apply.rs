//! Apply-pipeline handlers: the per-op apply transaction, the apply
//! cursor, post-commit Restore/Delete cascade fan-out, and the
//! descendant-cohort collectors.

use super::*;

// #2621 (THE INVERSION): the apply kernel moved DOWN into `agaric-engine`
// (`agaric_engine::apply::kernel`). These re-exports keep the app-side
// coordinator / queue / command sites (`apply_op` below, `task_handlers`,
// `domain::block_ops`, the batch import path) calling the kernel through the
// unchanged `crate::materializer::handlers::…` paths.
pub(crate) use agaric_engine::apply::kernel::{
    ApplyEffects, ChunkAccumulator, advance_apply_cursor, apply_op_projected, apply_op_tx,
    collect_delete_cohort, collect_restore_cohort,
};


/// RAII timer that records the elapsed wall-clock of one [`apply_op`] to the
/// `agaric.materializer.op_apply.duration` histogram on drop — so every exit
/// path (success AND the `?`-propagated errors) is captured without threading a
/// record call through each early return. PII-free (an opaque duration only).
/// When observability is off the record is a no-op (global no-op meter), so the
/// guard costs an `Instant` + a no-op call.
struct OpApplyTimer {
    started: std::time::Instant,
}

impl OpApplyTimer {
    fn start() -> Self {
        Self {
            started: std::time::Instant::now(),
        }
    }
}

impl Drop for OpApplyTimer {
    fn drop(&mut self) {
        crate::observability::record_op_apply_duration(
            self.started.elapsed().as_secs_f64() * 1000.0,
        );
    }
}

/// Takes `&Arc<OpRecord>` so callers (the `MaterializeTask::ApplyOp` arm)
/// that already hold the record as `Arc<OpRecord>` thread the borrow
/// through without a deep clone.
#[tracing::instrument(skip(pool, record, state), fields(seq = record.seq), err)]
pub(super) async fn apply_op(
    pool: &SqlitePool,
    record: &Arc<OpRecord>,
    state: &crate::loro::shared::LoroState,
) -> Result<(), AppError> {
    // Time the whole per-op apply and record it to the
    // `agaric.materializer.op_apply.duration` histogram on EVERY exit (the
    // `?`-propagated error paths included), via an RAII guard. The record helper
    // is unconditional + free when observability is off (the global meter is a
    // no-op), so this adds an `Instant::now()` + a no-op record on the hot path.
    let _apply_timer = OpApplyTimer::start();

    // SQL-review route through `begin_immediate_logged` so
    // sync-burst contention surfaces as upfront serialised wait (with
    // a `warn!` if slow) instead of mid-tx `busy_timeout` stalls
    // under SQLite's default DEFERRED isolation.
    let mut tx = crate::db::begin_immediate_logged(pool, "materializer_apply_op").await?;
    // #2604 — arm the engine-rollback scope for this single-op apply. The
    // `apply_op_projected` call below mutates the canonical per-space engine IN
    // PLACE (outside the SQL tx's atomicity); each mutation handler's
    // `for_space_recording` captures the touched space's pre-op checkpoint into
    // the armed log. If the projection or the commit fails, the engine is
    // rewound to that checkpoint so it never stays ahead of the rolled-back SQL
    // (the REMOTE-path divergence #2603 pins, which — unlike the LOCAL path —
    // does not self-heal via boot replay).
    let revert = crate::loro::revert::RevertScope::arm(state);
    // #2325/#2250: the single-op REMOTE path and the LOCAL command path now
    // share ONE projection function, [`apply_op_projected`]. The only
    // variation is the `advance_cursor` flag: `true` here (the REMOTE /
    // single-op path advances the global apply cursor in the same tx), `false`
    // on the LOCAL command sites (they rely on boot-replay idempotency and must
    // NOT move the cursor — #1257). The single-device `debug_assert!` guard and
    // the `advance_apply_cursor` call moved INTO that function's
    // `advance_cursor` branch.
    let apply_result = apply_op_projected(&mut tx, record, state, true).await;
    // Lift the recorded checkpoints out of the shared log WHILE the
    // `BEGIN IMMEDIATE` write lock is still held (the `commit()`/rollback below
    // releases it). This keeps the log armed only under that lock, so no
    // concurrent writer can ever record into another tx's log (#2604).
    let pending = revert.detach();
    // BOTH failure modes rewind the engine: a `?` out of `apply_op_projected`
    // (engine already mutated, SQL projection failed → tx rolls back on drop)
    // and a failing `commit()`. On success `pending` is dropped, keeping the op.
    let effects = match apply_result {
        Ok(effects) => match tx.commit().await {
            Ok(()) => effects,
            Err(e) => {
                pending.revert();
                return Err(e.into());
            }
        },
        Err(e) => {
            drop(tx); // roll back the SQL projection before rewinding the engine
            pending.revert();
            return Err(e);
        }
    };

    // The op itself was engine-applied INSIDE the tx above
    // (`apply_op_tx` → `apply_*_via_loro`, #400-routed on
    // `index`/`new_index`). There is deliberately NO per-op post-commit
    // engine re-dispatch: the old `dispatch_for_record` call re-applied
    // every op through the legacy position path, converging engine
    // sibling order toward ULID order on every boot replay (#603).
    // Note the engine therefore observes the op BEFORE the commit; a
    // tx rollback leaves the engine ahead of SQL until the next op-log
    // replay reconciles it (pre-existing property of the via-loro
    // design, see `apply_create_block_via_loro`'s atomicity note).
    //
    // RestoreBlock / DeleteBlock cascade fan-out. The SQL helpers
    // walk the descendant cohort but the Loro engine is per-block-id
    // only; without fan-out a 10-descendant subtree restore would
    // leave 9 blocks with stale `deleted_at` state in Loro. We
    // synthesise per-descendant ops sharing the root record's
    // metadata and apply each to the engine. Space id was captured
    // PRE-UPDATE in `apply_op_tx` because `resolve_block_space`
    // filters `deleted_at IS NULL`; a post-commit lookup would return
    // `None` for every cohort row.
    dispatch_restore_descendants(pool, record, &effects.restored_cohort, state).await;
    // #2017: symmetric UPWARD fan-out. The SQL restore also un-deleted the
    // contiguous soft-deleted ANCESTOR chain (the #1884 live-orphan fix) but
    // the in-tx engine apply touched only the seed, so the ancestors are alive
    // in SQL yet still tombstoned in the per-space CRDT. Without this fan-out
    // the next `reproject_block_deleted_at` re-deletes them in SQL —
    // self-perpetuating divergence. Reuses the same engine RestoreBlock helper
    // as the descendant fan-out.
    dispatch_restore_ancestors(pool, record, &effects.restored_ancestors, state).await;
    dispatch_delete_descendants(
        record,
        &effects.deleted_cohort,
        effects.delete_space_id.as_ref(),
        state,
    )
    .await;

    Ok(())
}


/// Fan out `RestoreBlock` for the full cohort the SQL cascade
/// restored (seed + every descendant). The engine's
/// `apply_restore_block` is per-block-id only, so without this fanout
/// a SQL restore of a 10-descendant subtree would leave 9 blocks
/// marked `deleted_at != Null` in the Loro doc. The materializer owns
/// the fan-out so the engine API stays per-block-id and SQL remains
/// the source of truth for the descendant cohort.
///
/// ## Why the cohort INCLUDES the seed
///
/// The in-tx engine apply (`apply_restore_block_via_loro`) already
/// targets the seed block, so the seed is applied twice (once in-tx,
/// once via this helper).  Engine `apply_restore_block` is idempotent
/// (no-op on an already-restored block).  Including the seed here makes
/// this helper the canonical cohort-restore function regardless of
/// whether the in-tx apply reached the engine for any specific op
/// record (it falls back to SQL-only on unresolved space / uninit Loro
/// state).  Net cost: one extra idempotent engine call per
/// RestoreBlock.
///
/// ## Implementation note
///
/// We call `engine_apply` directly with a synthesised
/// [`OpPayload::RestoreBlock`] — synthetic per-descendant records have
/// no stored payload to JSON-parse, so going direct keeps the per-call
/// cost bounded by the per-space engine lock + the engine's per-block-id
/// mutation (single-digit microseconds).
///
/// Errors inside `engine_apply` are absorbed (warn + skip) so this
/// helper has nothing to propagate.  Every per-block call reuses the
/// root op's metadata (`device_id`, `seq`, `space_id`) so log lines
/// stay anchored to the user-visible op.
pub(crate) async fn dispatch_restore_descendants(
    pool: &SqlitePool,
    root_record: &OpRecord,
    cohort: &[String],
    state: &crate::loro::shared::LoroState,
) {
    // #2226: thin wrapper over the shared restore fan-out; the downward cohort
    // and upward ancestor variants differ only in the op-id infix + log wording
    // carried by `FanoutKind`.
    fan_out_restore(pool, root_record, cohort, FanoutKind::Descendants, state).await;
}

/// #2017: symmetric UPWARD companion to [`dispatch_restore_descendants`].
///
/// A `RestoreBlock` SQL apply un-deletes not only the seed + descendant
/// cohort but ALSO the contiguous soft-deleted ANCESTOR chain above the
/// block (the #1884 live-orphan fix). The in-tx engine apply
/// (`apply_restore_block_via_loro`) touches only the SEED, so without this
/// fan-out the ancestors are alive in SQL but still tombstoned in the
/// per-space CRDT. `reproject_block_deleted_at` then reads the engine
/// (still "deleted") and RE-DELETES the ancestor in SQL — a
/// self-perpetuating divergence that re-deletes the ancestor on every
/// reproject. This helper drives `RestoreBlock` onto the engine for every
/// id in the chain, mirroring the descendant fan-out exactly.
///
/// Space is resolved once from the root block (every ancestor is in the
/// same space — they share the seed's per-space tree, and all are alive
/// again post-commit so `resolve_block_space` succeeds). The synthesised
/// `deleted_at_ref` is irrelevant to the engine's `apply_restore_block`
/// (per-block-id; clears the deleted marker regardless of the SQL
/// timestamp), so we reuse the root's. Errors are absorbed inside
/// `engine_apply`. The #2031 fanout-dropped metric is bumped on the same
/// unresolved-space / parse-failure paths as the descendant helper.
pub(crate) async fn dispatch_restore_ancestors(
    pool: &SqlitePool,
    root_record: &OpRecord,
    ancestors: &[String],
    state: &crate::loro::shared::LoroState,
) {
    // #2226: thin wrapper over the shared restore fan-out (see
    // [`dispatch_restore_descendants`]); only the op-id infix (`#ancestor/`)
    // and log wording differ, both carried by `FanoutKind::Ancestors`.
    fan_out_restore(pool, root_record, ancestors, FanoutKind::Ancestors, state).await;
}

/// Which restore fan-out is being driven onto the per-space engine.
///
/// [`dispatch_restore_descendants`] (downward cohort) and
/// [`dispatch_restore_ancestors`] (upward chain, #2017 / #1884) were
/// byte-for-byte identical apart from the op-id infix and the log/metric
/// wording; this enum selects those so both share one body
/// ([`fan_out_restore`]).
///
/// The `DeleteBlock` cascade ([`dispatch_delete_descendants`]) is deliberately
/// NOT modelled here: it carries a different payload type
/// (`OpPayload::DeleteBlock`, no `deleted_at_ref`) and resolves its space from a
/// caller-supplied `SpaceId` param rather than from the pool, so folding it into
/// this restore-shaped body would contort it rather than simplify it.
#[derive(Clone, Copy)]
enum FanoutKind {
    /// Downward descendant-cohort restore — op-id infix `#cohort/`.
    Descendants,
    /// Upward ancestor-chain restore (#1884 live-orphan fix / #2017 engine
    /// fan-out) — op-id infix `#ancestor/`.
    Ancestors,
}

impl FanoutKind {
    /// The op-id infix segment (`cohort` → `#cohort/`, `ancestor` →
    /// `#ancestor/`) that lets triage tell the two synthetic fan-out families
    /// apart in the op log.
    fn op_id_infix(self) -> &'static str {
        match self {
            FanoutKind::Descendants => "cohort",
            FanoutKind::Ancestors => "ancestor",
        }
    }

    /// Log-line prefix — `restore-cascade fanout` / `restore-ancestor fanout`.
    fn log_prefix(self) -> &'static str {
        match self {
            FanoutKind::Descendants => "restore-cascade fanout",
            FanoutKind::Ancestors => "restore-ancestor fanout",
        }
    }

    /// Noun used in the parse-failure skip line (`skipping <noun>`).
    fn fanout_noun(self) -> &'static str {
        match self {
            FanoutKind::Descendants => "descendant fan-out",
            FanoutKind::Ancestors => "ancestor fan-out",
        }
    }
}

/// #2226: shared body for the two symmetric restore fan-outs. Drives
/// `RestoreBlock` onto the per-space engine for every id in `ids`, reusing the
/// root op's metadata; `kind` selects the op-id infix + log wording.
///
/// The #2031 fanout-dropped metric is bumped (with the same warn/trace lines
/// as before) on exactly the three skip paths: unparseable root payload,
/// unresolved root space, or a `resolve_block_space` error. Errors inside
/// `engine_apply` are absorbed there, so this helper has nothing to propagate.
async fn fan_out_restore(
    pool: &SqlitePool,
    root_record: &OpRecord,
    ids: &[String],
    kind: FanoutKind,
    state: &crate::loro::shared::LoroState,
) {
    use crate::op::{OpPayload, RestoreBlockPayload};
    use crate::ulid::BlockId;

    if ids.is_empty() {
        return;
    }

    // Parse the root's payload once to extract `deleted_at_ref`. The payload is
    // the raw inner-only JSON (per `serialize_inner_payload` in `op_log.rs`),
    // not the tagged `OpPayload` form, so we go through the inner struct.
    let root_payload: RestoreBlockPayload = match serde_json::from_str(&root_record.payload) {
        Ok(p) => p,
        Err(e) => {
            // #2031: the SQL restore already committed but we cannot fan out to
            // the engine — it stays divergent until boot replay reconciles.
            // Meter the skip so it is observable.
            super::descendant_fanout_dropped::record();
            tracing::warn!(
                seq = root_record.seq,
                error = %e,
                "{}: failed to parse root RestoreBlockPayload; skipping {}",
                kind.log_prefix(),
                kind.fanout_noun(),
            );
            return;
        }
    };

    // Resolve the space once via the root's block_id (every id shares the seed's
    // per-space tree and is alive again post-commit, so `resolve_block_space`
    // succeeds). Keeps fanout O(N) on the engine call, not on SQL queries.
    let root_block = BlockId::from_trusted(root_payload.block_id.as_str());
    let space_id = match crate::space::resolve_block_space(pool, &root_block).await {
        Ok(Some(s)) => s,
        Ok(None) => {
            // #2031: SQL restore committed but the root block has no resolvable
            // space, so the engine cohort cannot be mirrored and stays divergent
            // until boot replay. Meter the skip.
            super::descendant_fanout_dropped::record();
            tracing::trace!(
                block_id = root_payload.block_id.as_str(),
                "{}: no space for root block; skipping",
                kind.log_prefix(),
            );
            return;
        }
        Err(e) => {
            // #2031: resolve_block_space failed post-commit; the engine cohort
            // is left divergent. Meter the skip.
            super::descendant_fanout_dropped::record();
            tracing::warn!(
                error = %e,
                "{}: resolve_block_space failed; skipping",
                kind.log_prefix(),
            );
            return;
        }
    };

    for id in ids {
        // Build the typed payload directly (no JSON round-trip). The engine's
        // `apply_restore_block` is per-block-id; `deleted_at_ref` is unused by
        // it (it only clears the deleted marker), so reusing the root's is safe
        // for both the descendant cohort and the ancestor chain.
        let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::from_trusted(id),
            deleted_at_ref: root_payload.deleted_at_ref,
        });

        let op_id = format!(
            "{}/{}#{}/{}",
            root_record.device_id,
            root_record.seq,
            kind.op_id_infix(),
            id,
        );
        crate::merge::engine_apply(
            &op_id,
            &payload,
            &root_record.device_id,
            &space_id,
            &root_record.created_at.to_string(),
            state,
        );
    }
}

/// Symmetric companion to [`dispatch_restore_descendants`] for the
/// `DeleteBlock` cascade.
///
/// The SQL `apply_delete_block_tx` walks `descendants_cte_active!()`
/// and stamps `deleted_at` on every active descendant. The Loro
/// engine's `apply_delete_block` is per-block-id only, so without this
/// fanout a 10-descendant subtree delete would leave 9 blocks alive in
/// the engine while SQL reports them deleted. The materializer owns
/// the fan-out so the engine API stays per-block-id and SQL remains
/// the source of truth for the descendant cohort.
///
/// ## Why the cohort INCLUDES the seed
///
/// Same idempotent-seed rationale as `dispatch_restore_descendants`:
/// the in-tx engine apply (`apply_delete_block_via_loro`) already
/// targets the seed, so including the seed here yields one extra
/// idempotent engine call per `DeleteBlock` (engine
/// `apply_delete_block` is a no-op on an already-deleted block — sets
/// `deleted_at` to the same marker). Including the seed makes this
/// helper the canonical cohort-delete function regardless of whether
/// the in-tx apply reached the engine for any specific op record.
///
/// ## Implementation note
///
/// We synthesise a per-cohort `OpPayload::DeleteBlock` and call
/// `engine_apply` directly (no JSON round-trip through a stored
/// payload).  Errors inside `engine_apply`
/// are absorbed (warn + skip) so this helper has nothing to propagate.
/// Per-call cost is bounded by the per-space engine lock + the engine's
/// per-block-id mutation (single-digit microseconds).
pub(crate) async fn dispatch_delete_descendants(
    root_record: &OpRecord,
    cohort: &[String],
    space_id: Option<&crate::space::SpaceId>,
    state: &crate::loro::shared::LoroState,
) {
    use crate::op::OpPayload;
    use crate::ulid::BlockId;

    if cohort.is_empty() {
        return;
    }

    let Some(space_id) = space_id else {
        // Pre-UPDATE space resolve returned None — the seed has no
        // resolvable space (pre-spaces data, or a block whose owning
        // page never received a `space` SetProperty). Nothing to do —
        // there's no canonical engine to mirror onto. The SQL-side
        // delete already stands as the durable outcome.
        //
        // #2031: SQL delete committed but the descendant cohort cannot
        // be mirrored onto an engine, leaving it divergent until boot
        // replay. Meter the skip so it is observable.
        super::descendant_fanout_dropped::record();
        tracing::trace!(
            seq = root_record.seq,
            "delete-cascade fanout: no space captured for root block; skipping",
        );
        return;
    };

    for cohort_id in cohort {
        // Build the typed payload directly (no JSON round-trip).
        let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::from_trusted(cohort_id),
        });

        let op_id = format!(
            "{}/{}#cohort/{}",
            root_record.device_id, root_record.seq, cohort_id,
        );
        crate::merge::engine_apply(
            &op_id,
            &payload,
            &root_record.device_id,
            space_id,
            &root_record.created_at.to_string(),
            state,
        );
    }
}

