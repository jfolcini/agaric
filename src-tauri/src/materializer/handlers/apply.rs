//! Apply-pipeline handlers: the per-op apply transaction, the apply
//! cursor, post-commit Restore/Delete cascade fan-out, and the
//! descendant-cohort collectors.

use super::*;

/// PEND-25 L2/L9: takes `&Arc<OpRecord>` so callers (the
/// `MaterializeTask::ApplyOp` arm) that already hold the record as
/// `Arc<OpRecord>` thread the borrow through without a deep clone.
pub(super) async fn apply_op(pool: &SqlitePool, record: &Arc<OpRecord>) -> Result<(), AppError> {
    // SQL-review M-1: route through `begin_immediate_logged` so
    // sync-burst contention surfaces as upfront serialised wait (with
    // a `warn!` if slow) instead of mid-tx `busy_timeout` stalls
    // under SQLite's default DEFERRED isolation.
    let mut tx = crate::db::begin_immediate_logged(pool, "materializer_apply_op").await?;
    let effects = apply_op_tx(&mut tx, record).await?;
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
    // `apply_op` is reached only via the test-only `dispatch_op` helper
    // today (see its doc comment). The release-build guard already lives at
    // boot (`replay.rs` `#412`); this assert exists to catch a test/dev
    // regression that wires a multi-device single-op apply before the
    // per-device watermark cursor lands. Remove once that cursor ships.
    #[cfg(debug_assertions)]
    {
        // Compile-checked `query_scalar!` macro (NOT the runtime fn form):
        // it reuses the identical `COUNT(DISTINCT device_id)` query already
        // cached for `recovery::replay`'s #412 release guard, so it needs no
        // new `.sqlx` offline entry, is schema-validated at build time, and
        // carries no #646 dynamic-SQL marker burden. This mirrors the batch
        // arm's invariant for the single-op path: the batch arm asserts the
        // in-batch records share one device; the single-op equivalent is
        // that the op_log as a whole is single-device (the same property the
        // replay guard enforces in all builds).
        let distinct_devices: i64 =
            sqlx::query_scalar!(r#"SELECT COUNT(DISTINCT device_id) AS "n!: i64" FROM op_log"#)
                .fetch_one(&mut *tx)
                .await?;
        debug_assert!(
            distinct_devices <= 1,
            "apply_op advances a single global apply cursor for device {:?} but \
             op_log spans {} devices; the single global cursor cannot represent \
             per-device watermarks — per-device cursor partitioning is required \
             (backend audit #412)",
            record.device_id,
            distinct_devices,
        );
    }
    // C-2b: advance the cursor in the same tx so `apply + cursor` are
    // atomic. A crash between the apply and the commit rolls both back
    // together; the cursor never points ahead of materialised state.
    advance_apply_cursor(&mut tx, record.seq).await?;
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
    dispatch_restore_descendants(pool, record, &effects.restored_cohort).await;
    dispatch_delete_descendants(
        record,
        &effects.deleted_cohort,
        effects.delete_space_id.as_ref(),
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
/// cost bounded by the registry lock + the engine's per-block-id
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
) {
    use crate::op::{OpPayload, RestoreBlockPayload};
    use crate::ulid::BlockId;

    if cohort.is_empty() {
        return;
    }

    let Some(state) = crate::loro::shared::get() else {
        // Loro state not initialised (test environment that bypasses
        // the boot setup). Nothing to do.
        return;
    };

    // Parse the root's payload once to extract `deleted_at_ref`.  The
    // payload is the raw inner-only JSON (per `serialize_inner_payload`
    // in `op_log.rs`), not the tagged `OpPayload` form, so we go
    // through the inner struct directly.
    let root_payload: RestoreBlockPayload = match serde_json::from_str(&root_record.payload) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                seq = root_record.seq,
                error = %e,
                "restore-cascade fanout: failed to parse root RestoreBlockPayload; \
                 skipping descendant fan-out",
            );
            return;
        }
    };

    // Resolve the space once via the root's block_id (every descendant
    // is in the same space — the descendant CTE walks within a single
    // `blocks.parent_id` graph).  Keeps fanout O(N) on the engine call
    // and not O(N) on `resolve_block_space` SQL queries.
    let root_block = BlockId::from_trusted(root_payload.block_id.as_str());
    let space_id = match crate::space::resolve_block_space(pool, &root_block).await {
        Ok(Some(s)) => s,
        Ok(None) => {
            tracing::trace!(
                block_id = root_payload.block_id.as_str(),
                "restore-cascade fanout: no space for root block; skipping",
            );
            return;
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "restore-cascade fanout: resolve_block_space failed; skipping",
            );
            return;
        }
    };

    for cohort_id in cohort {
        // Build the typed payload directly (no JSON round-trip).
        let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::from_trusted(cohort_id),
            deleted_at_ref: root_payload.deleted_at_ref,
        });

        let op_id = format!(
            "{}/{}#cohort/{}",
            root_record.device_id, root_record.seq, cohort_id,
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
/// Per-call cost is bounded by the registry lock + the engine's
/// per-block-id mutation (single-digit microseconds).
pub(crate) async fn dispatch_delete_descendants(
    root_record: &OpRecord,
    cohort: &[String],
    space_id: Option<&crate::space::SpaceId>,
) {
    use crate::op::OpPayload;
    use crate::ulid::BlockId;

    if cohort.is_empty() {
        return;
    }

    let Some(space_id) = space_id else {
        // Pre-UPDATE space resolve returned None — the seed has no
        // resolvable space (pre-FEAT-3 data, or a block whose owning
        // page never received a `space` SetProperty). Nothing to do —
        // there's no canonical engine to mirror onto. The SQL-side
        // delete already stands as the durable outcome.
        tracing::trace!(
            seq = root_record.seq,
            "delete-cascade fanout: no space captured for root block; skipping",
        );
        return;
    };

    let Some(state) = crate::loro::shared::get() else {
        // Engine state not initialised (test environment that
        // bypasses the boot setup).  Nothing to do.
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
pub(super) struct ApplyEffects {
    /// Block ids restored by a `RestoreBlock` apply — seed AND every
    /// descendant the SQL CTE walked.  Empty unless the op was
    /// `RestoreBlock`.  Order is whatever SQLite's CTE walk produces
    /// (no guarantee but stable across calls on a fixed schema).
    pub restored_cohort: Vec<String>,
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
    /// state — pre-FEAT-3 data). Required because
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
pub(super) async fn apply_op_tx(
    conn: &mut sqlx::SqliteConnection,
    record: &OpRecord,
) -> Result<ApplyEffects, AppError> {
    use std::str::FromStr;
    let op_type = OpType::from_str(&record.op_type).map_err(|e| {
        AppError::Validation(format!("unknown op_type '{}': {}", record.op_type, e))
    })?;
    let mut effects = ApplyEffects::default();
    // Per-op pre-state captured for the post-projection count refresh.
    // Each arm assigns exactly the variant matching its op type; op types
    // that can't affect the cache counts leave this at `None`.
    let mut pre_state = PreOpState::None;
    match op_type {
        OpType::CreateBlock => {
            // The engine path is the only path; the SQL-only
            // `apply_*_sql_only` helpers remain as fallbacks for
            // test-scaffolding cases (uninitialised Loro state,
            // unresolved space) inside the `via_loro` helpers
            // themselves.
            let p: CreateBlockPayload = serde_json::from_str(&record.payload)?;
            // PEND-56b: capture payload fields for the post-projection
            // pages_cache count refresh (`maintain_pages_cache_counts_after_op`).
            pre_state = PreOpState::Create {
                block_id: p.block_id.as_str().to_owned(),
                parent_id: p.parent_id.as_ref().map(|id| id.as_str().to_owned()),
                block_type: p.block_type.clone(),
                content: p.content.clone(),
            };
            apply_create_block_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::EditBlock => {
            let p: EditBlockPayload = serde_json::from_str(&record.payload)?;
            // PEND-56b: capture the new text so the post-projection
            // recompute knows which target pages to refresh.
            pre_state = PreOpState::Edit {
                block_id: p.block_id.as_str().to_owned(),
                to_text: p.to_text.clone(),
            };
            apply_edit_block_via_loro(conn, &record.device_id, &p).await?;
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
            // PEND-56b: feed the cohort into the count-refresh hook.
            pre_state = PreOpState::Cohort(cohort.clone());
            apply_delete_block_via_loro(conn, &record.device_id, &p, record.created_at).await?;
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
            // PEND-56b: cohort feeds the count refresh.
            pre_state = PreOpState::Cohort(cohort.clone());
            apply_restore_block_via_loro(conn, &record.device_id, &p).await?;
            effects.restored_cohort = cohort;
        }
        OpType::PurgeBlock => {
            let p: PurgeBlockPayload = serde_json::from_str(&record.payload)?;
            // PEND-56b: capture the affected pages BEFORE the SQL
            // cascade clears `block_links` (FK CASCADE on mig 0061).
            // The cascade walks the descendant CTE so we mirror that
            // shape to collect the set we need to refresh.
            pre_state = PreOpState::Purge {
                affected_pages: collect_purge_affected_pages(conn, p.block_id.as_str()).await?,
            };
            apply_purge_block_via_loro(conn, &record.device_id, &p).await?;
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
            apply_move_block_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::AddTag => {
            let p: AddTagPayload = serde_json::from_str(&record.payload)?;
            apply_add_tag_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::RemoveTag => {
            let p: RemoveTagPayload = serde_json::from_str(&record.payload)?;
            apply_remove_tag_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::SetProperty => {
            let p: SetPropertyPayload = serde_json::from_str(&record.payload)?;
            apply_set_property_via_loro(conn, &record.device_id, &p).await?;
        }
        OpType::DeleteProperty => {
            let p: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
            apply_delete_property_via_loro(conn, &record.device_id, &p).await?;
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
    // PEND-56b: maintain `pages_cache.{inbound_link_count,child_block_count}`.
    // Runs after every per-op projection inside the same transaction, so
    // the count UPDATEs commit atomically with the block mutations. The
    // hook is a no-op for op types that cannot affect the counts (see
    // `maintain_pages_cache_counts_after_op`).
    maintain_pages_cache_counts_after_op(conn, &pre_state).await?;
    tracing::debug!(op_type = %record.op_type, seq = record.seq, "applied op to materialized tables");
    Ok(effects)
}

/// Capture the set of pages whose `pages_cache` counts may be affected
/// by a `PurgeBlock` cascade. The cascade walks the descendant CTE and
/// removes `blocks` + cascading edges from `block_links`. We need to
/// refresh every page that:
///   1. owns one of the cohort blocks (its `child_block_count` drops),
///   2. is targeted by an outbound edge from a cohort block (its
///      `inbound_link_count` drops by 1 per distinct source).
///
/// Plus the cohort's own page ids if any cohort block is a page (their
/// `pages_cache` row is itself dropped by the cascade — the UPDATE filter
/// matches zero rows so it's a no-op, which is the desired outcome).
pub(super) async fn collect_purge_affected_pages(
    conn: &mut sqlx::SqliteConnection,
    seed_block_id: &str,
) -> Result<Vec<String>, AppError> {
    use std::collections::HashSet;
    // Walk the descendant CTE (PurgeBlock's `purge_block_sql_cascade`
    // uses the same shape) to find the cohort. Then read each block's
    // page_id + outbound target page_ids.
    let cohort = sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE d.depth < 100 \
         ) \
         SELECT id AS \"id!\" FROM descendants",
        seed_block_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    let cohort_ids: Vec<String> = cohort.into_iter().map(|r| r.id).collect();
    let mut affected: HashSet<String> = HashSet::new();
    for p in distinct_pages_for_blocks(conn, &cohort_ids).await? {
        affected.insert(p);
    }
    // #463: single batch query instead of one round-trip per cohort block.
    for p in outbound_target_pages_for_blocks(conn, &cohort_ids).await? {
        affected.insert(p);
    }
    Ok(affected.into_iter().collect())
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
