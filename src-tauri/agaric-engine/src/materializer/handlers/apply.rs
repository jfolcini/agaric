//! Apply-pipeline handlers: the per-op apply transaction, the apply
//! cursor, post-commit Restore/Delete cascade fan-out, and the
//! descendant-cohort collectors.

use super::*;

// #2621 (THE INVERSION): the apply kernel moved DOWN into `agaric-engine`
// (`crate::apply::kernel`). These re-exports keep the app-side
// coordinator / queue / command sites (`apply_op` below, `task_handlers`,
// `domain::block_ops`, the batch import path) calling the kernel through the
// unchanged `crate::materializer::handlers::…` paths.
pub use crate::apply::kernel::{
    ApplyEffects, ApplyMode, ChunkAccumulator, UnsweptBlock, advance_apply_cursor,
    apply_op_projected, apply_op_projected_with_mode, apply_op_tx, collect_delete_cohort,
    collect_restore_cohort,
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
        agaric_observability::record_op_apply_duration(
            self.started.elapsed().as_secs_f64() * 1000.0,
        );
    }
}

/// Takes `&Arc<OpRecord>` so callers (the `MaterializeTask::ApplyOp` arm)
/// that already hold the record as `Arc<OpRecord>` thread the borrow
/// through without a deep clone.
pub async fn apply_op(
    pool: &SqlitePool,
    record: &Arc<OpRecord>,
    state: &crate::loro::shared::LoroState,
) -> Result<(), AppError> {
    // #2896: live / remote single-op apply reprojects inline. Only the
    // boot-replay path reaches `apply_op_with_mode` with
    // `ApplyMode::ReplaySuppressed`.
    apply_op_with_mode(pool, record, ApplyMode::Normal, state).await
}

/// #2896 — [`apply_op`] with an EXPLICIT [`ApplyMode`]. The boot-replay
/// foreground task (`MaterializeTask::ReplayApplyOp`) routes through here so
/// each replayed op defers its inline reprojection into the replay-owned
/// [`ReplayDirtyParents`] sink; the [`apply_op`] wrapper passes
/// [`ApplyMode::Normal`]. The mode is stated per dispatch, so a concurrent
/// non-replay applier can never inherit replay suppression.
#[tracing::instrument(skip(pool, record, state, mode), fields(seq = record.seq), err)]
pub(super) async fn apply_op_with_mode(
    pool: &SqlitePool,
    record: &Arc<OpRecord>,
    mode: ApplyMode,
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
    let mut tx = agaric_store::db::begin_immediate_logged(pool, "materializer_apply_op").await?;
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
    let apply_result = apply_op_projected_with_mode(&mut tx, record, state, true, mode).await;
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
    // #4390: the THIRD `deleted_at` fan-out. A `MoveBlock` whose subject
    // carried an INHERITED tombstone re-derives it from the new position, in
    // SQL only, on the arm that has no engine — see `dispatch_unswept_cohort`.
    dispatch_unswept_cohort(
        record,
        &effects.unswept_cohort,
        effects.unswept_space_id.as_ref(),
        state,
    )
    .await;
    // #4285: the two fan-outs above mirror the SQL cohort onto the ENGINE.
    // This one repairs the SQL-side LINK edges of the same cohort — the half
    // #4209 reached for the seed and only the seed. Runs after them so the
    // reindex sees a cohort that is alive in both projections.
    reindex_restored_cohort_links(pool, &effects.restored_cohort, &effects.restored_ancestors)
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
/// [`agaric_store::op::OpPayload::RestoreBlock`] — synthetic per-descendant records have
/// no stored payload to JSON-parse, so going direct keeps the per-call
/// cost bounded by the per-space engine lock + the engine's per-block-id
/// mutation (single-digit microseconds).
///
/// Errors inside `engine_apply` are absorbed (warn + skip) so this
/// helper has nothing to propagate.  Every per-block call reuses the
/// root op's metadata (`device_id`, `seq`, `space_id`) so log lines
/// stay anchored to the user-visible op.
pub async fn dispatch_restore_descendants(
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
pub async fn dispatch_restore_ancestors(
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

/// #4285 — re-derive the LINK edges of every block a restore un-deleted, not
/// just the seed.
///
/// # What #4209 fixed, and where it stopped
///
/// #4209 gave `RestoreBlock`'s `invalidations_for_op` arm a per-block
/// `ReindexBlockLinks`, because a restore is the third way a block becomes
/// LINKABLE and the one #4118 did not observe. But that function is a pure
/// function of an `OpRecord` — no pool, no [`ApplyEffects`] — so it sees only
/// `record.block_id`, while a `RestoreBlock` un-deletes a whole COHORT: the
/// descendant subtree plus the #1884 contiguous ancestor chain. Every non-seed
/// member became linkable with nothing enqueued for it.
///
/// # Both directions, for the reason #4209 established
///
/// * INBOUND — a referrer that named the descendant while it was tombstoned
///   was declined by `reindex_block_links_conn`'s `deleted_at IS NULL` guard
///   and its debt recorded in `block_links_unresolved`. The debt is discharged
///   from the TARGET's reindex (`resolve_referrers_of`), which the descendant
///   never got, so the row survived with nothing left to trigger it.
/// * OUTBOUND — a reindex that ran while the block was soft-deleted read its
///   content as `WHERE … deleted_at IS NULL`, saw a content-less block, and
///   diffed its whole edge set away while correctly recording NO unresolved
///   row (only a live source owes a target, #4229). Nothing on the target side
///   can ever repair that; only a reindex of the block itself.
///
/// `run_reindex_block_links` runs `reindex_one_block_links` before
/// `resolve_referrers_of`, so one call per member covers both.
///
/// # Why this runs INLINE rather than enqueueing a task
///
/// The seed's repair is a background `ReindexBlockLinks`, but that queue is
/// reachable only from `CommandTx::commit_and_dispatch`. This helper has to
/// serve the REMOTE / replay path too (`apply_op`, the `BatchApplyOps` arm),
/// which holds a pool and a cohort and no queue handle — and on that path the
/// seed does not reach `invalidations_for_op` either, so an inline call is
/// what makes the remote restore work at all. Running the same code the task
/// would have run keeps one definition of the repair.
///
/// Cost is O(cohort), the same order as the engine fan-out beside it, and each
/// call is cheap for the overwhelmingly common member: a block with no link
/// tokens and no waiting referrers costs two source-keyed index seeks and an
/// empty diff. The seed is included and therefore repeated on the local path —
/// idempotent, and the alternative (special-casing which path enqueued what)
/// is worth less than the uniformity.
///
/// # Scope this does NOT extend to
///
/// A target made linkable by a PEER's non-restore op still does not reach the
/// push half. Inbound sync fans out through `enqueue_inbound_sync_rebuilds`,
/// which enqueues per-changed-block `UpdateFtsBlock` + `ReindexBlockTagRefs`
/// and a debounced global set, but no per-block link reindex — so a remotely
/// delivered `CreateBlock`/`EditBlock` that resolves a waiting referrer is
/// repaired only when something local touches one of the two blocks. That is
/// the pre-existing #4118 path bound (tracked in #4293), not something this
/// helper introduces; restores specifically ARE covered on the remote path,
/// because `apply_op` calls this.
///
/// Infallible / log-only, mirroring the engine fan-outs' call shape: the SQL
/// restore has already committed and a failed repair must not fail the op. A
/// member whose repair errors keeps its `block_links_unresolved` row, so the
/// retry-queue sweeper remains the recovery path.
///
/// No `QueueMetrics` handle is threaded in: two of the four call sites
/// (`apply_op`, the `BatchApplyOps` arm) do not hold one, and the only thing
/// it feeds is the `pending_retry_rows` GAUGE. Passing `None` keeps the seed
/// and the clear symmetric — both are skipped — so the gauge can only run
/// stale-LOW, which `note_retry_rows_deleted` already saturates at 0 by
/// design. It is never made inconsistent with the table.
///
/// Takes the two id sets as separate plain slices rather than a slice OF
/// slices: a `&[&[String]]` parameter makes the returned future's auto-trait
/// leakage higher-ranked over the inner lifetime, and every caller up the
/// `handle_foreground_task` chain then fails to prove `Send`.
pub async fn reindex_restored_cohort_links(
    pool: &SqlitePool,
    cohort: &[String],
    ancestors: &[String],
) {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for id in cohort.iter().chain(ancestors.iter()) {
        // The seed sits in the descendant cohort AND (for a
        // `restore_all_deleted` style call) can repeat across groups; the
        // reindex is idempotent but not free, so dedupe rather than repeat.
        if !seen.insert(id.as_str()) {
            continue;
        }
        if let Err(e) = super::task_handlers::run_reindex_block_links(pool, None, id, None).await {
            tracing::warn!(
                block_id = %id,
                error = %e,
                "#4285: link reindex for a restored cohort member failed; its \
                 unresolved rows stay for the retry sweeper"
            );
        }
    }
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
    use agaric_core::ulid::BlockId;
    use agaric_store::op::{OpPayload, RestoreBlockPayload};

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
    let space_id = match agaric_store::space::resolve_block_space(pool, &root_block).await {
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

/// Which of `block_ids` are KNOWN-ABSENT from `space_id`'s engine — the shared
/// membership probe behind the #4468 and #4472 fan-out guards.
///
/// # What "absent" means here, exactly
///
/// `LoroEngine::contains_block` is `node_for(id).is_some()`, and a `node_for`
/// miss is the one and only condition on which the engine's `get_block_map`
/// raises `block <id> not found`. So this set is precisely the set of members
/// whose `engine_apply` would fail for the reason "this block never entered
/// this engine" — and NOT for any other reason. A node that is present but
/// MALFORMED is `contains_block == true`, is not collected, still dispatches,
/// still raises, and still records the divergence. That case is real drift and
/// the guard must not silence it.
///
/// # Why a set built under ONE guard
///
/// The probe takes the per-space engine mutex once for the whole cohort and
/// drops it before any `engine_apply` takes its own, instead of re-acquiring
/// per member. `for_space` is not a free read — it lazily creates the engine
/// and marks the space dirty on every acquisition — so one acquisition for N
/// members is strictly cheaper than the N the fan-out already performs.
///
/// **TOCTOU:** a concurrent import can create a member between this probe and
/// its dispatch, in which case the mirror is skipped for a block the engine now
/// knows. That is not a new class: the whole post-commit fan-out is already
/// non-atomic with respect to the engine (each `engine_apply` takes and
/// releases the guard independently), and the next boot replay reconciles it.
/// Noted, not fixed.
///
/// # Metering
///
/// This function is a pure probe; the count is taken by
/// [`record_absent_from_engine_skip`] at each caller's actual skip site, so a
/// guard that stops skipping also stops counting.
///
/// The counter is the process-global SQL-only fallback one, with reason
/// `SqlOnlyFallbackReason::EngineMissingTarget` — the SAME vocabulary, for the
/// SAME condition, off the SAME `node_for` probe, that
/// `apply_delete_block_via_loro` already records in-transaction when it finds
/// its seed absent and takes the SQL-only cascade. The post-commit mirror's
/// skip is that decision's other half, so it belongs on that counter, which the
/// coordinator's status builder already surfaces as
/// `StatusInfo::sql_only_fallback_count`.
///
/// It deliberately does NOT record `descendant_fanout_dropped`: that counter
/// means "the engine may now be divergent from SQL", and for the population
/// this probe is written for — a member projected SQL-only during a no-space
/// window, so it never entered ANY engine — there is no node anywhere to
/// diverge.
///
/// **That justification is narrower than the probe, and the gap is real.**
/// `contains_block` answers for `space_id`'s engine ALONE, and `space_id` is
/// the SEED's space (each fan-out resolves exactly one). So a member can be
/// absent HERE and present in a DIFFERENT space's engine:
/// `apply_move_block_sql_only` reparents through `project_move_block_to_sql`,
/// which binds only `block_id` / `parent_id` / `position` and leaves
/// `blocks.space_id` untouched, so a block stamped for space Y can become a
/// `parent_id` descendant of a block in space X. `descendants_cte_active!()`
/// walks `parent_id` alone, so that block joins X's delete cohort; this probe
/// asks X, gets "absent", and the caller skips — while the block is still
/// alive in Y's engine and SQL has just tombstoned it. On THAT member the
/// classification is understated: it is exactly the "SQL deleted a cohort the
/// engine did not mirror" condition `descendant_fanout_dropped` names.
///
/// Accepted, and written down here rather than papered over. Nothing
/// REGRESSES: the mirror onto Y never happened either way, because a fan-out
/// only ever dispatches into the seed's space. Pre-#4472 that member was
/// dispatched to X, failed inside `get_block_map`, and bumped `divergence` —
/// loud, but by accident and against the wrong engine, since X was never the
/// engine that could have taken the mirror. Splitting the counter on "does
/// this member's own resolved space equal the fan-out's" would cost a
/// `resolve_block_space` round-trip PER MEMBER on a post-commit path that
/// today issues no query and holds no connection, to separate a residue that
/// requires a cross-space move under a since-deleted parent. Boot replay
/// reconciles both spaces regardless. Revisit if cross-space moves stop being
/// a corner case.
///
/// The skip must not be silent either — "absent from the engine" is also the
/// shape of genuine drift (a `CreateBlock` whose engine mirror failed and was
/// swallowed), and a `trace!`-only skip leaves that population uncountable at
/// every production level (#4468's skip was `trace!`-only; #4472 makes both
/// countable).
///
/// # On failure to acquire
///
/// An `Err` from `for_space` yields an EMPTY set, so every member dispatches
/// exactly as it did before this guard existed and `engine_apply`'s own
/// registry-failure arm reports the divergence with the detail. No error is
/// swallowed and no mirror the engine could have taken is ever skipped.
fn known_absent_from_engine<'a>(
    state: &crate::loro::shared::LoroState,
    space_id: &agaric_store::space::SpaceId,
    root_record: &OpRecord,
    block_ids: impl Iterator<Item = &'a str>,
) -> std::collections::HashSet<&'a str> {
    let mut absent: std::collections::HashSet<&'a str> = std::collections::HashSet::new();
    let Ok(mut guard) = state.registry.for_space(space_id, &root_record.device_id) else {
        return absent;
    };
    let engine = guard.engine_mut();
    for block_id in block_ids {
        if !engine.contains_block(block_id) {
            absent.insert(block_id);
        }
    }
    drop(guard);
    absent
}

/// Meter one fan-out member that [`known_absent_from_engine`] found absent and
/// the caller is therefore skipping (#4468/#4472).
///
/// Both fan-out guards call THIS, so the suppressed population is counted the
/// same way from both — and it is recorded at the point of the actual skip, not
/// at the probe, so a guard that stops skipping stops counting.
fn record_absent_from_engine_skip(root_record: &OpRecord, op: &'static str, block_id: &str) {
    super::sql_only_fallback::record(
        op,
        super::sql_only_fallback::SqlOnlyFallbackReason::EngineMissingTarget,
    );
    tracing::trace!(
        seq = root_record.seq,
        block_id = %block_id,
        op,
        "fanout: block absent from the engine; skipping the mirror (#4468/#4472)",
    );
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
///
/// ## Cohort members absent from this engine (#4472)
///
/// `deleted_cohort` is the set of rows the SQL cascade tombstoned, which is
/// not the same set as the blocks this space's engine knows. A member that was
/// projected SQL-only during a no-space window has no node here, and
/// `apply_delete_block` goes through `get_block_map`, which ERRORS on a missing
/// node — an error `engine_apply` turns into a `merge::divergence::record` bump
/// plus a `warn!`.
///
/// That is the same asymmetry #4468 fixed one helper down, and on this path the
/// two halves of the system openly contradict each other: for a delete whose
/// SEED is absent, `apply_delete_block_via_loro` has ALREADY probed the same
/// membership in-transaction, recorded
/// `SqlOnlyFallbackReason::EngineMissingTarget`, and taken the SQL-only cascade
/// — classifying the state as a legitimate soft fallback. The post-commit
/// fan-out then hands that identical block to `engine_apply`, which classifies
/// it as drift. So membership is probed here too, per member, via
/// `known_absent_from_engine`.
///
/// ### Why the guard is here and not at `ApplyEffects::deleted_cohort`
///
/// The obvious-looking alternative is to stop populating `deleted_cohort` in
/// `apply::kernel` when the in-tx apply already found the seed absent. That is
/// wrong in both directions:
///
/// * `deleted_cohort` is the SQL cascade's own output. It also feeds
///   `PreOpState::Cohort` (the `pages_cache` count refresh) and the command
///   path's `descendants_affected` reply, neither of which is about engine
///   membership. Truncating it there would corrupt two unrelated consumers to
///   fix a third.
/// * Seed membership does not imply cohort membership. A block C created in
///   this engine and later MOVED under an engine-absent parent A takes
///   `apply_move_block_via_loro`'s own `EngineMissingTarget` fallback: SQL
///   reparents C under A while the engine keeps C where it was. Deleting A then
///   yields a cohort whose seed is absent and whose descendant C is PRESENT.
///   Dropping the whole cohort would leave C alive in the engine while SQL
///   reports it deleted — exactly the divergence this helper exists to prevent,
///   reintroduced by the "fix".
///
/// The contradiction is not that the cohort is populated unconditionally; it is
/// that the fan-out was reading SQL-cascade membership as engine membership.
/// Per-member is the only granularity at which that is corrected.
pub async fn dispatch_delete_descendants(
    root_record: &OpRecord,
    cohort: &[String],
    space_id: Option<&agaric_store::space::SpaceId>,
    state: &crate::loro::shared::LoroState,
) {
    use agaric_core::ulid::BlockId;
    use agaric_store::op::OpPayload;

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

    // #4472: probe engine membership for the whole cohort under ONE guard,
    // released before any `engine_apply` takes its own. Only a KNOWN-absent
    // member is collected, and every skip below is metered as an
    // `EngineMissingTarget` SQL-only fallback — the same reason, off the same
    // probe, that `apply_delete_block_via_loro` records in-tx for the seed.
    // See this function's "Cohort members absent from this engine".
    let absent = known_absent_from_engine(
        state,
        space_id,
        root_record,
        cohort.iter().map(String::as_str),
    );

    for cohort_id in cohort {
        if absent.contains(cohort_id.as_str()) {
            // Never entered this engine (SQL-only projection during a no-space
            // window). `apply_delete_block` would raise `block not found` here,
            // and `engine_apply` would record that as drift — for the very
            // state the in-tx apply already classified as a legitimate soft
            // fallback.
            record_absent_from_engine_skip(root_record, "delete_block_cohort", cohort_id);
            continue;
        }
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

/// #4390 — the THIRD `deleted_at` fan-out, and the one that closes #4204's
/// open half.
///
/// # What it mirrors
///
/// `apply_move_block_sql_only`'s tail re-derives an INHERITED tombstone from
/// the subject's NEW position: it CLEARS the old cohort
/// (`unsweep_inherited_cohort_after_move`) and then lets
/// `sweep_move_under_tombstoned_ancestor` stamp whatever the new position
/// implies. Both halves write SQL and neither can write the engine — a move
/// whose subject is tombstoned is routed to that arm precisely BY
/// `resolve_block_space`'s `deleted_at IS NULL` filter, so the arm has no
/// engine by construction.
///
/// Without this fan-out the subject's per-space register keeps the OLD
/// cohort's timestamp, which a delete's `dispatch_delete_descendants` put
/// there for the whole cascade (seed *and* descendants — the reason
/// `reproject_block_deleted_at_from_engine`'s old "the engine stores
/// `deleted_at` on the delete seed only" claim was false for the op path).
/// The next snapshot import then reads that register and re-trashes the
/// subtree, so two peers disagree about whether the subtree is in the tree at
/// all (#4204) or about which cohort it is in (#4188) purely on whether they
/// learned the move by op replay or by import.
///
/// # Why it replays the SETTLED value rather than a blanket restore
///
/// [`UnsweptBlock`] carries the `deleted_at` the whole tail left on each row,
/// read back in-tx. `None` ⇒ `RestoreBlock` on the engine (#4204's shape, the
/// resurrection the maintainer ruling of 2026-08-26 adopts); `Some(ts)` ⇒
/// `DeleteBlock` at that exact marker (#4188's shape, where the sweep
/// re-stamped the rows this same tail had just cleared). A helper that
/// restored everything it un-swept would fix #4204 by breaking #4188.
///
/// # Space resolution
///
/// The space rides in from `ApplyEffects` rather than being resolved here,
/// captured in-tx with `resolve_soft_deleted_block_space` — the #2868 purge
/// helper, which reads the denormalized `blocks.space_id` and therefore
/// answers for a row that is soft-deleted. `resolve_block_space` would return
/// `None` for exactly the #4188 half.
///
/// # Blocks absent from this engine (#4468)
///
/// A block projected SQL-only during a no-space window never entered the
/// engine, and the two payload arms below disagree about that state:
/// `apply_restore_block` no-ops on a missing node, while `apply_delete_block`
/// goes through `get_block_map`, which ERRORS — and `engine_apply` turns that
/// error into a `merge::divergence::record` plus a `warn!`. That signal would
/// then fire on the arm reached *because* engine routing failed, i.e. for a
/// legitimate state rather than for drift. So membership is probed first and a
/// known-absent block is skipped, the same guard the engine arm's inline sweep
/// mirror uses for the same case (`crate::apply::loro_apply`, the
/// #4112 sweep block: `if engine.read_block(id)?.is_some()`) — expressed here
/// through [`known_absent_from_engine`], whose O(1) `contains_block` probe is
/// exactly equivalent to that `read_block` test and which meters each skip as
/// an `EngineMissingTarget` SQL-only fallback (#4472).
///
/// # Not covered: recovery's third interpreter
///
/// `db/recovery.rs`'s `move_block` arm hand-rolls the same un-sweep and is
/// deliberately out of scope: it runs before `sqlx::migrate!`, on a raw
/// executor, with no `LoroState` in scope — there is no engine there to
/// mirror onto. Recorded at that arm rather than left implicit.
///
/// Errors inside `engine_apply` are absorbed (warn + skip), so this helper has
/// nothing to propagate — the same contract as
/// [`dispatch_delete_descendants`].
pub(crate) async fn dispatch_unswept_cohort(
    root_record: &OpRecord,
    unswept: &[UnsweptBlock],
    space_id: Option<&agaric_store::space::SpaceId>,
    state: &crate::loro::shared::LoroState,
) {
    use agaric_core::ulid::BlockId;
    use agaric_store::op::{OpPayload, RestoreBlockPayload};

    if unswept.is_empty() {
        return;
    }

    let Some(space_id) = space_id else {
        // `resolve_soft_deleted_block_space` answered `None`, so this apply
        // cannot name an engine: the block's own `blocks.space_id` is NULL —
        // pre-spaces data, or a row whose column has not been propagated yet
        // (that resolver reads the column ALONE, with no `COALESCE` fallback
        // to the owning page) — or the row is gone. The SQL re-derivation
        // still stands as the durable outcome. Metered on the same counter as
        // the delete/restore fan-outs' unresolved-space skip (#2031) so the
        // divergence is observable rather than silent.
        super::descendant_fanout_dropped::record();
        tracing::trace!(
            seq = root_record.seq,
            "un-sweep fanout: no space for the moved block; skipping (#4390)",
        );
        return;
    };

    // #4468: probe engine membership up front, under ONE guard that is
    // released before `engine_apply` takes its own. Only a KNOWN-absent block
    // is collected — a present-but-malformed node dispatches exactly as it did
    // before, so the guard can never swallow a mirror the engine could have
    // taken. A registry failure is `engine_apply`'s own to report, with the
    // detail, so nothing is probed and nothing is skipped in that case.
    //
    // NOT a free read: `for_space` lazily creates the engine and marks the
    // space dirty on every acquisition (`loro_vv` exists precisely to avoid
    // that on read-only paths). Taking it once here is still strictly cheaper
    // than the N acquisitions the dispatch loop below already performs — but
    // this shape must not be copied onto a path that is genuinely read-only.
    //
    // TOCTOU: a concurrent import can create a member between the probe and
    // its dispatch, and the mirror is then skipped for a block the engine now
    // knows. The probe holds the guard across no `.await` and drops it before
    // `engine_apply` takes its own, so this adds no new class — the whole
    // post-commit fan-out is already non-atomic w.r.t. the engine, and boot
    // replay reconciles. Noted, not fixed. See #4473's analysis.
    let absent = known_absent_from_engine(
        state,
        space_id,
        root_record,
        unswept.iter().map(|b| b.block_id.as_str()),
    );

    for block in unswept {
        if absent.contains(block.block_id.as_str()) {
            // Never entered this engine (SQL-only projection during a
            // no-space window). Skipping is what `apply_restore_block`
            // already does for the `None` arm; without this the `Some(_)`
            // arm would instead raise a divergence signal for a legitimate
            // state. See this function's "Blocks absent from this engine".
            record_absent_from_engine_skip(root_record, "move_block_unswept", &block.block_id);
            continue;
        }
        let payload = match block.deleted_at {
            // #4204: the new position implies no cohort — the block is live in
            // SQL, so the engine must agree or the next import undoes it.
            None => OpPayload::RestoreBlock(RestoreBlockPayload {
                block_id: BlockId::from_trusted(&block.block_id),
                // Per-block-id on the engine; `apply_restore_block` clears the
                // marker regardless of the SQL timestamp, exactly as
                // `fan_out_restore` documents for its own synthesised value.
                deleted_at_ref: root_record.created_at,
            }),
            // #4188: the sweep re-stamped it at the new ancestor's cohort.
            // Mirror THAT timestamp, not the op's `created_at` — the engine
            // marker is the cohort identity a later import reads back.
            Some(_) => OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::from_trusted(&block.block_id),
            }),
        };

        let op_id = format!(
            "{}/{}#unswept/{}",
            root_record.device_id, root_record.seq, block.block_id,
        );
        // `engine_apply`'s `DeleteBlock` arm writes `op_created_at` as the
        // engine's `deleted_at` marker, so the settled cohort ts is threaded
        // through that parameter. The `RestoreBlock` arm ignores it.
        let marker = block
            .deleted_at
            .unwrap_or(root_record.created_at)
            .to_string();
        crate::merge::engine_apply(
            &op_id,
            &payload,
            &root_record.device_id,
            space_id,
            &marker,
            state,
        );
    }
}
