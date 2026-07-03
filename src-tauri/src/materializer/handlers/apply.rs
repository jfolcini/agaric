//! Apply-pipeline handlers: the per-op apply transaction, the apply
//! cursor, post-commit Restore/Delete cascade fan-out, and the
//! descendant-cohort collectors.

use super::*;

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
    // #2325/#2250: the single-op REMOTE path and the LOCAL command path now
    // share ONE projection function, [`apply_op_projected`]. The only
    // variation is the `advance_cursor` flag: `true` here (the REMOTE /
    // single-op path advances the global apply cursor in the same tx), `false`
    // on the LOCAL command sites (they rely on boot-replay idempotency and must
    // NOT move the cursor — #1257). The single-device `debug_assert!` guard and
    // the `advance_apply_cursor` call moved INTO that function's
    // `advance_cursor` branch.
    let effects = apply_op_projected(&mut tx, record, state, true).await?;
    tx.commit().await?;

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

/// #2325/#2250 — the SINGLE collapsed apply-projection entry point shared by
/// the single-op REMOTE path ([`apply_op`], `advance_cursor = true`) and the
/// LOCAL command sites (`advance_cursor = false`).
///
/// Before this, the LOCAL command path (`apply_*_via_loro` in a `CommandTx`)
/// and this single-op REMOTE path (`apply_op_tx` + cursor advance) were two
/// parallel projection paths that had to be kept byte-identical by hand — the
/// exact drift hazard #2250 flags. They now differ ONLY in the `advance_cursor`
/// flag.
///
/// Runs the op through [`apply_op_tx`] (engine-apply + SQL projection, with the
/// derived maintenance passes run inline — `chunk = None`, a "chunk of one")
/// and, ONLY when `advance_cursor` is set, runs the single-device guard and
/// advances the global materializer apply cursor to `record.seq` in the SAME
/// transaction.
///
/// # Why `advance_cursor` is a caller flag, not intrinsic
///
/// The REMOTE / single-op path advances the cursor so
/// `materialized_through_seq` tracks applied state. The LOCAL command path
/// deliberately does NOT (#1257): it leaves the cursor put so boot replay
/// re-applies every LOCAL op idempotently — the safety net while local
/// engine-apply hardens.
///
/// Returns the [`ApplyEffects`] from `apply_op_tx` UNCHANGED so the caller runs
/// the post-commit cohort fan-out (restore/delete descendants + ancestors)
/// AFTER it commits — the LOCAL delete/restore sites consume this instead of
/// their hand-rolled cohort capture.
pub(crate) async fn apply_op_projected(
    tx: &mut sqlx::SqliteConnection,
    record: &OpRecord,
    state: &crate::loro::shared::LoroState,
    advance_cursor: bool,
) -> Result<ApplyEffects, AppError> {
    // #2200: pass `None` — single-op / LOCAL apply is a "chunk of one", so the
    // derived maintenance passes (dense reproject, count recompute) run inline,
    // exactly as before. Only the batch import path opts into deferral.
    let effects = apply_op_tx(tx, record, None, state).await?;

    if advance_cursor {
        // #412 / #667 — SINGLE-DEVICE-CURSOR ASSUMPTION (single-op mirror of
        // the `BatchApplyOps` arm's guard in `task_handlers.rs`).
        //
        // `advance_apply_cursor` below moves a SINGLE GLOBAL scalar cursor to
        // `record.seq`, but `op_log.seq` is a PER-DEVICE counter (PK
        // `(device_id, seq)`). Advancing the global cursor for an op from one
        // device is only sound when the entire op_log belongs to that ONE
        // device — otherwise the cursor jumps past another device's
        // unmaterialised ops (which sit at `seq <= cursor`) and boot replay
        // silently drops them. The batch arm `debug_assert!`s the equivalent
        // within-batch invariant, and boot replay (`recovery::replay`)
        // hard-errors on a multi-device op_log in ALL builds; this is the
        // missing single-op counterpart.
        //
        // It is a `debug_assert!` (not a release-build `return Err`) on
        // purpose: multi-device single-op apply is NOT a supported production
        // path. Multi-device sync is unshipped (the remote-apply path is
        // test-only and the SyncDaemon is dormant until a peer is paired), and
        // the `advance_cursor = true` caller (`apply_op`) is reached only via
        // the test-only `dispatch_op` helper today. The release-build guard
        // already lives at boot (`replay.rs` `#412`); this assert exists to
        // catch a test/dev regression that wires a multi-device single-op apply
        // before the per-device watermark cursor lands. Remove once that cursor
        // ships.
        #[cfg(debug_assertions)]
        {
            // #2282 — index-backed O(log N) single-device probe. The op_log PK
            // `(device_id, seq)` indexes `device_id`, so `MIN`/`MAX` are
            // first/last index seeks: equal MIN and MAX ⇒ the whole log is one
            // device (COALESCE handles the empty log — vacuously single-device).
            let single_device: bool = sqlx::query_scalar!(
                r#"SELECT COALESCE(MIN(device_id) = MAX(device_id), 1) AS "single!: bool" FROM op_log"#
            )
            .fetch_one(&mut *tx)
            .await?;
            debug_assert!(
                single_device,
                "apply_op_projected advances a single global apply cursor for device {:?} but \
                 op_log spans multiple devices; the single global cursor cannot \
                 represent per-device watermarks — per-device cursor partitioning is \
                 required (backend audit #412)",
                record.device_id,
            );
        }
        // C-2b: advance the cursor in the same tx so `apply + cursor` are
        // atomic. A crash before the caller commits rolls both back together;
        // the cursor never points ahead of materialised state.
        advance_apply_cursor(tx, record.seq).await?;
    }

    Ok(effects)
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

/// C-2b: advance the materializer apply cursor inside the apply tx so
/// `apply + cursor` are atomic. The cursor is monotonic (`MAX`), so
/// out-of-order replay attempts (or mixed-direction batches) are no-ops.
///
/// The single-row table is seeded by migration `0040`; this UPDATE
/// always targets `id = 1`. The MAX semantics guarantee that
/// re-applying an already-applied op is a no-op for the cursor.
pub(super) async fn advance_apply_cursor(
    conn: &mut sqlx::SqliteConnection,
    seq: i64,
) -> Result<(), AppError> {
    let updated_at = crate::db::now_ms();
    sqlx::query!(
        "UPDATE materializer_apply_cursor \
         SET materialized_through_seq = MAX(materialized_through_seq, ?), \
             updated_at = ? \
         WHERE id = 1",
        seq,
        updated_at,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// #2200 Tier-2 import scaling: per-CHUNK accumulator that turns two
/// per-block O(N) passes into a single end-of-chunk O(N) pass.
///
/// A "chunk" is one `BatchApplyOps` transaction (the import path threads an
/// N-block CreateBlock batch through `apply_op_tx` in a loop). Two derived
/// maintenance steps were previously run once PER block, giving O(N²) total
/// work for an N-sibling / N-page import:
///
/// 1. **Dense-position reprojection** (`reproject_dense_positions`): each
///    imported block re-ranked its WHOLE sibling group. Instead we record the
///    latest authoritative sibling ordering per touched parent and reproject
///    each parent ONCE at end-of-chunk. Correct because
///    `LoroEngine::children_ordered_block_ids` returns the full post-insert
///    ordering on every call, so the LAST create touching a given parent
///    carries the complete final order — reprojecting that once yields exactly
///    the ranks the per-block reprojection would have converged on (#400: the
///    ordering key is insertion-stable, so deferring never reorders).
///
/// 2. **`pages_cache` count recompute** (`recompute_pages_cache_counts_for_pages`):
///    each CreateBlock ran a full descendant `COUNT(*)` for its page. Instead
///    we accumulate the distinct affected page ids and recompute their counts
///    ONCE at end-of-chunk. The per-op affected-page RESOLUTION (which has
///    side effects: `pages_cache` row seeding for page-creates, in-tx
///    `reindex_block_links`) still runs per op; only the terminal count
///    recompute is deferred. Final counts equal the per-block behaviour
///    because the recompute is a pure function of committed `blocks` /
///    `block_links` state, which is identical at end-of-chunk regardless of
///    how many times we recomputed en route.
///
/// The single-op path (`apply_op`) and every LOCAL command path pass `None`,
/// so their "chunk of one" flushes inline exactly as before — behaviour is
/// unchanged off the batch path.
///
/// ## Deferral is gated to ALL-`CreateBlock` chunks
///
/// The reprojection deferral is ONLY safe when the entire chunk is
/// `CreateBlock` ops. The accumulator snapshots each touched parent's sibling
/// order at create-time and replays it once at flush; a later same-parent
/// op in the same batch that reprojects INLINE (Move/Restore/Delete still do)
/// would be clobbered by the stale snapshot replay. The `BatchApplyOps` arm in
/// `task_handlers.rs` therefore constructs the accumulator (`Some`) ONLY when
/// every record in the batch is a `CreateBlock`; a mixed-op batch passes `None`
/// so EVERY op — creates included — reprojects inline exactly as it did before
/// this optimization (the known-correct behaviour). This makes the
/// stale-snapshot clobbering impossible: deferral runs only when there are no
/// moves/deletes/restores to invalidate a snapshot. The common markdown/import
/// path is all-create, so it keeps the deferral perf win.
#[derive(Default)]
pub(crate) struct ChunkAccumulator {
    /// Latest authoritative sibling ordering per touched parent group. Keyed
    /// by `(space_id, Option<block_id>)` where the second element is the
    /// parent's block id (`None` = that space's top-level group). The value is
    /// the full ordered child-id list read from the engine after the most
    /// recent insert into that group during the chunk — reprojecting it once at
    /// flush produces the final dense ranks.
    ///
    /// The key is SPACE-QUALIFIED (not a bare `Option<block_id>`): a single
    /// all-create chunk MAY span spaces (space is resolved per-op, and the
    /// batch arm only enforces single-DEVICE, not single-space). Non-`None`
    /// parent ids are globally-unique ULIDs so they never collide across
    /// spaces, but the `None` (top-level) key is NOT — a batch creating
    /// top-level blocks in two spaces would otherwise have one space's ordering
    /// overwrite the other's under last-writer-wins. Prefixing the space id
    /// makes the `None`-key collision impossible.
    reproject_groups: std::collections::HashMap<(String, Option<String>), Vec<String>>,
    /// Distinct pages whose `pages_cache` counts must be recomputed once at
    /// end-of-chunk.
    affected_pages: std::collections::HashSet<String>,
}

impl ChunkAccumulator {
    /// Record (or overwrite) the authoritative sibling ordering for a parent
    /// group touched by a create in this chunk. Keyed by `(space_id, parent)`
    /// so top-level (`None` parent) groups in different spaces never collide.
    /// Overwrite is intentional: the most recent list is the most complete (it
    /// includes every prior insert into the group), so the last writer wins and
    /// the flush reprojects the final order once.
    pub(super) fn record_reproject(
        &mut self,
        space_id: String,
        parent: Option<String>,
        ordered: Vec<String>,
    ) {
        self.reproject_groups.insert((space_id, parent), ordered);
    }

    /// Add many affected page ids at once.
    pub(super) fn extend_affected_pages(&mut self, page_ids: impl IntoIterator<Item = String>) {
        self.affected_pages.extend(page_ids);
    }

    /// End-of-chunk flush: reproject each touched sibling group ONCE, then
    /// recompute the distinct affected pages' counts ONCE. Idempotent and
    /// order-independent — the reproject writes final ranks and the count
    /// recompute is a pure function of committed state, so running the flush
    /// covers every parent/page touched regardless of interleaving. MUST run
    /// inside the chunk's transaction so the deferred writes commit atomically
    /// with the block mutations.
    pub(super) async fn flush(self, conn: &mut sqlx::SqliteConnection) -> Result<(), AppError> {
        for ordered in self.reproject_groups.values() {
            crate::loro::projection::reproject_dense_positions(conn, ordered).await?;
        }
        if !self.affected_pages.is_empty() {
            let pages: Vec<String> = self.affected_pages.into_iter().collect();
            recompute_pages_cache_counts_for_pages(conn, &pages).await?;
        }
        Ok(())
    }
}

/// Side-effects an `apply_op_tx` call may produce that the caller needs
/// to fan out AFTER the SQL transaction commits. The SQL UPDATE for a
/// `RestoreBlock` walks the descendant CTE and clears `deleted_at` for
/// every block in the matching `deleted_at_ref` cohort, but the per-
/// space `LoroEngine`'s `apply_restore_block` is per-block-id only —
/// without fanning out, a 10-descendant subtree restore would leave 9
/// blocks marked `deleted_at != Null` in the Loro doc.
///
/// The cohort vec INCLUDES the seed `block_id` so the post-commit
/// helper (`dispatch_restore_descendants`) is the canonical path for
/// driving Loro on the whole subtree. The engine's
/// `apply_restore_block` is idempotent so the duplicate seed-apply
/// (the in-tx `apply_restore_block_via_loro` also reaches the seed
/// when space resolution is healthy) is harmless. Empty for every op
/// type other than `RestoreBlock`.
///
/// `deleted_cohort` is the symmetric companion for the `DeleteBlock`
/// cascade. Same shape, same rationale: the SQL soft-delete walks N
/// descendants, the engine's `apply_delete_block` is per-block-id
/// only, so without per-descendant fan-out the engine state for the
/// descendants is "alive" while SQL says "deleted". Empty unless the
/// op was `DeleteBlock`. Includes the seed for the same
/// idempotent-seed-apply reason as `restored_cohort`.
///
/// `delete_space_id` is captured alongside `deleted_cohort` because
/// `resolve_block_space` filters `deleted_at IS NULL` — once the SQL
/// UPDATE has stamped the cohort as deleted, a post-commit
/// `resolve_block_space` lookup would return `None` for every row.
/// This is the asymmetry with `restored_cohort`: post-restore-UPDATE
/// the cohort is alive again so `dispatch_restore_descendants`
/// can resolve the space inline; post-delete-UPDATE the cohort is
/// dead, so we capture the space at the same pre-UPDATE moment as the
/// cohort itself.
#[derive(Debug, Default)]
pub(crate) struct ApplyEffects {
    /// Block ids restored by a `RestoreBlock` apply — seed AND every
    /// descendant the SQL CTE walked.  Empty unless the op was
    /// `RestoreBlock`.  Order is whatever SQLite's CTE walk produces
    /// (no guarantee but stable across calls on a fixed schema).
    pub restored_cohort: Vec<String>,
    /// #2017: contiguous soft-deleted ANCESTOR ids that a `RestoreBlock`
    /// apply un-deleted UPWARD (the #1884 live-orphan fix). The SQL UPDATE
    /// clears `deleted_at` on this chain but the per-space engine's
    /// `apply_restore_block` is per-block-id, so without a symmetric upward
    /// fan-out the engine keeps the ancestors tombstoned and the next
    /// `reproject_block_deleted_at` RE-DELETES them in SQL (self-perpetuating
    /// CRDT divergence). `dispatch_restore_ancestors` fans these onto the
    /// engine post-commit, mirroring `restored_cohort`'s descendant fan-out.
    /// Empty unless the op was `RestoreBlock` and an ancestor chain existed.
    pub restored_ancestors: Vec<String>,
    /// Block ids soft-deleted by a `DeleteBlock` apply — seed AND
    /// every active descendant the SQL CTE walked. Empty unless the op
    /// was `DeleteBlock`. Captured BEFORE the UPDATE so the
    /// `descendants_cte_active!()` filter still matches (post-UPDATE
    /// every cohort row has `deleted_at IS NOT NULL` and the CTE would
    /// skip them all).
    pub deleted_cohort: Vec<String>,
    /// Space id resolved for the `DeleteBlock` seed at PRE-UPDATE
    /// time. `None` for every other op type and for delete ops on
    /// blocks that have no resolvable space (a permitted but rare
    /// state — pre-spaces data). Required because
    /// `resolve_block_space` filters `deleted_at IS NULL`; a
    /// post-commit resolve attempt would fail on every cohort row.
    pub delete_space_id: Option<crate::space::SpaceId>,
}

/// Core apply-op logic operating on a bare [`SqliteConnection`].
///
/// Both the single-op path (`apply_op`) and the batched-transaction path
/// (`BatchApplyOps`) delegate here so that a batch can be wrapped in a
/// single transaction for atomicity.
///
/// Returns an [`ApplyEffects`] describing post-commit fan-out the
/// caller is responsible for running.  Today the only populated field
/// is `restored_cohort` (see the struct docs); every other op type
/// returns the default-empty effects.
/// `chunk`: when `Some`, the caller is applying a multi-op chunk (the
/// `BatchApplyOps` import path) and wants the two derived maintenance passes
/// (dense-position reprojection, `pages_cache` count recompute) DEFERRED to a
/// single end-of-chunk flush (`ChunkAccumulator::flush`) instead of running
/// once per op — turning the per-block O(N) passes into one per-chunk O(N)
/// pass (#2200). When `None` (single-op `apply_op`, every LOCAL command path)
/// both passes run inline exactly as before, so the "chunk of one" flushes
/// once with an identical result.
#[tracing::instrument(skip(conn, record, chunk, state), fields(seq = record.seq), err)]
pub(super) async fn apply_op_tx(
    conn: &mut sqlx::SqliteConnection,
    record: &OpRecord,
    chunk: Option<&mut ChunkAccumulator>,
    state: &crate::loro::shared::LoroState,
) -> Result<ApplyEffects, AppError> {
    use std::str::FromStr;
    let op_type = OpType::from_str(&record.op_type).map_err(|e| {
        AppError::validation(format!("unknown op_type '{}': {}", record.op_type, e))
    })?;
    let mut effects = ApplyEffects::default();
    // Per-op pre-state captured for the post-projection count refresh.
    // Each arm assigns exactly the variant matching its op type; op types
    // that can't affect the cache counts leave this at `None`.
    let mut pre_state = PreOpState::None;
    // #2200: re-borrow the optional chunk accumulator so it can be handed to
    // BOTH the CreateBlock reprojection-deferral below AND the terminal
    // count-maintenance hook. `Option<&mut _>` is not `Copy`; `as_deref_mut`
    // reborrows without moving so the accumulator survives to the flush point.
    let mut chunk = chunk;
    match op_type {
        OpType::CreateBlock => {
            // The engine path is the only path; the SQL-only
            // `apply_*_sql_only` helpers remain as fallbacks for
            // test-scaffolding cases (uninitialised Loro state,
            // unresolved space) inside the `via_loro` helpers
            // themselves.
            let p: CreateBlockPayload = serde_json::from_str(&record.payload)?;
            // Capture payload fields for the post-projection
            // pages_cache count refresh (`maintain_pages_cache_counts_after_op`).
            pre_state = PreOpState::Create {
                block_id: p.block_id.as_str().to_owned(),
                parent_id: p.parent_id.as_ref().map(|id| id.as_str().to_owned()),
                block_type: p.block_type.clone(),
                content: p.content.clone(),
            };
            // #2200 Item 1: when in a chunk, DEFER the dense-position
            // reprojection to end-of-chunk (record the touched parent group in
            // the accumulator); off the chunk path (`None`) reproject inline.
            apply_create_block_via_loro(conn, state, &record.device_id, &p, chunk.as_deref_mut())
                .await?;
        }
        OpType::EditBlock => {
            let p: EditBlockPayload = serde_json::from_str(&record.payload)?;
            // Capture the new text so the post-projection
            // recompute knows which target pages to refresh.
            pre_state = PreOpState::Edit {
                block_id: p.block_id.as_str().to_owned(),
                to_text: p.to_text.clone(),
            };
            apply_edit_block_via_loro(conn, state, &record.device_id, &p).await?;
        }
        OpType::DeleteBlock => {
            let p: DeleteBlockPayload = serde_json::from_str(&record.payload)?;
            // Capture the descendant cohort BEFORE the UPDATE. The SQL
            // cascade uses `descendants_cte_active!()` which filters
            // `deleted_at IS NULL`, so once the UPDATE stamps the
            // cohort as deleted the CTE no longer matches them. We
            // mirror the same CTE here so the captured set is exactly
            // the rows the UPDATE will touch. The cohort INCLUDES the
            // seed (mirrors `restored_cohort`'s shape).
            //
            // The space resolve runs at the same pre-UPDATE moment so
            // the post-commit fanout has a known-good space id to
            // pass to `engine_apply` (post-UPDATE every cohort row has
            // `deleted_at IS NOT NULL`, so a fresh `resolve_block_space`
            // call would return `None` — see `ApplyEffects` doc).
            let cohort = collect_delete_cohort(conn, &p).await?;
            let delete_space_id =
                crate::space::resolve_block_space(&mut *conn, &p.block_id).await?;
            // Feed the cohort into the count-refresh hook.
            pre_state = PreOpState::Cohort(cohort.clone());
            apply_delete_block_via_loro(conn, state, &record.device_id, &p, record.created_at)
                .await?;
            effects.deleted_cohort = cohort;
            effects.delete_space_id = delete_space_id;
        }
        OpType::RestoreBlock => {
            let p: RestoreBlockPayload = serde_json::from_str(&record.payload)?;
            // Capture the descendant cohort BEFORE the UPDATE — once
            // the UPDATE clears `deleted_at`, the cohort is no longer
            // identifiable by `(seed_id, deleted_at_ref)`.  This SELECT
            // mirrors the same CTE the UPDATE uses so the captured set
            // is exactly what gets restored.
            //
            // Keep the seed in the cohort: the post-commit fanout
            // (`dispatch_restore_descendants`) is the canonical path
            // that drives Loro for the entire cohort. Including the
            // seed makes the helper self-contained and avoids
            // depending on the in-tx `apply_restore_block_via_loro`
            // seed apply also reaching the engine — the duplicate
            // apply on the seed is idempotent (engine's
            // `apply_restore_block` is a no-op on an already-restored
            // block).
            let cohort = collect_restore_cohort(conn, &p).await?;
            // #2017: `apply_restore_block_via_loro` returns the contiguous
            // soft-deleted ANCESTOR chain it un-deleted upward (the #1884
            // live-orphan fix). Surface it so the post-commit fan-out drives
            // the engine for the ancestors too — the in-tx engine apply only
            // touched the seed, so without this the ancestors stay tombstoned
            // in the CRDT and the next reproject re-deletes them in SQL.
            let restored_ancestors =
                apply_restore_block_via_loro(conn, state, &record.device_id, &p).await?;
            // Both the descendant cohort AND the restored ancestors feed the
            // pages_cache count refresh: an un-deleted ancestor's owning page
            // gains a live child, so its `child_block_count` must be recomputed
            // or it is left stale.
            pre_state = PreOpState::RestoreCohortAndAncestors {
                cohort: cohort.clone(),
                ancestors: restored_ancestors.clone(),
            };
            effects.restored_cohort = cohort;
            effects.restored_ancestors = restored_ancestors;
        }
        OpType::PurgeBlock => {
            let p: PurgeBlockPayload = serde_json::from_str(&record.payload)?;
            // #2183: PurgeBlock's page-wide count recompute is deferred to the
            // background `RebuildPagesCacheCounts` task (dispatch's lifecycle
            // set), which recomputes from post-cascade state — so we no longer
            // capture a pre-cascade affected-pages snapshot here.
            pre_state = PreOpState::Purge;
            apply_purge_block_via_loro(conn, state, &record.device_id, &p).await?;
        }
        OpType::MoveBlock => {
            let p: MoveBlockPayload = serde_json::from_str(&record.payload)?;
            // E4: capture the moved block's owning page BEFORE the
            // projection reparents it. A cross-page reparent recomputes
            // `page_id` for the moved subtree, so the source page loses
            // descendants and the destination page gains them — both
            // `child_block_count`s must be refreshed post-projection.
            let move_block_id_str = p.block_id.as_str();
            let src_page =
                sqlx::query_scalar!("SELECT page_id FROM blocks WHERE id = ?", move_block_id_str)
                    .fetch_optional(&mut *conn)
                    .await?
                    .flatten();
            pre_state = PreOpState::Move {
                block_id: p.block_id.as_str().to_owned(),
                src_page,
            };
            apply_move_block_via_loro(conn, state, &record.device_id, &p).await?;
        }
        OpType::AddTag => {
            let p: AddTagPayload = serde_json::from_str(&record.payload)?;
            apply_add_tag_via_loro(conn, state, &record.device_id, &p).await?;
        }
        OpType::RemoveTag => {
            let p: RemoveTagPayload = serde_json::from_str(&record.payload)?;
            apply_remove_tag_via_loro(conn, state, &record.device_id, &p).await?;
        }
        OpType::SetProperty => {
            let p: SetPropertyPayload = serde_json::from_str(&record.payload)?;
            apply_set_property_via_loro(conn, state, &record.device_id, &p).await?;
        }
        OpType::DeleteProperty => {
            let p: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
            apply_delete_property_via_loro(conn, state, &record.device_id, &p).await?;
        }
        OpType::AddAttachment => {
            // Attachments stay on the SQL-only path — they don't go
            // through Loro.
            let p: AddAttachmentPayload = serde_json::from_str(&record.payload)?;
            apply_add_attachment_tx(conn, p, record.created_at).await?;
        }
        OpType::DeleteAttachment => {
            let p: DeleteAttachmentPayload = serde_json::from_str(&record.payload)?;
            apply_delete_attachment_tx(conn, p).await?;
        }
        OpType::RenameAttachment => {
            let p: RenameAttachmentPayload = serde_json::from_str(&record.payload)?;
            apply_rename_attachment_tx(conn, p).await?;
        }
    }
    // Maintain `pages_cache.{inbound_link_count,child_block_count}`.
    // Runs after every per-op projection inside the same transaction, so
    // the count UPDATEs commit atomically with the block mutations. The
    // hook is a no-op for op types that cannot affect the counts (see
    // `maintain_pages_cache_counts_after_op`).
    //
    // #2200 Item 2: when in a chunk, the hook records the affected page ids in
    // the accumulator and DEFERS the terminal `recompute_pages_cache_counts_for_pages`
    // to the end-of-chunk flush (one pass over the distinct affected pages),
    // instead of running the full descendant `COUNT(*)` recompute per op. Off
    // the chunk path it recomputes inline, unchanged. Per-op affected-page
    // RESOLUTION (with its side effects — page-create `pages_cache` seeding,
    // in-tx `reindex_block_links`) always runs here regardless.
    maintain_pages_cache_counts_after_op(conn, &pre_state, chunk).await?;
    tracing::debug!(op_type = %record.op_type, seq = record.seq, "applied op to materialized tables");
    Ok(effects)
}

/// Capture the descendant cohort that `apply_restore_block_tx` is
/// about to clear. Mirrors the CTE + `deleted_at = ?` filter used by
/// the UPDATE so the captured set is exactly the rows that will be
/// restored. Run inside the same tx, before the UPDATE, so the
/// snapshot reflects the soft-deleted state.
///
/// The list ALWAYS includes the seed `block_id` if it matches the
/// filter; the caller is responsible for excluding the seed when
/// constructing the per-descendant fan-out (the seed's engine
/// dispatch already happens once for the root op record).
pub(crate) async fn collect_restore_cohort(
    conn: &mut sqlx::SqliteConnection,
    p: &RestoreBlockPayload,
) -> Result<Vec<String>, AppError> {
    // #1055: mirror `project_restore_block_to_sql`'s cohort-contiguous
    // walk exactly so the captured fanout set equals the rows the UPDATE
    // clears (the recursive arm descends only through same-cohort blocks).
    let rows: Vec<(String,)> = sqlx::query_as::<_, (String,)>(concat!(
        crate::descendants_cte_cohort!(),
        "SELECT id FROM blocks \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
    ))
    .bind(p.block_id.as_str())
    .bind(p.deleted_at_ref)
    .bind(p.deleted_at_ref)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Capture the descendant cohort that `apply_delete_block_tx` is
/// about to soft-delete. Mirrors the CTE + `deleted_at IS NULL`
/// filter used by the UPDATE so the captured set is exactly the rows
/// that will be touched.
///
/// MUST run BEFORE the UPDATE: `descendants_cte_active!()` filters
/// `deleted_at IS NULL` in the recursive step, so once the UPDATE has
/// stamped the cohort as deleted the CTE no longer matches them and a
/// post-UPDATE call would return an empty list (or worse, the seed only
/// — depending on the recursion order).
///
/// The list ALWAYS includes the seed `block_id` if it's currently
/// active; the seed is the CTE's anchor row and is yielded at depth 0.
/// `dispatch_delete_descendants` re-applies the seed alongside
/// the descendants (idempotent — `apply_delete_block` is a no-op on an
/// already-deleted block) so the helper is the canonical cohort-delete
/// path regardless of whether the in-tx `apply_delete_block_via_loro`
/// seed apply reached the engine for any specific op record.
///
/// The captured cohort feeds the post-commit
/// `dispatch_delete_descendants` fanout; the SELECT itself is
/// cheap (single CTE walk; ~µs on small subtrees).
pub(crate) async fn collect_delete_cohort(
    conn: &mut sqlx::SqliteConnection,
    p: &DeleteBlockPayload,
) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> = sqlx::query_as::<_, (String,)>(concat!(
        crate::descendants_cte_active!(),
        "SELECT id FROM blocks \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
    ))
    .bind(p.block_id.as_str())
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}
