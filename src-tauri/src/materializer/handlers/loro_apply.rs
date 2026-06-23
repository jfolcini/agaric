//! Engine-routed apply handlers (`apply_*_via_loro`) plus the SQL
//! purge cascade. Each fn applies an op through the per-space Loro
//! engine then projects the result to SQL.

use super::*;

/// Apply CreateBlock through the engine then project to SQL.
///
/// 1. Resolves the block's space (parent_id-based for content blocks;
///    self-id for pages).
/// 2. Acquires the per-space [`crate::loro::engine::LoroEngine`] via
///    the registry.
/// 3. Applies `apply_create_block` to the engine.
/// 4. Reads back the engine's `BlockSnapshot` for the freshly-created
///    block.
/// 5. Drops the registry guard (the `MutexGuard` is `!Send` so it
///    cannot cross an `.await`).
/// 6. Projects the snapshot into SQL via
///    [`crate::loro::projection::project_create_block_to_sql`].
/// 7. Calls `tag_inheritance::inherit_parent_tags`, so derived tag
///    rows stay correct.
///
/// ## Atomic semantics
///
/// The SQL projection runs in the caller's transaction, so a
/// projection failure rolls back atomically with the rest of the
/// `apply_op_tx` work (cursor advance, etc.). The engine's apply is
/// NOT rolled back automatically.
///
/// ## Space resolution
///
/// For a `CreateBlock`, the `parent_id` is the resolution anchor when
/// present (content blocks descend from a page); otherwise the
/// block's own id is used (page-create with no parent).
///
/// ## Fallback modes
///
/// The engine path falls back to a SQL-only path
/// (`apply_*_sql_only` below) when:
/// - Loro state isn't initialised (test scaffolding without
///   `install_for_test`).
/// - Space cannot be resolved (orphan block, no `space` ancestor,
///   Pre- row, fresh page-create with no SetProperty(space)
///   yet).
///
/// In production both arms are unreachable — `init` runs at boot and
/// space resolution succeeds on every well-formed op. The SQL-only
/// fallback exists so that materializer / recovery / sync_daemon
/// tests can thread synthetic bare-block ops through `apply_op`
/// without a registered space.
pub(crate) async fn apply_create_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &CreateBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;
    use crate::ulid::BlockId;

    // Resolve space via parent_id (or self for a page-create that
    // has no parent).  Fall back to SQL-only on any resolve miss.
    let resolution_anchor: BlockId = match &p.parent_id {
        Some(parent) => parent.clone(),
        None => p.block_id.clone(),
    };
    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &resolution_anchor).await?
    else {
        super::sql_only_fallback::record(
            "create_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_create_block_sql_only(conn, p.clone()).await;
    };

    // Acquire engine guard, apply, read-back, drop guard.  The guard
    // is `!Send` so it cannot live across an `.await` — we keep all
    // engine work inside this sync block.
    let (snapshot, siblings): (BlockSnapshot, Vec<String>) = {
        let Some(state) = crate::loro::shared::get() else {
            super::sql_only_fallback::record(
                "create_block",
                super::sql_only_fallback::SqlOnlyFallbackReason::EngineUninit,
            );
            return apply_create_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        let parent = p.parent_id.as_ref().map(crate::ulid::BlockId::as_str);
        // #400 routing: new ops carry a 0-based `index`; pre-#400 ops carry the
        // legacy sparse `position` (mapped to a slot by the engine); neither ⇒
        // append at the end.
        match p.index {
            Some(index) => engine.apply_create_block_at(
                p.block_id.as_str(),
                &p.block_type,
                &p.content,
                parent,
                usize::try_from(index.max(0)).unwrap_or(usize::MAX),
            )?,
            None => engine.apply_create_block(
                p.block_id.as_str(),
                &p.block_type,
                &p.content,
                parent,
                p.position.unwrap_or(i64::MAX), // None ⇒ sort last (append)
            )?,
        }
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        // Authoritative sibling order for the dense-rank reprojection.
        let siblings = engine.children_ordered_block_ids(parent)?;
        drop(guard);
        let snap = snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_create_block_via_loro: engine read_block returned None \
                 immediately after apply_create_block for {}",
                p.block_id.as_str()
            ))
        })?;
        (snap, siblings)
    };

    // Project the engine's post-apply state into SQL, then reproject the whole
    // sibling group to dense 1-based positions matching the tree order (#400).
    projection::project_create_block_to_sql(conn, &snapshot).await?;
    projection::reproject_dense_positions(conn, &siblings).await?;

    // Tag inheritance — derived tag rows for the new block.
    let parent_str = p.parent_id.as_ref().map(crate::ulid::BlockId::as_str);
    tag_inheritance::inherit_parent_tags(&mut *conn, p.block_id.as_str(), parent_str).await?;
    Ok(())
}

/// Apply EditBlock through the engine then project to SQL.
///
/// Same shape as [`apply_create_block_via_loro`]: resolve space, take
/// the engine guard inside a sync scope, apply
/// `apply_edit_via_diff_splice`, read the post-apply snapshot, drop
/// the guard, project. Edit ops carry no `parent_id`, so the
/// resolution anchor is the `block_id` itself (which already has a
/// `parent_id` row in `blocks` — the resolution walks up from there).
pub(crate) async fn apply_edit_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &EditBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        super::sql_only_fallback::record(
            "edit_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_edit_block_sql_only(conn, p.clone()).await;
    };

    let snapshot: BlockSnapshot = {
        let Some(state) = crate::loro::shared::get() else {
            super::sql_only_fallback::record(
                "edit_block",
                super::sql_only_fallback::SqlOnlyFallbackReason::EngineUninit,
            );
            return apply_edit_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_edit_via_diff_splice(p.block_id.as_str(), &p.to_text)?;
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        drop(guard);
        snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_edit_block_via_loro: engine read_block returned None for {} \
                 (the block must exist for an EditBlock op to make sense)",
                p.block_id.as_str()
            ))
        })?
    };

    projection::project_edit_block_to_sql(conn, &snapshot).await?;
    Ok(())
}

/// Apply SetProperty through the engine then project to SQL.
///
/// Same shape as the per-block helpers: resolve space via the block's
/// id, take the engine guard, apply, drop, project. The engine apply
/// flattens all property values to a single string; the SQL projection
/// reads the typed-shape fields straight off the payload (the engine's
/// post-apply state for the typed fields equals the payload's fields
/// by construction, so this is correct — see the projection helper's
/// docstring). An unresolvable space falls back to the SQL-only
/// path.
pub(crate) async fn apply_set_property_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &SetPropertyPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        super::sql_only_fallback::record(
            "set_property",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_set_property_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            super::sql_only_fallback::record(
                "set_property",
                super::sql_only_fallback::SqlOnlyFallbackReason::EngineUninit,
            );
            return apply_set_property_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        // Store the value with its native type so the engine is
        // type-lossless (`value_num`→`Num`, `value_bool`→`Bool`); text/date/ref
        // are all strings, disambiguated at the SQL projection by
        // `property_definitions.value_type`. No typed field set ⇒ explicit
        // clear (`Null`). The typed SQL columns are still written from the
        // payload directly by `project_set_property_to_sql` below.
        use crate::loro::engine::PropertyValue;
        let value = if let Some(v) = &p.value_text {
            PropertyValue::Str(v.clone())
        } else if let Some(v) = p.value_num {
            PropertyValue::Num(v)
        } else if let Some(v) = &p.value_date {
            PropertyValue::Str(v.clone())
        } else if let Some(v) = &p.value_ref {
            PropertyValue::Str(v.as_str().to_owned())
        } else if let Some(b) = p.value_bool {
            PropertyValue::Bool(b)
        } else {
            PropertyValue::Null
        };
        engine.apply_set_property_typed(p.block_id.as_str(), &p.key, &value)?;
        drop(guard);
    }

    projection::project_set_property_to_sql(conn, p).await?;
    Ok(())
}

/// Apply DeleteBlock through the engine then project to SQL.
///
/// Engine `apply_delete_block` now stores the real `record.created_at`
/// Timestamp on the seed (Phase 2) — the same value the SQL
/// projection stamps — so cohort identity for restore lookups is
/// consistent between the engine and SQL, and lossless across sync.
/// The cascade (descendant fanout) is handled on the SQL side via the
/// projection's CTE-driven UPDATE; the engine only sees the seed
/// block's apply, with the post-commit
/// `dispatch_delete_descendants` fanning out the cohort to the
/// engine. An unresolvable space falls back to the SQL-only path.
pub(crate) async fn apply_delete_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &DeleteBlockPayload,
    now: i64,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        super::sql_only_fallback::record(
            "delete_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_delete_block_sql_only(conn, p.clone(), now).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            super::sql_only_fallback::record(
                "delete_block",
                super::sql_only_fallback::SqlOnlyFallbackReason::EngineUninit,
            );
            return apply_delete_block_sql_only(conn, p.clone(), now).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        // #109 Phase 2: the engine seed carries `deleted_at` as a String
        // slot (bridged to i64 at the SQL boundary); stringify here.
        engine.apply_delete_block(p.block_id.as_str(), &now.to_string())?;
        drop(guard);
    }

    projection::project_delete_block_to_sql(conn, p.block_id.as_str(), now).await?;
    // Sweep inherited tag rows for the deleted subtree.
    tag_inheritance::remove_subtree_inherited(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// Apply MoveBlock through the engine then project to SQL.
///
/// Engine `apply_move_block` writes parent_id + position via per-key
/// LWW; we read back the engine's post-apply snapshot and project
/// both fields into SQL. No sibling-shift on either side (see
/// projection helper's docstring for the rationale).
pub(crate) async fn apply_move_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &MoveBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        super::sql_only_fallback::record(
            "move_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_move_block_sql_only(conn, p.clone()).await;
    };

    // `(snapshot, old_parent_siblings, new_parent_siblings)`. A move can change
    // parent, so both the source and the target sibling groups need a dense
    // reprojection (#400). The resulting parent may differ from the requested
    // one (a cyclic/unknown-parent move keeps the current parent), so the
    // authoritative new parent is the post-apply snapshot's `parent_id`.
    let (snapshot, old_siblings, new_siblings): (BlockSnapshot, Vec<String>, Vec<String>) = {
        let Some(state) = crate::loro::shared::get() else {
            super::sql_only_fallback::record(
                "move_block",
                super::sql_only_fallback::SqlOnlyFallbackReason::EngineUninit,
            );
            return apply_move_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        let new_parent = p.new_parent_id.as_ref().map(crate::ulid::BlockId::as_str);
        let old_parent = engine.read_parent(p.block_id.as_str())?;
        // #400 routing: new ops carry a 0-based `new_index`; pre-#400 ops carry
        // the legacy sparse `new_position` (mapped to a slot by the engine).
        match p.new_index {
            Some(index) => engine.apply_move_block_to(
                p.block_id.as_str(),
                new_parent,
                usize::try_from(index.max(0)).unwrap_or(usize::MAX),
            )?,
            None => engine.apply_move_block(p.block_id.as_str(), new_parent, p.new_position)?,
        }
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        let snap = snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_move_block_via_loro: engine read_block returned None for {} \
                 (a MoveBlock op presupposes the block exists)",
                p.block_id.as_str()
            ))
        })?;
        let old_siblings = engine.children_ordered_block_ids(old_parent.as_deref())?;
        // Same-parent reorder (the common DnD / moveUp / moveDown case): source
        // and target groups are identical, so reproject once. Only fetch the
        // second group when the parent actually changed (#400, review perf).
        let new_siblings = if old_parent.as_deref() == snap.parent_id.as_deref() {
            Vec::new()
        } else {
            engine.children_ordered_block_ids(snap.parent_id.as_deref())?
        };
        drop(guard);
        (snap, old_siblings, new_siblings)
    };

    projection::project_move_block_to_sql(conn, &snapshot).await?;
    // Reproject the source group (it shrank, or — for a same-parent move — it is
    // the single affected group). `new_siblings` is empty on a same-parent move.
    projection::reproject_dense_positions(conn, &old_siblings).await?;
    if !new_siblings.is_empty() {
        projection::reproject_dense_positions(conn, &new_siblings).await?;
    }
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// Apply RestoreBlock through the engine then project to SQL.
///
/// Engine apply for the SEED only + SQL projection that walks the
/// cohort via the descendants CTE. The per-descendant engine fan-out
/// lives in the post-commit helper `dispatch_restore_descendants`
/// (the engine apply is idempotent, so re-running it is safe).
///
/// **Why the engine sees only the seed.** The engine's
/// `apply_restore_block` is per-block-id; walking descendants would
/// duplicate work that `dispatch_restore_descendants` already does
/// post-commit. The split keeps the engine API simple (1 block in, 1
/// mutation out) and keeps cohort semantics on the SQL side. If a
/// crash drops the fanout, the next op-log replay rebuilds the engine
/// from scratch.
///
/// **Space resolution on a soft-deleted block.** `resolve_block_space`
/// filters `deleted_at IS NULL` (AGENTS.md invariant #9 — tombstones
/// must not participate in space resolution). But a `RestoreBlock` op
/// TARGETS a tombstoned block by definition, so the canonical resolver
/// returns `None`. We work around this by reading `parent_id` directly
/// from `blocks` (no `deleted_at` filter) and resolving the parent's
/// space — correct because the parent is in the same space as the
/// soft-deleted child by the per-space-tree invariant. When the block
/// has no parent (orphan / page-level restore), the path falls back to
/// the SQL-only restore.
pub(crate) async fn apply_restore_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &RestoreBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;
    use crate::ulid::BlockId;

    // Read parent_id directly (the canonical resolver filters out
    // soft-deleted rows, which would always be the case here).
    let block_id_str = p.block_id.as_str();
    let parent_row = sqlx::query!("SELECT parent_id FROM blocks WHERE id = ?", block_id_str)
        .fetch_optional(&mut *conn)
        .await?;
    let resolution_anchor: BlockId = match parent_row.and_then(|r| r.parent_id) {
        Some(parent) => BlockId::from_trusted(&parent),
        None => p.block_id.clone(),
    };
    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &resolution_anchor).await?
    else {
        super::sql_only_fallback::record(
            "restore_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_restore_block_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            super::sql_only_fallback::record(
                "restore_block",
                super::sql_only_fallback::SqlOnlyFallbackReason::EngineUninit,
            );
            return apply_restore_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_restore_block(p.block_id.as_str())?;
        drop(guard);
    }

    projection::project_restore_block_to_sql(conn, p.block_id.as_str(), p.deleted_at_ref).await?;

    // #1884: `project_restore_block_to_sql` also restores the contiguous
    // soft-deleted ANCESTOR chain above the block (closing the live-orphan
    // gap). Recompute tag inheritance from the TOPMOST now-live ancestor so
    // the whole reconnected subtree — not just the block's own subtree — is
    // refreshed, matching the command path (`restore_block_inner`). The walk
    // climbs `parent_id` from the block to the highest live ancestor; with no
    // restored ancestors it resolves to the block itself (unchanged
    // behaviour).
    let inheritance_root = topmost_live_ancestor(&mut *conn, p.block_id.as_str()).await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, &inheritance_root).await?;
    Ok(())
}

/// #1884: id of the highest LIVE ancestor reachable by walking `parent_id`
/// upward from `block_id` (the block itself if its parent is deleted/absent
/// or the parent walk yields no higher live row). Used to root the
/// tag-inheritance recompute after the ancestor chain has been restored, so
/// the whole reconnected subtree is refreshed.
///
/// `depth < 100` bounds runaway recursion on corrupted `parent_id` chains
/// (AGENTS.md invariant #9).
pub(super) async fn topmost_live_ancestor(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<String, AppError> {
    // Walk live ancestors upward; the deepest (greatest depth) is the
    // topmost. All ancestors are live by this point (the chain was restored).
    // dynamic-sql: recursive variable-depth ancestor walk; not expressible as
    // a compile-checked `query!` macro.
    let top = sqlx::query_scalar::<_, String>(
        "WITH RECURSIVE live_anc(id, parent_id, depth) AS ( \
             SELECT b.id, b.parent_id, 0 FROM blocks b \
             WHERE b.id = ? AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT p.id, p.parent_id, a.depth + 1 FROM blocks p \
             INNER JOIN live_anc a ON p.id = a.parent_id \
             WHERE p.deleted_at IS NULL AND a.depth < 100 \
         ) \
         SELECT id FROM live_anc ORDER BY depth DESC LIMIT 1",
    )
    .bind(block_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(top.unwrap_or_else(|| block_id.to_string()))
}

/// Apply PurgeBlock through the engine then run the SQL cascade.
///
/// Engine apply is per-block-id (deletes the seed's `blocks`,
/// `block_properties`, `block_tags` entries from the LoroDoc). The
/// SQL side then runs the full cascade inline — the cascade is much
/// wider than the engine state (purges agenda_cache, tags_cache,
/// fts_blocks, etc. that the engine doesn't model) so it stays in
/// this helper rather than getting absorbed into a projection. The
/// engine descendant state is reconciled via op-log replay; per-
/// descendant engine purges may be added later if needed. The SQL
/// cascade is the source of truth users observe. SQL-only fallback
/// shape mirrors the other helpers; in production both arms are
/// unreachable.
pub(crate) async fn apply_purge_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &PurgeBlockPayload,
) -> Result<(), AppError> {
    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return purge_block_sql_cascade(conn, p).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return purge_block_sql_cascade(conn, p).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_purge_block(p.block_id.as_str())?;
        drop(guard);
    }

    purge_block_sql_cascade(conn, p).await?;
    Ok(())
}

/// SQL-side purge cascade.
///
/// PURGE walks many tables — much broader than the engine's three
/// (`blocks`, `block_properties`, `block_tags`) — so it stays SQL-side
/// rather than being absorbed into a projection. Every row that
/// descends from the purged block must go. `depth < 100` is the
/// runaway-recursion guard.
pub(super) async fn purge_block_sql_cascade(
    conn: &mut sqlx::SqliteConnection,
    p: &PurgeBlockPayload,
) -> Result<(), AppError> {
    let block_id = p.block_id.as_str();
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *conn)
        .await?;
    // C: materialise the descendants set ONCE into a TEMP
    // table, then read from the table in each cascade statement.
    // Pre-refactor each statement re-evaluated the recursive
    // `descendants_cte_purge!()` CTE end-to-end against the same
    // subtree (15× walks per cascade), needlessly extending the
    // writer-lock window.
    //
    // Cleanup pattern: SQLite TEMP tables are connection-scoped and
    // the connection comes from a pool, so the table can outlive the
    // handler unless we explicitly DROP it.  The defensive
    // `DROP TABLE IF EXISTS` at the top guards against a prior crash
    // that leaked the table on this connection; the explicit
    // `DROP TABLE` at the bottom keeps the connection's temp namespace
    // clean for the next caller.
    sqlx::query("DROP TABLE IF EXISTS _purge_descendants")
        .execute(&mut *conn)
        .await?;
    // #1655: build the descendants set from the shared
    // `descendants_cte_purge!()` macro (single source of truth for the
    // purge CTE body — outer `deleted_at`-free filter, `depth < 100` cap)
    // rather than re-inlining it here. `concat!` is required because the
    // macro expands to a string literal that must be prefixed by the
    // `CREATE TEMP TABLE … AS` header and suffixed by the projection.
    sqlx::query(concat!(
        "CREATE TEMP TABLE _purge_descendants AS ",
        crate::descendants_cte_purge!(),
        "SELECT id FROM descendants",
    ))
    .bind(block_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_tags \
         WHERE block_id IN (SELECT id FROM _purge_descendants) \
            OR tag_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM _purge_descendants) \
            OR tag_id IN (SELECT id FROM _purge_descendants) \
            OR inherited_from IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_properties \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    // block_properties: value_ref pointing into the subtree — DELETE the
    // property row rather than NULLing the ref. Under migration 0062's
    // exactly_one_value CHECK a `value_ref`-typed property has no other
    // typed value to fall back on, so a SET-NULL produces an invariant-
    // violating all-NULL row. Mirrors the equivalent crud.rs change
    // (see crud.rs:~1249 / 1613 / 2063 and migration 0062's header).
    sqlx::query(
        "DELETE FROM block_properties \
         WHERE value_ref IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_links \
         WHERE source_id IN (SELECT id FROM _purge_descendants) \
            OR target_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM agenda_cache \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM tags_cache \
         WHERE tag_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM pages_cache \
         WHERE page_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM attachments \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_drafts \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM fts_blocks \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM page_aliases \
         WHERE page_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM projected_agenda_cache \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    // block_tag_refs / page_link_cache: both columns of each table FK
    // into blocks(id) ON DELETE CASCADE, so the final `DELETE FROM blocks`
    // under `defer_foreign_keys = ON` would clean these up implicitly.
    // We delete them explicitly anyway (issue #1583): the explicit list
    // above is the canonical record of every derived table PURGE touches,
    // and relying on the cascade silently leaks stale rows if a future
    // migration alters the FK or adds a block-referencing cache without
    // CASCADE. Delete rows referencing the purged subtree on EITHER FK
    // column.
    sqlx::query(
        "DELETE FROM block_tag_refs \
         WHERE source_id IN (SELECT id FROM _purge_descendants) \
            OR tag_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM page_link_cache \
         WHERE source_page_id IN (SELECT id FROM _purge_descendants) \
            OR target_page_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM blocks \
         WHERE id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    // C: explicitly drop the temp table so the pooled
    // connection's temp namespace is empty for the next caller.
    sqlx::query("DROP TABLE _purge_descendants")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Apply AddTag through the engine then project to SQL.
///
/// Engine apply pushes the tag id onto the block's `block_tags` list
/// (idempotent — engine de-dupes). SQL projection writes the
/// `block_tags` row via `INSERT OR IGNORE`. Tag inheritance fanout
/// runs AFTER the projection. An unresolvable space falls back to the
/// SQL-only path.
pub(crate) async fn apply_add_tag_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &AddTagPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        super::sql_only_fallback::record(
            "add_tag",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_add_tag_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            super::sql_only_fallback::record(
                "add_tag",
                super::sql_only_fallback::SqlOnlyFallbackReason::EngineUninit,
            );
            return apply_add_tag_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_add_tag(p.block_id.as_str(), p.tag_id.as_str())?;
        drop(guard);
    }

    projection::project_add_tag_to_sql(conn, p.block_id.as_str(), p.tag_id.as_str()).await?;
    tag_inheritance::propagate_tag_to_descendants(
        &mut *conn,
        p.block_id.as_str(),
        p.tag_id.as_str(),
    )
    .await?;
    Ok(())
}

/// Apply RemoveTag through the engine then project to SQL.
///
/// Engine apply removes the tag id from the block's `block_tags` list
/// (idempotent — engine no-ops on missing tag). SQL projection
/// deletes the `block_tags` row. Tag inheritance cleanup runs AFTER
/// the projection. An unresolvable space falls back to the SQL-only
/// path.
pub(crate) async fn apply_remove_tag_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &RemoveTagPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        super::sql_only_fallback::record(
            "remove_tag",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_remove_tag_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            super::sql_only_fallback::record(
                "remove_tag",
                super::sql_only_fallback::SqlOnlyFallbackReason::EngineUninit,
            );
            return apply_remove_tag_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_remove_tag(p.block_id.as_str(), p.tag_id.as_str())?;
        drop(guard);
    }

    projection::project_remove_tag_to_sql(conn, p.block_id.as_str(), p.tag_id.as_str()).await?;
    tag_inheritance::remove_inherited_tag(&mut *conn, p.block_id.as_str(), p.tag_id.as_str())
        .await?;
    Ok(())
}

/// Apply DeleteProperty through the engine then project to SQL.
///
/// Engine apply removes the key from the block's properties map
/// (idempotent — engine no-ops on missing key). SQL projection runs
/// the per-key match (reserved key → UPDATE column to NULL;
/// non-reserved key → DELETE block_properties row). No
/// tag-inheritance fanout — properties don't propagate. An
/// unresolvable space falls back to the SQL-only path.
pub(crate) async fn apply_delete_property_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &DeletePropertyPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        super::sql_only_fallback::record(
            "delete_property",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_delete_property_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            super::sql_only_fallback::record(
                "delete_property",
                super::sql_only_fallback::SqlOnlyFallbackReason::EngineUninit,
            );
            return apply_delete_property_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_delete_property(p.block_id.as_str(), &p.key)?;
        drop(guard);
    }

    projection::project_delete_property_to_sql(conn, p.block_id.as_str(), &p.key).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// SQL-only fallback helpers.
//
// Used by the `apply_*_via_loro` helpers when:
//
// - Loro state is uninitialised (test scaffolding that doesn't call
//   `crate::loro::shared::install_for_test`). Production always
//   initialises via `crate::loro::shared::init` at boot.
// - Space resolution fails (orphan block, no `space` ancestor, pre-
// Row). These rows write SQL but skip the engine apply; a
//   later op-log replay will reconcile engine state if the row gets a
//   space.
//
// In production both arms are unreachable. The fallback exists so
// that ~55 materializer / recovery / sync_daemon tests can thread
// synthetic ops through `apply_op` against bare-block fixtures with
// no space chain.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod purge_derived_tables_tests {
    use crate::db::init_pool;
    use crate::op::PurgeBlockPayload;
    use crate::ulid::BlockId;

    /// #1583: `purge_block_sql_cascade` must EXPLICITLY clear
    /// `block_tag_refs` and `page_link_cache` for the purged subtree
    /// rather than relying on FK `ON DELETE CASCADE`. Seed a block with
    /// an inline tag-ref row and a page-link edge, purge it, and assert
    /// both derived tables hold zero rows referencing the purged block.
    #[tokio::test]
    async fn purge_clears_block_tag_refs_and_page_link_cache() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let db_path = dir.path().join("purge_derived.db");
        let pool = init_pool(&db_path).await.expect("init_pool");

        const SRC: &str = "01HZ00000000000000000000S1";
        const TAG: &str = "01HZ00000000000000000000T1";
        const TGT: &str = "01HZ00000000000000000000P2";

        // Seed three plain blocks: the source we will purge, a tag block
        // it inline-references, and a target page it links to.
        for id in [SRC, TAG, TGT] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', 'seed', NULL, 0)",
            )
            .bind(id)
            .execute(&pool)
            .await
            .expect("insert block");
        }

        // Inline tag reference: SRC content references TAG.
        sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)")
            .bind(SRC)
            .bind(TAG)
            .execute(&pool)
            .await
            .expect("insert block_tag_refs");
        // Page-link edge: SRC -> TGT.
        sqlx::query(
            "INSERT INTO page_link_cache (source_page_id, target_page_id, edge_count) \
             VALUES (?, ?, 1)",
        )
        .bind(SRC)
        .bind(TGT)
        .execute(&pool)
        .await
        .expect("insert page_link_cache");

        // Sanity: both derived rows exist pre-purge.
        let pre_refs: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tag_refs WHERE source_id = ?")
                .bind(SRC)
                .fetch_one(&pool)
                .await
                .expect("pre count refs");
        let pre_links: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM page_link_cache WHERE source_page_id = ?")
                .bind(SRC)
                .fetch_one(&pool)
                .await
                .expect("pre count links");
        assert_eq!(pre_refs.0, 1, "seed: block_tag_refs row must exist");
        assert_eq!(pre_links.0, 1, "seed: page_link_cache row must exist");

        // Purge the source block via the SQL cascade under test.
        //
        // GUARD STRENGTH: `block_tag_refs` and `page_link_cache` both carry
        // FK `ON DELETE CASCADE` into `blocks(id)`, and `init_pool` enables
        // `PRAGMA foreign_keys = ON`. If we left FK enforcement on, the
        // final `DELETE FROM blocks` would clean these rows via the cascade
        // EVEN IF the explicit DELETEs in `purge_block_sql_cascade` were
        // removed — making this test a non-guard (it passed under a mutation
        // that deleted both explicit statements). Disable FK enforcement on
        // THIS connection so the cascade cannot fire: the only path that can
        // clear the rows is the explicit `DELETE FROM block_tag_refs` /
        // `DELETE FROM page_link_cache` under test. (`defer_foreign_keys`,
        // set inside the cascade, is a no-op when `foreign_keys = OFF`.)
        let mut conn = pool.acquire().await.expect("acquire");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *conn)
            .await
            .expect("disable fk enforcement on purge connection");
        let payload = PurgeBlockPayload {
            block_id: BlockId::from_trusted(SRC),
        };
        super::purge_block_sql_cascade(&mut conn, &payload)
            .await
            .expect("purge_block_sql_cascade");
        drop(conn);

        // Both derived tables must be empty for the purged block —
        // proving the EXPLICIT DELETEs ran (not just an implicit FK
        // cascade).
        let post_refs: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tag_refs WHERE source_id = ? OR tag_id = ?")
                .bind(SRC)
                .bind(SRC)
                .fetch_one(&pool)
                .await
                .expect("post count refs");
        let post_links: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM page_link_cache \
             WHERE source_page_id = ? OR target_page_id = ?",
        )
        .bind(SRC)
        .bind(SRC)
        .fetch_one(&pool)
        .await
        .expect("post count links");
        assert_eq!(post_refs.0, 0, "purge must clear block_tag_refs rows");
        assert_eq!(post_links.0, 0, "purge must clear page_link_cache rows");
    }

    /// #1993 cascade safety: purging a block whose attachment shares a
    /// content-addressed blob with ANOTHER block must NOT unlink the blob
    /// bytes. `purge_block_sql_cascade` deletes only the attachment ROW; the
    /// refcount-aware GC then keeps the file because the sibling block's row
    /// still references it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purge_keeps_shared_blob_for_sibling_block_1993() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let pool = init_pool(&dir.path().join("purge_blob.db"))
            .await
            .expect("init_pool");

        const BLK_A: &str = "01HZ0000000000000000000PA1";
        const BLK_B: &str = "01HZ0000000000000000000PB1";
        let rel = "attachments/shared.bin";
        std::fs::create_dir_all(dir.path().join("attachments")).unwrap();
        std::fs::write(dir.path().join(rel), b"shared purge bytes").unwrap();

        for id in [BLK_A, BLK_B] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', 'seed', NULL, 0)",
            )
            .bind(id)
            .execute(&pool)
            .await
            .expect("insert block");
        }
        // Two attachment rows (one per block) sharing one blob file.
        for (att, blk) in [("ATT_PA", BLK_A), ("ATT_PB", BLK_B)] {
            sqlx::query(
                "INSERT INTO attachments \
                 (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, content_hash) \
                 VALUES (?, ?, 'application/zip', 'f.bin', 18, ?, 1735689600000, 'hash_shared')",
            )
            .bind(att)
            .bind(blk)
            .bind(rel)
            .execute(&pool)
            .await
            .expect("insert attachment");
        }
        sqlx::query(
            "INSERT INTO attachment_blobs (content_hash, on_disk_path, size_bytes, created_at) \
             VALUES ('hash_shared', ?, 18, 1735689600000)",
        )
        .bind(rel)
        .execute(&pool)
        .await
        .expect("insert blob");

        // Purge block A (deletes only its attachment ROW — never the file).
        let mut conn = pool.acquire().await.expect("acquire");
        let payload = crate::op::PurgeBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(BLK_A),
        };
        super::purge_block_sql_cascade(&mut conn, &payload)
            .await
            .expect("purge");
        drop(conn);

        // GC must NOT unlink the file: block B's row still references it.
        crate::materializer::handlers::cleanup_orphaned_attachments(&pool, None, dir.path())
            .await
            .expect("gc");

        assert!(
            dir.path().join(rel).exists(),
            "shared blob file must survive purge while sibling block references it"
        );
        let blob_n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachment_blobs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            blob_n, 1,
            "blob row must survive while a sibling references it"
        );
        // Block B's row is intact.
        let b_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE block_id = ?")
            .bind(BLK_B)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(b_rows, 1, "sibling block's attachment row must be intact");
    }
}
